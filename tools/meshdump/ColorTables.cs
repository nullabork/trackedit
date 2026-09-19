using System.Text.Json;
using System.Text.Json.Nodes;
using GBX.NET;

namespace Trackedit;

/// <summary>
/// Block paint in TM2020 resolves through two lookups: the map picks a
/// palette (Classic, Stunt, Red, Orange, …), and each material names a
/// colour target table (Default, Sport, Fun, TrackWall, Canopy, …) whose row
/// for that palette holds the five slot colours [White, Green, Blue, Red,
/// Black]. Openplanet extracts the tables as JSON next to the game data;
/// this exports them and records each material's table.
/// </summary>
public static class ColorTables
{
    private static readonly string[] SkipKeys = ["ClassId", "Colors", "Colors_Blind", "TM_Stunt", "TM_Stunt_Blind"];

    public static int Export(string root, string outDir)
    {
        var dir = Fs.Fix(Path.Combine(root, "Media", "ColorTargetTables"));
        if (!Directory.Exists(dir))
        {
            Console.Error.WriteLine($"no colour tables at {dir}");
            return 1;
        }
        var tables = new JsonObject();
        foreach (var file in Directory.EnumerateFiles(dir, "*.ColorTable.gbx.json"))
        {
            var name = Path.GetFileName(file);
            name = name[..name.IndexOf('.')];
            var doc = JsonNode.Parse(File.ReadAllText(file), null,
                new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip })?.AsObject();
            if (doc is null) continue;
            var rows = new JsonObject();
            foreach (var (key, value) in doc)
            {
                if (SkipKeys.Contains(key) || key.EndsWith("_ColorBlind") || key.EndsWith("_Blind")) continue;
                if (value is not JsonArray arr || arr.Count != 5) continue;
                var row = new JsonArray();
                foreach (var c in arr)
                {
                    var hex = c?.GetValue<string>() ?? "#000000";
                    row.Add(hex.Length >= 7 ? hex[..7].ToLowerInvariant() : hex.ToLowerInvariant());
                }
                rows[key] = row;
            }
            tables[name] = rows;
        }
        Directory.CreateDirectory(outDir);
        File.WriteAllText(Path.Combine(outDir, "colortables.json"), tables.ToJsonString());
        Console.WriteLine($"colour tables: {tables.Count} written");

        // Annotate the material library with each material's table.
        var matsPath = Path.Combine(outDir, "materials.json");
        if (File.Exists(matsPath))
        {
            var mats = JsonNode.Parse(File.ReadAllText(matsPath))!.AsObject();
            var tagged = 0;
            foreach (var (name, entry) in mats)
            {
                if (entry is not JsonObject obj) continue;
                if (TableFor(root, name) is string table)
                {
                    obj["colorTable"] = table;
                    tagged++;
                }
            }
            File.WriteAllText(matsPath, mats.ToJsonString());
            Console.WriteLine($"materials: {tagged} tagged with a colour table");
        }
        return 0;
    }

    private static readonly Dictionary<string, string?> cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// The colour target table a library material uses, from its
    /// .Material.Gbx reference table; "Default" for paintable materials that
    /// name none (they carry a HueMask). Null when the material is unknown.
    /// Library names are "Name" or "Modifier.Name" (see Dumper.RegisterMaterial).
    /// </summary>
    public static string? TableFor(string root, string libraryName)
    {
        if (cache.TryGetValue(libraryName, out var cached)) return cached;
        string? result = null;
        var dot = libraryName.IndexOf('.');
        var candidates = dot > 0
            ? new[] { Path.Combine(root, "Media", "Modifier", libraryName[..dot], libraryName[(dot + 1)..] + ".Material.Gbx") }
            : new[]
            {
                Path.Combine(root, "Media", "Material", libraryName + ".Material.Gbx"),
                Path.Combine(root, "Media", "Material_BlockCustom", libraryName + ".Material.Gbx"),
            };
        foreach (var candidate in candidates)
        {
            var path = Fs.Fix(candidate);
            if (!File.Exists(path)) continue;
            try
            {
                var gbx = Gbx.Parse(path);
                foreach (var f in gbx.RefTable?.Files ?? [])
                {
                    var p = f.FilePath.Replace('\\', '/');
                    var i = p.IndexOf("ColorTargetTables/", StringComparison.OrdinalIgnoreCase);
                    if (i < 0) continue;
                    var file = p[(i + "ColorTargetTables/".Length)..];
                    result = file[..file.IndexOf('.')];
                    break;
                }
                if (result is null)
                {
                    // Paintable (hue-masked) materials without an explicit
                    // table use the default one.
                    var hasMask = (Gbx.ParseNode(path) as GBX.NET.Engines.Plug.CPlugMaterial)?.CustomMaterial?.Textures?
                        .Any(t => t.Name?.Contains("HueMask", StringComparison.OrdinalIgnoreCase) == true) == true;
                    if (hasMask) result = "Default";
                }
            }
            catch { /* unreadable material: no table */ }
            break;
        }
        cache[libraryName] = result;
        return result;
    }
}
