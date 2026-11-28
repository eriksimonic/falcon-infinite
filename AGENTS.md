# Agent & Subagent Guidelines — Falcon Infinite

This repository is developed with a primary orchestrator agent plus cheap, fast implementation subagents run through the local **Hermes CLI**. Follow these rules in every session.

## 1. Subagent Delegation (Mandatory)

- **Do NOT spawn built-in IDE / Antigravity subagents** (`invoke_subagent`) for code implementation, refactoring, or repetitive edits. They burn through the primary model's usage quota rapidly.
- **Always delegate implementation subtasks to `hermes`** running **DeepSeek 4.1 Flash** (`deepseek-v4.1-flash`), which is the default model for implementation work (latest, fast, and cheapest).
- Keep the primary agent focused on diagnosis, architecture, reviewing diffs, and final verification.

### Standard Hermes Invocation

Use `--query-file -` with a quoted heredoc so GLSL, quotes, and shell metacharacters are passed verbatim:

```bash
hermes chat --oneshot --yolo \
  --provider alibaba-coding-plan \
  -m deepseek-v4.1-flash \
  --in /home/erik/Desktop/falcon-infinite \
  --query-file - <<'EOF'
<clear, scoped task prompt naming exact files, invariants, and verification command>
EOF
```

- **Default model**: `deepseek-v4.1-flash`
- **Default provider**: `alibaba-coding-plan`
- Scope each Hermes task to a narrow set of files and require it to verify its own changes (e.g. relevant `node tests/...` suite + `npm run build`) before finishing.
- After Hermes completes, inspect `git diff` and run full verification (`npm test && npm run build`) from the primary agent before reporting back.

## 2. Project Verification & Invariants

- **Full test + build gate**: `npm test && npm run build` (must pass with 0 failures across all test suites and a clean Vite production bundle).
- **Headless Node compatibility**: Modules under `src/world/`, `src/sim/`, and `src/aircraft/` are imported directly in Node tests without a browser DOM or WebGL context. Guard any `window`, `document`, `camera`, or `renderer` access carefully.
- **Shader & scene contracts checked by tests**:
  - `tests/living_vipava_test.mjs` asserts specific window-lighting substrings inside `BuildingSystem.material.fragmentShader`.
  - `tests/roadnet_test.mjs` asserts `RoadNetwork` adds a single root mesh (`net.mesh`) to the scene (attach auxiliary geometry such as bridge piers as children of `net.mesh`).
  - `tests/cities_destruction_test.mjs` tests the fallback runway clear zone when `getCustomAirports()` returns `null`.
  - Custom `ShaderMaterial`s in `src/world/` must include `#include <fog_fragment>`, `#include <tonemapping_fragment>`, and `#include <colorspace_fragment>` so colors match the ACESFilmic sRGB pipeline.
