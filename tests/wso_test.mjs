// Feature 14 acceptance test — AI WSO / co-pilot.
//
//   node tests/wso_test.mjs
//
// Part A drives WSOCopilot against a recording fake client with an injected
// clock (deterministic, no timers). Part B exercises McpStdioClient over an
// in-process transport. Part C boots the real mcp/server.mjs on an ephemeral
// port and verifies the handshake and graceful BRIDGE_OFFLINE handling.
// No browser and no npm dependencies beyond the repo.

import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { McpStdioClient, WSOCopilot } from '../mcp/wso_copilot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'mcp', 'server.mjs');

let checks = 0;
const failures = [];

function ok(cond, msg, detail = '') {
  checks++;
  if (!cond) failures.push(msg + (detail ? ' — ' + detail : ''));
  else if (process.env.WSO_VERBOSE) console.log('  ok  ' + msg);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function group(title) {
  if (process.env.WSO_VERBOSE) console.log('\n' + title);
}

// Records every tool call the copilot makes.
class FakeClient {
  constructor(responder = () => ({ ok: true })) {
    this.responder = responder;
    this.calls = [];
  }
  async callTool(name, args = {}) {
    this.calls.push({ name, args });
    return this.responder(name, args);
  }
}

function toolsOf(actions) {
  return actions.map((a) => a.tool);
}

function findAction(actions, tool) {
  return actions.find((a) => a.tool === tool) || null;
}

const LAUNCH = {
  onGround: false,
  kts: 420,
  altFt: 8000,
  aglFt: 7600,
  heading: 45,
  vsFpm: -200,
  fuelLb: 6200,
  ammo: { FLARE: 30 },
  rwrContacts: [{ id: 'sam-3', type: 'SAM', state: 'LAUNCH', isMissile: true }],
};

const LOCK = {
  onGround: false,
  kts: 400,
  altFt: 12000,
  aglFt: 11000,
  heading: 90,
  vsFpm: 0,
  fuelLb: 6000,
  ammo: { FLARE: 28 },
  rwrContacts: [{ id: 'sa-10', type: 'SAM', state: 'LOCK' }],
};

const QUIET = {
  onGround: false,
  kts: 320,
  altFt: 9000,
  aglFt: 8800,
  heading: 0,
  vsFpm: 0,
  fuelLb: 6000,
  ammo: { FLARE: 30 },
  rwrContacts: [],
};

// ===========================================================================
// Part A — decision engine
// ===========================================================================

group('A1. missile launch defense');

{
  let clock = 1_000_000;
  const client = new FakeClient();
  const cop = new WSOCopilot(client, { now: () => clock });

  const first = await cop.evaluateTelemetry(LAUNCH);
  const flare = findAction(first, 'combat_action');
  const radio = findAction(first, 'send_radio');
  ok(flare && flare.args.action === 'deploy_flares', 'SAM launch deploys flares');
  ok(radio && /SAM LAUNCH/i.test(radio.args.text), 'SAM launch sends the urgent radio callout', radio && radio.args.text);
  ok(radio && radio.args.priority === 'urgent', 'launch callout uses urgent priority');
  ok(radio && radio.args.sender === 'WSO', 'launch callout is sent as WSO');
  ok(client.calls.length === first.length && first.length === 2, 'both launch actions hit the client', String(client.calls.length));
  ok(cop.stats.flaresDeployed === 1 && cop.stats.radioSent === 1, 'stats count the launch response',
    JSON.stringify(cop.stats));

  clock += 500;
  const repeat = await cop.evaluateTelemetry(LAUNCH);
  ok(repeat.length === 0, 'immediate repeat tick is flare-cooldown suppressed', String(repeat.length));

  clock += 3500;
  const later = await cop.evaluateTelemetry(LAUNCH);
  ok(later.length === 2 && !!findAction(later, 'combat_action'), 'flare defense resumes after the cooldown');
  ok(cop.stats.flaresDeployed === 2, 'stats track the second deployment', String(cop.stats.flaresDeployed));

  const empty = await cop.evaluateTelemetry({ ...LAUNCH, ammo: { FLARE: 0 } });
  ok(empty.length === 0, 'no flares fired with an empty flare bucket');
}

group('A2. radar lock warning + dedupe');

{
  let clock = 2_000_000;
  const client = new FakeClient();
  const cop = new WSOCopilot(client, { now: () => clock });

  const first = await cop.evaluateTelemetry(LOCK);
  const radio = findAction(first, 'send_radio');
  ok(first.length === 1 && !!radio, 'LOCK produces a single radio callout', JSON.stringify(toolsOf(first)));
  ok(radio && /SPIKE/i.test(radio.args.text) && radio.args.priority === 'warn', 'LOCK callout is a warn SPIKE',
    radio && radio.args.text);
  ok(!findAction(first, 'combat_action'), 'LOCK alone does not dump flares');

  clock += 1000;
  ok((await cop.evaluateTelemetry(LOCK)).length === 0, 'LOCK callout is deduplicated inside radioCooldownMs');

  clock += 6000;
  ok((await cop.evaluateTelemetry(LOCK)).length === 1, 'LOCK callout repeats after the radio cooldown');
}

group('A3. terrain pull-up');

{
  let clock = 3_000_000;
  const client = new FakeClient();
  const cop = new WSOCopilot(client, { now: () => clock });
  const low = { ...QUIET, aglFt: 250, vsFpm: -1200, altFt: 600 };

  const first = await cop.evaluateTelemetry(low);
  const radio = findAction(first, 'send_radio');
  ok(first.length === 1 && !!radio, 'low terrain issues one callout', JSON.stringify(toolsOf(first)));
  ok(radio && /PULL UP/i.test(radio.args.text) && radio.args.priority === 'urgent', 'pull-up callout is urgent',
    radio && radio.args.text);

  clock += 1000;
  ok((await cop.evaluateTelemetry(low)).length === 0, 'pull-up callout is deduplicated');

  clock += 6000;
  ok((await cop.evaluateTelemetry(low)).length === 1, 'pull-up callout repeats after the cooldown');

  clock += 20000;
  ok((await cop.evaluateTelemetry({ ...low, onGround: true })).length === 0, 'no pull-up on the ground');
  ok((await cop.evaluateTelemetry({ ...low, aglFt: 400 })).length === 0, 'no pull-up above 350 ft AGL');
  ok((await cop.evaluateTelemetry({ ...low, vsFpm: -400 })).length === 0, 'no pull-up in level descent');
}

group('A4. bingo fuel latch');

{
  let clock = 4_000_000;
  const client = new FakeClient();
  const cop = new WSOCopilot(client, { now: () => clock });

  const first = await cop.evaluateTelemetry({ ...QUIET, fuelLb: 1750 });
  const radio = findAction(first, 'send_radio');
  ok(first.length === 1 && !!radio, 'bingo fuel issues one callout', JSON.stringify(toolsOf(first)));
  ok(radio && /BINGO FUEL/i.test(radio.args.text) && radio.args.priority === 'warn', 'bingo callout is a warn',
    radio && radio.args.text);
  ok(cop._bingoCalled === true, 'bingo is latched');

  clock += 30000;
  ok((await cop.evaluateTelemetry({ ...QUIET, fuelLb: 1200 })).length === 0, 'bingo never repeats once latched');
  ok(client.calls.length === 1, 'client saw exactly one bingo call', String(client.calls.length));
}

group('A5. scenario automation');

{
  let clock = 5_000_000;
  const client = new FakeClient();
  const cruise = new WSOCopilot(client, { scenario: 'cruise', now: () => clock });
  const airborne = { ...QUIET, kts: 250, autopilot: 'OFF', altFt: 12000, heading: 90 };

  const engaged = await cruise.evaluateTelemetry(airborne);
  const ap = findAction(engaged, 'set_flight_state');
  ok(!!ap, 'cruise engages the autopilot when airborne and AP is OFF', JSON.stringify(toolsOf(engaged)));
  ok(ap && ap.args.autopilot === 'ALT_HDG', 'cruise selects ALT_HDG');
  ok(ap && ap.args.altitudeFt === 12000 && ap.args.heading === 90, 'cruise keeps altitude and heading',
    ap && JSON.stringify(ap.args));
  ok(cruise.stats.autopilotUpdates === 1, 'autopilot update is counted');

  clock += 5000;
  ok((await cruise.evaluateTelemetry(airborne)).length === 0, 'cruise engages only once');

  const cruiseLow = new WSOCopilot(new FakeClient(), { scenario: 'cruise', now: () => clock });
  const lowEngage = await cruiseLow.evaluateTelemetry({ ...airborne, altFt: 3200 });
  const lowAp = findAction(lowEngage, 'set_flight_state');
  ok(lowAp && lowAp.args.altitudeFt === 5000, 'cruise floors the target altitude at 5000 ft', lowAp && JSON.stringify(lowAp.args));

  const cruiseOff = new WSOCopilot(new FakeClient(), { scenario: 'cruise', now: () => clock });
  ok((await cruiseOff.evaluateTelemetry({ ...airborne, autopilot: 'ALT_HDG' })).length === 0,
    'cruise never overrides a live autopilot');
  const cruiseGround = new WSOCopilot(new FakeClient(), { scenario: 'cruise', now: () => clock });
  ok((await cruiseGround.evaluateTelemetry({ ...airborne, onGround: true })).length === 0,
    'cruise does not engage on the ground');
  const cruiseSlow = new WSOCopilot(new FakeClient(), { scenario: 'cruise', now: () => clock });
  ok((await cruiseSlow.evaluateTelemetry({ ...airborne, kts: 150 })).length === 0,
    'cruise does not engage below 180 kts');

  const evade = new WSOCopilot(new FakeClient(), { scenario: 'evade', now: () => clock });
  const breakTurn = await evade.evaluateTelemetry(LAUNCH);
  const controls = findAction(breakTurn, 'set_controls');
  ok(!!controls, 'evade breaks on SAM launch', JSON.stringify(toolsOf(breakTurn)));
  ok(controls && controls.args.roll === 0.85 && controls.args.pitch === 0.6 && controls.args.durationMs === 1200,
    'evade pulse is the defensive break', controls && JSON.stringify(controls.args));

  const evadeLock = new WSOCopilot(new FakeClient(), { scenario: 'evade', now: () => clock });
  ok(!!findAction(await evadeLock.evaluateTelemetry(LOCK), 'set_controls'), 'evade also breaks on a radar lock');

  const patrol = new WSOCopilot(new FakeClient(), { scenario: 'patrol', now: () => clock });
  const patrolActions = await patrol.evaluateTelemetry(QUIET);
  ok(patrolActions.length === 0, 'patrol leaves the pilot stick and autopilot alone',
    JSON.stringify(toolsOf(patrolActions)));
}

group('A6. tick plumbing + stats shape');

{
  const client = new FakeClient(() => LAUNCH);
  const cop = new WSOCopilot(client, { pollMs: 1000 });
  ok(cop.running === false, 'copilot starts stopped');
  const actions = await cop.tick();
  ok(cop.stats.ticks === 1, 'tick counts polls');
  ok(cop.stats.flaresDeployed === 1 && cop.stats.radioSent === 1, 'tick dispatched the launch actions');
  ok(actions.length === 2, 'tick returns the actions it took', String(actions.length));
  ok(client.calls[0].name === 'get_telemetry', 'tick polls get_telemetry first');
  ok(JSON.stringify(client.calls[0].args) === JSON.stringify({ fresh: false }), 'tick asks for a cached snapshot');

  const wanted = ['ticks', 'flaresDeployed', 'radioSent', 'autopilotUpdates', 'errors'];
  ok(wanted.every((k) => typeof cop.stats[k] === 'number'), 'stats expose every contract counter',
    JSON.stringify(cop.stats));

  const wrapped = new FakeClient(() => ({ ok: true, telemetry: LAUNCH }));
  const wrappedCop = new WSOCopilot(wrapped, {});
  ok((await wrappedCop.tick()).length === 2, 'tick unwraps { telemetry } results');

  const offlineClient = new FakeClient(() => ({ ok: false, error: { code: 'BRIDGE_OFFLINE', message: 'no browser' } }));
  const offlineCop = new WSOCopilot(offlineClient, {});
  ok((await offlineCop.tick()).length === 0 && offlineCop.offline === true, 'BRIDGE_OFFLINE is skipped gracefully');
  ok(offlineCop.stats.errors === 0, 'offline is not counted as an engine error');

  const brokenClient = new FakeClient(() => {
    throw new Error('socket exploded');
  });
  const brokenCop = new WSOCopilot(brokenClient, {});
  const broken = await brokenCop.tick();
  ok(broken.length === 0 && brokenCop.stats.errors === 1, 'throwing clients are absorbed into stats.errors');

  const emptyCop = new WSOCopilot(new FakeClient(), {});
  ok((await emptyCop.evaluateTelemetry(null)).length === 0, 'null telemetry evaluates to no actions');

  let threw = null;
  try {
    new WSOCopilot({});
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof TypeError, 'constructor rejects a client without callTool');
}

group('A7. non-overlapping poll loop');

{
  const client = new FakeClient(() => QUIET);
  const cop = new WSOCopilot(client, { pollMs: 20 });
  cop.start();
  ok(cop.running === true, 'start() flips running');
  await delay(120);
  const ticks = cop.stats.ticks;
  ok(ticks >= 2, 'start() polls repeatedly', String(ticks));
  cop.stop();
  ok(cop.running === false, 'stop() flips running back');
  await delay(80);
  ok(cop.stats.ticks === ticks, 'stop() halts the poll loop', String(cop.stats.ticks));
}

group('A8. evaluation budget');

{
  let clock = 6_000_000;
  const cop = new WSOCopilot(new FakeClient(), { now: () => clock });
  const started = performance.now();
  const rounds = 200;
  for (let i = 0; i < rounds; i++) {
    clock += 20000;
    await cop.evaluateTelemetry(QUIET);
  }
  const avg = (performance.now() - started) / rounds;
  ok(avg < 2, 'evaluation averages under 2 ms', avg.toFixed(3) + ' ms');
}

group('A9. live bridge telemetry shapes');

{
  // buildTelemetry() emits ammo as { selected, rounds } and autopilot as
  // { mode }, while the flat/replay shape uses ammo.FLARE and a string.
  const liveLaunch = {
    ...LAUNCH,
    ammo: { selected: 'FLARE', rounds: { FLARE: 12, GUN: 510 } },
    autopilot: { mode: 'OFF', altitudeFt: null, headingDeg: null },
  };

  let clock = 7_000_000;
  const client = new FakeClient();
  const cop = new WSOCopilot(client, { now: () => clock });
  const first = await cop.evaluateTelemetry(liveLaunch);
  ok(!!findAction(first, 'combat_action'), 'nested ammo.rounds.FLARE deploys flares',
    JSON.stringify(toolsOf(first)));
  ok(!!findAction(first, 'send_radio'), 'nested-shape launch still sends the callout');

  const emptyLive = new WSOCopilot(new FakeClient(), { now: () => clock });
  const noFlares = await emptyLive.evaluateTelemetry({
    ...liveLaunch,
    ammo: { selected: 'FLARE', rounds: { FLARE: 0 } },
  });
  ok(!findAction(noFlares, 'combat_action'), 'nested empty flare bucket blocks deployment',
    JSON.stringify(toolsOf(noFlares)));

  const cruise = new WSOCopilot(new FakeClient(), { scenario: 'cruise', now: () => clock });
  const engaged = await cruise.evaluateTelemetry({
    ...QUIET,
    kts: 250,
    altFt: 12000,
    heading: 90,
    autopilot: { mode: 'OFF' },
  });
  ok(!!findAction(engaged, 'set_flight_state'), 'object autopilot { mode: OFF } allows cruise engage',
    JSON.stringify(toolsOf(engaged)));

  const cruiseLive = new WSOCopilot(new FakeClient(), { scenario: 'cruise', now: () => clock });
  ok((await cruiseLive.evaluateTelemetry({ ...QUIET, kts: 250, autopilot: { mode: 'ALT_HDG' } })).length === 0,
    'object autopilot { mode: ALT_HDG } blocks cruise');

  // Flat shapes keep working alongside the nested ones.
  const flat = new WSOCopilot(new FakeClient(), { now: () => clock });
  ok(!!findAction(await flat.evaluateTelemetry(LAUNCH), 'combat_action'), 'flat ammo.FLARE still deploys');
  const cruiseFlat = new WSOCopilot(new FakeClient(), { scenario: 'cruise', now: () => clock });
  ok(!!findAction(await cruiseFlat.evaluateTelemetry({ ...QUIET, kts: 250, autopilot: 'OFF' }), 'set_flight_state'),
    'flat string autopilot still engages cruise');
}

// ===========================================================================
// Part B — McpStdioClient over an injectable in-process transport
// ===========================================================================

group('B1. injected transport handshake + tool parsing');

{
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  toServer.setEncoding('utf8');
  const received = [];
  let buffer = '';

  const reply = (id, result) =>
    fromServer.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const replyError = (id, code, message) =>
    fromServer.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');

  const handle = (msg) => {
    if (msg.id === undefined) return; // notification
    if (msg.method === 'initialize') {
      reply(msg.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '0.0.1' },
      });
      return;
    }
    if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name;
      if (name === 'get_telemetry') {
        reply(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({ kts: 321, altFt: 12000 }) }],
          isError: false,
        });
        return;
      }
      if (name === 'send_radio') {
        const payload = { ok: false, error: { code: 'BRIDGE_OFFLINE', message: 'no browser client' } };
        reply(msg.id, {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: true,
        });
        return;
      }
      replyError(msg.id, -32602, 'Unknown tool: ' + name);
      return;
    }
    replyError(msg.id, -32601, 'Method not found: ' + msg.method);
  };

  toServer.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      received.push(msg);
      handle(msg);
    }
  });

  const client = new McpStdioClient({ stdin: toServer, stdout: fromServer, timeoutMs: 2000 });
  ok(client.child === null, 'injected transport does not spawn a child');

  const init = await client.connect();
  ok(init && init.serverInfo && init.serverInfo.name === 'fake-mcp', 'injected initialize returns serverInfo');
  ok(client.connected === true, 'connect() marks the client connected');
  ok(received[0] && received[0].method === 'initialize', 'initialize is the first message');
  ok(received[0] && received[0].jsonrpc === '2.0', 'requests are JSON-RPC 2.0');
  const note = received.find((m) => m.method === 'notifications/initialized');
  ok(!!note && note.id === undefined, 'initialized notification is sent without an id');

  const telemetry = await client.callTool('get_telemetry', { fresh: false });
  ok(telemetry && telemetry.kts === 321 && telemetry.altFt === 12000,
    'client parses JSON text content into an object');

  const toolError = await client.callTool('send_radio', { text: 'hello' });
  ok(toolError && toolError.ok === false, 'tool errors return ok:false');
  ok(toolError && toolError.error && toolError.error.code === 'BRIDGE_OFFLINE', 'tool error code is preserved');

  let rpcError = null;
  try {
    await client.callTool('does_not_exist', {});
  } catch (err) {
    rpcError = err;
  }
  ok(!!rpcError && rpcError.code === -32602, 'JSON-RPC errors throw', rpcError && String(rpcError.message));

  await client.close();
  ok(client.connected === false, 'close() marks the client disconnected');

  let afterClose = null;
  try {
    await client.callTool('get_telemetry', {});
  } catch (err) {
    afterClose = err;
  }
  ok(!!afterClose, 'calls after close() reject');
}

