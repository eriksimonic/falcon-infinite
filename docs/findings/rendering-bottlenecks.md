# Rendering and frame-time bottlenecks: Falcon Infinite

Audit date: 2026-11-28. Three.js r187 (`node_modules/three/package.json`). Scope: one read-only pass over `src/`. No source or test file was changed.

Every finding below cites lines that were read in this pass. Costs are counted from the code and from the live scene-graph telemetry. No frame times were profiled, so every FPS or millisecond figure in this document is an estimate and is labelled as one.

---

## 1. Executive summary

### Top 5 bottlenecks

1. **PERF-01 + PERF-02 + PERF-05: the forest dominates both GPU passes.** The broadleaf canopy is 4,387,200 of 5,823,687 scene triangles (75 %) and 4,387,200 of 5,166,008 shadow triangles (85 %). All 13,710 crowns within 6.8 km go through the shadow pass, but the shadow camera covers only ±1,400 m (`src/sim/sky.js:47-51`). Each crown also has 960 unshared vertices, because the merged lobes are non-indexed (`src/world/vegetation.js:35-68`). The fix is to index the canopy, use a low-poly crown beyond 2.4 km, and let only the near crowns cast shadows. It removes about 96 % of broadleaf vertex shader invocations across both passes (26.3 M to about 1.2 M per frame) and about 78 % of shadow triangles.
2. **PERF-04: two unneeded multisampled buffers.** EffectComposer clones the 4x MSAA HalfFloat target, so the OutputPass target is also 4x MSAA (`EffectComposer.js:80`). The canvas is also created with `antialias: true` (`src/main.js:87`), although only the FXAA quad is drawn to it. At 2592x1265 this is about 260 MB of VRAM and about 350 MB of extra write and resolve traffic per frame.
3. **PERF-03: a building collapse rebuilds the whole city every frame.** While any building collapses, `update()` sets `_needsRebuild = true` every frame (`src/world/buildings.js:1141-1149`). Each collapse lasts 2.4 to 3.8 s (`buildings.js:25-26`). Every frame of it re-streams up to 26,000 buildings and uploads about 7.8 MB of instance matrices. This is the main combat stutter.
4. **PERF-06 + PERF-07 + PERF-10: streaming spikes.** Each building rebuild (every 250 m of travel, about once per second at 250 m/s) uploads full pools of about 7.8 MB. Each vegetation rebuild (every 360 m) uploads about 3.2 MB and calls `terrainHeight` at least 18,000 times. Terrain builds up to 6 or 10 tiles per frame by count, not by time. On High that is up to 51,000 `terrainHeight` calls in one frame.
5. **PERF-08 + PERF-09: terrain fragment shader waste.** Inside the satellite coverage, the terrain shader computes the full procedural albedo (rock strata, field parcels, vineyard rows) and then replaces it with the ortho colour (`src/world/terrainview.js:300-330`). Every lit material also loops over 3 PointLights and 1 SpotLight that contribute nothing outside the cockpit.

### Estimated combined gain (unmeasured)

- **GPU, after wave 1:** main-pass triangles drop from 5.82 M to about 2.6 M (about -55 %), shadow-pass triangles from 5.17 M to about 1.2 M (about -78 %), and about 350 MB per frame of MSAA traffic goes away. If the frame is GPU-bound on geometry, as the triangle counts suggest, expect a 30 to 50 % shorter GPU frame on High. This is an estimate, not a measurement.
- **CPU:** collapse stutter falls from 144 to 228 consecutive full rebuilds to 2 rebuilds per collapse. Streaming upload spikes shrink to the live instance count. Terrain tile builds get a hard time budget per frame.

### All findings

| ID | Priority | Category | Subsystem | Primary files | Est. impact | Risk | Packet |
|---|---|---|---|---|---|---|---|
| PERF-01 | P0 | GPU Shadow Pass | Vegetation | `src/world/vegetation.js` | Shadow tris 5.17 M to about 1.2 M | Low | PKT-01 |
| PERF-02 | P0 | GPU Vertex | Vegetation | `src/world/vegetation.js` | Canopy verts per tree 960 to 168, lossless | Low | PKT-01 |
| PERF-03 | P0 | Streaming Stutter | Buildings | `src/world/buildings.js` | 144 to 228 full rebuilds per collapse to 2 | Medium | PKT-03 |
| PERF-04 | P0 | GPU Memory Bandwidth | PostFX | `src/sim/postfx.js`, `src/main.js` | About 260 MB VRAM, about 350 MB/frame traffic | Low | PKT-02 |
| PERF-05 | P1 | GPU Vertex | Vegetation | `src/world/vegetation.js` | Broadleaf main tris 4.39 M to about 1.5 M | Low | PKT-01 |
| PERF-06 | P1 | Streaming Stutter | Buildings, vegetation | `buildings.js`, `vegetation.js` | Upload per rebuild 7.8 MB + 3.2 MB to live prefix | Low | PKT-01, PKT-03 |
| PERF-07 | P1 | Streaming Stutter | Terrain | `src/world/terrainview.js` | Up to 51 k height samples per frame to a 4 ms budget | Medium | PKT-05 |
| PERF-08 | P1 | GPU Fragment & Fillrate | Terrain shader | `src/world/terrainview.js` | Skips about 40 % of albedo ALU under ortho | Medium | PKT-10 |
| PERF-09 | P1 | GPU Fragment & Fillrate | Lights, cockpit | `cockpit.js`, `aircraft.js`, `vfx.js` | 4 dead light loops per lit pixel | Low | PKT-06 |
| PERF-10 | P1 | Streaming Stutter | Vegetation | `src/world/vegetation.js` | 18 k+ height samples per rebuild to new cells only | Medium | PKT-11 |
| PERF-11 | P2 | GPU Shadow Pass | Buildings | `buildings.js`, `sky.js` | 586,904 shadow tris to about 10 % | Medium | PKT-04, PKT-09 |
| PERF-12 | P2 | GPU Shadow Pass | Sky, shadows | `src/sim/sky.js` | Whole shadow pass skipped above 4 km | Low | PKT-04 |
| PERF-13 | P2 | GPU Fragment & Fillrate | Building shader | `src/world/buildings.js` | About 9 hashes + 2 sin per facade pixel by day | Low | PKT-09 |
| PERF-14 | P2 | GPU Fragment & Fillrate | Sky dome | `src/sim/sky.js` | Sky shader only on visible sky pixels | Low | PKT-04 |
| PERF-15 | P2 | CPU Draw Calls | Landmarks | `src/world/landmarks.js` | About 460 PBR part meshes, all shadow casters | Medium | PKT-07 |
| PERF-16 | P2 | CPU Per-Frame JS & GC | Static scene | `landmarks.js`, `airports.js`, `carrier.js` | About 600 matrix recomposes per frame | Low | PKT-07 |
| PERF-17 | P2 | CPU Draw Calls | Airports | `src/world/airports.js` | One material per mesh, 22 transparent per airport | Low | PKT-07 |
| PERF-18 | P2 | CPU Per-Frame JS & GC | HUD | `src/ui/hud.js` | Full-screen 2D redraw at DPR up to 2 | Low | PKT-08 |
| PERF-19 | P2 | GPU Fragment & Fillrate | Renderer | `src/main.js` | Fixed DPR 1.35 is 1.82x the pixels of DPR 1 | Medium | PKT-12 |
| PERF-20 | P3 | CPU Per-Frame JS & GC | Sky | `src/sim/sky.js` | About 20 `THREE.Color` allocations per frame | Low | PKT-04 |
| PERF-21 | P3 | GPU Memory Bandwidth | Cockpit | `cockpit.js`, `aircraft.js` | 655 KB at 10 Hz in every view | Low | PKT-06 |
| PERF-22 | P3 | GPU Memory Bandwidth | VFX, traffic | `vfx.js`, `traffic.js` | Full-capacity buffer uploads per frame | Low | PKT-06 |
| PERF-23 | P3 | CPU Per-Frame JS & GC | Config, dead code | `main.js`, `config.js`, `terrainview.js` | Correctness and clarity | Low | PKT-02, PKT-05, PKT-12 |
| PERF-24 | P3 | GPU Fragment & Fillrate | Clouds | `src/sim/clouds.js` | Large alpha quads near the deck, not measured | Low | none (measure first) |

---

## 2. Measured baseline telemetry

Source: live scene graph on `http://127.0.0.1:5173`, High preset, day, Vipava Valley, in flight, 1920x937 CSS pixels.

### Frame setup

