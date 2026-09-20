/// <summary>
/// Where the game is installed — for the few things that ship as plain files next to
/// Trackmania.exe instead of inside the packs the Openplanet extraction covers
/// (Packs/Stadium_Skins.zip). TRACKEDIT_GAME_DIR wins; otherwise the usual places of the
/// Steam, Epic and Ubisoft Connect installs on every fixed drive.
/// </summary>
static class GameInstall
{
    /// <summary>The file in EVERY install found: an old copy of the game next to the current one
    /// (an abandoned launcher's) may hold less, so callers merge rather than take the first.</summary>
    public static List<string> FindAll(params string[] relative) =>
        Candidates().Select(dir => Path.Combine([dir, .. relative])).Where(File.Exists).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    static IEnumerable<string> Candidates()
    {
        if (Environment.GetEnvironmentVariable("TRACKEDIT_GAME_DIR") is { Length: > 0 } env) yield return env;
        if (OperatingSystem.IsWindows())
        {
            foreach (var drive in DriveInfo.GetDrives().Where(d => d.DriveType == DriveType.Fixed).Select(d => d.RootDirectory.FullName))
            {
                yield return Path.Combine(drive, "SteamLibrary", "steamapps", "common", "Trackmania");
                yield return Path.Combine(drive, "Program Files (x86)", "Steam", "steamapps", "common", "Trackmania");
                yield return Path.Combine(drive, "Program Files", "Epic Games", "TrackmaniaNext");
                yield return Path.Combine(drive, "Program Files (x86)", "Ubisoft", "Ubisoft Game Launcher", "games", "Trackmania");
                yield return Path.Combine(drive, "Games", "Trackmania");
            }
        }
        else
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            yield return Path.Combine(home, ".steam", "steam", "steamapps", "common", "Trackmania");
            yield return Path.Combine(home, ".local", "share", "Steam", "steamapps", "common", "Trackmania");
        }
    }
}
