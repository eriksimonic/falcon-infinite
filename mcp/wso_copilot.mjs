#!/usr/bin/env node
// FALCON / INFINITE — AI WSO / co-pilot runner (Feature 14).
//
//   browser  ──HTTP──▶  mcp/server.mjs  ──stdio JSON-RPC──▶  this process
//
// Zero npm dependencies beyond Node built-ins. The WSO polls get_telemetry
// through the local MCP server and answers with deterministic tactical calls:
// flare defense against SAM launches, radar-lock / pull-up / bingo-fuel
// callouts, and optional patrol / cruise / evade automation.
//
//   node mcp/wso_copilot.mjs [--scenario patrol|cruise|evade] [--port 5179] [--poll-ms 250]
//
// stdout is left clean; status lines go to stderr.

import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER_PATH = path.join(HERE, 'server.mjs');
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_NAME = 'falcon-wso';
const CLIENT_VERSION = '1.0.0';
const SCENARIOS = new Set(['patrol', 'cruise', 'evade']);

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio client (JSON-RPC 2.0, newline-framed)
// ---------------------------------------------------------------------------

export class McpStdioClient {
  /**
   * @param {object} [options]
   * @param {string} [options.command] node executable (default: process.execPath)
   * @param {string[]} [options.args] argv for the server (default: this dir's server.mjs)
   * @param {string} [options.cwd]
   * @param {object} [options.env]
   * @param {number} [options.timeoutMs]
   * @param {NodeJS.ReadableStream} [options.stdin]  injectable transport (skips spawn)
   * @param {NodeJS.WritableStream} [options.stdout]
   * @param {NodeJS.ReadableStream} [options.stderr]
   * @param {(text: string) => void} [options.onStderr]
   * @param {(message: object) => void} [options.onNotification]
   */
  constructor(options = {}) {
    this.command = options.command || process.execPath;
    this.args = Array.isArray(options.args) ? options.args.slice() : [SERVER_PATH];
    this.cwd = options.cwd || ROOT;
    this.env = options.env || process.env;
    this.timeoutMs = finiteOr(options.timeoutMs, 10000);
    this.stdin = options.stdin || null;
    this.stdout = options.stdout || null;
    this.stderr = options.stderr || null;
    this.onStderr = typeof options.onStderr === 'function' ? options.onStderr : null;
    this.onNotification = typeof options.onNotification === 'function' ? options.onNotification : null;

    this.child = null;
    this.connected = false;
    this.initResult = null;
    this.protocolErrors = 0;

    this._buffer = '';
    this._pending = new Map();
    this._nextId = 1;
    this._closed = false;
    this._spawned = false;

    this._handleData = (chunk) => this._ingest(chunk);
    this._handleEnd = () => {
      if (!this._closed) this._failAll(new Error('MCP transport closed'));
    };
  }

  // ---------------------------------------------------------------- connect

