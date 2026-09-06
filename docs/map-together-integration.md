# Map Together integration investigation

Investigated 2026-09-06. Source review only; no running Trackmania session was
connected and no plugin was installed or compiled.

Implementation follow-up: the bridge now uses Editor++ directly and no longer
requires Map Together or exposes room controls. See `tools/TrackeditLive`,
`tools/liveBridge.ts`, `src/ui/LiveDialog.ts`, and the README. The research below
is retained for potential future multiplayer synchronization.

## Conclusion

Connecting trackedit to a running in-game editor is feasible in principle through
a small Openplanet bridge using Editor++ for placements and Map Together for room
synchronization. The existing game client would remain the room participant;
browser edits would be attributed to that player. Full two-way synchronization
needs new code in trackedit and an in-game bridge, plus runtime validation.

There is a concrete dependency mismatch to resolve first: the reviewed Map
Together source calls `Editor::BeginCaptureSuppress`, `ResetCaptureSuppress`,
`RefreshTerrainSnapshot`, and terrain extension callbacks. The reviewed Editor++
master and dev sources do not provide the capture-suppression symbols or
`onTerrainChanged`. Do not assume the latest public source trees build together
or that installed release packages contain the same APIs.

## Sources inspected

- [Map Together source](https://github.com/XertroV/tm-map-together/tree/3233f5dcb56d24554a0975d289e50f4eee9dac69), master, manifest version 0.2.9.
- [Editor++ source](https://github.com/XertroV/tm-editor-plus-plus/tree/0641f74279b799a2f0f139f54545ea50820b9dc4), master, manifest version 0.8.99999999a.
- Editor++ dev commit `55831586a98cc37e972961546660e307cce0a794`, checked for the missing hooks as well.

## How Map Together works

1. The Openplanet plugin authenticates with `Auth::GetToken()` and opens a raw TCP
   connection on port 19796. It sends authentication and version bytes, then
   room and binary update messages. This is not a browser WebSocket or HTTP API.
   See [Socket.as](https://github.com/XertroV/tm-map-together/blob/3233f5dcb56d24554a0975d289e50f4eee9dac69/src/Socket.as).
2. Editor++ supplies block/item specs, macroblock placement/deletion, and change
   capture. Map Together reads last-frame placement/deletion buffers and sends
   macroblocks to the server. The current feed explicitly accounts for API edits
   and late coroutine placements.
3. Incoming updates are queued. The client can restore its cached undo baseline,
   apply server updates through Editor++, and cache the resulting state. Capture
   suppression prevents replay from being broadcast again. Updates wait while
   testing/loading and may also wait in non-placement editor modes.
   See [EditorFeed.as](https://github.com/XertroV/tm-map-together/blob/3233f5dcb56d24554a0975d289e50f4eee9dac69/src/EditorFeed.as).
4. Plugin exports include `GetStatus`, `JoinRoom`, `InviteCurrentMap`,
   `WaitUntilReady`, `WaitUntilIdle`, players, chat, and other room controls.
   They do not expose a general placement API or a subscribed stream of applied
   room edits. These are AngelScript imports for other Openplanet plugins, not
   network endpoints. See [Export_Imports.as](https://github.com/XertroV/tm-map-together/blob/3233f5dcb56d24554a0975d289e50f4eee9dac69/src/Export_Imports.as).

## Recommended connection

```text
trackedit browser <-> local Node bridge <-> Trackedit Live Openplanet plugin
                                              | Editor++ placement/snapshot APIs
                                              v
                                      running game editor
                                              | Map Together
                                              v
                                         room server
```

Use JSON over local HTTP polling initially: the Openplanet plugin fetches queued
commands and posts snapshots/results to Node; the browser uses HTTP or a socket
to the same Node process. This avoids implementing Map Together's binary protocol
and keeps its authentication inside the game. A later standalone Node service
can replace Vite for packaged/static deployments.

The local bridge should bind to loopback by default and require a session token
for game commands. Forward only selected status fields: Map Together's
`GetStatus()` includes the room password. Pair one browser document with one game
session explicitly; never replay queued writes automatically into another map.

## Existing trackedit seams and necessary changes

| Area | Existing code | Integration work |
| --- | --- | --- |
| Plugin entry | `src/plugins/api.ts` | Register a live-session plugin and connection UI. |
| Changes | `src/core/document.ts`, `src/core/commands.ts` | Batch committed edits; distinguish local commands from remote reconciliation. Include undo/redo and incremental command commits. |
| World placements | `src/io/trackoJson.ts` | Extract reusable conversion per placement, preserving IDs for synchronization. Bake layer transforms into game placements. |
| Local server | `vite.config.ts` | Add session, command queue, results, and snapshot endpoints; the debug bridge already demonstrates HTTP/browser round trips. |
| Openplanet installation | `tools/TrackeditExtract`, setup bridge | Reuse installation conventions for a separate live plugin with Editor/MapTogether dependencies. |

Editor++ exports `MakeBlockSpec`, `MakeItemSpec`, `MakeMacroblockSpec`,
`PlaceMacroblock`, `DeleteMacroblock`, and `GetMapAsMacroblock`. Resolve models
inside the game and use these factories: constructing the shared spec classes
directly does not supply their private implementations.
See [Editor++ exports](https://github.com/XertroV/tm-editor-plus-plus/blob/0641f74279b799a2f0f139f54545ea50820b9dc4/src/Editor/MacroblockManip_ExportCode.as).

Browser-origin edits should use normal Editor++ capture so Map Together sees
them. Do not manually send a second room message or suppress their capture.
Prove this behavior with the actual compatible plugin pair before expanding scope.

## Synchronization details that matter

- **Readback:** start with `GetMapAsMacroblock()` snapshots and compare normalized
  placement multisets once the editor has settled. Last-frame capture alone is
  insufficient because Map Together suppresses its own received/replayed changes.
  Coalesce snapshot work and measure large-map cost. An explicit post-apply callback
  in Map Together would be a better incremental path later.
- **Acknowledgment:** `WaitUntilIdle` only checks connection stage and pending
  incoming queue length. It does not prove a particular browser action was sent
  and acknowledged. Use operation IDs, settled readback and reconciliation; a
  second client must validate room propagation during the prototype.
- **Identity:** trackedit IDs are local; macroblock placement specs do not carry
  those IDs. Preserve a mapping and occurrence counts for duplicate identical
  placements. Game object pointers are unsuitable as persistent identifiers
  because replay can recreate objects.
- **Coordinates:** trackedit uses 32 x 8 x 32 cells and currently defaults to a
  64 m free-position Y adjustment. Editor++ specs use another macroblock offset,
  typically +56 m, and grid block specs subtract one Y cell internally. Use game
  world positions with the factory APIs and explicitly undo spec offsets when
  reading snapshots; do not copy JSON coordinates straight into network specs.
  Query map-dependent offsets. See [Map.as](https://github.com/XertroV/tm-editor-plus-plus/blob/0641f74279b799a2f0f139f54545ea50820b9dc4/src/Editor/Map.as)
  and [spec factories](https://github.com/XertroV/tm-editor-plus-plus/blob/0641f74279b799a2f0f139f54545ea50820b9dc4/src/Editor/MacroblockManip.as).
- **Rotations/metadata:** trackedit JSON is yaw/pitch/roll; Editor++ uses
  pitch/yaw/roll. Convert explicitly. Translate flags by meaning rather than
  copying GBX flag integers. Preserve ground/ghost state, variants, colors,
  author/collection, and item pivot/scale when supported.
- **Layers:** game placements are flattened. Keep trackedit layers locally and
  preserve them during reconciliation. Initially treat layer visibility as local
  UI state: `exportDump` omits hidden layers, so using it blindly as a live-state
  snapshot would incorrectly turn hiding a layer into game deletions.
- **Undo/concurrency:** remote edits should not enter local undo history or be
  emitted back as new browser edits. A local undo must become an inverse live
  operation with a precondition, not a whole-map restore. Reject stale operations
  when the target changed remotely. Full reset/import requires explicit session
  handling, not automatic bulk replacement.
- **Scope:** terrain, skins, embedded/custom assets, and arbitrary map metadata
  exceed the initial placement bridge. Trackedit's present placement model does
  not represent all of these. Preserve unknown game content while editing the
  supported subset; never rebuild the whole game map from our lossy projection.

## Smallest useful prototype and acceptance checks

1. Verify installed versions and resolve the missing Editor++ hooks. Compile a
   bridge exposing sanitized Map Together status and a read-only map snapshot.
2. Import the running map into a new live document, then place/delete one official
   air grid block through Editor++ while already joined to a room. Confirm it
   appears exactly once both locally and on a second Map Together client.
3. Add a free block and a stock item. Test all four grid directions, nonzero
   pitch/yaw/roll, multiple heights, and a transformed layer against game readback.
4. Add settled snapshot reconciliation. Edit from the browser, the local game,
   and the second room participant. Check duplicate placements, deletion,
   replacement, undo, and absence of rebroadcast loops.
5. Test loading, driving/test mode, non-place edit mode, disconnect/reconnect,
   changed room/map, rejected placement, and a dropped response. Retries must not
   duplicate placements; stale queued operations must not affect another session.

The first milestone is status + snapshot + one verified room-synchronized block.
Bidirectional editing should follow only after that path and version pairing are
proven in the game. No Map Together server modification appears necessary for
this approach; that remains a source-based feasibility conclusion, not a tested
integration claim.
