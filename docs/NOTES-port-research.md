# Port or re-architect? Research log (branch `crazy/native-port-research`)

Question from the map owner (2026-09-19): large maps load slowly and the
viewport lags; would another language/framework be better for a full port —
same 3D view, roughly the same UI, speed first?

Short answer: **measure first — and the measurement says the slowness is the
way we draw, not the language we draw in.** Sections 1–2 are measured on this
machine; section 3 is the framework survey; section 4 the recommendation.

## 1. Where the time goes today (measured)

Map: RHEVARA (TMX 357419), 31,610 placements, RTX 3080, Chrome (ANGLE/D3D11),
camera over the whole map, `renderer.info` + `gl.finish()` timing of 10–12
forced frames.

| | value |
| --- | --- |
| draw calls per frame | **53,133** |
| triangles per frame | 10.7 M |
| CPU+GPU time per frame | **267–318 ms (≈ 3–4 fps)**, spikes over 1 s |
| unique geometries / textures | 1,985 / 226 |
| scene objects / meshes | 103,157 / 75,192 (53,214 of them hidden: clip caps etc.) |
| JS heap | ~500 MB |
| time until the editor is usable | > 20 s |
| mesh store on disk | **11 GB of text OBJ** in 11,004 files, 3,733 of them over 1 MB |

10.7 M triangles is nothing for this GPU. 53 k draw calls is the whole
problem: every placement near the camera is its own cloned object, every
material of it its own draw call, and nothing is culled in bulk. WebGL spends
the frame in per-draw overhead. Only ~2,000 geometries are unique — the scene
is almost pure repetition, which is the best case for instancing.

Loading: meshes are text OBJ, parsed on the main thread, one fetch per block;
the map JSON is 8.9 MB and the mesh index 8 MB, parsed before anything shows.

## 2. Experiment: the same frame, instanced (15 ms of setup, no other change)

In the running page: group every visible mesh by (geometry, materials), build
one `InstancedMesh` per group with the meshes' world matrices, render that.
No culling at all, every triangle drawn:

| | draw calls | triangles | frame |
| --- | --- | --- | --- |
| today | 53,133 | 10.7 M | 267 ms |
| naive instancing | 8,759 | 11.0 M | **63 ms** |

4× from a hack. What is left is visible in the numbers: 8.7 k calls (one per
material slot — a shared texture array / atlas per shader takes that to a few
hundred) and 11 M triangles with no culling or LOD (chunked culling and the
existing far-box LOD take most of that away). Both are standard; together
they put this map at 60 fps in the browser. Building the instances took 15 ms.

