# Feature 11 — Local MCP Server & Live Game Control Bridge

## Why This Makes Sense
Exposing **FALCON / INFINITE** through a local **Model Context Protocol (MCP)** server lets any AI agent (Antigravity, Hermes, Pi, etc.) act as a live **AI Co-Pilot / WSO / AWACS / Flight Test Engineer** — reading real-time telemetry, flying maneuvers, switching weather/wind/missions/theaters, firing weapons, teleporting to test scenarios, and capturing live canvas screenshots.

## Architecture (Zero-Friction Local Bridge)
```
[MCP Client (AGY / Hermes / Pi)]
        │  stdio (JSON-RPC 2.0 MCP)
        ▼
[mcp/server.mjs]  <── HTTP/SSE or localhost bridge (127.0.0.1:5179) ──>  [Browser: src/core/mcp_bridge.js]
                                                                                  │
                                                                          window.__falcon
```

- **Localhost only (`127.0.0.1`)**, disabled in production builds unless enabled via `?mcp=1` or Vite dev mode.
- Uses **zero external npm dependencies** (pure Node `http` + JSON-RPC 2.0 MCP over `stdin`/`stdout`, with simple long-poll or SSE command queue + POST telemetry/results so no extra WebSocket package is needed!).

## File Ownership (STRICT)
Create ONLY:
- `mcp/server.mjs` — Executable Node stdio MCP server + built-in `127.0.0.1:5179` HTTP bridge for the browser game client.
- `src/core/mcp_bridge.js` — Lightweight browser-side bridge client (polls commands from `127.0.0.1:5179`, executes actions against `app` / `window.__falcon`, posts telemetry snapshots & optional canvas screenshots back).
- `tests/mcp_test.mjs` — Headless end-to-end test booting `mcp/server.mjs`, verifying MCP `initialize`, `tools/list`, and round-trip `tools/call` against a simulated browser client.

## MCP Tools Exposed
1. **`get_telemetry`** — Returns live aircraft state (`kts`, `mach`, `altFt`, `aglFt`, `heading`, `pitch`, `roll`, `throttle`, `afterburner`, `g`, `aoa`, `fuelLb`, `windDir`, `windKts`, `mode`, `mission`, `targets`, `rwrContacts`, `ammo`, `fps`).
2. **`set_flight_state`** — Set throttle, autopilot mode (`OFF`/`ALT_HDG`/`ATT`), target altitude/heading, gear, flaps, brakes, or `teleport` (`x, y, z, heading, speedMs`) for instant test scenarios.
3. **`set_controls`** — Apply timed virtual stick/rudder/throttle pulse (`pitch`, `roll`, `yaw`, `throttleDelta`, `durationMs`).
4. **`combat_action`** — Select weapon (`GUN`/`AIM9`/`MK82`), fire burst, deploy flares, toggle NVG, or trigger ejection.
5. **`set_environment`** — Switch `weather` (`clear`..`storm`), `wind` (`auto`..`gale`), `theater` (`temperate`..`desert`), `hour` (`0..24`), `timeScale`, or `camera` (`cockpit`/`chase`/`wing`/`orbit`).
6. **`start_mission`** — Start/reset a sortie (`free`, `sead`, `strike`, `cap`) or respawn at runway.
7. **`send_radio`** — Inject a custom AWACS / ATC tactical radio callout (`sender`, `text`, `priority`) directly onto the pilot's HUD!
8. **`capture_screenshot`** — Captures a composite PNG (WebGL scene + 2D HUD) from the browser and returns it as MCP image content for visual inspection.

## Verification (`tests/mcp_test.mjs`)
- Spawns `mcp/server.mjs` over stdio, sends MCP `initialize` + `tools/list`, connects a mock browser client to the local bridge, invokes `get_telemetry`, `set_environment`, and `send_radio` via `tools/call`, and asserts exact round-trip JSON responses and clean shutdown.
