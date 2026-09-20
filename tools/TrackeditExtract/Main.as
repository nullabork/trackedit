// Trackedit Extract: batch-extracts a known list of game files by path via
// the Fids API (works even for files whose names Pack Explorer can't
// resolve). Output lands in OpenplanetNext/Extract, same as manual
// extraction — trackedit's tools/setup.ps1 then turns it into web meshes.
//
// extract_list.txt ships with the plugin (the complete set trackedit needs).
// After a game update adds blocks, regenerate additions with meshdump
// "missing" and append them.

bool g_run = false;
// The car model alone (ExtractCar below) — the full run does it too.
bool g_carOnly = false;

void RenderMenu()
{
    if (UI::MenuItem("\\$9cfTrackedit Extract\\$z (run file extraction)")) {
        g_run = true;
    }
    if (UI::MenuItem("\\$9cfTrackedit Extract\\$z (car model only)")) {
        g_carOnly = true;
    }
}

void Main()
{
    while (true) {
        if (g_run) {
            g_run = false;
            RunExtraction();
        }
        if (g_carOnly) {
            g_carOnly = false;
            int n = ExtractCar();
            UI::ShowNotification("Trackedit Extract", "Car model: " + n + " files extracted");
        }
        yield();
    }
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

    ok += ExtractCar();

    print("Trackedit extract done: " + ok + " extracted, " + miss + " not found/failed, " + total + " total");
    UI::ShowNotification("Trackedit Extract", "Done: " + ok + " extracted, " + miss + " skipped of " + total);
}

// --- the car model -----------------------------------------------------------
// trackedit plays driving lines back with the game's car. It is not in extract_list.txt:
// the models are whole FOLDERS under GameData/Skins/Models/CarSport — Snow, Rally and
// Desert each with a MainBody.Mesh.gbx, the Stadium car's body under
// Stadium/Prestige/Ranked and its textures under Stadium/Common. (Found by walking the
// file tree once; the hundred-odd national "Stadium_XXX.zip" files beside the folders are
// empty placeholders and are left alone.)

int ExtractCarFolder(CSystemFidsFolder@ folder, int depth)
{
    if (folder is null || depth > 4) return 0;
    Fids::UpdateTree(folder);
    int ok = 0;
    for (uint i = 0; i < folder.Leaves.Length; i++) {
        auto fid = folder.Leaves[i];
        if (fid is null) continue;
        Fids::Preload(fid);
        if (Fids::Extract(fid)) ok++;
        if (i % 8 == 7) yield(); // textures are big: stay under the script time limit
    }
    yield();
    for (uint i = 0; i < folder.Trees.Length; i++) ok += ExtractCarFolder(folder.Trees[i], depth + 1);
    return ok;
}

int ExtractCar()
{
    array<string> folders = { "Stadium", "Snow", "Rally", "Desert" };
    int ok = 0;
    for (uint i = 0; i < folders.Length; i++)
        ok += ExtractCarFolder(Fids::GetGameFolder("GameData/Skins/Models/CarSport/" + folders[i]), 0);
    print("Trackedit extract: car model, " + ok + " files");
    return ok;
}
