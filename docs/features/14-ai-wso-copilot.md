# Feature 14 — Ultra-Fast AI WSO / Co-Pilot over MCP

## Goal
Build a lightweight, zero-dependency Node.js AI WSO (Weapon Systems Officer) / Co-Pilot runner that connects to the existing local MCP server (`mcp/server.mjs`) over stdio JSON-RPC 2.0, continuously reads `get_telemetry`, and provides real-time tactical assistance:
- Automatic countermeasure flare deployment + urgent radio warning on SAM missile launch.
- Deduplicated tactical threat callouts (SAM lock / bandit contact) via `send_radio`.
- Fuel (bingo), terrain (pull-up), and stall advisories via `send_radio`.
- Automated flight-test / autopilot scenario modes (`patrol`, `cruise`, `evade`).
- Optional non-blocking LLM tactical advisor hook when `WSO_LLM_URL` and `WSO_LLM_KEY` are provided.

## File Ownership (STRICT)
Create ONLY:
- `mcp/wso_copilot.mjs`
- `tests/wso_test.mjs`

Do NOT modify any existing files.

## Module Contract (`mcp/wso_copilot.mjs`)
Zero npm dependencies (use only `node:child_process`, `node:process`, `node:url`, `fetch`).

### 1. `McpStdioClient` (exported)
Minimal JSON-RPC 2.0 stdio client that spawns `node mcp/server.mjs` (or accepts injectable `stdin`/`stdout` streams for testing):
- `new McpStdioClient({ command, args, cwd, env, timeoutMs })`
- `async connect()` — spawns server, sends `initialize`, sends `notifications/initialized`.
- `async callTool(name, args = {})` — sends `tools/call`, parses `structuredContent` or JSON text content, throws on RPC error or returns `{ ok: false, error }` on tool error.
- `async close()` — terminates child cleanly.

### 2. `WSOCopilot` (exported)
Pure decision & control engine usable with any client exposing `callTool(name, args)`:
- `new WSOCopilot(client, options = {})`
  - `options`: `{ pollMs = 250, scenario = 'patrol', flareCooldownMs = 3500, radioCooldownMs = 6000, llmUrl = '', llmKey = '', llmModel = 'gemini-2.5-flash-lite', now = () => Date.now() }`
- State:
  - `this.running = false`
  - `this.stats = { ticks: 0, flaresDeployed: 0, radioSent: 0, autopilotUpdates: 0, errors: 0 }`
- Methods:
  - `async evaluateTelemetry(telemetry)` — deterministic, fast (`< 2 ms`) tactical evaluation of a telemetry snapshot (from `get_telemetry`). Returns an array of actions taken (`[{ tool, args }]`):
    1. **Missile Launch Defense**: if `telemetry.rwrContacts` contains an entry with `isMissile === true` or `state === 'LAUNCH'`:
       - If flare cooldown elapsed AND `(telemetry.ammo?.FLARE ?? 1) > 0`: call `combat_action({ action: 'deploy_flares' })` and `send_radio({ sender: 'WSO', text: 'SAM LAUNCH! FLARES OUT — BREAK HARD!', priority: 'urgent' })`.
    2. **Radar Lock / Bandit Warning**: if `rwrContacts` has `state === 'LOCK'` (and not on launch cooldown), call `send_radio({ sender: 'WSO', text: 'SPIKE! RADAR LOCK — PREPARE COUNTERMEASURES', priority: 'warn' })` (deduplicated by `radioCooldownMs`).
    3. **Terrain Pull-Up Alert**: if `!telemetry.onGround && telemetry.aglFt < 350 && telemetry.vsFpm < -700`, call `send_radio({ sender: 'WSO', text: 'LOW TERRAIN — PULL UP!', priority: 'urgent' })` (deduplicated).
    4. **Bingo Fuel Alert**: if `Number.isFinite(telemetry.fuelLb) && telemetry.fuelLb <= 1800 && !this._bingoCalled`, call `send_radio({ sender: 'WSO', text: 'BINGO FUEL — RTB OR HIT TANKER', priority: 'warn' })` and latch `_bingoCalled = true`.
    5. **Scenario Automation**:
       - `'cruise'`: if airborne (`!telemetry.onGround && telemetry.kts > 180`) and `telemetry.autopilot === 'OFF'`, engages `set_flight_state({ autopilot: 'ALT_HDG', altitudeFt: Math.max(5000, Math.round(telemetry.altFt || 8000)), heading: Math.round(telemetry.heading || 0) })` once.
       - `'evade'`: on `LAUNCH` or `LOCK`, pulses a defensive break turn via `set_controls({ roll: 0.85, pitch: 0.6, durationMs: 1200 })`.
       - `'patrol'`: default WSO advisory + auto-flare mode (does not override pilot stick).
  - `async tick()` — calls `client.callTool('get_telemetry', { fresh: false })`, passes result to `evaluateTelemetry(t)` if valid and not offline.
  - `start()` / `stop()` — non-overlapping `setTimeout` poll loop.

### 3. CLI Entrypoint
When invoked directly (`import.meta.url === pathToFileURL(process.argv[1]).href`):
- Parses `--scenario <patrol|cruise|evade>`, `--port <5179>`, `--poll-ms <250>`.
- Spawns `McpStdioClient` pointing to `mcp/server.mjs` with `FALCON_MCP_PORT`, starts `WSOCopilot`, logs concise status lines to stderr, handles `SIGINT`/`SIGTERM` cleanly.

## Verification (`tests/wso_test.mjs`)
Standalone headless Node test verifying:
1. Missile launch in `rwrContacts` triggers `deploy_flares` + urgent `send_radio`, and respects `flareCooldownMs` on immediate repeat ticks.
2. Radar `LOCK` triggers warning radio callout with deduplication.
3. Low terrain (`aglFt: 250, vsFpm: -1200`) triggers urgent `PULL UP` radio callout.
4. Bingo fuel (`fuelLb: 1750`) triggers `BINGO FUEL` once (latched).
5. `'cruise'` scenario engages `ALT_HDG` autopilot when airborne and AP is `OFF`; `'evade'` scenario issues `set_controls` break turn on SAM launch.
6. Live `McpStdioClient` handshake (`connect`, `tools/call` on `get_telemetry` returning `BRIDGE_OFFLINE` gracefully, `close`) against real `mcp/server.mjs` on an ephemeral port (`0`).
7. Exits with code `0` and prints `ALL WSO CHECKS PASSED`.