- Preset `high` (`src/config.js:89-104`): `pixelRatio` 1.35, `segmentsNear` 40, `segmentsFar` 20, `clouds` 340, `buildingRadius` 11,000, `buildingLimit` 26,000, `treeRadius` 6,800, `treeLimit` 18,000. The preset says `shadows: false`, but `src/main.js:99` enables shadows for every preset except `low`.
- Drawing buffer at DPR 1.35: 2592x1265 = 3,278,880 pixels. The renderer uses `min(devicePixelRatio, 1.35)` (`src/main.js:411-413`). On a DPR 1 display it is 1,799,040 pixels, and every fill-rate figure below scales by 0.55.
- PostFX: `EffectComposer` with a HalfFloat 4x MSAA target, then `RenderPass`, `UnrealBloomPass`, `OutputPass`, FXAA `ShaderPass` (`src/sim/postfx.js:142-168`).
- Shadows: sun `DirectionalLight`, 2048x2048, ortho box ±1,400 m, near 100, far 14,000 (`src/sim/sky.js:43-53`). `shadowMap.autoUpdate` is never set, so the map renders every frame. `PCFSoftShadowMap` (`src/main.js:100`) no longer exists in r187. `WebGLShadowMap.js:99-103` warns once and switches to `PCFShadowMap` (5 hardware PCF taps).
- `renderer.info.memory`: 334 geometries, 37 textures, 40 programs.

### Where the triangles are

| Mesh | Instances x tris | Triangles | Casts shadow | Source |
|---|---|---|---|---|
| Broadleaf canopy | 13,710 x 320 | 4,387,200 | yes | `vegetation.js:229, 239` |
| Trunks | 18,000 x 20 | 360,000 | no | `vegetation.js:228, 237` |
| Buildings (walls) | 20,977 x 12 | 251,724 | yes | `buildings.js:993-1001` |
| Plinths | 17,181 x 12 | 206,172 | yes | `buildings.js:1010-1015` |
| Conifer canopy | 4,290 x 42 | 180,180 | yes | `vegetation.js:230, 241` |
| Gable roofs | 14,254 x 8 | 114,032 | yes | `buildings.js:1021-1026` |
| Inland water | 1 mesh | 98,273 | no | `water.js:604` |
| Highways | 1 mesh | 89,064 | no | `roadnet.js:444-449` |
| Hip roofs | 2,496 x 6 | 14,976 | yes | `buildings.js:1030-1035` |
| Terrain tiles | N x up to 3,520 | rest | receive only | `terrainview.js:984-988` |

The shadow total reconciles: 4,387,200 + 180,180 + 251,724 + 206,172 + 114,032 + 14,976 = 5,154,284. The remaining 11,724 shadow triangles come from the F-16 and the landmarks. Vegetation and buildings are 99.8 % of the shadow pass.

All six vegetation and building `InstancedMesh` objects use `frustumCulled = false` (`vegetation.js:233`, `buildings.js:995, 1012, 1023, 1032`). Even with culling on, one bounding sphere spans the whole 6.8 to 28 km radius, so nothing would be culled. Every instance goes through the vertex shader in the main pass and again in the shadow pass.

### Where the 1,067 meshes and 567 shadow casters come from (estimates)

Counts are call sites multiplied by loop bounds. The airport and landmark lists were not counted at runtime, so the table does not reconcile exactly.

| Source | Individual meshes | castShadow | Transparent materials | Notes |
|---|---|---|---|---|
| Terrain tiles | one per tile, about 250 to 350 (not counted) | 0 (receive only) | 0 | `terrainview.js:984-988` |
| F-16 airframe | 110 to 120 | 80 to 100 | 5 to 6 | traverse at `f16.js:1095-1101` |
| Cockpit (always visible) | 45 to 50 | 0 | 2 | `aircraft.js:33-34`, no visibility toggle |
| VFX explosion pool | 84 (hidden until used) | 0 | 84 | `vfx.js:482-546` |
| Air traffic | 36 meshes + 8 lines | 0 | 8 | `traffic.js:191-258` |
| Carrier | 70 to 90 | 0 | 1 | `carrier.js:441-594` |
| Airports | 55 to 75 per airport | 0 | 22 per airport | `airports.js:140-392` |
| Landmarks | the remainder, about 460 casters | one per `_box`/`_cyl`/`_cone` | 1 to 3 per landmark | `landmarks.js:339-385` |

- About 460 of the 567 shadow casters are landmark parts. They keep the default `frustumCulled = true`, so the shadow camera culls them. Only landmarks within the ±1.4 km box cost shadow draws.
- 179 transparent objects: 84 explosion parts, 22 per airport, 8 trail lines, F-16 glass and glow, cockpit HUD glass and rain, clouds, rain, wind streaks, landmark glows and beacons.
- 7 lights: hemisphere, sun, moon (`sky.js:32-58`), 2 cockpit PointLights (`cockpit.js:665-670`), blast PointLight at intensity 0 (`vfx.js:302-304`), landing SpotLight at intensity 0 (`aircraft.js:61-66`).

### Checked and not a bottleneck

- **Ocean draw order.** `painterSortStable` sorts by `material.id` before depth (`WebGLRenderLists.js`). The terrain material (`terrainview.js:548`) is created before the ocean material (`terrainview.js:578`, `1056`), so the ocean draws after the terrain and early-Z rejects the covered pixels.
- **Terrain shadow casting.** Terrain tiles only receive shadows (`terrainview.js:987`). They add nothing to the shadow pass.
- **Air traffic.** 4 airliners (`traffic.js:12`) with small per-frame work.

### Getting real numbers

`renderer.info` resets on every composer pass, so the raw dump shows only the FXAA draw. To measure a whole frame, set `renderer.info.autoReset = false` once and call `renderer.info.reset()` at the start of `App.loop` (`src/main.js:2264`). Read `renderer.info.render.calls` and `.triangles` after `postfx.render`. Use the Chrome Performance panel with "GPU" enabled for GPU time, and compare the same flight path before and after each packet.

---

## 3. Detailed findings

### P0 critical

#### PERF-01: the whole forest goes through the shadow pass

- **Category:** GPU Shadow Pass.
- **Location:** `src/world/vegetation.js:228-242` (one InstancedMesh per species, `frustumCulled = false`, leaves and conifers `castShadow = true`), `src/world/vegetation.js:265-413` (rebuild fills one pool per species out to `treeRadius`), `src/sim/sky.js:43-53, 259-270` (shadow box ±1,400 m, re-centred on the camera every frame).
- **Root cause and cost:**
  - Trees fill a disc of radius 6,800 m, about 145 km². The shadow box covers 2,800 m x 2,800 m in light space. At 45° sun elevation its ground footprint is about 2.8 km x 4 km, about 11 km², or about 8 % of the disc.
  - Every frame the shadow pass still runs the vertex shader for all 13,710 broadleaf and 4,290 conifer instances: 13,710 x 960 + 4,290 x 93 = about 13.6 M vertex invocations. About 92 % of those triangles are then clipped by the shadow frustum.
  - The shadow map renders every frame (`autoUpdate` default true), so this cost repeats on every frame.
- **Recommended fix:**
  1. In `rebuild()`, split each canopy species into two InstancedMeshes: `leavesNear` and `conifersNear` for trees within `VEG_NEAR_R = 2400` m of the camera, and `leavesFar` and `conifersFar` for the rest.
  2. Set `castShadow = true` and `receiveShadow = true` on the near meshes only. Set `castShadow = false` on the far meshes.
  3. Keep the existing shuffled cell walk unchanged, so the tree distribution under `treeLimit` stays the same. Route each emitted tree to the near or far pool by its distance to the camera.
  4. The radius 2,400 m covers the box corner (1,980 m) plus most of the 360 m rebuild step. At low sun the footprint is longer than 2.4 km along the sun azimuth, so trees beyond 2.4 km lose their shadows. At that distance a 10 m tree shadow is 1 to 3 pixels.
  5. Size each pool to the current species cap, so a live quality switch still cannot overflow (`vegetation.js:206-216`).
- **Expected result:** broadleaf shadow triangles drop from 4.39 M to about 0.55 M (about 12.5 % of trees are near, assuming even density). This is the main part of the shadow-pass reduction.
- **Invariants:** `vegetation.js` must stay headless-safe (`scene` may be null or a stub, `vegetation.js:13-14`). `World.setTheater` hides `vegetation.group` (`world.js:68-72`), so all new meshes must be children of `this.group`. No current test imports `vegetation.js`. The packet adds `tests/vegetation_perf_test.mjs`.

#### PERF-02: canopy geometry has no vertex reuse

- **Category:** GPU Vertex.
- **Location:** `src/world/vegetation.js:35-68` (`mergeSimpleGeometries`), `95-117` (`makeBroadleafLobe`), `121-140` (`makeBroadleafCanopy`).
- **Root cause and cost:**
  - `IcosahedronGeometry` is a `PolyhedronGeometry`, which builds non-indexed geometry (`PolyhedronGeometry.js:60`). Detail 1 gives 80 triangles and 240 vertices per lobe, but only 42 unique positions.
  - `mergeSimpleGeometries` then writes a sequential index (`vegetation.js:55-57`), so the GPU post-transform cache never reuses a vertex.
  - Each broadleaf crown has 4 x 240 = 960 vertices where 4 x 42 = 168 are unique. 13,710 crowns x 960 = 13.16 M vertex invocations per pass, 26.3 M per frame across main and shadow passes.
  - Displacement and normals depend only on the vertex position (`vegetation.js:99-113`), and the AO colour depends only on `y` (`vegetation.js:71-91`). Welding the duplicates is lossless.
