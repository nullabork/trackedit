// Snapshot transport intentionally reads the actual map, not Editor++'s capture
// buffers: other plugins may suppress those buffers while replaying remote edits.
uint SnapshotRevision = 0;
string SnapshotContent;
Json::Value@ LatestSnapshot;
vec3 MacroOffset;
bool Watching = false;
const array<string> ColorNames = {"Default", "White", "Green", "Blue", "Red", "Black"};

Json::Value@ VecJson(vec3 v) {
    auto a = Json::Array();
    a.Add(Math::Round(v.x * 10000.0) / 10000.0);
    a.Add(Math::Round(v.y * 10000.0) / 10000.0);
    a.Add(Math::Round(v.z * 10000.0) / 10000.0);
    return a;
}
vec3 JsonVec(Json::Value@ a) { return vec3(float(a[0]), float(a[1]), float(a[2])); }

CGameCtnBlock@[]@ MapBlocks(CGameCtnEditorFree@ editor) {
    CGameCtnBlock@[] blocks;
    auto pmt = editor.PluginMapType;
    for (uint i = 0; i < pmt.ClassicBlocks.Length; i++) {
        auto b = pmt.ClassicBlocks[i];
        if (b.BlockInfo !is null && !b.BlockInfo.IsClip && !b.BlockInfo.IsTerrain) blocks.InsertLast(b);
    }
    for (uint i = 0; i < pmt.GhostBlocks.Length; i++) {
        auto b = pmt.GhostBlocks[i];
        if (b.BlockInfo !is null && !b.BlockInfo.IsClip && !b.BlockInfo.IsTerrain) blocks.InsertLast(b);
    }
    return blocks;
}

Json::Value@ BlockRecord(CGameCtnBlock@ b) {
    auto spec = Editor::MakeBlockSpec(b);
    auto o = Json::Object();
    o["name"] = spec.name;
    o["coord"] = spec.isFree ? VecJson(vec3()) : VecJson(vec3(b.Coord.x, b.Coord.y, b.Coord.z));
    o["dir"] = spec.isFree ? 0 : int(b.Direction);
    o["isFree"] = spec.isFree;
    o["isGhost"] = !spec.isFree && spec.isGhost;
    o["isGround"] = !spec.isFree && spec.isGround;
    o["absPos"] = spec.isFree ? VecJson(spec.pos - MacroOffset) : VecJson(vec3());
    o["yawPitchRoll"] = spec.isFree ? VecJson(vec3(spec.pyr.y, spec.pyr.x, spec.pyr.z)) : VecJson(vec3());
    o["color"] = ColorNames[uint(spec.color) % ColorNames.Length];
    o["variant"] = spec.variant;
    o["autoVariant"] = false;
    o["mobilIndex"] = spec.mobilIx;
    o["mobilVariant"] = spec.mobilVariant;
    o["lightmapQuality"] = uint(spec.lmQual);
    o["waypoint"] = Json::Parse("null");
    if (spec.waypoint !is null) {
        auto wp = Json::Object();
        wp["tag"] = spec.waypoint.tag;
        wp["order"] = spec.waypoint.order;
        o["waypoint"] = wp;
    }
    // Keep skinned blocks visible, but don't reconstruct their unmodeled skin data.
    o["protected"] = b.Skin !is null;
    return o;
}

