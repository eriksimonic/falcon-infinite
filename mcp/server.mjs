#!/usr/bin/env node
// FALCON / INFINITE — local MCP server (Feature 11).
//
//   MCP client  ──stdio JSON-RPC 2.0──▶  this process  ──127.0.0.1 HTTP──▶  browser
//
// The stdio side speaks Model Context Protocol (tools/list + tools/call).
// The HTTP side is a tiny long-poll command queue plus telemetry/result sink
// for src/core/mcp_bridge.js. No npm dependencies: node:http + node:process.
//
// Security: the HTTP bridge binds to 127.0.0.1 only and refuses non-loopback
// browser Origins. stdout is reserved for the MCP wire; diagnostics go to
// stderr so an MCP client's transport is never corrupted.

import http from 'node:http';
import process from 'node:process';

const SERVER_NAME = 'falcon-infinite';
const SERVER_TITLE = 'FALCON / INFINITE — Local Game Bridge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const LOOPBACK = '127.0.0.1';
const MAX_BODY_BYTES = 24 * 1024 * 1024; // screenshots are base64 PNGs
const MAX_QUEUED_COMMANDS = 64;
const COMMAND_STALE_MS = 20000;
const CLIENT_GRACE_MS = 5000;

const TELEMETRY_NOTE =
  'kts, mach, altFt, aglFt, heading, pitch, roll, throttle, afterburner, g, aoa, ' +
  'fuelLb, windDir, windKts, mode, mission, targets, rwrContacts, ammo, fps';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

class BridgeError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.data = data;
  }
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------