- **Recommended fix:** in `makeBroadleafCanopy()`, call `mergeVertices(geo)` from `three/examples/jsm/utils/BufferGeometryUtils.js` after `paintCanopyAO`, and use its return value. Alternatively, weld each lobe with `mergeVertices` before `mergeSimpleGeometries`. Do the same for the far LOD geometry from PERF-05. Leave the conifer geometry alone: `ConeGeometry` is already indexed (93 vertices, 42 triangles).
- **Expected result:** 960 to 168 vertices per broadleaf crown, a 5.7x cut in canopy vertex work in both passes, with an identical image.
- **Invariants:** headless-safe, because `BufferGeometryUtils` only imports `three`. The triangle count must stay 320 per near crown. The test checks the vertex count and the index count.

#### PERF-03: a collapsing building rebuilds every building on every frame

- **Category:** Streaming Stutter (combat).
- **Location:** `src/world/buildings.js:1141-1149` (`if (this.collapsing.size > 0) { ... this._needsRebuild = true; }` on every update), `1195-1197` (rebuild when `_needsRebuild`), `2079-2110` (full stream with `_addCollapse` for collapsing keys), `2114-2135` (5 full instance uploads), `2191` (flag cleared only at the end of `rebuild`), `25-26` (collapse lasts 2.4 to 3.8 s).
- **Root cause and cost:**
  - During a collapse, every frame runs the whole `rebuild()`: settlement query, LOD streaming with sorting (`buildings.js:1840-1900`), `_ground` per building and `_addSilhouette` for up to 26,000 buildings.
  - Each rebuild uploads full pools: buildings 26,000, plinths 26,000, gable roofs 26,000, hip roofs 13,000 and ruins 26,000 instances (`buildings.js:990, 1030, 1044-1048`). That is 117,000 x 64 B = 7.5 MB, plus 5,000 x 64 B street lights (`buildings.js:1075, 2183-2184`), about 7.8 MB per frame.
  - At 60 fps one collapse causes 144 to 228 consecutive full rebuilds. Overlapping collapses from a bomb string extend this.
- **Recommended fix:**
  1. Add a small `collapseMesh` InstancedMesh (capacity 512, same geometry and material as `this.mesh`, `castShadow = true`, `frustumCulled = false`, `name = 'building-collapse'`).
  2. In `rebuild()`, skip collapsing buildings entirely (do not call `_addCollapse` there).
  3. Add `_updateCollapseMesh()`. It loops `this.collapsing.values()` and calls the existing `_addCollapse(addBox, c.b, g, c)` with an `addBox` that writes into `collapseMesh`. It sets `collapseMesh.count` and uploads only the used range (PERF-06).
  4. In `update()`, call `_updateCollapseMesh()` every frame while `collapsing.size > 0`. Replace the unconditional `this._needsRebuild = true` at line 1148 with `this._needsRebuild = true` only when an entry finishes (inside the `if (c.t >= c.duration)` branch at line 1144).
  5. `applyBlast` keeps setting `_needsRebuild = true` when a collapse starts (`buildings.js:1470, 1506`). One rebuild then removes the intact building, and one more adds the ruin when it ends.
- **Expected result:** 2 full rebuilds per collapse instead of 144 to 228. The per-frame cost during a collapse becomes a few hundred matrix writes.
- **Invariants:** `tests/cities_destruction_test.mjs:114` expects `_needsRebuild === true` right after `applyBlast`. Lines 284-355 expect `collapsing` to be a `Map` and the collapse to be animated. Keep both. The headless path (`scene` null, `buildings.js:978-984`) must still advance collapse timers without touching meshes. `tests/living_vipava_test.mjs:335-381` asserts substrings of `this.material.fragmentShader`. Do not change the shader in this packet.

#### PERF-04: two multisampled buffers that nothing needs

- **Category:** GPU Memory Bandwidth.
- **Location:** `src/sim/postfx.js:142-147` (one 4x MSAA HalfFloat target passed to the composer), `node_modules/three/examples/jsm/postprocessing/EffectComposer.js:80` (`renderTarget2 = renderTarget.clone()`, also 4x MSAA) and `:97` (`readBuffer = renderTarget2`), `src/main.js:85-91` (`antialias: this.preset.antialias`, true on Medium and High).
- **Root cause and cost:**
  - Pass order per frame: `RenderPass` and `UnrealBloomPass` have `needsSwap = false` and draw into `readBuffer` (renderTarget2). `OutputPass` writes renderTarget1 and swaps. FXAA is the last pass, writes the canvas and swaps again. Two swaps per frame is even, so the scene always lands in renderTarget2.
  - renderTarget1 only receives the OutputPass full-screen quad. As 4x MSAA it costs 3.28 M x 4 samples x 8 B = 105 MB of colour plus 52 MB of depth and stencil in VRAM. Each frame it writes 105 MB of samples and resolves them (another 105 MB read).
  - The canvas also has 4x MSAA because `antialias: true`. Only the FXAA quad draws into it. It costs about 105 MB of VRAM, a 52 MB multisample write per frame and a browser resolve on present.
  - Total avoidable: about 260 MB of VRAM and about 350 MB of memory traffic per frame (about 21 GB/s at 60 fps). Tiled GPUs pay less; desktop GPUs pay roughly this.
- **Recommended fix:**
  1. In `_build()`, create `this.sceneTarget` as today (HalfFloat, `samples: this.samples`, with depth). Create `this.postTarget` as HalfFloat, `samples: 0`, `depthBuffer: false`.
  2. Construct the composer with `postTarget`. Then replace the clone: dispose `composer.renderTarget2`, assign `composer.renderTarget2 = this.sceneTarget`, `composer.readBuffer = this.sceneTarget`, `composer.writeBuffer = this.postTarget`.
  3. In `render()`, after `this.composer.render()`, add a guard: if `this.composer.readBuffer !== this.sceneTarget`, call `this.composer.swapBuffers()`. This keeps the scene in the MSAA target if someone later adds a pass with an odd swap count.
  4. Keep `this.renderTarget` pointing at `sceneTarget` for compatibility, and dispose both targets in `dispose()` and in the `_build()` catch block.
  5. In `src/main.js:87`, set `antialias: false`. Medium and High always run PostFX with MSAA and FXAA. Low already has `antialias: false` and PostFX off (`main.js:435`).
  6. In `src/main.js:100`, change `THREE.PCFSoftShadowMap` to `THREE.PCFShadowMap`. r187 already does this at run time and warns.
- **Visual effect:** none. The scene target keeps 4x MSAA, and FXAA still runs on the tonemapped output.
- **Invariants:** `tests/cinematic_juice_test.mjs:345-418` builds `PostFXSystem` with null and stub renderers. The headless passthrough and the `enabled: false` path must stay the same. Keep the bloom constants and the `setNight`, `pulseBloom`, `update` and `resize` behaviour unchanged.

### P1 high

#### PERF-05: full-detail crowns and trunks out to 6.8 km

- **Category:** GPU Vertex.
- **Location:** `src/world/vegetation.js:218-230` (one trunk and one crown geometry for all distances), `318-389` (every tree writes a trunk).
- **Root cause and cost:** a broadleaf crown is 320 triangles at every distance. At 2.4 km a 12 m crown is about 6 pixels wide at 937 px over 62° FOV. Trunks (360,000 triangles) are drawn to 6.8 km, where a 3 m trunk under the crown is below one pixel tall.
- **Recommended fix:**
  1. For the far broadleaf mesh from PERF-01, build a low-poly crown with the same 4 lobe offsets and radii but `IcosahedronGeometry(radius, 0)` (20 triangles per lobe, 80 per crown). Weld it with `mergeVertices` (48 vertices).
  2. Keep the far conifer on the current conifer geometry (42 triangles).
  3. Write trunks only for near trees. Far trees get no trunk.
- **Expected result:** broadleaf main-pass triangles 4.39 M to about 1.5 M (1,714 near x 320 + 11,996 far x 80). Trunks 360,000 to about 45,000. Main-pass broadleaf vertex invocations 13.16 M to about 0.9 M together with PERF-02.
- **Invariants:** as PERF-01. The trunk pool can stay at its current size.

#### PERF-06: every streaming rebuild uploads the full instance pools