  async connect() {
    if (this.connected) return this.initResult;
    if (this._closed) throw new Error('MCP client is closed');

    if (!this.stdout) {
      this.child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this._spawned = true;
      this.stdin = this.child.stdin;
      this.stdout = this.child.stdout;
      this.stderr = this.child.stderr;

      this.child.once('error', (err) => this._failAll(err));
      this.child.once('exit', (code, signal) => {
        if (this._closed) return;
        this.connected = false;
        this._failAll(
          new Error('MCP server exited (code ' + code + (signal ? ', signal ' + signal : '') + ')'),
        );
      });
      if (this.stdin) this.stdin.on('error', (err) => this._failAll(err));
      if (this.stderr) {
        this.stderr.setEncoding?.('utf8');
        this.stderr.on('data', (chunk) => {
          if (this.onStderr) {
            try {
              this.onStderr(String(chunk));
            } catch {
              /* diagnostics must never break the loop */
            }
          }
        });
      }
    }

    this.stdout.setEncoding?.('utf8');
    this.stdout.on('data', this._handleData);
    if (typeof this.stdout.on === 'function') {
      this.stdout.on('end', this._handleEnd);
      this.stdout.on('close', this._handleEnd);
    }

    const result = await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });

    this.initResult = result;
    this.connected = true;
    this._notify('notifications/initialized', {});
    return result;
  }

  // -------------------------------------------------------------- tool call

  async callTool(name, args = {}) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('callTool(name, args) requires a non-empty tool name');
    }
    const result = await this._request('tools/call', { name, arguments: args || {} });

    let payload = null;
    if (result && result.structuredContent !== undefined) {
      payload = result.structuredContent;
    } else {
      const text = this._firstText(result);
      if (text !== null) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }
    }

    if (result && result.isError) {
      const raw = payload && typeof payload === 'object' && payload.error ? payload.error : {};
      return {
        ok: false,
        error: {
          code: typeof raw.code === 'string' ? raw.code : 'TOOL_ERROR',
          message:
            typeof raw.message === 'string'
              ? raw.message
              : typeof payload === 'string' && payload
                ? payload
                : 'Tool call failed',
          ...(raw.data !== undefined ? { data: raw.data } : {}),
        },
      };
    }

    if (payload !== null) return payload;
    if (result && result.content !== undefined) return { ok: true, content: result.content };
    return { ok: true };
  }

  // ------------------------------------------------------------------ close

  async close() {
    if (this._closed) return;
    this._closed = true;
    this.connected = false;
    this._failAll(new Error('MCP client closed'));

    try {
      this.stdout?.removeListener?.('data', this._handleData);
      this.stdout?.removeListener?.('end', this._handleEnd);
      this.stdout?.removeListener?.('close', this._handleEnd);
    } catch {
      /* stream already gone */
    }

    const child = this.child;
    this.child = null;

    if (child) {
      try {
        child.stdin?.end();
      } catch {
        /* stdin already closed */
      }
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
            resolve();
          }, 1500);
          timer.unref?.();
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    } else if (this._spawned === false) {
      // Injected transport: only the writable end belongs to us.
      try {
        this.stdin?.end?.();
      } catch {
        /* already ended */
      }
    }
  }

  // -------------------------------------------------------------- internals

  _write(message) {
    if (!this.stdin) throw new Error('MCP transport is not connected');
    const line = JSON.stringify(message) + '\n';
    this.stdin.write(line);
  }

  _notify(method, params) {
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    this._write(message);
  }

  _request(method, params) {
    if (this._closed) return Promise.reject(new Error('MCP client is closed'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(String(id));
        reject(new Error('MCP request timed out after ' + this.timeoutMs + ' ms: ' + method));
      }, this.timeoutMs);
      timer.unref?.();
      this._pending.set(String(id), { resolve, reject, timer, method });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(String(id));
        reject(err);
      }
    });
  }

  _failAll(error) {
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this._pending.clear();
  }

  _firstText(result) {
    if (!result || !Array.isArray(result.content)) return null;
    const part = result.content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    return part ? part.text : null;
  }

  _ingest(chunk) {
    this._buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (;;) {
      // Blank lines between messages are legal noise.
      while (this._buffer.length && (this._buffer[0] === '\n' || this._buffer[0] === '\r')) {
        this._buffer = this._buffer.slice(1);
      }
      if (!this._buffer.length) return;

      if (this._buffer.slice(0, 14).toLowerCase() === 'content-length') {
        // Optional LSP-style framing, accepted for client compatibility.
        let headerEnd = this._buffer.indexOf('\r\n\r\n');
        let sep = 4;
        if (headerEnd === -1) {
          headerEnd = this._buffer.indexOf('\n\n');
          sep = 2;
        }
        if (headerEnd === -1) return;
        const header = this._buffer.slice(0, headerEnd);
        const match = /content-length:\s*(\d+)/i.exec(header);
        const start = headerEnd + sep;
        if (!match) {
          this._buffer = this._buffer.slice(start);
          continue;
        }
        const length = Number(match[1]);
        if (this._buffer.length < start + length) return;
        const body = this._buffer.slice(start, start + length);
        this._buffer = this._buffer.slice(start + length);
        this._message(body);
        continue;
      }

      const newline = this._buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this._buffer.slice(0, newline).trim();
      this._buffer = this._buffer.slice(newline + 1);
      if (line) this._message(line);
    }
  }

  _message(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.protocolErrors++;
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.protocolErrors++;
      return;
    }

    const hasId =
      Object.prototype.hasOwnProperty.call(message, 'id') &&
      message.id !== null &&
      message.id !== undefined;
    if (hasId) {
      const entry = this._pending.get(String(message.id));
      if (!entry) return;
      this._pending.delete(String(message.id));
      clearTimeout(entry.timer);
      if (message.error) {
        const err = new Error(
          typeof message.error.message === 'string'
            ? message.error.message
            : 'MCP error ' + message.error.code,
        );
        err.code = message.error.code;
        err.data = message.error.data;
        entry.reject(err);
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string' && this.onNotification) {
      try {
        this.onNotification(message);
      } catch {
        /* notification handlers are diagnostics only */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Decision engine
// ---------------------------------------------------------------------------

const SAM_LAUNCH_CALLOUT = 'SAM LAUNCH! FLARES OUT — BREAK HARD!';
const RADAR_LOCK_CALLOUT = 'SPIKE! RADAR LOCK — PREPARE COUNTERMEASURES';
const PULL_UP_CALLOUT = 'LOW TERRAIN — PULL UP!';
const BINGO_CALLOUT = 'BINGO FUEL — RTB OR HIT TANKER';

function contactState(contact) {
  return String(contact && contact.state ? contact.state : '').toUpperCase();
}

// Telemetry arrives in two shapes:
//   live bridge:  { ammo: { selected, rounds: { FLARE } }, autopilot: { mode } }
//   flat/replay:  { ammo: { FLARE }, autopilot: 'OFF' }
// Accept both so a copilot works against either producer.
function flareCount(telemetry) {
  const ammo = telemetry && telemetry.ammo;
  if (!ammo || typeof ammo !== 'object') return 1;
  const rounds = ammo.rounds && typeof ammo.rounds === 'object' ? ammo.rounds : null;
  const nested = rounds ? rounds.FLARE : undefined;
  if (Number.isFinite(nested)) return nested;
  return Number.isFinite(ammo.FLARE) ? ammo.FLARE : 1;
}

function autopilotMode(telemetry) {
  const ap = telemetry && telemetry.autopilot;
  if (typeof ap === 'string') return ap.toUpperCase();
  if (ap && typeof ap === 'object' && typeof ap.mode === 'string') return ap.mode.toUpperCase();
  return 'OFF';
}

export class WSOCopilot {
  /**
   * @param {{ callTool(name: string, args?: object): Promise<any> }} client
   * @param {object} [options]
   * @param {number} [options.pollMs]
   * @param {'patrol'|'cruise'|'evade'} [options.scenario]
   * @param {number} [options.flareCooldownMs]
   * @param {number} [options.radioCooldownMs]
   * @param {string} [options.llmUrl]
   * @param {string} [options.llmKey]
   * @param {string} [options.llmModel]
   * @param {() => number} [options.now]
   * @param {(action: {tool: string, args: object}) => void} [options.onAction]
   */
  constructor(client, options = {}) {
    if (!client || typeof client.callTool !== 'function') {
      throw new TypeError('WSOCopilot requires a client exposing callTool(name, args)');
    }
    this.client = client;
    this.pollMs = Math.max(25, finiteOr(options.pollMs, 250));
    this.scenario = SCENARIOS.has(options.scenario) ? options.scenario : 'patrol';
    this.flareCooldownMs = Math.max(0, finiteOr(options.flareCooldownMs, 3500));
    this.radioCooldownMs = Math.max(0, finiteOr(options.radioCooldownMs, 6000));
    this.llmUrl = typeof options.llmUrl === 'string' ? options.llmUrl : '';
    this.llmKey = typeof options.llmKey === 'string' ? options.llmKey : '';
    this.llmModel = typeof options.llmModel === 'string' && options.llmModel
      ? options.llmModel
      : 'gemini-2.5-flash-lite';
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.onAction = typeof options.onAction === 'function' ? options.onAction : null;

    this.running = false;
    this.offline = false;
    this.lastError = null;
    this.stats = {
      ticks: 0,
      flaresDeployed: 0,
      radioSent: 0,
      autopilotUpdates: 0,
      errors: 0,
    };

    this._timer = null;
    this._lastFlareAt = -Infinity;
    this._lastLaunchAt = -Infinity;
    this._lastEvadeAt = -Infinity;
    this._lastAdviceAt = -Infinity;
    this._radioAt = new Map();
    this._bingoCalled = false;
    this._cruiseEngaged = false;
  }

  // ------------------------------------------------------------- evaluation

  /**
   * Deterministic tactical pass over one telemetry snapshot.
   * Resolves to the actions dispatched, in decision order.
   */
  async evaluateTelemetry(telemetry) {
    const t = telemetry && typeof telemetry === 'object' && !Array.isArray(telemetry) ? telemetry : {};
    const now = this.now();
    const actions = [];
    const push = (tool, args) => actions.push({ tool, args });

    const contacts = Array.isArray(t.rwrContacts) ? t.rwrContacts.filter(Boolean) : [];
    const launch = contacts.some((c) => c.isMissile === true || contactState(c) === 'LAUNCH');
    const lock = contacts.some((c) => contactState(c) === 'LOCK');

    // 1 — missile launch defense.
    if (launch) {
      const flaresLeft = flareCount(t);
      const flareReady = now - this._lastFlareAt >= this.flareCooldownMs;
      if (flareReady && flaresLeft > 0) {
        this._lastFlareAt = now;
        this._lastLaunchAt = now;
        this.stats.flaresDeployed++;
        push('combat_action', { action: 'deploy_flares' });
        this._radioAt.set('launch', now);
        this.stats.radioSent++;
        push('send_radio', {
          sender: 'WSO',
          text: SAM_LAUNCH_CALLOUT,
          priority: 'urgent',
        });
      }
    }

    // 2 — radar lock / bandit spike. Suppressed while the launch callout is live.
    const launchCooling = launch || now - this._lastLaunchAt < this.radioCooldownMs;
    if (lock && !launchCooling && this._radioReady('radar-lock', now)) {
      this._radioAt.set('radar-lock', now);
      this.stats.radioSent++;
      push('send_radio', {
        sender: 'WSO',
        text: RADAR_LOCK_CALLOUT,
        priority: 'warn',
      });
    }

    // 3 — terrain pull-up.
    if (
      !t.onGround &&
      Number.isFinite(t.aglFt) &&
      Number.isFinite(t.vsFpm) &&
      t.aglFt < 350 &&
      t.vsFpm < -700 &&
      this._radioReady('pull-up', now)
    ) {
      this._radioAt.set('pull-up', now);
      this.stats.radioSent++;
      push('send_radio', {
        sender: 'WSO',
        text: PULL_UP_CALLOUT,
        priority: 'urgent',
      });
    }

    // 4 — bingo fuel, latched once per sortie.
    if (Number.isFinite(t.fuelLb) && t.fuelLb <= 1800 && !this._bingoCalled) {
      this._bingoCalled = true;
      this.stats.radioSent++;
      push('send_radio', {
        sender: 'WSO',
        text: BINGO_CALLOUT,
        priority: 'warn',
      });
    }

    // 5 — scenario automation.
    if (this.scenario === 'cruise') {
      const autopilot = autopilotMode(t);
      const airborne = !t.onGround && Number.isFinite(t.kts) && t.kts > 180;
      if (airborne && autopilot === 'OFF' && !this._cruiseEngaged) {
        this._cruiseEngaged = true;
        this.stats.autopilotUpdates++;
        push('set_flight_state', {
          autopilot: 'ALT_HDG',
          altitudeFt: Math.max(5000, Math.round(t.altFt || 8000)),
          heading: Math.round(t.heading || 0),
        });
      }
    } else if (this.scenario === 'evade') {
      const threatened = launch || lock;
      if (threatened && now - this._lastEvadeAt >= 1200) {
        this._lastEvadeAt = now;
        push('set_controls', { roll: 0.85, pitch: 0.6, durationMs: 1200 });
      }
    }
    // 'patrol' advises and defends; it never moves the pilot's stick.

    if (!actions.length) return actions;

    await Promise.all(
      actions.map(async (action) => {
        try {
          const result = await this.client.callTool(action.tool, action.args);
          if (result && result.ok === false) {
            this.lastError = result.error || { code: 'TOOL_ERROR', message: action.tool + ' failed' };
          }
        } catch (err) {
          this.stats.errors++;
          this.lastError = err;
        }
        if (this.onAction) {
          try {
            this.onAction(action);
          } catch {
            /* logging is best effort */
          }
        }
      }),
    );

    // Optional LLM advisor: fire-and-forget, rate-limited, never blocks a tick.
    if (this.llmUrl && this.llmKey && now - this._lastAdviceAt >= this.radioCooldownMs) {
      this._lastAdviceAt = now;
      Promise.resolve()
        .then(() => this.advise(t))
        .catch(() => {});
    }

    return actions;
  }

  _radioReady(key, now) {
    const last = this._radioAt.get(key);
    return last === undefined || now - last >= this.radioCooldownMs;
  }

  // -------------------------------------------------------------------- tick

  async tick() {
    this.stats.ticks++;
    let snapshot;
    try {
      snapshot = await this.client.callTool('get_telemetry', { fresh: false });
    } catch (err) {
      this.stats.errors++;
      this.lastError = err;
      return [];
    }

    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [];

    if (snapshot.ok === false || snapshot.offline === true) {
      const code = snapshot.error && snapshot.error.code;
      this.offline = code === 'BRIDGE_OFFLINE' || code === 'BRIDGE_TIMEOUT' || snapshot.offline === true;
      return [];
    }

    this.offline = false;
    const telemetry =
      snapshot.telemetry && typeof snapshot.telemetry === 'object' && !Array.isArray(snapshot.telemetry)
        ? snapshot.telemetry
        : snapshot;
    if (!telemetry || typeof telemetry !== 'object' || Array.isArray(telemetry)) return [];

    try {
      return await this.evaluateTelemetry(telemetry);
    } catch (err) {
      this.stats.errors++;
      this.lastError = err;
      return [];
    }
  }

  // ------------------------------------------------------------------- loop

  start() {
    if (this.running) return this;
    this.running = true;
    this._schedule(0);
    return this;
  }

  stop() {
    this.running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    return this;
  }

  _schedule(delayMs) {
    if (!this.running) return;
    this._timer = setTimeout(async () => {
      this._timer = null;
      if (!this.running) return;
      try {
        await this.tick();
      } finally {
        if (this.running) this._schedule(this.pollMs);
      }
    }, delayMs);
    if (this._timer.unref) this._timer.unref();
  }

  // ---------------------------------------------------------- LLM advisor

  /**
   * Optional tactical advisory via an HTTP LLM endpoint. Non-blocking when
   * called from evaluateTelemetry(). Supports Gemini and OpenAI-style shapes.
   */
  async advise(telemetry) {
    if (!this.llmUrl || !this.llmKey) return null;
    const t = telemetry && typeof telemetry === 'object' ? telemetry : {};
    const state = {
      altFt: t.altFt,
      aglFt: t.aglFt,
      kts: t.kts,
      vsFpm: t.vsFpm,
      heading: t.heading,
      fuelLb: t.fuelLb,
      g: t.g,
      aoa: t.aoa,
      rwrContacts: Array.isArray(t.rwrContacts) ? t.rwrContacts.slice(0, 4) : [],
    };
    const prompt =
      'You are the weapons systems officer of an F-16C. In at most 90 characters, ' +
      'give one immediate tactical call (no quotes, no preamble). State: ' +
      JSON.stringify(state);

    const gemini = /generativelanguage\.googleapis\.com/i.test(this.llmUrl);
    const body = gemini
      ? {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 64, temperature: 0.4 },
        }
      : {
          model: this.llmModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 64,
          temperature: 0.4,
        };

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 4000) : null;
    timer?.unref?.();
    try {
      const response = await fetch(this.llmUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.llmKey,
          'x-goog-api-key': this.llmKey,
        },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) return null;
      const data = await response.json();
      const raw =
        data?.candidates?.[0]?.content?.parts?.[0]?.text ||
        data?.choices?.[0]?.message?.content ||
        data?.response ||
        '';
      const text = String(raw).replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!text) return null;
      this.stats.radioSent++;
      await this.client.callTool('send_radio', { sender: 'WSO-AI', text, priority: 'info' });
      return text;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const options = {
    scenario: process.env.WSO_SCENARIO || 'patrol',
    port: Number(process.env.FALCON_MCP_PORT || 5179),
    pollMs: Number(process.env.WSO_POLL_MS || 250),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') ? arg.split('=') : [arg, undefined];
    const next = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--scenario') options.scenario = String(next());
    else if (flag === '--port') options.port = Number(next());
    else if (flag === '--poll-ms') options.pollMs = Number(next());
  }
  if (!SCENARIOS.has(options.scenario)) options.scenario = 'patrol';
  if (!Number.isFinite(options.port) || options.port < 0 || options.port > 65535) options.port = 5179;
  if (!Number.isFinite(options.pollMs) || options.pollMs < 25) options.pollMs = 250;
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const log = (message) => process.stderr.write('[wso] ' + message + '\n');

  const client = new McpStdioClient({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: ROOT,
    env: {
      ...process.env,
      FALCON_MCP_PORT: String(options.port),
      MCP_BRIDGE_PORT: String(options.port),
    },
    timeoutMs: 15000,
    onStderr: (text) => process.stderr.write(text),
  });

  let copilot = null;
  let closing = false;
  const shutdown = async (reason) => {
    if (closing) return;
    closing = true;
    log('shutting down (' + reason + ')');
    if (copilot) copilot.stop();
    try {
      await client.close();
    } catch {
      /* already down */
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const init = await client.connect();
    const serverName = init && init.serverInfo ? init.serverInfo.name : 'mcp server';
    log('connected to ' + serverName + ' — bridge port ' + options.port);

    copilot = new WSOCopilot(client, {
      pollMs: options.pollMs,
      scenario: options.scenario,
      llmUrl: process.env.WSO_LLM_URL || '',
      llmKey: process.env.WSO_LLM_KEY || '',
      llmModel: process.env.WSO_LLM_MODEL || 'gemini-2.5-flash-lite',
      onAction: (action) => log('→ ' + action.tool + ' ' + JSON.stringify(action.args)),
    });
    log('scenario=' + copilot.scenario + ' poll=' + copilot.pollMs + 'ms');
    copilot.start();
  } catch (err) {
    log('fatal: ' + (err && err.message ? err.message : String(err)));
    try {
      await client.close();
    } catch {
      /* already down */
    }
    process.exitCode = 1;
  }
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write('[wso] fatal: ' + (err && err.stack ? err.stack : String(err)) + '\n');
    process.exit(1);
  });
}