const TELEPORT_SCHEMA = {
  type: 'object',
  description: 'Absolute world teleport (metres, Y up; North = -Z, East = +X).',
  properties: {
    x: { type: 'number', description: 'World X, metres east.' },
    y: { type: 'number', description: 'World Y, metres above sea level (omit for 300 m AGL).' },
    z: { type: 'number', description: 'World Z, metres south (north is negative).' },
    heading: { type: 'number', description: 'Heading in degrees clockwise from north (0..360).' },
    speedMs: { type: 'number', description: 'True airspeed in m/s (default keeps current speed).' },
  },
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'get_telemetry',
    title: 'Live telemetry',
    description:
      'Read the live F-16C state: ' + TELEMETRY_NOTE + '. ' +
      'Returns the most recent browser snapshot; pass fresh=true to force a round-trip to the cockpit.',
    inputSchema: {
      type: 'object',
      properties: {
        fresh: { type: 'boolean', description: 'Force a browser round-trip even if a cached snapshot is fresh.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_flight_state',
    title: 'Set flight state',
    description:
      'Set throttle (0..1), autopilot OFF/ALT_HDG/ATT with target altitudeFt/heading, gear, flaps (0..2), ' +
      'wheel brakes, or teleport the jet for instant test scenarios.',
    inputSchema: {
      type: 'object',
      properties: {
        throttle: { type: 'number', minimum: 0, maximum: 1 },
        autopilot: { type: 'string', enum: ['OFF', 'ALT_HDG', 'ATT'] },
        altitudeFt: { type: 'number', description: 'Autopilot target altitude, feet MSL.' },
        heading: { type: 'number', description: 'Autopilot target heading, degrees clockwise from north.' },
        gear: {
          description: 'Landing gear: true = down, false = up, "toggle" = flip.',
          oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['toggle'] }],
        },
        flaps: { type: 'integer', minimum: 0, maximum: 2 },
        brakes: { type: 'boolean', description: 'Wheel brakes on the ground / speedbrakes in the air.' },
        teleport: TELEPORT_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_controls',
    title: 'Pulse flight controls',
    description:
      'Apply a timed virtual stick/rudder/throttle pulse. Axes are -1..1; a positive pitch pulls the nose up, ' +
      'positive roll banks left, positive yaw yaws left, positive throttleDelta advances the throttle.',
    inputSchema: {
      type: 'object',
      properties: {
        pitch: { type: 'number', minimum: -1, maximum: 1 },
        roll: { type: 'number', minimum: -1, maximum: 1 },
        yaw: { type: 'number', minimum: -1, maximum: 1 },
        throttleDelta: { type: 'number', minimum: -1, maximum: 1 },
        durationMs: { type: 'integer', minimum: 50, maximum: 20000, default: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'combat_action',
    title: 'Combat action',
    description:
      'Select a weapon (GUN/AIM9/MK82), fire a shot or burst, deploy flares, toggle NVGs, or trigger ejection.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['select_weapon', 'fire', 'deploy_flares', 'toggle_nvg', 'eject'],
        },
        weapon: { type: 'string', enum: ['GUN', 'AIM9', 'MK82'] },
        burstMs: {
          type: 'integer',
          minimum: 0,
          maximum: 5000,
          description: 'When firing, keep firing for this long (GUN bursts, ripple release).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_environment',
    title: 'Set environment',
    description:
      'Switch weather (clear/few/scattered/overcast/storm), wind (auto/calm/breeze/windy/gale), ' +
      'theater (temperate/desert), time of day (hour 0..24), time scale (1/5/20/60/300), ' +
      'or camera (cockpit/chase/wing/orbit).',
    inputSchema: {
      type: 'object',
      properties: {
        weather: { type: 'string', enum: ['clear', 'few', 'scattered', 'overcast', 'storm'] },
        wind: { type: 'string', enum: ['auto', 'calm', 'breeze', 'windy', 'gale'] },
        theater: { type: 'string', enum: ['temperate', 'desert'] },
        hour: { type: 'number', minimum: 0, maximum: 24, description: 'Simulated local hour; 24 wraps to 0.' },
        timeScale: { type: 'number', enum: [1, 5, 20, 60, 300] },
        camera: { type: 'string', enum: ['cockpit', 'chase', 'wing', 'orbit'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'start_mission',
    title: 'Start mission',
    description:
      'Start or reset a sortie: free, sead (Wild Weasel), strike (Baghdad strike) or cap (BARCAP). ' +
      'Set respawn=true to reset the jet to the runway first.',
    inputSchema: {
      type: 'object',
      properties: {
        mission: { type: 'string', enum: ['free', 'sead', 'strike', 'cap'], default: 'free' },
        respawn: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'send_radio',
    title: 'Send tactical radio',
    description:
      'Inject an AWACS / ATC / flight callout onto the pilot radio feed and HUD toast. ' +
      'priority is info, warn or urgent.',
    inputSchema: {
      type: 'object',
      properties: {
        sender: { type: 'string', maxLength: 24, default: 'MAGIC' },
        text: { type: 'string', minLength: 1, maxLength: 300 },
        priority: { type: 'string', enum: ['info', 'warn', 'urgent'], default: 'info' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'capture_screenshot',
    title: 'Capture screenshot',
    description:
      'Capture the current composite frame (WebGL scene + 2D HUD) as a PNG and return it as MCP image content.',
    inputSchema: {
      type: 'object',
      properties: {
        maxWidth: { type: 'integer', minimum: 320, maximum: 3840, description: 'Optional downscale width in pixels.' },
      },
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

function toolResult(toolName, payload) {
  if (toolName === 'capture_screenshot' && payload && typeof payload.png === 'string') {
    const data = payload.png.replace(/^data:image\/png;base64,/, '');
    const meta = {
      width: Number.isFinite(payload.width) ? payload.width : null,
      height: Number.isFinite(payload.height) ? payload.height : null,
      format: 'png',
      bytes: Number.isFinite(payload.bytes) ? payload.bytes : data.length,
    };
    return {
      content: [
        { type: 'image', data, mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify(meta) },
      ],
      structuredContent: meta,
      isError: false,
    };
  }

  const body = payload === undefined ? { ok: true } : payload;
  const result = {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    isError: false,
  };
  if (body && typeof body === 'object' && !Array.isArray(body)) result.structuredContent = body;
  return result;
}

function toolError(code, message, data) {
  const error = { ok: false, error: { code, message } };
  if (data !== undefined) error.error.data = data;
  return {
    content: [{ type: 'text', text: JSON.stringify(error) }],
    structuredContent: error,
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Browser bridge: loopback HTTP + long-poll command queue
// ---------------------------------------------------------------------------

function isLoopbackOrigin(origin) {
  if (origin === 'null') return true; // file:// — still a local page
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function sendJson(res, status, body, origin = null) {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds ' + limit + ' bytes'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON'));
      }
    });
    req.on('error', (err) => fail(err));
  });
}

class GameBridge {
  constructor(options = {}) {
    this.host = LOOPBACK;
    this.port = Number.isFinite(options.port) ? options.port : 5179;
    this.resultTimeoutMs = Number.isFinite(options.resultTimeoutMs) ? options.resultTimeoutMs : 8000;
    this.screenshotTimeoutMs = Number.isFinite(options.screenshotTimeoutMs)
      ? options.screenshotTimeoutMs
      : 15000;
    this.commands = [];
    this.waiters = [];
    this.pending = new Map();
    this.clients = new Map();
    this.seq = 0;
    this.telemetry = null;
    this.telemetryAt = 0;
    this.startedAt = Date.now();
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        const code = err instanceof HttpError ? err.code : 'INTERNAL_ERROR';
        if (!(err instanceof HttpError)) console.error('[falcon-mcp] http error:', err);
        try {
          sendJson(res, status, { ok: false, error: { code, message: err.message } }, res.__corsOrigin || null);
        } catch {
          res.destroy();
        }
      });
    });
    this.server.on('clientError', (_err, socket) => {
      if (socket && !socket.destroyed) socket.destroy();
    });
    // Long-polls are intentionally allowed to sit for 30 s.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60000;
    this.server.keepAliveTimeout = 65000;
  }

  async listen() {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    if (address && typeof address === 'object') this.port = address.port;
    return this.port;
  }

  async close() {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      try {
        waiter.send([]);
      } catch {
        /* socket already gone */
      }
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError('SERVER_SHUTDOWN', 'MCP server shut down before ' + entry.tool + ' completed'));
      this.pending.delete(id);
    }
    this.commands.length = 0;
    if (!this.server.listening) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      if (timer.unref) timer.unref();
      this.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      this.server.closeAllConnections?.();
    });
  }

  hasClient(graceMs = CLIENT_GRACE_MS) {
    const now = Date.now();
    for (const client of this.clients.values()) {
      if (client.open || now - client.lastAt < graceMs) return true;
    }
    return false;
  }

  activeClientCount() {
    const now = Date.now();
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.open || now - client.lastAt < 15000) count++;
    }
    return count;
  }

  hasFreshTelemetry(maxAgeMs) {
    return !!this.telemetry && Date.now() - this.telemetryAt <= maxAgeMs;
  }

  dispatch(tool, args, timeoutMs = this.resultTimeoutMs) {
    if (!this.hasClient()) {
      return Promise.reject(
        new BridgeError(
          'BRIDGE_OFFLINE',
          'No browser client is polling 127.0.0.1:' + this.port +
            '. Open the simulator in dev mode or with ?mcp=1.',
        ),
      );
    }
    if (this.commands.length >= MAX_QUEUED_COMMANDS) {
      this.commands.shift();
    }
    const id = 'cmd-' + Date.now().toString(36) + '-' + (++this.seq).toString(36);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.commands = this.commands.filter((c) => c.id !== id);
        reject(
          new BridgeError(
            'BRIDGE_TIMEOUT',
            'No browser result for ' + tool + ' within ' + timeoutMs + ' ms',
          ),
        );
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer, tool });
      this.commands.push({ id, tool, args: args || {}, ts: Date.now() });
      this._deliver();
    });
  }

  _settle(id, payload) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (payload && payload.ok) {
      entry.resolve(payload.result);
    } else {
      const err = payload && payload.error ? payload.error : {};
      entry.reject(
        new BridgeError(
          typeof err.code === 'string' ? err.code : 'BROWSER_ERROR',
          typeof err.message === 'string' ? err.message : 'Browser reported a failed tool call',
          err.data,
        ),
      );
    }
    return true;
  }

  _takeCommands() {
    const out = [];
    const now = Date.now();
    while (this.commands.length && out.length < 16) {
      const command = this.commands.shift();
      if (now - command.ts > COMMAND_STALE_MS) {
        this._settle(command.id, {
          ok: false,
          error: { code: 'BRIDGE_TIMEOUT', message: command.tool + ' expired in the command queue' },
        });
        continue;
      }
      out.push(command);
    }
    return out;
  }

  _deliver() {
    while (this.waiters.length && this.commands.length) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.send(this._takeCommands());
    }
  }

  _removeWaiter(waiter, markClosed = true) {
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    if (markClosed) {
      const client = this.clients.get(waiter.clientId);
      if (client) {
        client.open = false;
        client.lastAt = Date.now();
      }
    }
  }

  async _handle(req, res) {
    const originHeader = req.headers.origin;
    const origin = originHeader && isLoopbackOrigin(originHeader) ? originHeader : null;
    res.__corsOrigin = origin;
    if (originHeader && !origin) {
      sendJson(res, 403, {
        ok: false,
        error: { code: 'FORBIDDEN_ORIGIN', message: 'Only loopback browser origins may use the bridge' },
      });
      return;
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url || '/', 'http://' + LOOPBACK);
    } catch {
      throw new HttpError(400, 'BAD_REQUEST', 'Bad request URL');
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && (path === '/' || path === '/info')) {
      sendJson(res, 200, {
        ok: true,
        name: SERVER_NAME,
        version: SERVER_VERSION,
        bridge: 'http://127.0.0.1:' + this.port,
        endpoints: ['GET /health', 'GET /commands?wait=ms', 'POST /telemetry', 'POST /result'],
        clients: this.activeClientCount(),
      }, origin);
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, {
        ok: true,
        name: SERVER_NAME,
        version: SERVER_VERSION,
        host: this.host,
        port: this.port,
        clients: this.activeClientCount(),
        queued: this.commands.length,
        pending: this.pending.size,
        telemetryAgeMs: this.telemetry ? Date.now() - this.telemetryAt : null,
        uptimeMs: Date.now() - this.startedAt,
      }, origin);
      return;
    }

    if (req.method === 'GET' && path === '/commands') {
      this._handleCommands(req, res, url, origin);
      return;
    }

    if (req.method === 'POST' && path === '/telemetry') {
      const body = await readJsonBody(req);
      const snapshot = body && typeof body === 'object' && body.telemetry ? body.telemetry : body;
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new HttpError(400, 'INVALID_TELEMETRY', 'Telemetry body must be a JSON object');
      }
      this.telemetry = snapshot;
      this.telemetryAt = Date.now();
      sendJson(res, 200, { ok: true, receivedAt: this.telemetryAt, clients: this.activeClientCount() }, origin);
      return;
    }

    if (req.method === 'POST' && path === '/result') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || typeof body.id !== 'string') {
        throw new HttpError(400, 'INVALID_RESULT', 'Result body must include a string id');
      }
      const settled = this._settle(body.id, body);
      sendJson(res, 200, { ok: true, settled }, origin);
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'Unknown bridge endpoint: ' + path);
  }

  _handleCommands(req, res, url, origin) {
    const clientId = String(url.searchParams.get('client') || 'default').slice(0, 64);
    const waitMs = Math.max(0, Math.min(30000, Number(url.searchParams.get('wait') || 0) || 0));
    const now = Date.now();
    const client = this.clients.get(clientId) || { open: false, lastAt: 0 };
    client.lastAt = now;
    this.clients.set(clientId, client);

    const send = (commands) => {
      if (client.open) {
        client.open = false;
        client.lastAt = Date.now();
      }
      sendJson(res, 200, { ok: true, commands, now: Date.now() }, origin);
    };

    const ready = this._takeCommands();
    if (ready.length) {
      send(ready);
      return;
    }
    if (waitMs <= 0) {
      send([]);
      return;
    }

    client.open = true;
    const waiter = { res, clientId, send, timer: null };
    waiter.timer = setTimeout(() => {
      this._removeWaiter(waiter);
      send([]);
    }, waitMs);
    if (waiter.timer.unref) waiter.timer.unref();
    res.on('close', () => this._removeWaiter(waiter, true));
    this.waiters.push(waiter);
  }
}