- **Category:** Streaming Stutter.
- **Location:** `src/world/buildings.js:2114-2135, 2183-2184`, `src/world/vegetation.js:402-406`, trigger distances `buildings.js:1195` (250 m) and `vegetation.js:260` (360 m).
- **Root cause and cost:** `instanceMatrix.needsUpdate = true` with no update range uploads the whole array. Buildings: about 7.8 MB per rebuild, about once per second at 250 m/s. Vegetation: trunks 18,000 + leaves 14,400 + conifers 12,600 = 45,000 x 64 B = 2.9 MB, plus about 0.3 MB of colours. Only `count` instances are drawn, for example 20,977 of 26,000 buildings, 2,496 of 13,000 hip roofs, and few or no ruins.
- **Recommended fix:** before setting `needsUpdate`, call `attr.clearUpdateRanges()` and `attr.addUpdateRange(0, count * itemSize)` on each `instanceMatrix` (itemSize 16) and `instanceColor` (itemSize 3). `addUpdateRange` exists in r187 (`BufferAttribute.js:189`). Skip the upload when `count` is 0 and was 0 before.
- **Expected result:** for ruins and hip roofs the upload drops by more than 80 %. Overall upload per rebuild drops to the live instance count.
- **Invariants:** a quality switch to a smaller preset must still clamp `count` to the pool (`vegetation.js:393-400`).

#### PERF-07: terrain tile builds have no time budget

- **Category:** Streaming Stutter.
- **Location:** `src/world/terrainview.js:995-1008` (`update`), `838-849` (`_buildPending`), `851-866` (height grid), `900-918` (normals), `951-975` (index array), `664-680` (`invalidateBounds`), `826-833` (pending sort).
- **Root cause and cost:**
  - The budget is a tile count: 6 per frame, or 10 above 3,000 m (`terrainview.js:1007`). A High near tile samples `(N+2)²` = 43² = 1,849 heights (`terrainview.js:861-866`). Near tiles with step under 12 m add 4 more `terrainHeight` calls per vertex for normals (`terrainview.js:906-913`): 4 x 1,681 = 6,724. That is 8,573 `terrainHeight` calls per tile and up to 51,438 in one frame at budget 6.
  - Each `terrainHeight` call is a Catmull-Rom bicubic over 4x4 reads per DEM tier with fallback (`dem.js:177-233, 323-385`) plus 9 airport cell lookups (`terrain.js:322-346`).
  - Each tile allocates four `Float32Array`s, a `THREE.Color` and a plain JS index array with about 10,560 numbers (`terrainview.js:861, 874-877, 951-975`). The index array depends only on `segs`, so it is the same for every tile at a level band.
  - `pending.shift()` is O(n) per tile (`terrainview.js:841`).
  - `invalidateBounds` deletes meshes at once (`terrainview.js:672-675`). Holes then show until the rebuilt tiles arrive. It only runs for live Terrarium tiles outside the macro ring (`world.js:93-116`), so it does not affect central Vipava.
  - The 20-tile boot budget is dead code: `_rebuild` sets `lastBuildX` (`terrainview.js:834`) before line 1007 reads it, so `lastBuildX === Infinity` is never true there. Boot uses `refresh(center, 16)` instead (`main.js:595`).
- **Recommended fix:**
  1. Give `_buildPending(budgetTiles, budgetMs = 4)` a time budget. Read `performance.now()` before the loop and stop when `built >= budgetTiles` or the elapsed time exceeds `budgetMs`. Always build at least one tile. `refresh()` keeps passing only a tile count, with `budgetMs = Infinity`.
  2. Sort `pending` farthest first and use `pop()` instead of `shift()`.
  3. Cache the index attribute per `segs` in `this._indexCache` (a `Map`), as a `Uint16Array` when the vertex count is below 65,536 (High near: 1,845 vertices). Share the attribute between tiles.
  4. Before every tile `geometry.dispose()` (`terrainview.js:673, 755, 1015`), call `geometry.setIndex(null)` first. `WebGLGeometries` deletes the GPU buffer of `geometry.index` on dispose, which would force a re-upload of the shared index.
  5. In `invalidateBounds`, move affected tiles to the stale set instead of deleting them, so they draw until the replacement exists. Keep a `Map` of key to mesh for stale tiles, because the stale clean-up loop at `terrainview.js:1009-1018` looks meshes up in `this.tiles`.
  6. Remove the dead `lastBuildX === Infinity ? 20` branch, or compute the boot flag before calling `_rebuild`.
- **Expected result:** tile builds never take more than about 4 ms of a frame. Index allocation per tile goes away.
- **Invariants:** `src/world/` must stay headless-safe. `performance` exists in Node 16 and later. Keep `mesh.matrixAutoUpdate = false` (`terrainview.js:988`). The `WaterSurface` class in the same file must not change in this packet.

#### PERF-08: procedural terrain albedo is computed and then thrown away under the satellite ortho

- **Category:** GPU Fragment & Fillrate.
- **Location:** `src/world/terrainview.js:186-330` (`DETAIL_ALBEDO`), `300-330` (ortho drape, `terrAlb = mix(terrAlb, satRgb, satW)`), ortho bounds `terrainview.js:424-428`.
- **Root cause and cost:**
  - In the HD bounds (40 km x 30 km around the valley, `terrainview.js:425`), `satW` is 1, so `terrAlb` is fully replaced by `satRgb`.
  - Before that, each terrain pixel computes: 1 `thStrata` for the rock colour, scree and crevice terms, the field parcel block (rotation with `cos` and `sin`, a hash, 4 colour mixes, the vineyard `sin`, 2 `fwidth`), the tonal and warmth terms, and a luminance pull. None of it reaches the screen there.
  - Terrain covers most of the 3.28 M pixels, and each pixel also runs 6 `thNoise` (24 hashes), 3 `thStrata` and 3 ortho texture reads.
- **Recommended fix:**
  1. Move the ortho weight computation (`orthoWeight` calls and `satW`) above step 1 in `DETAIL_ALBEDO`. Keep the texture reads where they are.
  2. Also move `float submerge = 1.0 - smoothstep( -6.0, 0.2, vTerrWorld.y );` above the branch. The shoreline line `satRgb = mix( satRgb, terrAlb, submerge * 0.85 )` reads the procedural `terrAlb` even where `satW` is 1, so the procedural albedo is still needed on submerged pixels.
  3. Hoist every derivative above the branch. `fwidth()` inside per-pixel control flow is undefined in GLSL and can produce NaN sparkles along the branch edge. Today that means `fwidth( cf.x )` in `rowFade` and `fwidth( vTerrWorld.y )` in `strataAA`. Compute `cf` (and the `rot`, `rp`, `gcell` it needs) and both `fwidth` values before the branch, or derive the row footprint from `pxM`.
  4. Wrap the albedo-only work (the tone and warmth block, `rockCol` from `band` to the final mix, the field block 3 except the hoisted values, and the luminance pull 3b) in `if ( satW < 0.999 || submerge > 0.0 ) { ... }`.
  5. Keep outside the branch every value that `DETAIL_NORMAL` or `DETAIL_SHEEN` reads: `terrN`, `terrSlope`, `rockMask`, `strataAA`, `warp`, `snowMask`, `n6` to `n520`, `d6` to `d520`, `f6` to `f520`, `pxM`, `terrDist`, `terrP`. Declare them before the branch.
  6. The branch condition is constant over large screen areas, so warp divergence happens only along the ortho blend band and the shoreline.
- **Expected result:** the skipped work is about 40 % of the albedo pass ALU inside the ortho area. Not measured.
- **Invariants:** the shader is a `MeshLambertMaterial` patched in `onBeforeCompile` (`terrainview.js:548-570`), so the three.js fog, tone mapping and colour space chunks stay in place. The image must be the same where `satW` is 1, and the same outside the ortho area. Check with a before and after screenshot at the same camera, time and weather.

#### PERF-09: four dead lights in every lit shader

- **Category:** GPU Fragment & Fillrate.
- **Location:** `src/aircraft/cockpit.js:665-670` (2 PointLights, range 5.0 m and 3.4 m), `src/aircraft/aircraft.js:33-34` (cockpit group always attached and visible), `aircraft.js:61-66, 140` (landing SpotLight, intensity 0 unless night and gear down), `src/sim/vfx.js:302-304, 1085-1089, 1255` (blast PointLight, intensity 0 when idle).
- **Root cause and cost:**
  - three.js builds every lit program with `NUM_POINT_LIGHTS 3` and `NUM_SPOT_LIGHTS 1`. Intensity 0 does not remove a light from the loop. Only `visible = false` on the light or an ancestor removes it.
  - Every terrain, tree, F-16, landmark, airliner and debris pixel runs 4 extra light evaluations. The cockpit lights only reach 5 m, and the cockpit sits inside the fuselage in external views.
- **Recommended fix:**
  1. Hide only the two cockpit PointLights outside the cockpit view. Do not hide the cockpit group: the canopy glass is about 50 % transparent and the pilot figure stays visible in external views (`f16.js:1111-1113`), so the seat and panels must stay. In `Aircraft.update` (`aircraft.js:170-177`), set `env.cockpitView = started && this.mode === 'cockpit'` (the same test as `f16.js:1112`) before `this.cockpit.update(dt, flight, env)`. In `cockpit.js` `update()`, set `light.visible = fill.visible = !!e.cockpitView`.
  2. Set `this.landingLight.visible = night > 0.2 && flight.gearPos > 0.5` next to the intensity write at `aircraft.js:140`.
  3. Set `this._blastLight.visible = this._blastLight.intensity > 0` next to the writes at `vfx.js:1085-1089` and `1255`.
  4. A change in the light count switches all lit programs to another variant. three.js caches the variant after the first compile, so only the first switch hitches. Optionally prewarm both variants at boot with `renderer.compile`.
