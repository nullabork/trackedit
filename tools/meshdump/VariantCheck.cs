using System.Text.Json;
using GBX.NET;
using GBX.NET.Engines.Game;
using GBX.NET.LZO;

namespace Trackedit;

/// <summary>
/// Verifies, for every block of a map, that the variant the map names exists
/// in the game's definition of that block.
///
/// A placed block selects its look with two things in its flags: the ground
/// bit (the air or the ground list) and a variant index (bits 21+: 0 = the
/// base, 1… = AdditionalVariantsAir / AdditionalVariantsGround). If that
/// reading of the flags is right, no block of any map may name an index its
/// definition does not have — so this is both a check of a map and, over
/// tens of thousands of blocks, of the reading itself.
///
/// Writes a JSON report (per block name: counts per variant, the variants the
/// definition has, and whether the extraction holds a mesh for each), and
/// prints the summary with every problem found.
/// </summary>
public static class VariantCheck
{
    public static int Run(string mapPath, string gameDataRoot, string? meshesDir, string? reportPath)
    {
        Gbx.LZO = new Lzo();
        var map = Gbx.ParseNode<CGameCtnChallenge>(mapPath);
        var blocks = (map.Blocks ?? []).Where(b => !b.IsClip).ToList();

        // Definitions by block name (the file stem up to the first dot).
        var files = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in Directory.EnumerateFiles(Path.Combine(gameDataRoot, "GameCtnBlockInfo"), "*.Gbx", SearchOption.AllDirectories))
        {
            var stem = Path.GetFileName(f);
            stem = stem[..stem.IndexOf('.')];
            files.TryAdd(stem, f);
        }
        var index = meshesDir is not null && File.Exists(Path.Combine(meshesDir, "index.json"))
            ? JsonDocument.Parse(File.ReadAllText(Path.Combine(meshesDir, "index.json"))).RootElement.GetProperty("blocks")
            : (JsonElement?)null;

        var defs = new Dictionary<string, (int Air, int Ground, string[] AirNames, string[] GroundNames)?>();
        var rows = new SortedDictionary<string, Row>(StringComparer.Ordinal);
        int custom = 0, undefinedBlocks = 0, outOfRange = 0, noMesh = 0;
        var problems = new List<string>();

        foreach (var b in blocks)
        {
            var name = b.Name;
            if (name.EndsWith("_CustomBlock", StringComparison.OrdinalIgnoreCase)) { custom++; continue; }
            if (!defs.TryGetValue(name, out var def))
            {
                def = null;
                if (files.TryGetValue(name, out var file))
                {
                    try
                    {
                        if (Gbx.ParseNode(file) is CGameCtnBlockInfo info)
                        {
                            var air = info.AdditionalVariantsAir ?? [];
                            var ground = info.AdditionalVariantsGround ?? [];
                            def = (air.Length, ground.Length,
                                new[] { info.VariantBaseAir?.Name ?? "" }.Concat(air.Select(v => v?.Name ?? "")).ToArray(),
                                new[] { info.VariantBaseGround?.Name ?? "" }.Concat(ground.Select(v => v?.Name ?? "")).ToArray());
                        }
                    }
                    catch { /* unreadable definition: reported as undefined */ }
                }
                defs[name] = def;
            }
            if (def is null) { undefinedBlocks++; continue; }

            var variant = (b.Flags >> 21) & 0x3f;
            var ground_ = b.IsGround;
            var available = ground_ ? def.Value.Ground : def.Value.Air;
            if (!rows.TryGetValue(name, out var row))
                rows[name] = row = new Row { AirVariants = def.Value.AirNames, GroundVariants = def.Value.GroundNames };
            var key = (ground_ ? "ground" : "air") + (variant == 0 ? "" : variant.ToString());
            row.Used[key] = row.Used.GetValueOrDefault(key) + 1;

            if (variant > available)
            {
                outOfRange++;
                if (problems.Count < 40)
                    problems.Add($"{name} at {b.Coord} names {(ground_ ? "ground" : "air")} variant {variant}, but its definition has only {available} additional");
            }
            else if (variant > 0 && index is { } idx && idx.TryGetProperty(name, out var entry))
            {
                // A variant without a mesh of its own is fine when it looks like
                // its base (the extractor drops identical ones) — but then the
                // tables must still list it.
                var hasTable = entry.TryGetProperty("units", out var units) && units.TryGetProperty(key, out _);
                if (!hasTable) { noMesh++; row.NotExtracted.Add(key); }
            }
        }

        var byVariant = rows.Values.SelectMany(r => r.Used).GroupBy(kv => kv.Key).ToDictionary(g => g.Key, g => g.Sum(kv => kv.Value));
        Console.WriteLine($"{map.MapName}: {blocks.Count} blocks, {custom} custom (not checked), {undefinedBlocks} without a readable definition");
        Console.WriteLine("  by variant: " + string.Join(", ", byVariant.OrderBy(kv => kv.Key).Select(kv => $"{kv.Key} {kv.Value}")));
        Console.WriteLine($"  naming a variant their definition does not have: {outOfRange}");
        if (index is not null) Console.WriteLine($"  naming a variant the extraction does not know yet (re-extract blocks): {noMesh}");
        foreach (var p in problems) Console.WriteLine("  ! " + p);

        if (reportPath is not null)
        {
            File.WriteAllText(reportPath, JsonSerializer.Serialize(new
            {
                map = map.MapName,
                blocks = blocks.Count,
                custom,
                undefinedBlocks,
                outOfRange,
                notExtracted = noMesh,
                byVariant,
                perBlock = rows.ToDictionary(kv => kv.Key, kv => new
                {
                    used = kv.Value.Used,
                    airVariants = kv.Value.AirVariants,
                    groundVariants = kv.Value.GroundVariants,
                    notExtracted = kv.Value.NotExtracted.Distinct().ToArray(),
                }),
            }, new JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"  report: {reportPath}");
        }
        return outOfRange == 0 ? 0 : 2;
    }

    private sealed class Row
    {
        public Dictionary<string, int> Used { get; } = new();
        public string[] AirVariants { get; init; } = [];
        public string[] GroundVariants { get; init; } = [];
        public List<string> NotExtracted { get; } = [];
    }
}