// ---------------------------------------------------------------------------
// MCP (stdio JSON-RPC 2.0)
// ---------------------------------------------------------------------------

function writeMessage(message) {
  const line = JSON.stringify(message);
  process.stdout.write(line + '\n');
}

function writeError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeMessage({ jsonrpc: '2.0', id: id === undefined ? null : id, error });
}

function hasId(message) {
  return message && Object.prototype.hasOwnProperty.call(message, 'id');
}

function protocolVersionFor(params) {
  const requested = params && params.protocolVersion;
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return DEFAULT_PROTOCOL_VERSION;
}

function initializeResult(params) {
  return {
    protocolVersion: protocolVersionFor(params),
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
    instructions:
      'FALCON / INFINITE local cockpit bridge. Start the simulator in Vite dev mode (or append ' +
      '?mcp=1) so window.__falcon is bridged, then use get_telemetry to inspect the jet, ' +
      'set_environment to change weather/time/camera, set_flight_state to teleport or configure ' +
      'autopilot, and send_radio to talk to the pilot.',
  };
}

class McpServer {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.quiet = !!options.quiet;
    this.initialized = false;
    this.clientInfo = null;
  }

  async callTool(name, args) {
    if (!TOOL_NAMES.has(name)) {
      throw new RpcError(-32602, 'Unknown tool: ' + name);
    }
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      throw new RpcError(-32602, 'tools/call arguments must be an object');
    }
    const input = args || {};

    try {
      if (name === 'get_telemetry' && input.fresh !== true && this.bridge.hasFreshTelemetry(2500)) {
        return toolResult(name, this.bridge.telemetry);
      }
      if (name === 'get_telemetry') {
        try {
          const payload = await this.bridge.dispatch(name, input, 2500);
          return toolResult(name, payload);
        } catch (err) {
          if (err instanceof BridgeError && err.code === 'BRIDGE_TIMEOUT' && this.bridge.telemetry) {
            return toolResult(name, this.bridge.telemetry);
          }
          throw err;
        }
      }
      const timeout = name === 'capture_screenshot' ? this.bridge.screenshotTimeoutMs : this.bridge.resultTimeoutMs;
      const payload = await this.bridge.dispatch(name, input, timeout);
      return toolResult(name, payload);
    } catch (err) {
      if (err instanceof BridgeError) return toolError(err.code, err.message, err.data);
      if (err instanceof RpcError) throw err;
      return toolError('INTERNAL_ERROR', err && err.message ? err.message : String(err));
    }
  }

  async handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new RpcError(-32600, 'Invalid Request');
    }
    if (typeof message.method !== 'string') {
      throw new RpcError(-32600, 'Invalid Request: method must be a string');
    }
    if (message.jsonrpc !== undefined && message.jsonrpc !== '2.0') {
      throw new RpcError(-32600, 'Invalid Request: jsonrpc must be "2.0"');
    }

    const id = message.id;
    const params = message.params && typeof message.params === 'object' ? message.params : {};

    switch (message.method) {
      case 'initialize':
        this.initialized = true;
        this.clientInfo = params.clientInfo || null;
        return { jsonrpc: '2.0', id, result: initializeResult(params) };

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string' || !name) {
          throw new RpcError(-32602, 'tools/call requires a string name');
        }
        const result = await this.callTool(name, params.arguments);
        return { jsonrpc: '2.0', id, result };
      }

      case 'notifications/initialized':
      case 'initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return null;

      default:
        if (typeof message.method === 'string' && message.method.startsWith('notifications/')) {
          return null;
        }
        throw new RpcError(-32601, 'Method not found: ' + message.method);
    }
  }
}