- **Invariants:** `tests/cockpit_test.mjs:127-135` checks indicator fields and that `cockpit.js` contains `aoaUp`, `aoaMid`, `aoaDown`, `masterCaution`, `canopyRain` and `depthWrite: false`. Keep `light.intensity = ind.floodIntensity` (`cockpit.js:718`). `tests/vfx_test.mjs` runs `CombatVFX.update` headlessly, so the visibility write must not need a scene.

#### PERF-10: each vegetation rebuild resamples terrain for every tree

- **Category:** Streaming Stutter.
- **Location:** `src/world/vegetation.js:256-263` (rebuild every 360 m), `290-390` (cell walk).
- **Root cause and cost:** each rebuild walks (2 x 6,800 / 95)² = about 20,500 cells. Every cell calls `fbm01` twice. Each wooded cell calls `terrainHeight`, `slopeAt` and `airportNear`, and each tree calls `terrainHeight` again, sometimes `slopeAt` too. With the 18,000 tree limit that is at least 18,000 `terrainHeight` calls plus about 20,500 x 2 `fbm01` calls in one frame, every 360 m (about every 1.4 s at 250 m/s). Between two rebuilds 360 m apart, about 90 % of the cells are the same.
- **Recommended fix:**
  1. Cache per-cell results in a `Map` keyed by `cx * 73856093 ^ cz` (or a string key). Store either "empty" or a compact `Float32Array` of the accepted trees' x, y, z, rotation, height, crown width, species flag and colour.
  2. Results are deterministic per cell, because `rng` is seeded from `(cx, cz)` (`vegetation.js:315`). The cache is therefore exact.
  3. Bound the cache with an LRU limit of about 40,000 cells, or drop cells outside `1.5 x treeRadius` on each rebuild.
  4. The `n < limit` cut-off and the shuffled cell order stay the same. Only the per-cell sampling is cached.
- **Expected result:** after the first rebuild, a rebuild samples only the new edge cells, about 10 % of the work.
- **Invariants:** headless-safe. Do this after PKT-01, because both change `rebuild()`.

### P2 medium

#### PERF-11: buildings cast shadows out to 28 km

- **Category:** GPU Shadow Pass.
- **Location:** `src/world/buildings.js:993-1036` (`castShadow = true`, `frustumCulled = false` on 4 building meshes), `1909-1919` (`rFar` up to 28,000 m), `src/sim/sky.js:47-51`.
- **Root cause and cost:** 54,908 building instances (586,904 triangles) go through the shadow vertex stage. Only those within about 2 km of the camera can land in the ±1,400 m box. Unlike trees, buildings cannot simply split into near and far meshes without doubling 5 pools and all colour uploads.
- **Recommended fix:** use layer-1 shadow proxies that share the main instance buffers.
  1. In `rebuild()`, write instances in two passes over the streamed list: first every building within `SHADOW_NEAR_R = 2400` m of the camera, then the rest. Record the near counts `nearN`, `nearPN`, `nearGN`, `nearHN`.
  2. For each of the 4 building meshes, create a proxy `InstancedMesh` with the same geometry and material and the same capacity. Then set `proxy.instanceMatrix = main.instanceMatrix`, so it shares the GPU buffer. Set `proxy.count = nearN` (and so on), `proxy.layers.set(1)`, `proxy.castShadow = true`, `proxy.frustumCulled = false`.
  3. Set `castShadow = false` on the 4 main meshes. Keep `castShadow = true` on `collapseMesh` from PERF-03 and on `ruinMesh`.
  4. `WebGLShadowMap` uses `shadow.camera.layers` when any layer other than 0 is enabled on it (`WebGLShadowMap.js:293, 524`). PKT-04 enables layer 1 on the sun shadow camera. The main camera only has layer 0, so the proxies never draw in the main pass.
- **Expected result:** building shadow triangles drop to about 10 % (near share). Upload cost does not change, because the buffer is shared.
- **Invariants:** depends on PKT-03 (same file) and PKT-04 (layer 1). `tests/living_vipava_test.mjs:335-381` reads `sys.material.fragmentShader`. `this.material` must stay the wall material. `tests/cities_destruction_test.mjs:250-280` builds with a stub scene, so the proxies must be added through the same `scene` checks as the main meshes.

#### PERF-12: the shadow map renders every frame, including at altitude

- **Category:** GPU Shadow Pass.
- **Location:** `src/sim/sky.js:255-270`, `src/main.js:99`.
- **Root cause and cost:** the shadow pass runs whenever the sun is above 0.05 and overcast is below 0.85. At 4,000 m and above, the ±1.4 km shadow box covers a small part of the view, but the whole caster set still renders into a 2048² map every frame.
- **Recommended fix:**
  1. Add an altitude cut-off with hysteresis: shadows off above 4,000 m camera altitude, back on below 3,500 m.
  2. Do not toggle `castShadow` for this, because that changes the program variant of every lit material. Instead set `this.sun.shadow.intensity = 0` (r187 `LightShadow.intensity`, `LightShadow.js:41`) and `this.renderer.shadowMap.autoUpdate = false`. Restore `intensity = 1` and `autoUpdate = true` below the lower threshold.
  3. Keep the existing `castShadow` gating for night and overcast (`sky.js:259-260`). It changes rarely, and turning off `castShadow` also removes the shadow taps at night.
  4. Guard `this.renderer?.shadowMap`, because tests may pass a stub renderer.
- **Expected result:** no shadow pass above 4 km.

#### PERF-13: the building shader runs the night-window logic by day

- **Category:** GPU Fragment & Fillrate.
- **Location:** `src/world/buildings.js:245-288` (night block in the facade fragment shader).
- **Root cause and cost:** by day `uNight` is 0, but each facade pixel still computes `buildingSeed`, `resOcc`, `roomSeed`, `swPeriod`, `rollA`, `rollB`, `tone`, `rndTv`, `brightness` (9 `h21` calls) and 2 `sin` for the TV flicker. The result is multiplied by `uNight` and adds nothing.
- **Recommended fix:** wrap the block from `vec2 instCell = ...` through `col += winColor * lit * uNight * 1.15 * brightness;` in `if (uNight > 0.001) { ... }`. Declare `instCell` and `buildingSeed` before the `if`, because the roof code below (`roofPick`, `buildingSeed`) also uses them. A uniform branch does not diverge.
- **Invariants:** `tests/living_vipava_test.mjs:335-381` checks exact substrings. All of them must still be present byte for byte: `vec3(1.0, 0.78, 0.42)`, `vec3(1.0, 0.62, 0.25)`, `vec3(0.78, 0.90, 1.0)`, `vec3(0.36, 0.64, 1.0)`, `vec3(0.34, 0.60, 1.0)`, `tvWave`, `sin(uTime *`, `varying vec2 vInstXZ`, `vec2 instCell = floor(vInstXZ * 0.25)`, `float buildingSeed = h21(instCell`, `float isBig = clamp(smoothstep(10.0, 14.5, vScale.y)`, `0.10 + 0.08 * buildingSeed`, `0.20 + 0.10 * buildingSeed`, `h21(instCell + 19.3)`, `float occupancy = mix(resOcc, bigOcc, isBig);`, `uniform float uNight, uCullDist, uTime;`, `float swPeriod = 45.0 + 95.0`, `smoothstep(0.0, 0.015, fract(swT))`, `* 1.15 * brightness`, `0.38 + 0.60 * h21(`, `smoothstep(0.21 - aa.x`, `smoothstep(0.84 - aa.y`, `fwidth(uvCell)`, `roofDetailAA`. The string `* 1.45 *` must stay absent. Keep the `#include <fog_fragment>`, `<tonemapping_fragment>` and `<colorspace_fragment>` lines.

#### PERF-14: the sky dome shades every pixel before the opaque pass

- **Category:** GPU Fragment & Fillrate.
- **Location:** `src/sim/sky.js:104-180` (`depthTest: false`, `depthWrite: false`, `renderOrder = -1000`).
- **Root cause and cost:** the dome draws first and runs its fragment shader (several `pow`, the moon hash, the star branch at night) on all 3.28 M pixels. Terrain, trees and buildings then overwrite most of the lower half.
- **Recommended fix:**
  1. In the dome vertex shader, after `gl_Position = projectionMatrix * mv;`, add `gl_Position.z = gl_Position.w;`. This puts the dome on the far plane.
  2. Set `depthTest: true`, keep `depthWrite: false`, and set `depthFunc: THREE.LessEqualDepth`.
  3. Set `mesh.renderOrder = 900`, so the dome draws last within the opaque list. Transparent objects (clouds at `renderOrder` 3, rain, particles) still draw after it, because three.js renders the transparent list after the opaque list.