// ===========================================================================
// Part C — live stdio handshake against mcp/server.mjs (ephemeral port)
// ===========================================================================

group('C1. live MCP server handshake');

let liveClient = null;
try {
  liveClient = new McpStdioClient({
    command: process.execPath,
    args: [SERVER, '--port', '0', '--quiet'],
    cwd: ROOT,
    env: { ...process.env, MCP_BRIDGE_PORT: '0' },
    timeoutMs: 15000,
  });

  const init = await liveClient.connect();
  ok(!!init && !!init.serverInfo, 'live server answers initialize');
  ok(init.serverInfo.name === 'falcon-infinite', 'live server identifies itself', init.serverInfo && init.serverInfo.name);
  ok(init.capabilities && !!init.capabilities.tools, 'live server advertises tools');
  ok(typeof init.instructions === 'string' && init.instructions.length > 20, 'live server supplies instructions');

  const snapshot = await liveClient.callTool('get_telemetry', { fresh: false });
  ok(snapshot && snapshot.ok === false, 'offline telemetry reports ok:false', JSON.stringify(snapshot));
  ok(snapshot && snapshot.error && snapshot.error.code === 'BRIDGE_OFFLINE',
    'offline telemetry reports BRIDGE_OFFLINE', snapshot && snapshot.error && snapshot.error.code);

  const copilot = new WSOCopilot(liveClient, { pollMs: 1000 });
  const actions = await copilot.tick();
  ok(Array.isArray(actions) && actions.length === 0, 'copilot tick survives a bridgeless server');
  ok(copilot.offline === true && copilot.stats.ticks === 1, 'copilot marks the bridge offline');
} catch (err) {
  ok(false, 'live MCP handshake completes', err && err.stack ? err.stack : String(err));
} finally {
  if (liveClient) {
    await liveClient.close();
    ok(liveClient.child === null, 'close() reaps the spawned server');
  }
}

// ===========================================================================
// Summary
// ===========================================================================

if (failures.length) {
  console.error('\n' + failures.length + ' of ' + checks + ' WSO CHECKS FAILED');
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}

console.log('ALL WSO CHECKS PASSED');
console.log('  ' + checks + ' checks');
process.exit(0);