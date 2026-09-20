using System.Numerics;
using System.Text.Json;
using GBX.NET;
using GBX.NET.Engines.Plug;

/// <summary>
/// meshdump car &lt;GameDataRoot&gt; &lt;meshesDir&gt; — the car, for playing driving lines back.
///
/// The model is not part of the block/item extraction: it sits under
/// GameData/Skins/Models/CarSport (the extract plugin's "find &amp; extract the car model" walks
/// the game's file tree for it). Desert / Rally / Snow carry a MainBody.Mesh.gbx each; the
/// Stadium car's body is the one under Stadium/Prestige/Ranked, its textures under
/// Stadium/Common. Every model is a CPlugSolid2Model with four LODs — the second is written
/// as car/&lt;Name&gt;.obj, the base-colour textures (&lt;Material&gt;_B.dds) as PNGs, and car/index.json
/// lists what there is. Without the extraction nothing is written and the editor keeps its box.
/// </summary>
static class CarDump
{
    public static int Run(string gameDataStadium, string meshesDir)
    {
        // The argument is …/Extract/GameData/Stadium like every other command's.
        var models = Path.GetFullPath(Path.Combine(gameDataStadium, "..", "Skins", "Models", "CarSport"));
        if (!Directory.Exists(models))
        {
            Console.WriteLine($"car: nothing under {models} — run \"Trackedit Extract (find & extract the car model)\" in the game");
            return 0;
        }
        var outDir = Path.Combine(meshesDir, "car");
        Directory.CreateDirectory(outDir);
        var index = new Dictionary<string, object?>();
        foreach (var (name, mesh, textures) in new[]
        {
            ("Stadium", Path.Combine(models, "Stadium", "Prestige", "Ranked", "MainBody.Mesh.gbx"), Path.Combine(models, "Stadium", "Common")),
            ("Snow", Path.Combine(models, "Snow", "MainBody.Mesh.gbx"), Path.Combine(models, "Snow")),
            ("Rally", Path.Combine(models, "Rally", "MainBody.Mesh.gbx"), Path.Combine(models, "Rally")),
            ("Desert", Path.Combine(models, "Desert", "MainBody.Mesh.gbx"), Path.Combine(models, "Desert")),
        })
        {
            if (!File.Exists(mesh)) continue;
            try
            {
                if (Gbx.ParseNode(mesh) is not CPlugSolid2Model model) continue;
                var entry = Export(model, name, textures, outDir);
                if (entry is not null) index[name] = entry;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"  car {name}: {ex.Message}");
            }
        }
        File.WriteAllText(Path.Combine(outDir, "index.json"), JsonSerializer.Serialize(index));
        Console.WriteLine($"car: {index.Count} models -> {outDir}");
        return 0;
    }

    static Dictionary<string, object?>? Export(CPlugSolid2Model model, string name, string textureDir, string outDir)
    {
        var geoms = model.ShadedGeoms;
        if (geoms is null || model.Visuals is null) return null;
        var builder = new ObjBuilder();
        // The second LOD when there is one: a marker seen from a chase camera does not need the
        // showroom mesh (7 MB of OBJ), and the silhouette is the same.
        var lod = geoms.Any(g => (g.LodMask & 2) != 0) ? 2 : 1;
        var used = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var geom in geoms)
        {
            if ((geom.LodMask & lod) == 0) continue;
            if (model.Visuals[geom.VisualIndex] is not CPlugVisualIndexedTriangles visual) continue;
            // "…Decal…" layers are damage overlays: nothing to show on an undamaged car.
            var material = MaterialName(model, geom.MaterialIndex);
            if (material is null) continue;
            used.Add(material);
            builder.AddVisual(visual, Quaternion.Identity, Vector3.Zero, material, null);
        }
        if (builder.IsEmpty) return null;
        File.WriteAllText(Path.Combine(outDir, name + ".obj"), builder.ToObj());

        // Base colour per material: "<Material>_B.dds" beside the model (Skin, Details, Wheels; Glass has none).
        var materials = new Dictionary<string, string?>();
        foreach (var m in used)
        {
            var dds = Directory.Exists(textureDir)
                ? Directory.EnumerateFiles(textureDir, "*.dds").FirstOrDefault(f => Path.GetFileName(f).Equals(m + "_B.dds", StringComparison.OrdinalIgnoreCase))
                : null;
            string? png = null;
            if (dds is not null)
            {
                try
                {
                    Dumper.ConvertDds(dds, Path.Combine(outDir, $"{name}_{m}.png"));
                    png = $"car/{name}_{m}.png";
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"  car texture {m}: {ex.Message}");
                }
            }
            materials[m] = png;
        }
        Console.WriteLine($"  car {name}: bounds x {builder.Min.X:0.##}..{builder.Max.X:0.##} y {builder.Min.Y:0.##}..{builder.Max.Y:0.##} z {builder.Min.Z:0.##}..{builder.Max.Z:0.##}; materials {string.Join(", ", materials.Select(kv => kv.Key + (kv.Value is null ? " (flat)" : "")))}");
        return new Dictionary<string, object?>
        {
            ["obj"] = $"car/{name}.obj",
            ["materials"] = materials,
            ["min"] = new[] { builder.Min.X, builder.Min.Y, builder.Min.Z },
            ["max"] = new[] { builder.Max.X, builder.Max.Y, builder.Max.Z },
        };
    }

    /// <summary>
    /// The texture set a car material draws from — "Skin", "Details", "Wheels", "Glass", "Gem"… —
    /// which is the last word of its name ("_SkinDmg_Skin", "_DetailsDmgNormal_Wheels"). Null
    /// for the damage decal layers.
    /// </summary>
    static string? MaterialName(CPlugSolid2Model model, int i)
    {
        string? raw = null;
        if (model.MaterialIds?.Length > i) raw = model.MaterialIds[i];
        else if (model.CustomMaterials?.ElementAtOrDefault(i)?.MaterialName is { Length: > 0 } custom) raw = custom;
        else if (model.Materials?.Length > i) raw = model.Materials[i].File?.FilePath;
        if (string.IsNullOrEmpty(raw)) return $"Material{i}";
        var stem = Path.GetFileName(raw.Replace('\\', '/'));
        var dot = stem.IndexOf('.');
        var name = new string((dot > 0 ? stem[..dot] : stem).Where(c => char.IsLetterOrDigit(c) || c == '_').ToArray());
        if (name.Contains("Decal", StringComparison.OrdinalIgnoreCase)) return null;
        var set = name[(name.LastIndexOf('_') + 1)..];
        // The Stadium body comes from the ranked prestige skin, the only place it ships as a
        // mesh: its medal and gems are that skin's ornaments, not the car.
        return set.StartsWith("Gem", StringComparison.Ordinal) || set.StartsWith("Prestige", StringComparison.Ordinal) ? null : set;
    }
}