- **Expected result:** the sky shader runs only on visible sky pixels.
- **Invariants:** no logarithmic depth buffer is in use (`main.js:85-91`), so `z = w` maps to depth 1.0. Check the horizon line and fog colour at the terrain edge at 52 km (`terrainview.js:805`) before and after.

#### PERF-15: landmarks are about 460 individual PBR meshes

- **Category:** CPU Draw Calls.
- **Location:** `src/world/landmarks.js:321-336` (`MeshStandardMaterial` per colour), `339-385` (`_box`, `_cyl`, `_cone` each create a `Mesh` with `castShadow` and `receiveShadow`), `833` (beacon `MeshStandardMaterial` per beacon).
- **Root cause and cost:** each visible part is a separate draw call with its own matrix upload, using a PBR program that loops over all lights (PERF-09). In the shadow pass, the parts within the shadow box draw again.
- **Recommended fix:** do the low-risk steps now.
  1. Set `matrixAutoUpdate = false` on every part and call `updateMatrix()` once after placement (see PERF-16).
  2. Set `castShadow = false` on parts whose largest scale is under 2 m (merlons, finials, small sections). They cast shadows of a few texels at 2048² over 2.8 km (1.37 m per texel).
- **Deferred:** merging the static parts per material would remove most draw calls. It conflicts with `tests/landmarks_test.mjs:150` (each landmark needs at least 4 children) and `tests/landmarks_test.mjs:383-388` (looks up the campanile foundation by child `position.z`). Do not merge without an orchestrator decision to change those tests.
- **Invariants:** `tests/landmarks_test.mjs:150-165` (at least 20 triangles, foundation skirt 3.5 m or more), `:190-213` (beacon emissive and lighthouse opacity animate), `tests/grounding_audit_test.mjs`. `Box3.setFromObject` uses world matrices, so call `updateMatrix()` and `updateMatrixWorld()` after placement.

#### PERF-16: static objects recompute their matrices every frame

- **Category:** CPU Per-Frame JS & GC.
- **Location:** only terrain tiles set `matrixAutoUpdate = false` (`terrainview.js:988`, the only hit in `src/`). Static parts in `landmarks.js:339-385`, `airports.js:140-392` and `carrier.js:51-594` keep the default.
- **Root cause and cost:** `scene.updateMatrixWorld()` recomposes the local matrix (position, quaternion, scale) of every object with `matrixAutoUpdate` on, every frame. The estimate is about 600 static objects.
- **Recommended fix:** after each static object is placed, set `matrixAutoUpdate = false` and call `updateMatrix()`. Before doing so, grep for `position`, `rotation` and `scale` writes made after `_box`, `_cyl` or `_cone` return, and for writes to landmark root objects during grounding. Apply the flag only to part meshes that nothing moves after construction, and call `updateMatrix()` after any later placement write. Leave it on for animated objects: landmark beacons and lighthouse beams (`landmarks.js:438-547, 960-980`), the carrier group if it moves, airport rabbit lights if their transform changes (`airports.js:377-392`).
- **Invariants:** `tests/carrier_test.mjs`, `tests/landmarks_test.mjs`. Any test that moves a landmark or carrier after construction needs `updateMatrix()` in the move path.

#### PERF-17: airports create one material per mesh

- **Category:** CPU Draw Calls.
- **Location:** `src/world/airports.js:134` (`box()` creates a `MeshLambertMaterial` per call), `151, 220, 230, 243, 255, 261, 267, 273, 282, 291, 300` (inline materials), `345-353` (4 PAPI materials), `356-363` (8 approach bar materials), `377-392` (6 rabbit materials).
- **Root cause and cost:** about 55 to 75 meshes per airport with mostly unique materials. Each material switch is a uniform upload and state change. The 22 transparent materials per airport also go through the transparent sort every frame.
- **Recommended fix:** add a per-`AirportSystem` material cache keyed by colour and flags (the same pattern as `landmarks.js:321-336`). Share one material per PAPI colour state and one per rabbit phase only where the per-light opacity animation allows it. Check how `update()` animates PAPI and rabbit lights before sharing those. Set `matrixAutoUpdate = false` on static parts (PERF-16).
- **Invariants:** airports are disposed through `group.traverse` (`airports.js:546`). A shared material must be disposed once, from the cache, not per mesh.

#### PERF-18: the HUD canvas redraws the full screen at up to DPR 2

- **Category:** CPU Per-Frame JS & GC.
- **Location:** `src/ui/hud.js:47-56` (backing store at `min(devicePixelRatio, 2)`), `64-76` (full clear and redraw every frame, on purpose, per the comment at `hud.js:67-70`).
- **Root cause and cost:** the redraw is intentional, to keep the pippers in sync. On a DPR 2 display the 2D canvas is 3840x1874 = 7.2 M pixels, twice the WebGL buffer at DPR 1.35. The browser composites the layer every frame. `ctx.font` is set dozens of times per frame from template strings (`hud.js:133, 182, 208, 211, 234, 237, 251, 327, 330`).
- **Recommended fix:**
  1. Cap the HUD DPR at the WebGL pixel ratio. Read it from `this.renderer.getPixelRatio()` through an optional setter, or cap it at 1.5. Thin symbology stays sharp at 1.5.
  2. Build the font strings once per resize and reuse them. Skip `ctx.font =` when the value has not changed (keep a `_font` cache field).
- **Invariants:** `tests/tactical_test.mjs` and `tests/kneeboard_test.mjs` draw through stub canvases and read the drawn texts. Text output must not change.

#### PERF-19: the pixel ratio is fixed at 1.35 on High

- **Category:** GPU Fragment & Fillrate.
- **Location:** `src/main.js:92, 411-413, 419, 430`, `src/config.js:91`.
- **Root cause and cost:** DPR 1.35 renders 1.82x the pixels of DPR 1, and with 4x MSAA HalfFloat every pixel is expensive. The resolution never adapts to load.
- **Recommended fix:** add dynamic resolution in `main.js`.
  1. Keep an exponential moving average of frame time (the loop already tracks `this.fps`, `main.js:2269`).
  2. If the average stays above 18.5 ms for 2 s, lower an internal `_dynScale` by 0.1. If it stays below 14 ms for 4 s, raise it by 0.05. Clamp it to the range 0.75 to 1.0.
  3. Make `_pixelRatio()` return `min(devicePixelRatio, preset.pixelRatio) * _dynScale`.
  4. Call `resize()` only when the scale changes, and at most once per second.
- **Trade-off:** a slightly softer image under heavy load. FXAA and MSAA keep the edges clean.
- **Invariants:** do it after PKT-02 (same file). `postfx.resize` already handles DPR changes (`postfx.js:264-276`).

### P3 low

#### PERF-20: the sky update allocates about 20 colours per frame

- **Category:** CPU Per-Frame JS & GC.
- **Location:** `src/sim/sky.js:200-290`: `new THREE.Color` at 200, 201, 205-210, 219, 226, 229, 278, 279, 281 (two), 289, plus `.clone()` at 202, 212, 214, 280, 287.
- **Root cause and cost:** about 20 short-lived objects per frame, about 1,200 per second at 60 fps. Small, but it is steady GC pressure in the main loop.
- **Recommended fix:** move the constant colours (`warm`, `noon`, the six zenith and horizon colours, `grey`, `dayAmb`, `nightAmb`) to module-level constants. Use module-level scratch colours for `sunCol`, `zen`, `hor`, `amb`, `groundAmb`, `fogCol` and the theatre tints (`.copy()` then `.lerp()`). Return one reused result object. No caller reads the return value (`main.js:351, 988, 1235, 1259, 1884`).

#### PERF-21: the cockpit screens redraw and upload in every view

- **Category:** GPU Memory Bandwidth.
- **Location:** `src/aircraft/aircraft.js:33-34, 177` (cockpit always attached, `update` always called), `src/aircraft/cockpit.js:59-69` (`CanvasTexture` with default mipmaps and `anisotropy = 4`), `727-754` (10 Hz redraw of two 256² MFDs and two 128² gauges).
- **Root cause and cost:** 2 x 262,144 B + 2 x 65,536 B = 655,360 B per redraw, about 6.5 MB/s, each with mipmap generation, even in chase and external views, where the screens are too small to read through the canopy.
- **Recommended fix:** use the `env.cockpitView` flag from PERF-09 step 1. In `update()`, skip the 10 Hz MFD block when `env.cockpitView` is false. Keep the per-frame lamp and stick animation, because those parts can be seen through the canopy. Redraw the MFDs at once when the view switches back to the cockpit, so the screens are never stale. For MFD and gauge textures set `generateMipmaps = false` and `minFilter = THREE.LinearFilter`. The screens are viewed at about 1:1 from the seat.
- **Invariants:** `tests/cockpit_test.mjs:127-135`.

#### PERF-22: particle and trail buffers upload in full every frame