class StdioTransport {
  constructor(onLine, onEnd) {
    this.onLine = onLine;
    this.onEnd = onEnd;
    this.buffer = Buffer.alloc(0);
    process.stdin.on('data', (chunk) => this._push(chunk));
    process.stdin.on('end', () => this.onEnd());
    process.stdin.on('close', () => this.onEnd());
    process.stdin.on('error', () => this.onEnd());
    process.stdin.resume();
  }

  _push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this._drain();
  }

  _drain() {
    for (;;) {
      if (!this.buffer.length) return;

      // Tolerate leading blank lines between messages.
      while (this.buffer.length && (this.buffer[0] === 10 || this.buffer[0] === 13)) {
        this.buffer = this.buffer.subarray(1);
      }
      if (!this.buffer.length) return;

      const head = this.buffer.subarray(0, Math.min(32, this.buffer.length)).toString('latin1').toLowerCase();
      if (head.startsWith('content-length')) {
        // Optional LSP-style framing used by a few MCP clients.
        let headerEnd = this.buffer.indexOf('\r\n\r\n');
        let sep = 4;
        if (headerEnd === -1) {
          headerEnd = this.buffer.indexOf('\n\n');
          sep = 2;
        }
        if (headerEnd === -1) return;
        const header = this.buffer.subarray(0, headerEnd).toString('latin1');
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match) {
          this.buffer = this.buffer.subarray(headerEnd + sep);
          continue;
        }
        const length = Number(match[1]);
        const start = headerEnd + sep;
        if (this.buffer.length < start + length) return;
        const body = this.buffer.subarray(start, start + length).toString('utf8');
        this.buffer = this.buffer.subarray(start + length);
        this.onLine(body);
        continue;
      }

      const newline = this.buffer.indexOf(10);
      if (newline === -1) return;
      const line = this.buffer.subarray(0, newline).toString('utf8').trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line) this.onLine(line);
    }
  }
}