Json::Value@ CaptureSnapshot() {
    if (!Ready()) return null;
    auto editor = cast<CGameCtnEditorFree>(GetApp().Editor);
    auto model = editor.PluginMapType.GetBlockModelFromName("RoadTechStraight");
    if (model is null) throw("Live sync currently requires a Stadium block collection.");
    // The public free-block factory adds the decoration's macroblock offset.
    MacroOffset = Editor::MakeBlockSpec(model, vec3(), vec3()).pos;
    auto o = Json::Object();
    o["mapSession"] = MapSession();
    o["mapName"] = string(editor.Challenge.MapName);
    o["decoration"] = editor.Challenge.DecorationName;
    auto size = editor.Challenge.Size;
    o["size"] = VecJson(vec3(size.x, size.y, size.z));
    o["yOffset"] = (MacroOffset.y + 8.0) / 8.0;
    auto blocks = Json::Array();
    auto mapBlocks = MapBlocks(editor);
    for (uint i = 0; i < mapBlocks.Length; i++) blocks.Add(BlockRecord(mapBlocks[i]));
    o["blocks"] = blocks;
    // Items are imported for context and remain read-only in the browser.
    auto items = Json::Array();
    for (uint i = 0; i < editor.Challenge.AnchoredObjects.Length; i++) {
        auto item = editor.Challenge.AnchoredObjects[i];
        auto spec = Editor::MakeItemSpec(item);
        auto rec = Json::Object();
        rec["name"] = spec.name;
        rec["absPos"] = VecJson(item.AbsolutePositionInMap);
        rec["yawPitchRoll"] = VecJson(vec3(item.Yaw, item.Pitch, item.Roll));
        rec["itemAuthor"] = spec.author;
        rec["scale"] = spec.scale;
        rec["pivot"] = VecJson(spec.pivotPos);
        rec["color"] = ColorNames[uint(spec.color) % ColorNames.Length];
        items.Add(rec);
    }
    o["items"] = items;
    string content = Json::Write(o);
    if (content != SnapshotContent) {
        SnapshotRevision++;
        SnapshotContent = content;
    }
    o["revision"] = SnapshotRevision;
    @LatestSnapshot = o;
    return o;
}

bool EqualRecord(Json::Value@ a, Json::Value@ b, bool defaultMobil = false) {
    if (string(a["name"]) != string(b["name"]) || string(a["color"]) != string(b["color"])) return false;
    const array<string> flags = {"isFree", "isGhost", "isGround", "protected"};
    for (uint i = 0; i < flags.Length; i++) if (bool(a[flags[i]]) != bool(b[flags[i]])) return false;
    const array<string> nums = {"dir", "mobilIndex", "lightmapQuality"};
    for (uint i = 0; i < nums.Length; i++) if (uint(a[nums[i]]) != uint(b[nums[i]])) return false;
    // Only the requested new block (b) may permit a game-selected variant.
    // Removal matching remains exact, including concrete imported variants.
    bool autoVariant = defaultMobil && b.HasKey("autoVariant") && bool(b["autoVariant"]);
    if (!autoVariant && uint(a["variant"]) != uint(b["variant"])) return false;
    if (!(defaultMobil && (uint(a["mobilVariant"]) == 63 || uint(b["mobilVariant"]) == 63)))
        if (uint(a["mobilVariant"]) != uint(b["mobilVariant"])) return false;
    const array<string> vectors = {"coord", "absPos", "yawPitchRoll"};
    for (uint i = 0; i < vectors.Length; i++)
        for (uint j = 0; j < 3; j++) if (Math::Abs(float(a[vectors[i]][j]) - float(b[vectors[i]][j])) > 0.00015) return false;
    bool aw = a["waypoint"].GetType() == Json::Type::Object;
    bool bw = b["waypoint"].GetType() == Json::Type::Object;
    if (aw != bw) return false;
    return !aw || (string(a["waypoint"]["tag"]) == string(b["waypoint"]["tag"]) && uint(a["waypoint"]["order"]) == uint(b["waypoint"]["order"]));
}