- **Category:** GPU Memory Bandwidth.
- **Location:** `src/sim/vfx.js:213-250` (loop over the full capacity and full uploads while any particle lives; puffs 1,400, sparks 420), `vfx.js:1143-1148` (debris, 160 instances), `src/sim/traffic.js:282-293` (trail upload every frame).
- **Root cause and cost:** about 50 KB per frame during combat, and a loop over 1,400 slots for 1 live puff. Small.
- **Recommended fix:** track the highest active slot index in `ParticlePool` (`_hi`). Loop to `_hi` and call `addUpdateRange(0, (_hi + 1) * itemSize)` on `posAttr`, `alphaAttr` and `sizeAttr`. For debris, upload `count * 16` floats.
- **Invariants:** `tests/vfx_test.mjs` checks pool counts and visibility. Keep `points.visible = this.count > 0`.

#### PERF-23: dead config and mismatches

- **Category:** CPU Per-Frame JS & GC (clarity).
- **Location:**
  - `src/config.js:71, 87, 103`: `shadows: false` on every preset, but `src/main.js:99, 431` use `preset.name !== 'low'`.
  - `src/main.js:100`: `PCFSoftShadowMap` is removed in r187 (handled in PKT-02).
  - `src/sim/postfx.js:272-274`: `bloomPass.setSize(w, h)` runs right after `composer.setSize`, which already sized the pass in device pixels (`EffectComposer.js:152`). The end state is bloom at CSS resolution, which is cheaper. Keep it. Do not change it to device pixels, which would cost 1.82x more bloom pixels.
  - `src/world/terrainview.js:1007`: the 20-tile branch is dead (PERF-07).
- **Recommended fix:** make `main.js` read `preset.shadows`, and set it to `true` for medium and high in `config.js` (PKT-12). Add a comment at `postfx.js:272` that explains the CSS-resolution bloom.

#### PERF-24: cloud puffs overdraw near the cloud deck

- **Category:** GPU Fragment & Fillrate.
- **Location:** `src/sim/clouds.js:60, 76-146` (capacity 340 x 6 = 2,040 instanced quads, `transparent`, `DoubleSide`, `frustumCulled = false`), `307-316` (quad size = radius x 0.75 to 1.7, radius 420 to 1,040 m, so up to about 1.77 km wide).
- **Root cause and cost:** the fragment shader is cheap (one texture read and a discard below alpha 0.004, `clouds.js:121-137`). Near or inside the deck, many large quads cover the screen and blend into a 4x MSAA HalfFloat target. The cost depends on the weather and the camera height and was not measured. In the clear weather of the telemetry run it is low.
- **Recommended fix:** none now. Profile a SCATTERED or OVERCAST flight through the deck first. If it shows up, fade puffs whose projected size passes about 1.5 screen heights.

---

## 4. Implementation packets for DeepSeek 4.1 Flash

### Rules for every packet

- Run each packet with the standard Hermes call from `AGENTS.md` (`hermes chat --oneshot --yolo --provider alibaba-coding-plan -m deepseek-v4.1-flash --in /home/erik/Desktop/falcon-infinite --query-file -`).
- Touch only the files listed for the packet. Packets in one wave share no files.
- A packet may create a new `tests/*_perf_test.mjs` file. It must not edit `package.json`. After each wave the orchestrator appends the new test files to the `"test"` script in one commit.
- Keep `src/world/`, `src/sim/` and `src/aircraft/` headless-safe. Guard every `window`, `document`, `performance`, `renderer` and `scene` access.
- Every custom `ShaderMaterial` in `src/world/` keeps `#include <fog_fragment>`, `#include <tonemapping_fragment>` and `#include <colorspace_fragment>`.
- `RoadNetwork` keeps one root mesh (`tests/roadnet_test.mjs`). No packet here touches `roadnet.js`.
- Before wave 1, the orchestrator captures baseline screenshots and `renderer.info` totals (see "Getting real numbers") at named cameras: Vipava High at noon over forest, at golden hour looking along the sun azimuth, over a town at night, in cockpit view, inside the HD ortho, on the ortho blend edge, and in the temperate theatre. Every "matches the baseline" check below refers to these.
- After each wave the orchestrator runs `npm test && npm run build` and compares the same cameras against the baseline.

### Wave 1 (parallel, no shared files)

#### PKT-01: vegetation geometry, near and far split, shadow subset, upload ranges

- **Findings:** PERF-01, PERF-02, PERF-05, PERF-06 (vegetation part).
- **Files:** `src/world/vegetation.js`, new `tests/vegetation_perf_test.mjs`.
- **Steps:**
  1. Import `mergeVertices` from `three/examples/jsm/utils/BufferGeometryUtils.js`.
  2. Weld the broadleaf canopy with `mergeVertices` after `paintCanopyAO`.
  3. Add a far broadleaf geometry: the same 4 lobes with `IcosahedronGeometry(radius, 0)`, normalised like `makeBroadleafCanopy`, then welded.
  4. Replace `leaves` and `conifers` with `leavesNear`, `leavesFar`, `conifersNear`, `conifersFar`. Near meshes use the full geometries and cast and receive shadows. Far meshes use the low-poly broadleaf or the conifer geometry, with no shadows.
  5. Keep `this.leaves` and `this.conifers` as getters or aliases to the near meshes, so other code that reads them still works.
  6. Route each emitted tree by distance to the camera with `VEG_NEAR_R = 2400`. Write trunks only for near trees.
  7. Upload only `count * 16` matrix floats and `count * 3` colour floats with `clearUpdateRanges()` and `addUpdateRange()`.
- **Acceptance criteria:**
  - The near broadleaf geometry has 168 vertices or fewer and 320 triangles (index count 960).
  - The far broadleaf geometry has 80 triangles.
  - With a stub scene and a camera at `(0, 500, 0)`, every near instance is within 2,400 m of the camera, and every far instance is beyond it.
  - Near plus far tree count equals the pre-change baseline. Measured on 2026-11-28 with `new VegetationSystem(null, QUALITY.high)` and `rebuild({ position: (0, 500, 0) })` in Node, without the Vipava DEM: 18,000 trees, 10,654 broadleaf, 7,346 conifer. Assert these three numbers.
  - Golden-hour check: a screenshot at sun elevation about 10°, looking along the sun azimuth over forest, shows no visible shadow cut-off line. If it does, scale `VEG_NEAR_R` with `1 / sin(sun elevation)`, clamped to the range 2,400 to 4,500 m. `update()` already receives `sky`, so pass `sky.sunElevation` to `rebuild()`.
  - Near meshes have `castShadow === true`. Far meshes and trunks have `castShadow === false`.
  - `new VegetationSystem(null, QUALITY.high)` and `rebuild()` run without a DOM.
- **Verify:** `node tests/vegetation_perf_test.mjs && npm run build`.

#### PKT-02: PostFX buffers and renderer context

- **Findings:** PERF-04, PERF-23 (`PCFSoftShadowMap`, bloom comment).
- **Files:** `src/sim/postfx.js`, `src/main.js`.
- **Steps:** follow PERF-04 steps 1 to 6. Add the comment from PERF-23 at `postfx.js:272`. In `main.js` change only lines 87 and 100.
- **Acceptance criteria:**
  - `node tests/cinematic_juice_test.mjs` passes without changes to the test.
  - In the browser: `__falcon.postfx.composer.renderTarget1.samples === 0`, `__falcon.postfx.composer.renderTarget2.samples === 4` on WebGL2, `__falcon.renderer.getContextAttributes().antialias === false`.
  - No `PCFSoftShadowMap has been removed` warning in the console.
  - The image matches the baseline screenshot (edges stay antialiased).
- **Verify:** `node tests/cinematic_juice_test.mjs && npm run build`.

#### PKT-03: building collapse mesh and upload ranges

- **Findings:** PERF-03, PERF-06 (buildings part).
- **Files:** `src/world/buildings.js`, new `tests/buildings_perf_test.mjs`.
- **Steps:** follow PERF-03 steps 1 to 5 and PERF-06 for all `instanceMatrix` and `instanceColor` uploads in `rebuild()`, `collapseMesh` and `lightMesh`. Do not change any shader string.
- **Acceptance criteria:**
  - With a stub scene, start a collapse with `applyBlast` on a tall building, then call `update(1/60, camera, null)` 240 times. `rebuild` runs at most 3 times (wrap `sys.rebuild` with a counter in the test).
  - `collapseMesh.count > 0` while `collapsing.size > 0`, and its matrices change between two frames.
  - After the collapse ends, the key is in `destroyed`, and the next rebuild adds ruin instances.
  - `node tests/cities_destruction_test.mjs` and `node tests/living_vipava_test.mjs` pass unchanged.
- **Verify:** `node tests/buildings_perf_test.mjs && node tests/cities_destruction_test.mjs && node tests/living_vipava_test.mjs && node tests/grounding_audit_test.mjs && npm run build`.

#### PKT-04: sky allocations, sky dome order, altitude shadow cut-off, shadow layer