function parseArgs(argv) {
  const options = {
    port: Number(process.env.MCP_BRIDGE_PORT || 5179),
    resultTimeoutMs: Number(process.env.MCP_RESULT_TIMEOUT_MS || 8000),
    screenshotTimeoutMs: Number(process.env.MCP_SCREENSHOT_TIMEOUT_MS || 15000),
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') ? arg.split('=') : [arg, undefined];
    const next = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--port') options.port = Number(next());
    else if (flag === '--timeout' || flag === '--result-timeout-ms') options.resultTimeoutMs = Number(next());
    else if (flag === '--screenshot-timeout-ms') options.screenshotTimeoutMs = Number(next());
    else if (flag === '--quiet') options.quiet = true;
    else if (flag === '--help' || flag === '-h') {
      process.stderr.write(
        'FALCON / INFINITE local MCP server\n\n' +
          'Usage: node mcp/server.mjs [--port 5179] [--timeout 8000] [--quiet]\n\n' +
          'MCP is spoken over stdin/stdout (JSON-RPC 2.0). The browser bridge listens on\n' +
          '127.0.0.1 only. Start the sim with "npm run dev" (or ?mcp=1) to attach it.\n',
      );
      process.exit(0);
    } else if (flag === '--version') {
      process.stderr.write(SERVER_VERSION + '\n');
      process.exit(0);
    } else if (arg) {
      process.stderr.write('[falcon-mcp] ignoring unknown argument: ' + arg + '\n');
    }
  }
  if (!Number.isFinite(options.port) || options.port < 0 || options.port > 65535) options.port = 5179;
  if (!Number.isFinite(options.resultTimeoutMs) || options.resultTimeoutMs < 100) options.resultTimeoutMs = 8000;
  if (!Number.isFinite(options.screenshotTimeoutMs) || options.screenshotTimeoutMs < 1000) {
    options.screenshotTimeoutMs = 15000;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bridge = new GameBridge(options);

  try {
    await bridge.listen();
  } catch (err) {
    process.stderr.write(
      '[falcon-mcp] cannot listen on ' + LOOPBACK + ':' + options.port + ' — ' +
        (err && err.message ? err.message : String(err)) + '\n',
    );
    process.exitCode = 1;
    return;
  }

  if (!options.quiet) {
    process.stderr.write('[falcon-mcp] stdio MCP server ready (protocol ' + DEFAULT_PROTOCOL_VERSION + ')\n');
    process.stderr.write('[falcon-mcp] browser bridge listening on http://' + LOOPBACK + ':' + bridge.port + '\n');
    process.stderr.write('[falcon-mcp] open the sim with ?mcp=1 (or in Vite dev mode) to attach it\n');
  }

  const server = new McpServer(bridge, options);
  let shuttingDown = false;

  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await bridge.close();
    } catch {
      /* ignore */
    }
    if (!options.quiet) process.stderr.write('[falcon-mcp] shutdown\n');
    process.exit(code);
  };

  const transport = new StdioTransport(
    (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        writeError(null, -32700, 'Parse error');
        return;
      }
      if (Array.isArray(message)) {
        // JSON-RPC batches are not part of MCP; answer each element anyway.
        Promise.all(
          message.map(async (item) => (hasId(item) ? server.handle(item).catch((err) => rpcFailure(item.id, err)) : null)),
        ).then((responses) => {
          const out = responses.filter(Boolean);
          if (out.length) writeMessage(out);
        });
        return;
      }
      if (!hasId(message)) {
        // Notifications never receive a response, even if the handler throws.
        server.handle(message).catch(() => {});
        return;
      }
      server
        .handle(message)
        .then((response) => {
          if (response) writeMessage(response);
        })
        .catch((err) => writeMessage(rpcFailure(message.id, err)));
    },
    () => {
      shutdown(0);
    },
  );

  // Keep a reference so the linter and GC agree the transport is live.
  void transport;

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
  });
  process.on('uncaughtException', (err) => {
    process.stderr.write('[falcon-mcp] uncaught: ' + (err && err.stack ? err.stack : String(err)) + '\n');
    shutdown(1);
  });
  process.on('unhandledRejection', (err) => {
    process.stderr.write('[falcon-mcp] unhandled rejection: ' + (err && err.stack ? err.stack : String(err)) + '\n');
  });
}

function rpcFailure(id, err) {
  if (err instanceof RpcError) {
    return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } };
  }
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code: -32603, message: 'Internal error: ' + (err && err.message ? err.message : String(err)) },
  };
}

main().catch((err) => {
  process.stderr.write('[falcon-mcp] fatal: ' + (err && err.stack ? err.stack : String(err)) + '\n');
  process.exit(1);
});