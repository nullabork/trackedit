using System.Text.Json;

/// <summary>
/// cap_turns.json: the quarter turn the GAME gives each top/bottom clip relative to its
/// block, keyed "block|variant|clip|face|x,y,z". Harvested from the clip blocks baked into map
/// files by `npm run cliptruth -- --harvest` (a turn is kept when seen at least twice and in
/// at least four of five sightings) and shipped beside the converter. Facts about the game's
/// blocks, not anyone's map.
/// </summary>
static class CapTurns
{
    private static readonly Lazy<Dictionary<string, int>> Table = new(() =>
    {
        foreach (var dir in new[] { AppContext.BaseDirectory, Path.Combine(Directory.GetCurrentDirectory(), "tools", "meshdump"), Directory.GetCurrentDirectory() })
        {
            var path = Path.Combine(dir, "cap_turns.json");
            if (!File.Exists(path)) continue;
            try
            {
                var table = JsonSerializer.Deserialize<Dictionary<string, int>>(File.ReadAllText(path)) ?? [];
                Console.WriteLine($"cap turns: {table.Count} caps placed by the game's own direction ({path})");
                return table;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"cap_turns.json unreadable: {ex.Message}");
            }
        }
        Console.WriteLine("cap turns: no cap_turns.json — every cap is oriented by shape fit");
        return [];
    });

    public static int? Find(string block, string variantTag, string clip, string face, int x, int y, int z) =>
        Table.Value.TryGetValue($"{block}|{variantTag}|{clip}|{face}|{x},{y},{z}", out var turn) ? turn : null;
}