- **Findings:** PERF-20, PERF-14, PERF-12, and the layer-1 prerequisite of PERF-11.
- **Files:** `src/sim/sky.js`, new `tests/sky_perf_test.mjs`.
- **Steps:**
  1. Remove all per-frame `new THREE.Color` and `.clone()` calls in `update()` (PERF-20).
  2. Move the sky dome to the far plane and draw it last among opaques (PERF-14).
  3. Add the altitude cut-off with `shadow.intensity` and `renderer.shadowMap.autoUpdate` (PERF-12).
  4. In the constructor, call `this.sun.shadow.camera.layers.enable(1)`. Layer 0 must stay enabled.
- **Acceptance criteria:**
  - With a stub scene (`{ add() {} }`) and a stub renderer (`{ toneMappingExposure: 1, shadowMap: { autoUpdate: true } }`), 100 calls to `update()` do not throw.
  - `update()` returns the same `sunColor` object on two calls.
  - `dome.material.depthTest === true` and `dome.renderOrder > 0`.
  - The shadow camera layers have 0 and 1 enabled.
  - At camera `y = 5000`, `sun.shadow.intensity === 0` and `shadowMap.autoUpdate === false`. Back at `y = 300` both are restored.
  - In the browser the sky, sun disc, horizon and fog match the baseline at noon and at dusk.
- **Verify:** `node tests/sky_perf_test.mjs && npm run build`.

#### PKT-05: terrain tile streaming budget

- **Findings:** PERF-07, PERF-23 (dead budget branch).
- **Files:** `src/world/terrainview.js` (streaming code only, not `WaterSurface` and not the shader strings), new `tests/terrain_stream_perf_test.mjs`.
- **Steps:** follow PERF-07 steps 1 to 6.
- **Acceptance criteria:**
  - Two tiles with the same `segs` share one index attribute object, and its array is a `Uint16Array` for High near tiles.
  - `_buildPending(100, 0)` builds exactly 1 tile. `_buildPending(3, Infinity)` builds at most 3.
  - After `invalidateBounds` over a built area, the affected meshes stay in the group until replacements are built.
  - Disposing a tile does not dispose the shared index (`geometry.index === null` before `dispose`).
  - `node tests/dem_test.mjs` and `node tests/water_test.mjs` pass.
- **Verify:** `node tests/terrain_stream_perf_test.mjs && node tests/dem_test.mjs && node tests/water_test.mjs && npm run build`.

#### PKT-06: dead lights, cockpit visibility, small uploads

- **Findings:** PERF-09, PERF-21, PERF-22.
- **Files:** `src/aircraft/aircraft.js`, `src/aircraft/cockpit.js`, `src/sim/vfx.js`, `src/sim/traffic.js`.
- **Steps:** follow PERF-09 steps 1 to 3, PERF-21 and PERF-22.
- **Acceptance criteria:**
  - The cockpit group stays visible in every view. Only the two cockpit PointLights follow `env.cockpitView`.
  - In chase view, in daylight, with gear up and no explosion, a lit program reports 0 point lights and 0 spot lights. In cockpit view it reports 2 point lights. Check with `renderer.info.programs` or by reading `NUM_POINT_LIGHTS` in a program's defines.
  - The MFD canvases do not redraw in chase view and redraw at once on the switch to cockpit view.
  - The landing light still works at night with gear down. The blast light still flashes on detonation.
  - MFD textures have `generateMipmaps === false`.
  - `node tests/cockpit_test.mjs`, `node tests/vfx_test.mjs` and `node tests/ejection_traffic_test.mjs` pass. `traffic.js` must still contain no `Math.random` (`tests/ejection_traffic_test.mjs:58`).
- **Verify:** `node tests/cockpit_test.mjs && node tests/vfx_test.mjs && node tests/ejection_traffic_test.mjs && npm run build`.

#### PKT-07: static scene objects

- **Findings:** PERF-15 (low-risk part), PERF-16, PERF-17.
- **Files:** `src/world/landmarks.js`, `src/world/airports.js`, `src/world/carrier.js`.
- **Steps:**
  1. Set `matrixAutoUpdate = false` and call `updateMatrix()` on static parts after placement in all three files. Leave animated parts alone.
  2. In `landmarks.js`, set `castShadow = false` on parts with a largest scale below 2 m.
  3. In `airports.js`, add a material cache for static boxes and inline Lambert materials. Dispose cached materials once in the airport disposal path.
  4. Do not merge landmark geometry.
- **Acceptance criteria:**
  - `node tests/landmarks_test.mjs`, `node tests/grounding_audit_test.mjs`, `node tests/carrier_test.mjs` and `node tests/living_vipava_test.mjs` pass unchanged.
  - The number of unique materials per airport drops (count them in the test log or the browser).
  - Landmarks and airports look the same as the baseline.
- **Verify:** `node tests/landmarks_test.mjs && node tests/grounding_audit_test.mjs && node tests/carrier_test.mjs && node tests/living_vipava_test.mjs && npm run build`.

#### PKT-08: HUD canvas

- **Findings:** PERF-18.
- **Files:** `src/ui/hud.js`.
- **Steps:** cap the HUD backing-store DPR at 1.5. Cache font strings and skip unchanged `ctx.font` writes.
- **Acceptance criteria:** `node tests/tactical_test.mjs` and `node tests/kneeboard_test.mjs` pass. The HUD looks the same on a DPR 1 display.
- **Verify:** `node tests/tactical_test.mjs && node tests/kneeboard_test.mjs && npm run build`.

### Wave 2 (after wave 1 is merged and green)

#### PKT-09: building shadow proxies and day branch

- **Findings:** PERF-11, PERF-13.
- **Depends on:** PKT-03 (same file) and PKT-04 (shadow camera layer 1).
- **Files:** `src/world/buildings.js`, `tests/buildings_perf_test.mjs`.
- **Steps:** follow PERF-11 steps 1 to 3 and PERF-13.
- **Acceptance criteria:**
  - The 4 proxies have layer 1 only, `castShadow === true`, and share `instanceMatrix` with their main mesh (`proxy.instanceMatrix === main.instanceMatrix`).
  - Main building meshes have `castShadow === false`.
  - All proxy instances are within 2,400 m of the camera at rebuild time.
  - Every substring listed under PERF-13 is still in `sys.material.fragmentShader`.
  - In the browser, near building shadows look the same as the baseline.
- **Verify:** `node tests/buildings_perf_test.mjs && node tests/living_vipava_test.mjs && node tests/cities_destruction_test.mjs && node tests/grounding_audit_test.mjs && npm run build`.

#### PKT-10: terrain albedo skip under ortho

- **Findings:** PERF-08.
- **Depends on:** PKT-05 (same file).
- **Files:** `src/world/terrainview.js` (`DETAIL_ALBEDO` string only).
- **Steps:** follow PERF-08 steps 1 to 4.
- **Acceptance criteria:**
  - The shader compiles: no WebGL errors in the console on boot.
  - Screenshots at 3 fixed cameras match the baseline: inside the HD ortho, on the ortho blend edge, and outside all ortho tiers (temperate theatre).
- **Verify:** `npm test && npm run build`, then the screenshot comparison.

#### PKT-11: vegetation cell cache

- **Findings:** PERF-10.
- **Depends on:** PKT-01 (same file).
- **Files:** `src/world/vegetation.js`, `tests/vegetation_perf_test.mjs`.
- **Steps:** follow PERF-10 steps 1 to 4.
- **Acceptance criteria:**
  - Rebuilding at the same camera twice gives identical instance matrices.
  - A rebuild after a 400 m move calls `terrainHeight` less than 25 % as often as a cold rebuild. Count the calls by wrapping the import through an injected height function, or by reading a call counter the system exposes for tests.
  - The cache never holds more than its limit.
- **Verify:** `node tests/vegetation_perf_test.mjs && npm run build`.

### Wave 3

#### PKT-12: dynamic resolution and shadow preset flag

- **Findings:** PERF-19, PERF-23 (`preset.shadows`).
- **Depends on:** PKT-02 (same `main.js`).
- **Files:** `src/main.js`, `src/config.js`.
- **Steps:** follow PERF-19 steps 1 to 4. Set `shadows: true` on medium and high in `config.js`, and use `preset.shadows` at `main.js:99` and `431`.
- **Acceptance criteria:**
  - `node tests/mcp_test.mjs` passes (it drives `App`).
  - With the browser throttled (Chrome DevTools, CPU or GPU slowdown), `renderer.getPixelRatio()` drops within 3 s and recovers when the throttle is removed.
  - Low still has no shadows. Medium and high still have shadows.
- **Verify:** `npm test && npm run build`.

### Wave summary

| Wave | Packets | Files (no overlap within a wave) |
|---|---|---|
| 1 | PKT-01 to PKT-08 | vegetation.js; postfx.js + main.js; buildings.js; sky.js; terrainview.js; aircraft.js + cockpit.js + vfx.js + traffic.js; landmarks.js + airports.js + carrier.js; hud.js |
| 2 | PKT-09, PKT-10, PKT-11 | buildings.js; terrainview.js; vegetation.js |
| 3 | PKT-12 | main.js + config.js |

12 packets in total. PERF-24 has no packet until a cloud-deck profile shows a cost.
