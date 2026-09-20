// Trackedit Extract: batch-extracts a known list of game files by path via
// the Fids API (works even for files whose names Pack Explorer can't
// resolve). Output lands in OpenplanetNext/Extract, same as manual
// extraction — trackedit's tools/setup.ps1 then turns it into web meshes.
//
// extract_list.txt ships with the plugin (the complete set trackedit needs).
// After a game update adds blocks, regenerate additions with meshdump
// "missing" and append them.
//
// A line ending in "\*" names a FOLDER: every file in it, recursively. Used for
// the item skins (light colours), whose file names are not known in advance and
// which live outside GameData — so each folder is looked for under the game,
// user, fake and program-data roots, and the log says where it was found.

bool g_run = false;
// Only the folder lines (the skins): seconds instead of the full run.
bool g_foldersOnly = false;

void RenderMenu()
{
    if (UI::MenuItem("\\$9cfTrackedit Extract\\$z (run file extraction)")) {
        g_run = true;
        g_foldersOnly = false;
    }
    if (UI::MenuItem("\\$9cfTrackedit Extract\\$z (skins only)")) {
        g_run = true;
        g_foldersOnly = true;
    }
}

void Main()
{
    while (true) {
        if (g_run) {
            g_run = false;
            RunExtraction();
        }
        yield();
    }
}

// Every file of a folder tree. Returns how many were extracted.
int ExtractFolder(CSystemFidsFolder@ folder)
{
    if (folder is null) return 0;
    Fids::UpdateTree(folder);
    int ok = 0;
    for (uint i = 0; i < folder.Leaves.Length; i++) {
        auto fid = folder.Leaves[i];
        if (fid is null) continue;
        Fids::Preload(fid);
        if (Fids::Extract(fid)) ok++;
    }
    for (uint i = 0; i < folder.Trees.Length; i++) ok += ExtractFolder(folder.Trees[i]);
    return ok;
}

// A folder line: the first root that has it (with files in it) wins.
int ExtractFolderLine(const string &in path)
{
    array<string> roots = { "game", "user", "fake", "programdata" };
    for (uint r = 0; r < roots.Length; r++) {
        CSystemFidsFolder@ folder = null;
        if (roots[r] == "game") @folder = Fids::GetGameFolder(path);
        else if (roots[r] == "user") @folder = Fids::GetUserFolder(path);
        else if (roots[r] == "fake") @folder = Fids::GetFakeFolder(path);
        else @folder = Fids::GetProgramDataFolder(path);
        int n = ExtractFolder(folder);
        if (n > 0) {
            print("Trackedit extract: " + path + " -> " + n + " files (" + roots[r] + " root)");
            return n;
        }
    }
    print("Trackedit extract: folder not found under any root: " + path);
    return 0;
}

void RunExtraction()
{
    IO::FileSource list("extract_list.txt");
    int ok = 0;
    int miss = 0;
    int total = 0;

    print("Trackedit extract: starting...");

    while (!list.EOF()) {
        string line = list.ReadLine().Trim();
        if (line.Length == 0) continue;
        total++;

        if (line.EndsWith("\\*")) {
            int n = ExtractFolderLine(line.SubStr(0, line.Length - 2));
            if (n > 0) ok += n; else miss++;
            yield();
            continue;
        }
        if (g_foldersOnly) { total--; continue; }

        auto fid = Fids::GetGame(line);
        if (fid is null) {
            miss++;
        } else {
            // Some files only extract once their node has been loaded.
            Fids::Preload(fid);
            if (Fids::Extract(fid)) {
                ok++;
            } else {
                miss++;
            }
        }

        if (total % 100 == 0) {
            print("Trackedit extract: " + total + " processed, " + ok + " extracted...");
            yield();
        }
    }

    print("Trackedit extract done: " + ok + " extracted, " + miss + " not found/failed, " + total + " total");
    UI::ShowNotification("Trackedit Extract", "Done: " + ok + " extracted, " + miss + " skipped of " + total);
}
