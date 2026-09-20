// Sweep: the game's clips for EVERY block, not just the ones a map uses.
//
// In an EMPTY scratch map, each block model of the game is placed on its own
// (once in the air, once on the ground), the clip blocks the editor generates
// around it are recorded relative to the block, and it is removed again. The
// result is the full table of "which clip, in which cell, facing which way"
// that trackedit's extractor otherwise has to fit by shape.
//
// Refuses to run in a map that has blocks: it clears the map between blocks.
// Output: OpenplanetNext/PluginStorage/TrackeditTruth/sweep.json

bool g_sweeping = false;
bool g_stopSweep = false;
string g_sweepStatus;

const int SWEEP_X = 24;
const int SWEEP_Z = 24;
const int SWEEP_AIR_Y = 24;
const int SWEEP_GROUND_Y = 9;

uint CountRealBlocks(CGameEditorPluginMapMapType@ pmt)
{
    uint n = 0;
    for (uint i = 0; i < pmt.ClassicBlocks.Length; i++) {
        auto b = pmt.ClassicBlocks[i];
        if (b.BlockInfo !is null && !b.BlockInfo.IsClip && !b.BlockInfo.IsTerrain) n++;
    }
    return n + pmt.GhostBlocks.Length;
}

Json::Value@ SweepOne(CGameEditorPluginMapMapType@ pmt, CGameCtnBlockInfo@ model, int y, const string &in where)
{
    auto rec = Json::Object();
    rec["name"] = string(model.IdName);
    rec["where"] = where;
    bool placed = pmt.PlaceBlock(model, int3(SWEEP_X, y, SWEEP_Z), CGameEditorPluginMap::ECardinalDirections::North);
    rec["placed"] = placed;
    if (!placed) return rec;
    yield(); // clips are generated with the placement; one frame for good measure

    // The block itself, as the block list reports it: clip cells are recorded
    // relative to it, so the editor API's coordinate origin does not matter.
    CGameCtnBlock@ self = null;
    for (uint i = 0; i < pmt.ClassicBlocks.Length; i++) {
        auto b = pmt.ClassicBlocks[i];
        if (b.BlockInfo !is null && !b.BlockInfo.IsClip && !b.BlockInfo.IsTerrain && string(b.BlockInfo.IdName) == string(model.IdName)) { @self = b; break; }
    }
    auto clips = Json::Array();
    auto others = Json::Array();
    if (self !is null) {
        rec["dir"] = int(self.Direction);
        for (uint i = 0; i < pmt.ClassicBlocks.Length; i++) {
            auto b = pmt.ClassicBlocks[i];
            if (b is self || b.BlockInfo is null || b.BlockInfo.IsTerrain) continue;
            auto o = Json::Object();
            o["name"] = string(b.BlockInfo.IdName);
            auto rel = Json::Array();
            rel.Add(int(b.Coord.x) - int(self.Coord.x));
            rel.Add(int(b.Coord.y) - int(self.Coord.y));
            rel.Add(int(b.Coord.z) - int(self.Coord.z));
            o["rel"] = rel;
            o["dir"] = int(b.Direction);
            if (b.BlockInfo.IsClip) clips.Add(o);
            else others.Add(o); // pillars and the like the game adds by itself
        }
    }
    rec["found"] = self !is null;
    rec["clips"] = clips;
    rec["others"] = others;
    pmt.RemoveAllBlocks();
    yield();
    return rec;
}

void RunSweep()
{
    g_sweeping = true;
    g_stopSweep = false;
    auto editor = cast<CGameCtnEditorFree>(GetApp().Editor);
    if (editor is null || editor.PluginMapType is null) {
        g_sweepStatus = "open a NEW EMPTY map in the map editor first";
        g_sweeping = false;
        return;
    }
    auto pmt = editor.PluginMapType;
    uint existing = CountRealBlocks(pmt);
    if (existing > 0) {
        g_sweepStatus = "refused: this map has " + existing + " blocks — the sweep clears the map, use a new empty one";
        g_sweeping = false;
        return;
    }

    auto results = Json::Array();
    uint total = pmt.BlockModels.Length;
    for (uint i = 0; i < total; i++) {
        if (g_stopSweep) break;
        // Leaving the editor mid-sweep ends it.
        if (cast<CGameCtnEditorFree>(GetApp().Editor) is null) break;
        auto model = pmt.BlockModels[i];
        if (model is null || model.IsClip || model.IsTerrain) continue;
        results.Add(SweepOne(pmt, model, SWEEP_AIR_Y, "air"));
        results.Add(SweepOne(pmt, model, SWEEP_GROUND_Y, "ground"));
        if (i % 20 == 0) g_sweepStatus = "block " + i + " of " + total;
    }

    auto root = Json::Object();
    root["models"] = total;
    root["complete"] = !g_stopSweep;
    root["results"] = results;
    string path = IO::FromStorageFolder("sweep.json");
    IO::File f(path, IO::FileMode::Write);
    f.Write(Json::Write(root));
    f.Close();
    g_sweepStatus = results.Length + " placements -> " + path;
    print("Trackedit Truth sweep: " + g_sweepStatus);
    g_sweeping = false;
}