Editor::BlockSpec@ SpecFromRecord(Json::Value@ rec, CGameCtnEditorFree@ editor) {
    if (bool(rec["protected"])) throw("Live sync cannot modify blocks with skins yet.");
    auto model = editor.PluginMapType.GetBlockModelFromName(string(rec["name"]));
    if (model is null) throw("Block model unavailable in game: " + string(rec["name"]));
    Editor::BlockSpec@ spec;
    if (bool(rec["isFree"])) {
        vec3 ypr = JsonVec(rec["yawPitchRoll"]);
        @spec = Editor::MakeBlockSpec(model, JsonVec(rec["absPos"]), vec3(ypr.y, ypr.x, ypr.z));
    } else {
        nat3 coord = nat3(uint(rec["coord"][0]), uint(rec["coord"][1]), uint(rec["coord"][2]));
        auto size = editor.Challenge.Size;
        if (coord.y == 0 || coord.x >= size.x || coord.y >= size.y || coord.z >= size.z) throw("Block grid cell is outside the supported game bounds.");
        @spec = Editor::MakeBlockSpec(model, coord, int(rec["dir"]));
        spec.isGround = bool(rec["isGround"]);
        spec.isGhost = bool(rec["isGhost"]);
    }
    for (uint i = 0; i < ColorNames.Length; i++) if (ColorNames[i] == string(rec["color"])) spec.color = CGameCtnBlock::EMapElemColor(i);
    spec.variant = uint(rec["variant"]);
    spec.mobilIx = uint(rec["mobilIndex"]);
    spec.mobilVariant = uint(rec["mobilVariant"]);
    spec.lmQual = CGameCtnBlock::EMapElemLightmapQuality(uint(rec["lightmapQuality"]));
    if (rec["waypoint"].GetType() == Json::Type::Object)
        @spec.waypoint = Editor::WaypointSpec(string(rec["waypoint"]["tag"]), uint(rec["waypoint"]["order"]));
    return spec;
}

uint CountRecords(Json::Value@ records, Json::Value@ target) {
    uint count = 0;
    for (uint i = 0; i < records.Length; i++) if (EqualRecord(records[i], target, true)) count++;
    return count;
}

Json::Value@ ApplySync(Json::Value@ cmd) {
    string reason = ReadinessError();
    if (reason.Length > 0) throw(reason);
    auto p = cmd["payload"];
    auto before = CaptureSnapshot();
    if (string(p["mapSession"]) != MapSession()) throw("Game map changed. Reconnect to load it.");
    auto result = Json::Object();
    if (uint(p["revision"]) != SnapshotRevision) {
        result["ok"] = false;
        result["conflict"] = true;
        result["snapshot"] = before;
        return result;
    }
    auto editor = cast<CGameCtnEditorFree>(GetApp().Editor);
    auto mapBlocks = MapBlocks(editor);
    CGameCtnBlock@[] remove;
    array<bool> used(mapBlocks.Length, false);
    auto toRemove = p["remove"];
    auto toAdd = p["add"];
    trace("Sync revision " + SnapshotRevision + ": remove " + toRemove.Length + ", add " + toAdd.Length);
    // Resolve every target and every model before mutating the map.
    for (uint i = 0; i < toRemove.Length; i++) {
        if (bool(toRemove[i]["protected"])) throw("Live sync cannot modify blocks with skins yet.");
        bool found = false;
        for (uint j = 0; j < mapBlocks.Length; j++) {
            if (!used[j] && EqualRecord(BlockRecord(mapBlocks[j]), toRemove[i])) {
                used[j] = true; remove.InsertLast(mapBlocks[j]); found = true; break;
            }
        }
        if (!found) throw("A block changed before deletion. Sync stopped.");
    }
    auto additions = Editor::MakeMacroblockSpec();
    for (uint i = 0; i < toAdd.Length; i++) additions.Blocks.InsertLast(SpecFromRecord(toAdd[i], editor));
    // Preserve the native undo boundary; a whole batch becomes one game undo step.
    bool changed = false;
    try {
        if (remove.Length > 0) {
            changed = true;
            Editor::DeleteBlocks(remove, false);
            if (Editor::HasPendingFreeBlocksToDelete()) Editor::RunDeleteFreeBlockDetection();
        }
        if (toAdd.Length > 0) {
            changed = true;
            if (!Editor::PlaceMacroblock(additions, false)) throw("Game rejected part of the block batch.");
        }
        if (changed) editor.PluginMapType.AutoSave();
    } catch {
        if (changed) editor.PluginMapType.AutoSave();
        throw(getExceptionInfo() + " The game may contain a partial edit; reconnect to inspect it.");
    }
    auto after = CaptureSnapshot();
    if (after is null) throw("Editor became unavailable after applying the batch. Reconnect to inspect it.");
    // The bridge verifies the final multiset against this revision before
    // acknowledging success, including game-selected replacement variants.
    result["ok"] = true;
    result["snapshot"] = after;
    result["message"] = "Blocks synchronized";
    return result;
}
