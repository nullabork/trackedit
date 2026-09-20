// Trackedit Extract: batch-extracts a known list of game files by path via
// the Fids API (works even for files whose names Pack Explorer can't
// resolve). Output lands in OpenplanetNext/Extract, same as manual
// extraction — trackedit's tools/setup.ps1 then turns it into web meshes.
//
// extract_list.txt ships with the plugin (the complete set trackedit needs).
// After a game update adds blocks, regenerate additions with meshdump
// "missing" and append them.

bool g_run = false;

void RenderMenu()
{
    if (UI::MenuItem("\\$9cfTrackedit Extract\\$z (run file extraction)")) {
        g_run = true;
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

    print("Trackedit extract done: " + ok + " extracted, " + miss + " not found/failed, " + total + " total");
    UI::ShowNotification("Trackedit Extract", "Done: " + ok + " extracted, " + miss + " skipped of " + total);
}
