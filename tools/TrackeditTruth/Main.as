// Trackedit Truth: a developer aid, not something a mapper needs.
//
// Around every block the game generates CLIP blocks — undersides, top plates,
// side walls, end caps — and keeps them in the editor's block lists. Map files
// do not store them, so trackedit has to work out which clip pieces show and
// which way each one faces. This dumps what the game itself decided for the
// map open in the editor: every clip block with its name, cell and direction,
// next to the ordinary blocks. tools/clip_truth.ts compares trackedit's result
// against it (npm run cliptruth).
//
// Output: OpenplanetNext/PluginStorage/TrackeditTruth/clips-<mapUid>.json
//
// A second menu entry sweeps EVERY block of the game in an empty map: Sweep.as.

string g_status;

void RenderMenu()
{
    if (UI::MenuItem("\\$9cfTrackedit Truth\\$z (dump clip blocks)" + (g_status.Length > 0 ? "  " + g_status : ""))) {
        g_status = Dump();
        print("Trackedit Truth: " + g_status);
    }
    // Every block of the game, one at a time, in an empty scratch map (Sweep.as).
    if (g_sweeping) {
        if (UI::MenuItem("\\$9cfTrackedit Truth\\$z (stop sweep)  " + g_sweepStatus)) g_stopSweep = true;
    } else if (UI::MenuItem("\\$9cfTrackedit Truth\\$z (sweep every block — EMPTY map only)" + (g_sweepStatus.Length > 0 ? "  " + g_sweepStatus : ""))) {
        startnew(RunSweep);
    }
}

void Main() {}

void AddRecord(CGameCtnBlock@ b, bool ghost, Json::Value@ clips, Json::Value@ blocks)
{
    if (b is null || b.BlockInfo is null || b.BlockInfo.IsTerrain) return;
    auto o = Json::Object();
    o["name"] = string(b.BlockInfo.IdName);
    auto c = Json::Array();
    c.Add(int(b.Coord.x));
    c.Add(int(b.Coord.y));
    c.Add(int(b.Coord.z));
    o["coord"] = c;
    o["dir"] = int(b.Direction);
    o["ghost"] = ghost;
    if (b.BlockInfo.IsClip) clips.Add(o);
    else blocks.Add(o);
}

string Dump()
{
    auto editor = cast<CGameCtnEditorFree>(GetApp().Editor);
    if (editor is null || editor.Challenge is null || editor.PluginMapType is null)
        return "open the map in the map editor first";
    auto pmt = editor.PluginMapType;
    auto clips = Json::Array();
    auto blocks = Json::Array();
    for (uint i = 0; i < pmt.ClassicBlocks.Length; i++) AddRecord(pmt.ClassicBlocks[i], false, clips, blocks);
    for (uint i = 0; i < pmt.GhostBlocks.Length; i++) AddRecord(pmt.GhostBlocks[i], true, clips, blocks);

    string uid = string(editor.Challenge.EdChallengeId);
    auto root = Json::Object();
    root["mapUid"] = uid;
    root["mapName"] = string(editor.Challenge.MapName);
    root["clips"] = clips;
    root["blocks"] = blocks;

    string path = IO::FromStorageFolder("clips-" + uid + ".json");
    IO::File f(path, IO::FileMode::Write);
    f.Write(Json::Write(root));
    f.Close();
    return clips.Length + " clip blocks, " + blocks.Length + " blocks -> " + path;
}