**A port that keeps today's one-object-per-block design would still be slow**
(native draw calls are maybe 5–10× cheaper than WebGL's, not 50×); **a
re-architecture is needed in any language, and it is most of the win.**

## 2b. What was done about it (same day, this branch)

Three changes, all in `src/render`:

1. **The load time was a bug, not the platform.** Opening the map spent
   50–83 s in `DocumentRenderer.rebuild`, of which the real work (cloning
   templates, clip adjacency, batching) was under 1 s. The rest: every
   `addPlacement` re-synced its layer, and that sync walks every placement —
   31,610 × 31,610. Syncing only when a layer group is created:
   **83,474 ms → 755 ms** (the renderer now logs this breakdown for large maps).
2. **Instanced, chunk-culled drawing** (`InstanceBatcher`): every placement's
   meshes are grouped by (layer, geometry, materials, 768 m map chunk) into one
   `InstancedMesh` each; three.js frustum-culls whole groups by bounding sphere.
3. **Parked placement objects** (`ParkingGroup`): the per-placement objects
   still exist — picking, bounds, selection boxes and the transform tools use
   them — but they sit in an invisible group whose `updateMatrixWorld` does
   not recurse. three.js otherwise walks all 100,000 of them every frame,
   which alone cost ~20 ms of matrix updates plus ~25 ms of traversal even
   with nothing drawn. Only the selection is drawn as ordinary objects, so
   drags still show live.

Measured on the same map and machine, background tab, `gl.finish()` timing:

| | before | after |
| --- | --- | --- |
| opening the map (renderer rebuild) | 50–83 s | **0.76 s** |
| frame, editing view (close to the track) | 61.6 ms, 478 calls | **5.2 ms**, 1,119 calls, 2.3 M triangles |
| frame, whole map in view | 267–318 ms, 53,133 calls | **70 ms**, 10,434 calls, 8.8 M triangles |
| per-frame matrix update | 20.6 ms | 0.5 ms |

What is left, in order of value:

- **Whole-map views are still call-bound** (10 k calls): ~3 material slots
  per batch. One texture array (or atlas) per shader family would take this
  to a few hundred calls — the remaining big rendering win.
- **Memory and the LOD system.** The heap is ~500 MB because 15,600 near
  placements each own a cloned object tree; that is what keeps the far-box
  LOD necessary. Replacing the per-placement clone with a flat list of
  (geometry, material, matrix) parts per template — objects only for the
  selection — removes that cost, and then **the LOD system can go**: all
  31 k placements as instances is ~60 k instances, which the batches handle.
- **Meshes**: 11 GB of text OBJ parsed on the main thread. A binary cache
  (positions/normals/uvs/indices as typed arrays, or glTF + meshopt) loaded in
  a worker removes the streaming stutter and most of the disk footprint.
- **Picking** raycasts 15 k objects (~18 ms a pick): `three-mesh-bvh` or a
  chunk grid makes it sub-millisecond.

## 3. If we ever do port: the framework survey

Web survey by a research agent, 2026-09-19; claims below are as reported
there and were not re-verified one by one.

**The pivot fact is GBX.NET.** Everything that reads the game's files is C#.
GBX.NET states NativeAOT/trimming support and can be exported as a C ABI
library (`[UnmanagedCallersOnly]`), so non-.NET stacks are possible but pay
a marshalling layer forever; there is no usable Rust or C++ GBX parser.
Licence note worth knowing today as well: GBX.NET's core is MIT but its LZO
component (needed for map bodies, and used by our `meshdump`) is GPLv3.

| stack | rendering | UI for an editor | GBX | verdict |
| --- | --- | --- | --- | --- |
| **three.js, re-architected** (this branch) | instancing + culling proven above; WebGPU renderer not yet a win (one benchmark: WebGL 4× faster for many small meshes); `BatchedMesh` currently slower than instancing | keeps everything we have | sidecar CLI as today (Blazor-WASM parsing is proven by gbx.tools' own explorer) | **first choice** |
| **Godot 4 + C#** | MultiMesh = one mesh each, so ~2 k MultiMeshes; culling/LOD issues open; RenderingServer unbenchmarked at this scale | Control nodes are fine, but `Tree` reportedly chokes at 10 k+ rows — build a virtual list | in-process, MIT-compatible | best full port if one is wanted; prototype the 30 k-instance case first |
| **Custom .NET** (Silk.NET or Vortice + ImGui.NET) | highest ceiling, you own culling/LOD/shadows | ImGui docking + clipper lists work; plainer look; Veldrid is dead, Silk.NET 3 mid-transition | in-process, no conversion step at all | strongest technically, most work |
| Unity 6 | strongest out of the box (GPU Resident Drawer, BRG) | UI Toolkit has virtualised lists | GPLv3 LZO vs a proprietary runtime: licence conflict | excluded on licence |
| Stride (C#) | instancing benchmarked well; small ecosystem | thin | in-process | risky ecosystem |
| Rust (Bevy / wgpu + egui) | Bevy 0.16+ GPU-driven rendering is excellent | no docking/virtual tree; API churn every ~3 months hurts AI-assisted work | AOT shim or sidecar forever | not for a solo dev + agents |
| C++ (Qt / ImGui + bgfx) | fine; TrenchBroom (Qt+GL) still has open large-scene perf issues | Qt is best-in-class for trees/docks; licence cost | shim forever | slowest velocity |
| Tauri/Electron + native view | compositing a native GPU surface with a webview is unresolved upstream | — | — | avoid |

The common thread in how comparable tools got fast (TrenchBroom, Tiled's
move to a GPU scene graph, Blockbench's known one-object-per-element
ceiling, Figma's custom renderer): **instancing, spatial culling/streaming
and binary assets matter far more than the language.**

## 4. Recommendation

Stay on three.js and finish the re-architecture started here. The two worst
numbers are already gone (83 s → 0.76 s to open, 62 → 5 ms per frame while
editing) without touching the UI or the tools. A port would have had to do
exactly this work anyway, plus rebuild every panel, tool and dialog, plus —
outside .NET — wrap GBX.NET forever.

Revisit a port only if, after the texture-array and flat-instance steps,
whole-map views still cannot hold 60 fps. If so, the order to try is
**Godot 4 + C#** (prototype: 60 k instances of 2 k meshes through
RenderingServer, and a virtualised 30 k-row tree) and then a custom
Silk.NET/Vortice + ImGui renderer.

## 5. Mesh loading moved to workers (2026-09-20)

Measured for RHEVARA with everything loaded (what a LOD distance of 20,000
amounts to): 967 distinct mesh files, 325 MB of OBJ text, 12.1 M vertices.

| | wall time | page thread blocked |
| --- | --- | --- |
| before: OBJLoader on the page, 4 loads in flight | ~19 s (extrapolated from a 97-file sample: 2.0 s) | ~16 s |
| now: a pool of 12 workers fetches, parses and shades; buffers are transferred | **4.7 s** | ~0 |
| 20 workers | 5.4 s | — past a dozen the server and the largest files set the pace |

`src/render/objWorker.ts` + `objWorkerPool.ts`; MeshProvider falls back to
its own OBJLoader where workers are unavailable. Same files, same object
tree as before (a Group of named meshes, materials by name), so nothing else
changed. Left on the table: a binary mesh cache (the text is 325 MB to say
what 12 M vertices say — indexed and quantised it is a fraction), which would
cut the remaining seconds and the 11 GB on disk.
