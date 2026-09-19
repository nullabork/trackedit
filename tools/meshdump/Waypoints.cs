using System.Text.Json;
using GBX.NET;
using GBX.NET.Engines.Game;
using GBX.NET.Engines.GameData;

namespace Trackedit;

/// <summary>
/// Which blocks and items are waypoints, read from the game's own
/// definitions (CGameCtnBlockInfo.WayPointType, CGameItemModel.WaypointType)
/// rather than guessed from names — "DecoPlatformDirtSlope2Start" is a slope,
/// not a start. Writes `waypoints.json`: { "<name>": "Start" | "Finish" |
/// "Checkpoint" | "StartFinish" | … }. The editor uses it to tag placements
/// it creates (a checkpoint without its waypoint property is just scenery in
/// the game) and to find the waypoints a driving line passes through.
/// </summary>
public static class Waypoints
{
    public static int Run(string root, string outDir)
    {
        var result = new SortedDictionary<string, string>(StringComparer.Ordinal);
        var files = Directory.EnumerateFiles(root, "*.Gbx", SearchOption.AllDirectories)
            .Where(f => f.Contains("GameCtnBlockInfo", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".Item.Gbx", StringComparison.OrdinalIgnoreCase))
            .ToList();
        Console.WriteLine($"scanning {files.Count} block and item definitions");
        int read = 0, failed = 0;
        foreach (var file in files)
        {
            try
            {
                switch (Gbx.ParseNode(file))
                {
                    case CGameCtnBlockInfo info:
                        read++;
                        if (info.WayPointType.ToString() is { } bt && bt != "None") result[info.Ident.Id] = bt;
                        break;
                    case CGameItemModel item:
                        read++;
                        if (item.WaypointType.ToString() is { } it && it != "None")
                            result[Path.GetRelativePath(Path.Combine(root, "Items"), file).Replace('/', '\\')] = it;
                        break;
                }
            }
            catch { failed++; }
        }
        Directory.CreateDirectory(outDir);
        var path = Path.Combine(outDir, "waypoints.json");
        File.WriteAllText(path, JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"{result.Count} waypoint definitions from {read} files ({failed} unreadable) -> {path}");
        foreach (var g in result.Values.GroupBy(v => v)) Console.WriteLine($"  {g.Key}: {g.Count()}");
        return 0;
    }
}
