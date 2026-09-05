// meshdump: builds trackedit's block/item geometry + texture library from the
// user's own TM2020 game data (extracted once via Openplanet's Pack Explorer —
// the pak files themselves are encrypted with keys only the running game has).
//
// usage:
//   meshdump probe  <file.pak>                     - check pak readability
//   meshdump blocks <GameDataRoot> <outDir> [filter]
//   meshdump items  <GameDataRoot> <outDir> [filter]
//
// Output layout under <outDir> (the editor's public/meshes):
//   <BlockName>/{air|ground}.obj       one OBJ per block, usemtl per material
//   items/<ItemName>.obj               one OBJ per item
//   textures/<Material>.png            diffuse textures (DDS -> PNG, <=512px)
//   index.json                         { blocks: {name: {size, air, ground}},
//                                        items: {name: {obj}} }
//   materials.json                     { name: { texture } }
//
// index.json and materials.json are merged with what's already on disk, so
// blocks and items can be dumped in either order.

using System.Globalization;
using System.IO.Compression;
using System.Numerics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using GBX.NET;
using GBX.NET.Engines.Game;
using GBX.NET.Engines.GameData;
using GBX.NET.Engines.Plug;
using GBX.NET.LZO;
using GBX.NET.PAK;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

Gbx.LZO = new Lzo();

if (args.Length < 2)
{
    Console.Error.WriteLine("usage: meshdump probe <file.pak> | meshdump blocks|items <GameDataRoot> <outDir> [filter]");
    return 1;
}

switch (args[0])
{
    case "probe":
        return await ProbeAsync(args[1]);
    case "blocks":
    case "items":
        if (args.Length < 3)
        {
            Console.Error.WriteLine($"usage: meshdump {args[0]} <GameDataRoot> <outDir> [filter]");
            return 1;
        }
        var dumper = new Dumper(args[1], args[2], args.Length > 3 ? args[3] : null);
        return args[0] == "blocks" ? dumper.DumpBlocks() : dumper.DumpItems();
    case "embedded":
        {
            // Extract a map's embedded custom blocks/items into the editor's
            // mesh library so they render like everything else.
            if (args.Length < 3)
            {
                Console.Error.WriteLine("usage: meshdump embedded <map.Gbx> <outDir>");
                return 1;
            }
            return new EmbeddedDumper(args[2]).Dump(args[1]);
        }
    case "modinfo":
        {
            // Print a map's mod (custom texture pack) reference as JSON.
            var map = Gbx.ParseNode<CGameCtnChallenge>(args[1]);
            var mod = map.ModPackDesc;
            Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
            {
                file = mod?.FilePath,
                url = mod?.LocatorUrl?.ToString(),
            }));
            return 0;
        }
    case "modpack":
        {
            // Convert a downloaded mod zip into a texture override set:
            //   <outDir>/textures/<Material>.png + <outDir>/mod.json
            if (args.Length < 3)
            {
                Console.Error.WriteLine("usage: meshdump modpack <mod.zip> <outDir>");
                return 1;
            }
            var outRoot = args[2];
            var texDir = Path.Combine(outRoot, "textures");
            Directory.CreateDirectory(texDir);
            var materials = new JsonObject();
            using var zip = ZipFile.OpenRead(args[1]);
            var tmp = Path.Combine(Path.GetTempPath(), "trackedit-mod-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tmp);
            var converted = 0;
            try
            {
                foreach (var entry in zip.Entries)
                {
                    var ext = Path.GetExtension(entry.Name).ToLowerInvariant();
                    if (ext is not (".dds" or ".tga" or ".png") || entry.Length == 0) continue;
                    var stem = Path.GetFileNameWithoutExtension(entry.Name);
                    // Diffuse maps only: "<Material>_D.dds" (skip _N/_R/_I/... layers).
                    string material;
                    if (stem.EndsWith("_D", StringComparison.OrdinalIgnoreCase)) material = stem[..^2];
                    else if (stem.Contains('_')) continue;
                    else material = stem;
                    var pngPath = Path.Combine(texDir, material + ".png");
                    try
                    {
                        if (ext == ".png")
                        {
                            using var s = entry.Open();
                            using var f = File.Create(pngPath);
                            s.CopyTo(f);
                        }
                        else
                        {
                            var raw = Path.Combine(tmp, entry.Name.Replace('/', '_'));
                            entry.ExtractToFile(raw, true);
                            Dumper.ConvertDds(raw, pngPath);
                        }
                        materials[material] = "textures/" + material + ".png";
                        converted++;
                    }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine($"  skip {entry.Name}: {ex.Message}");
                    }
                }
            }
            finally
            {
                Directory.Delete(tmp, true);
            }
            File.WriteAllText(Path.Combine(outRoot, "mod.json"),
                new JsonObject { ["materials"] = materials }.ToJsonString());
            Console.WriteLine($"mod pack: {converted} textures -> {outRoot}");
            return 0;
        }
    case "mobilinfo":
        {
            // Per-variant Mobils matrix of a BlockInfo: what geometry each
            // [variant][subVariant] cell actually references.
            if (Gbx.ParseNode(args[1]) is not CGameCtnBlockInfo bi)
            {
                Console.WriteLine("not a CGameCtnBlockInfo");
                return 1;
            }
            void Dump(string tag, CGameCtnBlockInfoVariant? v)
            {
                if (v is null) { Console.WriteLine($"[{tag}] null"); return; }
                var m = v.Mobils;
                Console.WriteLine($"[{tag}] mobils={m?.Length ?? 0}");
                for (var a = 0; a < (m?.Length ?? 0); a++)
                    for (var b = 0; b < m![a].Length; b++)
                    {
                        var mob = m[a][b];
                        var solid = mob?.SolidFid is CPlugSolid ? "solid" : mob?.SolidFid?.GetType().Name ?? "-";
                        var prefab = mob?.PrefabFid is CPlugPrefab p ? $"prefab({p.Ents?.Length ?? 0} ents)" : "-";
                        var mats = "";
                        if (mob?.PrefabFid is CPlugPrefab pp)
                            foreach (var ent in pp.Ents ?? [])
                                if (ent.Model is CPlugStaticObjectModel { Mesh.Materials: { } mm })
                                    mats += " " + string.Join(",", mm.Select(x =>
                                        Path.GetFileNameWithoutExtension(x.File?.FilePath ?? "?")));
                        Console.WriteLine($"  [{a}][{b}] {solid} {prefab}{mats}");
                    }
            }
            Dump("air", bi.VariantBaseAir);
            Dump("ground", bi.VariantBaseGround);
            return 0;
        }
    case "nodeinfo":
        {
            // Generic inspector: node type, chunks, and one level of
            // interesting properties (for classes we have no exporter for).
            var node = Gbx.ParseNode(args[1]);
            Console.WriteLine($"type: {node?.GetType().FullName}");
            if (node is null) return 1;
            foreach (var ch in node.Chunks)
                Console.WriteLine($"  chunk 0x{ch.Id:X8} {ch.GetType().Name}");
            foreach (var p in node.GetType().GetProperties())
            {
                object? v;
                try { v = p.GetValue(node); } catch { continue; }
                if (v is null || p.Name is "Chunks" or "GameVersion") continue;
                var desc = v is System.Collections.ICollection col ? $"[{col.Count}]" : v.ToString();
                Console.WriteLine($"  .{p.Name}: {p.PropertyType.Name} = {desc}");
            }
            return 0;
        }
    case "refs":
        {
            var gbx = Gbx.Parse(args[1]);
            foreach (var f in gbx.RefTable?.Files ?? [])
                Console.WriteLine($"{f.FilePath}   -> exists: {File.Exists(ResolveRef(args[1], gbx.RefTable!.AncestorLevel, f.FilePath))}");
            return 0;
        }
    case "missing":
        {
            // Walk every extracted Gbx and collect referenced files that are
            // not on disk — the list to feed the Openplanet extraction plugin.
            if (args.Length < 3)
            {
                Console.Error.WriteLine("usage: meshdump missing <GameDataRoot> <out.txt>");
                return 1;
            }
            var missing = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            var scanned = 0;
            foreach (var file in Directory.EnumerateFiles(args[1], "*.Gbx", Fs.Recurse))
            {
                scanned++;
                try
                {
                    var gbx = Gbx.ParseHeader(file);
                    foreach (var f in gbx.RefTable?.Files ?? [])
                    {
                        var full = RefPaths.Resolve(file, gbx.RefTable!.AncestorLevel, f.FilePath);
                        if (!File.Exists(full)) missing.Add(full);
                    }
                }
                catch { /* unreadable file, skip */ }
                if (scanned % 1000 == 0) Console.WriteLine($"  scanned {scanned}...");
            }
            File.WriteAllLines(args[2], missing);
            Console.WriteLine($"scanned {scanned} gbx files, {missing.Count} missing referenced files -> {args[2]}");
            return 0;
        }
    case "prefabinfo":
        {
            if (Gbx.ParseNode(args[1]) is not CPlugPrefab pf)
            {
                Console.WriteLine("not a CPlugPrefab");
                return 1;
            }
            Console.WriteLine($"ents: {pf.Ents?.Length ?? 0}");
            foreach (var ent in pf.Ents ?? [])
            {
                var extras = new List<string>();
                foreach (var prop in ent.GetType().GetProperties())
                {
                    if (prop.PropertyType.Name.Contains("RefTableFile"))
                    {
                        var v = prop.GetValue(ent);
                        if (v is not null) extras.Add($"{prop.Name}={(v as GBX.NET.Components.GbxRefTableFile)?.FilePath ?? v}");
                    }
                }
                Console.WriteLine($"  model={ent.Model?.GetType().Name ?? "NULL"} {string.Join(" ", extras)}");
            }
            return 0;
        }
    case "unitinfo":
        {
            if (Gbx.ParseNode(args[1]) is not CGameCtnBlockInfo bi)
            {
                Console.WriteLine("not a BlockInfo");
                return 1;
            }
            foreach (var variant in new (string, CGameCtnBlockInfoVariant?)[] { ("air", bi.VariantBaseAir), ("ground", bi.VariantBaseGround) })
            {
                Console.WriteLine($"[{variant.Item1}] units: {variant.Item2?.BlockUnitModels?.Length ?? 0}");
                foreach (var u in variant.Item2?.BlockUnitModels ?? [])
                {
                    if (u is null) continue;
                    var clipProps = new List<string>();
                    foreach (var prop in u.GetType().GetProperties())
                        if (prop.Name.Contains("Clip", StringComparison.OrdinalIgnoreCase))
                        {
                            var v = prop.GetValue(u);
                            if (v is Array arr)
                            {
                                var items = new List<string>();
                                foreach (var item in arr)
                                {
                                    var node = item?.GetType().GetProperty("Node")?.GetValue(item);
                                    var ident = node?.GetType().GetProperty("Ident")?.GetValue(node);
                                    var idName = ident?.GetType().GetProperty("Id")?.GetValue(ident);
                                    items.Add(idName?.ToString() ?? (item is null ? "-" : item.GetType().Name));
                                }
                                clipProps.Add($"{prop.Name}=[{string.Join(", ", items)}]");
                            }
                            else if (v is not null) clipProps.Add($"{prop.Name}={v}");
                        }
                    Console.WriteLine($"  unit {u.RelativeOffset}: {string.Join(" | ", clipProps)}");
                }
            }
            return 0;
        }
    case "solidinfo":
        {
            if (Gbx.ParseNode(args[1]) is not CPlugPrefab pf2)
            {
                Console.WriteLine("not a CPlugPrefab");
                return 1;
            }
            var i = 0;
            foreach (var ent in pf2.Ents ?? [])
            {
                if (ent.Model is not CPlugStaticObjectModel { Mesh: not null } so) continue;
                Console.WriteLine($"ent[{i}] StaticObjectModel pos={ent.Position} quat={ent.Rotation}:");
                var s2 = so.Mesh;
                var g = 0;
                foreach (var geom in s2.ShadedGeoms ?? [])
                {
                    var vis = s2.Visuals?[geom.VisualIndex] as CPlugVisualIndexedTriangles;
                    var verts = vis?.VertexStreams.Count > 0 ? vis.VertexStreams[0].Positions?.Length ?? 0 : vis?.Vertices?.Length ?? 0;
                    var mat = s2.MaterialIds?.Length > geom.MaterialIndex ? s2.MaterialIds[geom.MaterialIndex].ToString() :
                        s2.Materials?.Length > geom.MaterialIndex ? s2.Materials[geom.MaterialIndex].File?.FilePath ?? "?" : "?";
                    var bounds = "";
                    var ps = vis?.VertexStreams.Count > 0 ? vis.VertexStreams[0].Positions : null;
                    if (ps is { Length: > 0 })
                    {
                        float minX = float.MaxValue, maxX = float.MinValue, minY = float.MaxValue, maxY = float.MinValue, minZ = float.MaxValue, maxZ = float.MinValue;
                        foreach (var p in ps)
                        {
                            minX = Math.Min(minX, p.X); maxX = Math.Max(maxX, p.X);
                            minY = Math.Min(minY, p.Y); maxY = Math.Max(maxY, p.Y);
                            minZ = Math.Min(minZ, p.Z); maxZ = Math.Max(maxZ, p.Z);
                        }
                        bounds = $" x[{minX:0.#},{maxX:0.#}] y[{minY:0.#},{maxY:0.#}] z[{minZ:0.#},{maxZ:0.#}]";
                    }
                    Console.WriteLine($"  geom[{g++}] lodMask={geom.LodMask} mat={mat} verts={verts}{bounds}");
                }
                i++;
            }
            return 0;
        }
    case "matinfo":
        {
            var node = Gbx.ParseNode(args[1]);
            Console.WriteLine($"type: {node?.GetType().FullName}");
            if (node is CPlugMaterial mat)
            {
                Console.WriteLine($"CustomMaterial: {mat.CustomMaterial?.GetType().FullName ?? "null"}");
                Console.WriteLine($"Shader: {mat.Shader?.GetType().FullName ?? "null"} file={mat.ShaderFile?.FilePath ?? "-"}");
                Console.WriteLine($"DeviceMaterials: {mat.DeviceMaterials?.Length.ToString() ?? "null"}");
                foreach (var bmp in mat.CustomMaterial?.Textures ?? [])
                {
                    string full = "-";
                    try { full = (bmp.Texture as CPlugBitmap)?.ImageFile?.GetFullPath() ?? "-"; }
                    catch (Exception ex) { full = "ERR " + ex.Message; }
                    Console.WriteLine($"  tex '{bmp.Name}': node={bmp.Texture?.GetType().Name ?? "null"} file={bmp.TextureFile?.FilePath ?? "-"} image={(bmp.Texture as CPlugBitmap)?.ImageFile?.FilePath ?? "-"} full={full} exists={(full.StartsWith("ERR") || full == "-" ? "?" : File.Exists(full).ToString())}");
                }
            }
            return 0;
        }
    case "iteminfo":
        if (Gbx.ParseNode(args[1]) is not CGameItemModel it)
        {
            Console.WriteLine("not a CGameItemModel");
            return 1;
        }
        Console.WriteLine($"name: {it.Ident.Id}");
        Console.WriteLine($"EntityModel: {it.EntityModel?.GetType().FullName ?? "null"}");
        Console.WriteLine($"EntityModelEdition: {it.EntityModelEdition?.GetType().FullName ?? "null"}");
        if (it.EntityModel is CGameCommonItemEntityModel cim)
        {
            Console.WriteLine($"  StaticObject: {cim.StaticObject?.GetType().FullName ?? "null"}");
            Console.WriteLine($"  StaticObject.Mesh: {cim.StaticObject?.Mesh?.GetType().FullName ?? "null"}");
        }
        if (it.EntityModel is GBX.NET.Engines.Meta.NPlugItem_SVariantList vl)
        {
            var variantsProp = vl.GetType().GetProperty("Variants");
            Console.WriteLine($"  Variants prop: {variantsProp?.PropertyType.FullName ?? "MISSING"}");
            if (variantsProp?.GetValue(vl) is System.Collections.IEnumerable variants)
            {
                foreach (var v in variants)
                {
                    Console.WriteLine($"  variant: {v?.GetType().FullName}");
                    foreach (var p in v!.GetType().GetProperties())
                        Console.WriteLine($"    .{p.Name}: {p.GetValue(v)?.GetType().FullName ?? "null"}");
                    break;
                }
            }
        }
        return 0;
    default:
        Console.Error.WriteLine($"unknown command {args[0]}");
        return 1;
}

static string ResolveRef(string gbxPath, int ancestorLevel, string relativePath) =>
    RefPaths.Resolve(gbxPath, ancestorLevel, relativePath);

static async Task<int> ProbeAsync(string pakPath)
{
    var pak = await Pak.ParseAsync(pakPath);
    Console.WriteLine($"parsed. files: {pak.Files.Count}");
    return pak.Files.Count > 0 ? 0 : 2;
}

/// <summary>
/// Extracts a map's embedded custom blocks/items (the zip inside Map.Gbx)
/// into the editor mesh library. Custom items export their crystal/model
/// mesh; custom blocks alias the official archetype block they re-skin.
/// </summary>
sealed class EmbeddedDumper(string outDir)
{
    public int Dump(string mapPath)
    {
        Gbx.LZO = new Lzo();
        if (Gbx.ParseNode(mapPath) is not CGameCtnChallenge map)
        {
            Console.Error.WriteLine("not a Map.Gbx");
            return 1;
        }
        var zip = map.EmbeddedZipData;
        if (zip is null || zip.Length == 0)
        {
            Console.WriteLine("no embedded data in this map");
            return 0;
        }

        Directory.CreateDirectory(Path.Combine(outDir, "embedded"));
        var indexPath = Path.Combine(outDir, "index.json");
        var index = File.Exists(indexPath)
            ? JsonNode.Parse(File.ReadAllText(indexPath))!.AsObject()
            : new JsonObject();
        index["blocks"] ??= new JsonObject();
        index["items"] ??= new JsonObject();
        var blocks = index["blocks"]!.AsObject();
        var items = index["items"]!.AsObject();

        // Pass 1: export every embedded asset, remembering it by zip path.
        var helper = new Dumper(".", outDir, null);
        var assets = new List<(string zipPath, JsonObject entry, bool isBlock)>();
        using var archive = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read);
        int ok = 0, skipped = 0, failed = 0;

        foreach (var entry in archive.Entries)
        {
            if (!entry.Name.EndsWith(".Gbx", StringComparison.OrdinalIgnoreCase)) continue;
            try
            {
                using var ms = new MemoryStream();
                using (var es = entry.Open()) es.CopyTo(ms);
                ms.Position = 0;
                if (Gbx.ParseNode(ms) is not CGameItemModel item)
                {
                    skipped++;
                    continue;
                }
                var zipPath = entry.FullName.Replace('/', '\\');
                var safe = Sanitize(zipPath);

                if (item.EntityModelEdition is CGameCommonItemEntityModelEdition { MeshCrystal: not null } edition)
                {
                    var obj = Path.Combine(outDir, "embedded", safe + ".obj");
                    edition.MeshCrystal.ExportToObj(obj, Path.Combine(outDir, "embedded", safe + ".mtl"));
                    assets.Add((zipPath, new JsonObject { ["obj"] = $"embedded/{safe}.obj" }, false));
                    ok++;
                    continue;
                }
                if (item.EntityModelEdition is CGameBlockItem blockItem)
                {
                    // Custom block: reuses (re-skins) an official block's mesh.
                    var arch = blockItem.ArchetypeBlockInfoId;
                    if (arch is not null && blocks[arch] is JsonObject src)
                    {
                        assets.Add((zipPath, (JsonObject)src.DeepClone(), true));
                        ok++;
                    }
                    else skipped++;
                    continue;
                }

                var builder = new ObjBuilder();
                helper.AddItemEntityModel(builder, item.EntityModel);
                if (builder.IsEmpty)
                {
                    skipped++;
                    continue;
                }
                var path = Path.Combine(outDir, "embedded", safe + ".obj");
                File.WriteAllText(path, builder.ToObj());
                assets.Add((zipPath, new JsonObject { ["obj"] = $"embedded/{safe}.obj" }, false));
                ok++;
            }
            catch (Exception ex)
            {
                failed++;
                Console.Error.WriteLine($"  FAIL {entry.FullName}: {ex.Message}");
            }
        }

        // Pass 2: key the index by the names the MAP actually uses. Those are
        // author-relative paths that rarely match the zip layout, so join on
        // the filename, disambiguating by longest common path suffix.
        var mapNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var b in map.Blocks ?? [])
            if (LooksCustom(b.Name)) mapNames.Add(b.Name);
        foreach (var o in map.AnchoredObjects ?? [])
            if (LooksCustom(o.ItemModel.Id)) mapNames.Add(o.ItemModel.Id);

        var mapped = 0;
        foreach (var name in mapNames)
        {
            var baseName = BaseFileName(name);
            (string zipPath, JsonObject entry, bool isBlock)? best = null;
            var bestScore = -1;
            foreach (var a in assets)
            {
                if (!BaseFileName(a.zipPath).Equals(baseName, StringComparison.OrdinalIgnoreCase)) continue;
                var score = CommonSuffix(name, a.zipPath);
                if (score > bestScore)
                {
                    bestScore = score;
                    best = a;
                }
            }
            if (best is null) continue;
            var target = best.Value.isBlock ? blocks : items;
            target[name] = best.Value.entry.DeepClone();
            mapped++;
        }

        File.WriteAllText(indexPath, index.ToJsonString());
        Console.WriteLine($"embedded: {ok} exported, {mapped}/{mapNames.Count} map names mapped, {skipped} skipped, {failed} failed");
        return 0;
    }

    private static bool LooksCustom(string? name) =>
        name is not null && (name.Contains('\\') || name.Contains(".gbx", StringComparison.OrdinalIgnoreCase));

    /** "…\Ramp.Block.Gbx_CustomBlock" -> "ramp.block.gbx" */
    private static string BaseFileName(string name)
    {
        var file = name[(name.LastIndexOf('\\') + 1)..];
        var i = file.IndexOf(".gbx", StringComparison.OrdinalIgnoreCase);
        return (i >= 0 ? file[..(i + 4)] : file).ToLowerInvariant();
    }

    /// <summary>Suffix match on paths truncated at ".Gbx" (map block names
    /// append "_CustomBlock" after the extension).</summary>
    private static int CommonSuffix(string a, string b)
    {
        static string Norm(string s)
        {
            var i = s.IndexOf(".gbx", StringComparison.OrdinalIgnoreCase);
            return (i >= 0 ? s[..(i + 4)] : s).ToLowerInvariant();
        }
        var al = Norm(a);
        var bl = Norm(b);
        var n = 0;
        while (n < al.Length && n < bl.Length && al[al.Length - 1 - n] == bl[bl.Length - 1 - n]) n++;
        return n;
    }

    private static string Sanitize(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var c in s)
            sb.Append(char.IsLetterOrDigit(c) || c is '-' or '_' or '.' ? c : '_');
        return sb.ToString();
    }
}

static class RefPaths
{
    /// <summary>Ref-table paths are relative to the Gbx file's directory raised by AncestorLevel.</summary>
    public static string Resolve(string gbxPath, int ancestorLevel, string relativePath)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(gbxPath))!;
        for (var i = 0; i < ancestorLevel; i++)
            dir = Path.GetDirectoryName(dir) ?? dir;
        return Fs.Fix(Path.GetFullPath(Path.Combine(dir, relativePath.Replace('\\', Path.DirectorySeparatorChar))));
    }
}

/// <summary>Filesystem helpers that tolerate case mismatches. Windows is
/// case-insensitive but Linux is not, and the game's ref tables freely mix
/// case against the extracted tree (".Gbx" vs ".gbx", folder casing).</summary>
static class Fs
{
    private static readonly bool CaseSensitive = !OperatingSystem.IsWindows();
    /// <summary>dir -> (lowercased entry name -> actual entry name); null = unlistable dir.</summary>
    private static readonly Dictionary<string, Dictionary<string, string>?> dirCache = [];

    /// <summary>Case-insensitive recursive glob (Directory.EnumerateFiles
    /// patterns are case-SENSITIVE on Linux, so "*.Gbx" would miss ".gbx").</summary>
    public static readonly EnumerationOptions Recurse = new()
    {
        RecurseSubdirectories = true,
        MatchCasing = MatchCasing.CaseInsensitive,
    };

    /// <summary>Returns the on-disk casing of <paramref name="path"/> when the
    /// exact path doesn't exist but a case-insensitive match does; otherwise
    /// the path unchanged (a caller's Exists check then fails as before).</summary>
    public static string Fix(string path)
    {
        if (!CaseSensitive || File.Exists(path) || Directory.Exists(path)) return path;
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full)!;
        var cur = root;
        foreach (var part in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            var next = Path.Combine(cur, part);
            if (!File.Exists(next) && !Directory.Exists(next))
            {
                var actual = Index(cur)?.GetValueOrDefault(part.ToLowerInvariant());
                if (actual is null) return path;
                next = Path.Combine(cur, actual);
            }
            cur = next;
        }
        return cur;
    }

    private static Dictionary<string, string>? Index(string dir)
    {
        if (dirCache.TryGetValue(dir, out var cached)) return cached;
        Dictionary<string, string>? map;
        try
        {
            map = [];
            foreach (var entry in Directory.EnumerateFileSystemEntries(dir))
            {
                var name = Path.GetFileName(entry);
                map[name.ToLowerInvariant()] = name;
            }
        }
        catch
        {
            map = null;
        }
        dirCache[dir] = map;
        return map;
    }
}

sealed class Dumper(string root, string outDir, string? filter)
{
    /// <summary>Material name -> diffuse image full path (null = looked up, none found).</summary>
    private readonly Dictionary<string, string?> materialImages = [];
    /// <summary>Material name -> opacity-mask image (decal lettering etc.).</summary>
    private readonly Dictionary<string, string> materialOpacity = [];
    /// <summary>Materials whose shader projects the texture from world axes.</summary>
    private readonly HashSet<string> materialProjected = [];
    private int ok, failed, skipped;

    public int DumpBlocks()
    {
        var files = Directory
            .EnumerateFiles(root, "*.Gbx", Fs.Recurse)
            .Where(f => f.Contains("GameCtnBlockInfo", StringComparison.OrdinalIgnoreCase))
            .ToList();
        Console.WriteLine($"found {files.Count} BlockInfo gbx files");
        Directory.CreateDirectory(outDir);

        var index = LoadIndex();
        var blocks = index["blocks"]!.AsObject();
        // Blocks with no geometry of their own (the deco-wall family): their
        // visual comes from a VFC clip; resolve after everything exported.
        var clipFallbacks = new List<(string name, string file, int[]? size)>();

        var processed = 0;
        foreach (var file in files)
        {
            Progress(++processed, files.Count);
            try
            {
                if (Gbx.ParseNode(file) is not CGameCtnBlockInfo info) { skipped++; continue; }
                var name = info.Ident.Id;
                if (filter is not null && !name.Contains(filter, StringComparison.OrdinalIgnoreCase)) { skipped++; continue; }

                var size = UnitsSize(info.VariantBaseAir) ?? UnitsSize(info.VariantBaseGround);
                var blockDir = Path.Combine(outDir, name);
                var air = ExportVariant(info.VariantBaseAir, blockDir, "air");
                var ground = ExportVariant(info.VariantBaseGround, blockDir, "ground");
                if (air is null && ground is null)
                {
                    clipFallbacks.Add((name, file, size));
                    continue;
                }

                blocks[name] = new JsonObject
                {
                    ["size"] = size is null ? null : new JsonArray(size[0], size[1], size[2]),
                    ["air"] = air is null ? null : $"{name}/air.obj",
                    ["ground"] = ground is null ? null : $"{name}/ground.obj",
                };
                ok++;
            }
            catch (Exception ex)
            {
                failed++;
                Console.Error.WriteLine($"  FAIL {Path.GetFileName(file)}: {ex.Message}");
            }
        }

        // Second pass: alias geometry-less blocks to their clip's export.
        var aliased = 0;
        foreach (var (name, file, size) in clipFallbacks)
        {
            try
            {
                var gbx = Gbx.Parse(file);
                string? clipId = null;
                foreach (var rf in gbx.RefTable?.Files ?? [])
                {
                    if (!rf.FilePath.Contains("Clip.Gbx", StringComparison.OrdinalIgnoreCase)) continue;
                    var candidate = Path.GetFileName(rf.FilePath.Replace('\\', '/'));
                    candidate = candidate[..candidate.IndexOf('.')];
                    // Prefer vertical clips; otherwise take the first clip.
                    if (blocks[candidate] is JsonObject &&
                        (clipId is null || rf.FilePath.Contains("VerticalClip", StringComparison.OrdinalIgnoreCase)))
                        clipId = candidate;
                }
                if (clipId is null || blocks[clipId] is not JsonObject clipEntry) { skipped++; continue; }
                var entry = (JsonObject)clipEntry.DeepClone();
                entry["size"] = size is null ? null : new JsonArray(size[0], size[1], size[2]);
                blocks[name] = entry;
                aliased++;
            }
            catch
            {
                skipped++;
            }
        }
        Console.WriteLine($"clip-aliased {aliased} geometry-less blocks (deco walls etc.)");

        Finish(index);
        return 0;
    }

    public int DumpItems()
    {
        var files = Directory
            .EnumerateFiles(root, "*.Item.Gbx", Fs.Recurse)
            .ToList();
        Console.WriteLine($"found {files.Count} Item gbx files");
        Directory.CreateDirectory(Path.Combine(outDir, "items"));

        var index = LoadIndex();
        var items = index["items"]!.AsObject();
        var usedVegetProxy = false;

        var processed = 0;
        foreach (var file in files)
        {
            Progress(++processed, files.Count);
            try
            {
                var gbx = Gbx.Parse(file);
                if (gbx.Node is not CGameItemModel item) { skipped++; continue; }
                var name = item.Ident.Id;
                if (filter is not null && !name.Contains(filter, StringComparison.OrdinalIgnoreCase)) { skipped++; continue; }

                var builder = new ObjBuilder();
                AddItemEntityModel(builder, item.EntityModel);

                // Some items (gates, obstacles) don't expose EntityModel but do
                // reference their prefab in the ref table — load it directly.
                if (builder.IsEmpty && gbx.RefTable is not null)
                {
                    foreach (var rf in gbx.RefTable.Files)
                    {
                        if (!rf.FilePath.EndsWith(".Prefab.Gbx", StringComparison.OrdinalIgnoreCase)) continue;
                        var full = RefPaths.Resolve(file, gbx.RefTable.AncestorLevel, rf.FilePath);
                        if (!File.Exists(full)) continue;
                        if (Gbx.ParseNode(full) is CPlugPrefab prefab)
                            AddPrefab(builder, prefab, Quaternion.Identity, Vector3.Zero);
                        break;
                    }
                }
                // Procedural vegetation: no stored mesh anywhere — emit a
                // stylized proxy tree sized from the PlaceParam ref name.
                if (builder.IsEmpty && gbx.RefTable is not null
                    && gbx.RefTable.Files.Any(f => f.FilePath.EndsWith(".VegetTreeModel.Gbx", StringComparison.OrdinalIgnoreCase)))
                {
                    float hgt = 8, wid = 4;
                    foreach (var rf in gbx.RefTable.Files)
                    {
                        var m = System.Text.RegularExpressions.Regex.Match(
                            Path.GetFileName(rf.FilePath), @"^Veget(\d+)m(\d+)m\.");
                        if (!m.Success) continue;
                        hgt = int.Parse(m.Groups[1].Value);
                        wid = int.Parse(m.Groups[2].Value);
                        break;
                    }
                    VegetProxy.Build(builder, name, hgt, wid);
                    usedVegetProxy = true;
                }

                if (builder.IsEmpty) { skipped++; continue; }

                File.WriteAllText(Path.Combine(outDir, "items", name + ".obj"), builder.ToObj());
                items[name] = new JsonObject { ["obj"] = $"items/{name}.obj" };
                ok++;
            }
            catch (Exception ex)
            {
                failed++;
                Console.Error.WriteLine($"  FAIL {Path.GetFileName(file)}: {ex.Message}");
            }
        }

        if (usedVegetProxy)
        {
            // Give the proxy materials flat colors the renderer can use.
            var matPath = Path.Combine(outDir, "materials.json");
            var mats = File.Exists(matPath) ? JsonNode.Parse(File.ReadAllText(matPath))!.AsObject() : [];
            foreach (var (mname, color) in VegetProxy.Materials)
                mats[mname] = new JsonObject { ["texture"] = null, ["color"] = color };
            File.WriteAllText(matPath, mats.ToJsonString());
        }

        Finish(index);
        return 0;
    }

    /// <summary>Machine-parsable progress line every 50 files — the setup
    /// bridge greps "progress a/b" out of stdout to drive its progress bar.</summary>
    private static void Progress(int processed, int total)
    {
        if (processed % 50 == 0 || processed == total)
            Console.WriteLine($"  progress {processed}/{total}");
    }

    private JsonObject LoadIndex()
    {
        var path = Path.Combine(outDir, "index.json");
        var index = File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))!.AsObject() : [];
        index["blocks"] ??= new JsonObject();
        index["items"] ??= new JsonObject();
        return index;
    }

    private void Finish(JsonObject index)
    {
        File.WriteAllText(Path.Combine(outDir, "index.json"), index.ToJsonString());
        WriteMaterials();
        Console.WriteLine($"done: {ok} exported, {skipped} skipped, {failed} failed -> {outDir}");
    }

    private static int[]? UnitsSize(CGameCtnBlockInfoVariant? variant)
    {
        var units = variant?.BlockUnitModels;
        if (units is null || units.Length == 0) return null;
        int mx = 0, my = 0, mz = 0;
        foreach (var u in units)
        {
            if (u is null) continue;
            mx = Math.Max(mx, u.RelativeOffset.X);
            my = Math.Max(my, u.RelativeOffset.Y);
            mz = Math.Max(mz, u.RelativeOffset.Z);
        }
        return [mx + 1, my + 1, mz + 1];
    }

    private string? ExportVariant(CGameCtnBlockInfoVariant? variant, string blockDir, string tag)
    {
        if (variant?.Mobils is null || variant.Mobils.Length == 0) return null;
        var builder = new ObjBuilder();

        // Mobils[variant][subVariant] are alternative appearances, not parts —
        // exporting them all overlays duplicate geometry. Base look = [0][0].
        var mobil = variant.Mobils[0].Length > 0 ? variant.Mobils[0][0] : null;
        if (mobil is null) return null;

        if (mobil.SolidFid is CPlugSolid solid)
            AddSolid(builder, solid, Quaternion.Identity, Vector3.Zero);
        if (mobil.PrefabFid is CPlugPrefab prefab)
            AddPrefab(builder, prefab, Quaternion.Identity, Vector3.Zero);

        // The game fills exposed faces with per-unit CLIPS: bottom clips are
        // the concrete undersides, side clips the end caps. Merge them in so
        // pieces look closed from below/behind like in-game.
        AddUnitClips(builder, variant, tag == "ground");

        if (builder.IsEmpty) return null;
        Directory.CreateDirectory(blockDir);
        var path = Path.Combine(blockDir, tag + ".obj");
        File.WriteAllText(path, builder.ToObj());
        // Sidecar for tools/diagnose_clips.py: which vertex ranges came from
        // the block body vs which clip on which face.
        File.WriteAllText(path + ".src.json", System.Text.Json.JsonSerializer.Serialize(
            builder.Sources.Select(s => new { src = s.Src, start = s.Start, count = s.Count })));
        return path;
    }

    private static CGameCtnBlockInfoMobil? FirstMobilWithGeometry(CGameCtnBlockInfoVariant? v)
    {
        var cm = v?.Mobils is { Length: > 0 } m && m[0].Length > 0 ? m[0][0] : null;
        return cm?.SolidFid is CPlugSolid || cm?.PrefabFid is CPlugPrefab ? cm : null;
    }

    /** The mobil row with the most prefab ents = the standalone wall look. */
    private static CPlugPrefab? DensestWallRow(CGameCtnBlockInfo clip, bool preferGround)
    {
        CPlugPrefab? best = null;
        var bestEnts = 0;
        var variants = preferGround
            ? new CGameCtnBlockInfoVariant?[] { clip.VariantBaseGround, clip.VariantBaseAir }
            : [clip.VariantBaseAir, clip.VariantBaseGround];
        foreach (var v in variants)
        {
            foreach (var row in v?.Mobils ?? [])
            {
                var mob = row.Length > 0 ? row[0] : null;
                if (mob?.PrefabFid is CPlugPrefab p && (p.Ents?.Length ?? 0) > bestEnts)
                {
                    bestEnts = p.Ents!.Length;
                    best = p;
                }
            }
            if (best is not null) break; // prefer the host-matching variant
        }
        return best;
    }

    /** Raw canonical-frame bounds of a clip's geometry, cached per clip. */
    private readonly Dictionary<string, (Vector3 Min, Vector3 Max)> probeCache = [];

    private (Vector3 Min, Vector3 Max) ProbeBounds(string key, Action<ObjBuilder> emitRaw)
    {
        if (probeCache.TryGetValue(key, out var b)) return b;
        var pb = new ObjBuilder();
        emitRaw(pb);
        b = (pb.Min, pb.Max);
        probeCache[key] = b;
        return b;
    }

    /** Measured max-Z of a wall prefab (canonical north frame), cached. */
    private readonly Dictionary<string, float> wallDepths = [];

    private float WallDepth(string clipId, CPlugPrefab wall)
    {
        if (wallDepths.TryGetValue(clipId, out var d)) return d;
        var scratch = new ObjBuilder();
        AddPrefab(scratch, wall, Quaternion.Identity, Vector3.Zero);
        d = scratch.MaxZ;
        wallDepths[clipId] = d;
        return d;
    }

    /** VFC clip id -> its one-cell wall segment prefab (TopBottom), cached. */
    private readonly Dictionary<string, CPlugPrefab?> vfcSegments = [];

    private CPlugPrefab? VfcSegmentPrefab(string clipId, bool preferGround)
    {
        var key = clipId + (preferGround ? "|g" : "|a");
        if (vfcSegments.TryGetValue(key, out var cached)) return cached;
        CPlugPrefab? result = null;
        try
        {
            var clipDir = Path.Combine(root, "Stadium", "GameCtnBlockInfo", "GameCtnBlockInfoClip");
            var file = new[] { ".EDVerticalClip.Gbx", ".EDClip.Gbx" }
                .Select(ext => Fs.Fix(Path.Combine(clipDir, clipId + ext)))
                .FirstOrDefault(File.Exists);
            if (file is not null)
            {
                var gbx = Gbx.Parse(file);
                var files = (gbx.RefTable?.Files ?? []).ToList();
                var want = preferGround ? "_Ground" : "_Air";
                var candidates = files
                    .Where(f => f.FilePath.Contains("VFCTopBottom", StringComparison.OrdinalIgnoreCase))
                    .Concat(files.Where(f => f.FilePath.Contains("VFCBottom", StringComparison.OrdinalIgnoreCase)))
                    .ToList();
                var pick = candidates.FirstOrDefault(f => f.FilePath.Contains(want, StringComparison.OrdinalIgnoreCase))
                           ?? candidates.FirstOrDefault();
                if (pick is not null)
                {
                    var full = RefPaths.Resolve(file, gbx.RefTable!.AncestorLevel, pick.FilePath);
                    if (File.Exists(full) && Gbx.ParseNode(full) is CPlugPrefab p) result = p;
                }
            }
        }
        catch
        {
            // best-effort: a wall face simply stays open
        }
        vfcSegments[key] = result;
        return result;
    }

    private void AddUnitClips(ObjBuilder builder, CGameCtnBlockInfoVariant variant, bool preferGround)
    {
        // Clip meshes are modeled in one canonical frame (verified against
        // the extracted geometry): face clips (FC) sit on the unit's NORTH
        // face (z=32); bottom clips (FCB) are a cap at y=8. Each attachment
        // point needs its own transform — a yaw about the unit centre for the
        // other faces, a -8 drop for the bottom.
        var center = new Vector3(16f, 0f, 16f);
        foreach (var unit in variant.BlockUnitModels ?? [])
        {
            if (unit is null) continue;
            var off = new Vector3(
                unit.RelativeOffset.X * 32f,
                unit.RelativeOffset.Y * 8f,
                unit.RelativeOffset.Z * 32f);

            void Merge(GBX.NET.External<CGameCtnBlockInfoClip>[]? clips, Quaternion q, Vector3 extra, string face = "?")
            {
                foreach (var ext in clips ?? [])
                {
                    if (ext.Node is not CGameCtnBlockInfo clip) continue;
                    // Prefer the host block's variant, but fall back to the
                    // other one — several clips model only air OR ground
                    // (the slope deco walls carry geometry only in air).
                    var first = preferGround
                        ? (CGameCtnBlockInfoVariant?)clip.VariantBaseGround
                        : clip.VariantBaseAir;
                    var second = preferGround
                        ? (CGameCtnBlockInfoVariant?)clip.VariantBaseAir
                        : clip.VariantBaseGround;
                    var cm = FirstMobilWithGeometry(first) ?? FirstMobilWithGeometry(second);

                    // The clip's geometry in its own canonical frame — used
                    // to DERIVE the placement instead of assuming modeling
                    // conventions (caps at y=8, wall screens at z=32 — true
                    // for air variants, false for several ground ones).
                    Action<ObjBuilder>? emitRaw = null;
                    var isWall = clip is CGameCtnBlockInfoClipVertical && cm?.SolidFid is not CPlugSolid;
                    CPlugPrefab? wall = null;
                    if (isWall)
                    {
                        wall = DensestWallRow(clip, preferGround);
                        if (wall is not null)
                            emitRaw = b => AddPrefab(b, wall, Quaternion.Identity, Vector3.Zero);
                    }
                    else if (cm is not null)
                    {
                        emitRaw = b =>
                        {
                            if (cm.SolidFid is CPlugSolid cs) AddSolid(b, cs, Quaternion.Identity, Vector3.Zero);
                            if (cm.PrefabFid is CPlugPrefab cp) AddPrefab(b, cp, Quaternion.Identity, Vector3.Zero);
                        };
                    }
                    if (emitRaw is null) continue;
                    var (rawMin, rawMax) = ProbeBounds(
                        $"{clip.Ident.Id}|{preferGround}|{(isWall ? "w" : "m")}", emitRaw);
                    if (rawMin.X > rawMax.X) continue; // empty

                    // Vertical caps: shift only when the clip follows the
                    // "flat cap at the opposite face" convention.
                    var extraEff = face switch
                    {
                        "bottom" => new Vector3(0, rawMin.Y >= 6f ? -8f : 0f, 0),
                        "top" => new Vector3(0, rawMax.Y <= 2f ? 8f : 0f, 0),
                        _ => extra,
                    };

                    // TALL caps (loop shells, slope undersides) are
                    // asymmetric and the attachment stores no direction —
                    // orient them so their height profile TRACKS the block's
                    // own profile over this unit (a mirrored shell would rise
                    // where the body falls, covering the ride surface).
                    if (face is "bottom" or "top" && cm is not null && !builder.IsEmpty)
                    {
                        var zLo = off.Z; var zHi = off.Z + 32f;
                        var xLo = off.X; var xHi = off.X + 32f;
                        var bodyZs = ObjBuilder.Slope(builder.MaxYByZ, zLo, zHi);
                        var bodyXs = ObjBuilder.Slope(builder.MaxYByX, xLo, xHi);
                        var tall = rawMax.Y - rawMin.Y > 3f;
                        var flip = Quaternion.CreateFromAxisAngle(Vector3.UnitY, MathF.PI);
                        float Err(Quaternion cq)
                        {
                            var ct = off + extraEff + center - Vector3.Transform(center, cq);
                            var sc = new ObjBuilder();
                            void em(ObjBuilder b2)
                            {
                                if (cm.SolidFid is CPlugSolid s2) AddSolid(b2, s2, cq, ct);
                                if (cm.PrefabFid is CPlugPrefab p2) AddPrefab(b2, p2, cq, ct);
                            }
                            em(sc);
                            if (tall)
                            {
                                // Tall shells must RISE where the body rises.
                                var zs = ObjBuilder.Slope(sc.MaxYByZ, zLo, zHi);
                                var xs = ObjBuilder.Slope(sc.MaxYByX, xLo, xHi);
                                return MathF.Abs(zs - bodyZs) + MathF.Abs(xs - bodyXs);
                            }
                            // Flat caps/strips (a ramp's coping plate) must
                            // TOUCH the body under their own footprint — the
                            // mirrored end has nothing at their level.
                            var bodyZ = ObjBuilder.RangeMax(builder.MaxYByZ, sc.Min.Z, sc.Max.Z);
                            var bodyX = ObjBuilder.RangeMax(builder.MaxYByX, sc.Min.X, sc.Max.X);
                            var level = face == "top" ? sc.Max.Y : sc.Min.Y;
                            return MathF.Abs(level - MathF.Min(bodyZ, bodyX));
                        }
                        if (Err(Quaternion.Concatenate(flip, q)) + 0.5f < Err(q))
                            q = Quaternion.Concatenate(flip, q);
                    }
                    var t = off + extraEff + center - Vector3.Transform(center, q);

                    Action<ObjBuilder> emit;
                    if (isWall && rawMax.Z > 33f)
                    {
                        // Modular wall compositions (TrackWallVFC family) are
                        // modeled with the screen toward the cell and the
                        // body extending OUTWARD past the face — flip in
                        // place so the farthest extent lands flush on the
                        // face plane and the body tucks inside:
                        // (x,y,z) -> (32-x, y, (32+minZ)-z).
                        var flip = Quaternion.CreateFromAxisAngle(Vector3.UnitY, MathF.PI);
                        var qc = Quaternion.Concatenate(flip, q);
                        var tc = Vector3.Transform(new Vector3(32f, 0f, 32f + rawMin.Z), q) + t;
                        var w = wall!;
                        emit = b => AddPrefab(b, w, qc, tc);
                    }
                    else if (isWall)
                    {
                        // Pre-positioned one-piece wall panels (shaped loop/
                        // deco profiles) already sit in place — merge as-is.
                        var w = wall!;
                        emit = b => AddPrefab(b, w, q, t);
                    }
                    else
                    {
                        var c = cm!;
                        emit = b =>
                        {
                            if (c.SolidFid is CPlugSolid cs) AddSolid(b, cs, q, t);
                            if (c.PrefabFid is CPlugPrefab cp) AddPrefab(b, cp, q, t);
                        };
                    }

                    // VALIDATION GATE: build into a scratch buffer first and
                    // commit only clips that actually seat against the block
                    // body. The game re-attaches some block-space caps to
                    // several units; naive per-unit offsets send those copies
                    // floating outside the block — the root of many "end/side
                    // texture in the wrong place" reports.
                    var scratch = new ObjBuilder();
                    emit(scratch);
                    if (scratch.IsEmpty) continue;
                    // (blocks with no body geometry keep all their clips)
                    if (!builder.IsEmpty && scratch.GapTo(builder.Min, builder.Max) > 1.5f) continue;

                    builder.SetSource(
                        $"clip:{clip.Ident.Id}:{face}:{unit.RelativeOffset.X},{unit.RelativeOffset.Y},{unit.RelativeOffset.Z}");
                    emit(builder);
                }
            }

            Quaternion Yaw(float deg) =>
                Quaternion.CreateFromAxisAngle(Vector3.UnitY, deg * MathF.PI / 180f);

            Merge(unit.ClipsBottom, Quaternion.Identity, new Vector3(0, -8f, 0), "bottom");
            // Top caps are modeled at y=0; the top face sits at y=8.
            Merge(unit.ClipsTop, Quaternion.Identity, new Vector3(0, 8f, 0), "top");
            Merge(unit.ClipsNorth, Quaternion.Identity, Vector3.Zero, "north");
            Merge(unit.ClipsSouth, Yaw(180f), Vector3.Zero, "south");
            Merge(unit.ClipsEast, Yaw(90f), Vector3.Zero, "east");
            Merge(unit.ClipsWest, Yaw(-90f), Vector3.Zero, "west");
        }
        builder.SetSource("mobil");
    }

    // --- geometry walkers ---

    /// <summary>Item entity models: TM2020 items wrap theirs in a variant list.</summary>
    public void AddItemEntityModel(ObjBuilder b, object? model)
    {
        switch (model)
        {
            case GBX.NET.Engines.Meta.NPlugItem_SVariantList list:
                // Base look = first variant.
                var variant = list.Variants?.FirstOrDefault();
                if (variant is not null) AddItemEntityModel(b, variant.EntityModel);
                break;
            case CGameCommonItemEntityModel { StaticObject.Mesh: CPlugSolid2Model s2m }:
                AddSolid2(b, s2m, Quaternion.Identity, Vector3.Zero);
                break;
            case CPlugStaticObjectModel { Mesh: not null } so:
                AddSolid2(b, so.Mesh, Quaternion.Identity, Vector3.Zero);
                break;
            case CPlugDynaObjectModel { Mesh: not null } dyn:
                // Obstacles/moving items: export their mesh at rest pose.
                AddSolid2(b, dyn.Mesh, Quaternion.Identity, Vector3.Zero);
                break;
            case CPlugPrefab prefab:
                AddPrefab(b, prefab, Quaternion.Identity, Vector3.Zero);
                break;
        }
    }

    private void AddPrefab(ObjBuilder b, CPlugPrefab prefab, Quaternion q, Vector3 t)
    {
        foreach (var ent in prefab.Ents ?? [])
        {
            var entQ = new Quaternion(ent.Rotation.X, ent.Rotation.Y, ent.Rotation.Z, ent.Rotation.W);
            var entP = new Vector3(ent.Position.X, ent.Position.Y, ent.Position.Z);
            var cq = Quaternion.Concatenate(entQ, q);
            var ct = Vector3.Transform(entP, q) + t;
            switch (ent.Model)
            {
                case CPlugStaticObjectModel { Mesh: not null } so:
                    AddSolid2(b, so.Mesh, cq, ct);
                    break;
                case CPlugDynaObjectModel { Mesh: not null } dyn:
                    AddSolid2(b, dyn.Mesh, cq, ct);
                    break;
                case CPlugPrefab sub:
                    AddPrefab(b, sub, cq, ct);
                    break;
            }
        }
    }

    private void AddSolid(ObjBuilder b, CPlugSolid solid, Quaternion q, Vector3 t)
    {
        if (solid.Tree is CPlugTree tree) AddTree(b, tree, q, t);
    }

    private void AddTree(ObjBuilder b, CPlugTree tree, Quaternion q, Vector3 t)
    {
        var loc = tree.Location;
        if (loc is not null)
        {
            var m = new Matrix4x4(
                loc.Value.XX, loc.Value.XY, loc.Value.XZ, 0,
                loc.Value.YX, loc.Value.YY, loc.Value.YZ, 0,
                loc.Value.ZX, loc.Value.ZY, loc.Value.ZZ, 0,
                0, 0, 0, 1);
            var lq = Quaternion.CreateFromRotationMatrix(m);
            var lp = new Vector3(loc.Value.TX, loc.Value.TY, loc.Value.TZ);
            t = Vector3.Transform(lp, q) + t;
            q = Quaternion.Concatenate(lq, q);
        }

        if (tree.Visual is CPlugVisualIndexedTriangles visual)
        {
            var mat = RegisterMaterial(tree.ShaderFile?.FilePath, (tree.Shader as CPlugMaterial));
            b.AddVisual(visual, q, t, mat, materialProjected.Contains(mat));
        }

        foreach (var child in tree.Children ?? [])
            AddTree(b, child, q, t);

        if (tree is CPlugTreeVisualMip mip && mip.Levels.Count > 0)
            AddTree(b, mip.Levels.OrderBy(l => l.FarZ).First().Tree, q, t);
    }

    private void AddSolid2(ObjBuilder b, CPlugSolid2Model s2m, Quaternion q, Vector3 t)
    {
        var geoms = s2m.ShadedGeoms;
        if (geoms is null || s2m.Visuals is null) return;
        var anyLod0 = geoms.Any(g => (g.LodMask & 1) != 0);
        foreach (var geom in geoms)
        {
            if (anyLod0 && (geom.LodMask & 1) == 0) continue;
            if (s2m.Visuals[geom.VisualIndex] is not CPlugVisualIndexedTriangles visual) continue;

            string mat = "default";
            if (s2m.MaterialIds?.Length > geom.MaterialIndex && s2m.MaterialIds[geom.MaterialIndex] is string matId)
                mat = RegisterMaterial(matId, null);
            else if (s2m.Materials?.Length > geom.MaterialIndex)
                mat = RegisterMaterial(s2m.Materials[geom.MaterialIndex].File?.FilePath, s2m.Materials[geom.MaterialIndex].Node);

            b.AddVisual(visual, q, t, mat, materialProjected.Contains(mat));
        }
    }

    // --- material/texture library ---

    /// <summary>Normalizes a material reference to a short name and records its diffuse texture once.</summary>
    private string RegisterMaterial(string? pathOrId, CPlugMaterial? node)
    {
        if (string.IsNullOrEmpty(pathOrId)) return "default";
        var name = Path.GetFileName(pathOrId.Replace('\\', '/'));
        foreach (var suffix in new[] { ".Material.Gbx", ".Material.gbx", ".gbx", ".Gbx" })
            if (name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                name = name[..^suffix.Length];
        name = Sanitize(name);

        if (!materialImages.ContainsKey(name))
        {
            materialImages[name] = null;
            try
            {
                // Materials referenced by id alone carry no node — load their
                // .Material.Gbx from the extracted game data instead.
                var mat = node ?? LoadMaterial(name);
                var (img, slot) = FindDiffuse(mat);
                materialImages[name] = img;
                // Py*/Pxz* slots = the shader projects the texture from
                // world axes; mesh UVs are meaningless for these.
                if (slot is not null &&
                    (slot.StartsWith("Py", StringComparison.Ordinal) ||
                     slot.StartsWith("Pxz", StringComparison.Ordinal)))
                    materialProjected.Add(name);
                // Decal shaders shape their content with an opacity mask
                // (TOpacity — e.g. the TRACKMANIA lettering over a plain
                // white base). Remember it so conversion bakes it into alpha.
                var opacity = FindSlotImage(mat, n => n is "TOpacity" or "Opacity");
                if (opacity is not null) materialOpacity[name] = opacity;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"  material {name}: {ex.Message}");
            }
        }
        return name;
    }

    private CPlugMaterial? LoadMaterial(string name)
    {
        foreach (var folder in new[] { "Material", "Material_BlockCustom" })
        {
            var path = Fs.Fix(Path.Combine(root, "Media", folder, name + ".Material.Gbx"));
            if (File.Exists(path))
                return Gbx.ParseNode(path) as CPlugMaterial;
        }
        return null;
    }

    private static string? FindSlotImage(CPlugMaterial? node, Func<string?, bool> match)
    {
        return node?.CustomMaterial?.Textures?
            .Where(x => match(x.Name))
            .Select(x => (x.Texture as CPlugBitmap)?.ImageFile?.GetFullPath() is string p ? Fs.Fix(p) : null)
            .FirstOrDefault(p => p is not null && File.Exists(p));
    }

    private static (string? Path, string? Slot) FindDiffuse(CPlugMaterial? node)
    {
        var bitmaps = node?.CustomMaterial?.Textures;
        if (bitmaps is null) return (null, null);
        // TM2020 albedo slots: BaseColor, BaseColorOp, PyBaseColor (projected),
        // etc. Prefer exact names, then anything *BaseColor* that isn't a
        // hue mask, then legacy names, then any resolvable texture.
        (string?, string?) byName(Func<string?, bool> match)
        {
            foreach (var x in bitmaps.Where(x => match(x.Name)))
            {
                var p = (x.Texture as CPlugBitmap)?.ImageFile?.GetFullPath();
                if (p is not null)
                {
                    p = Fs.Fix(p);
                    if (File.Exists(p)) return (p, x.Name);
                }
            }
            return (null, null);
        }

        var r = byName(n => n is "BaseColor" or "BaseColorOp" or "Diffuse");
        if (r.Item1 is null) r = byName(n => n is not null && n.Contains("BaseColor") && !n.Contains("HueMask"));
        if (r.Item1 is null) r = byName(n => n is "Blend3" or "Albedo");
        if (r.Item1 is null) r = byName(_ => true);
        return r;
    }

    private void WriteMaterials()
    {
        var texDir = Path.Combine(outDir, "textures");
        Directory.CreateDirectory(texDir);
        var path = Path.Combine(outDir, "materials.json");
        var json = File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))!.AsObject() : [];

        int converted = 0, missing = 0;
        foreach (var (name, image) in materialImages)
        {
            if (image is null)
            {
                json[name] ??= new JsonObject { ["texture"] = null };
                missing++;
                continue;
            }
            var pngRel = $"textures/{name}.png";
            var pngPath = Path.Combine(outDir, pngRel);
            var opacity = materialOpacity.GetValueOrDefault(name);
            // Opacity-masked materials always regenerate: the mask must be
            // baked into the PNG's alpha (decal lettering, cut-outs).
            if (!File.Exists(pngPath) || opacity is not null)
            {
                try
                {
                    ConvertDds(image, pngPath);
                    if (opacity is not null) BakeOpacity(pngPath, opacity);
                    converted++;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"  texture {name}: {ex.Message}");
                    json[name] = new JsonObject { ["texture"] = null };
                    continue;
                }
            }
            var entry = new JsonObject { ["texture"] = pngRel };
            // A HueMask sibling means the game can repaint this material
            // (block color painting). The mask is per-pixel: only masked
            // texels change color in-game — export it so the editor can
            // tint exactly those.
            var mask = FindHueMask(image);
            if (mask is not null)
            {
                entry["colorable"] = true;
                var maskRel = $"textures/{name}_HueMask.png";
                var maskPath = Path.Combine(outDir, maskRel);
                try
                {
                    if (!File.Exists(maskPath))
                    {
                        ConvertDds(mask, maskPath);
                        // The mask value rides in the GREEN channel; alpha is
                        // often 0, which canvas compositing would erase —
                        // flatten it so the browser can read the channel.
                        using var img = SixLabors.ImageSharp.Image.Load<Rgba32>(maskPath);
                        img.ProcessPixelRows(rows =>
                        {
                            for (var y = 0; y < rows.Height; y++)
                            {
                                var row = rows.GetRowSpan(y);
                                for (var x = 0; x < row.Length; x++) row[x].A = 255;
                            }
                        });
                        img.SaveAsPng(maskPath);
                    }
                    entry["hueMask"] = maskRel;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"  huemask {name}: {ex.Message}");
                }
            }
            json[name] = entry;
        }

        File.WriteAllText(path, json.ToJsonString());
        Console.WriteLine($"materials: {materialImages.Count} referenced, {converted} textures converted, {missing} without image");
    }

    /// <summary>Bake an opacity mask (lettering in its luminance) into a
    /// PNG's alpha channel — the renderer's alphaTest cuts it out.</summary>
    private static void BakeOpacity(string pngPath, string opacityImage)
    {
        var tmp = pngPath + ".op.png";
        try
        {
            ConvertDds(opacityImage, tmp);
            using var basePng = SixLabors.ImageSharp.Image.Load<Rgba32>(pngPath);
            using var mask = SixLabors.ImageSharp.Image.Load<Rgba32>(tmp);
            // UVs are authored for the DECAL's layout — keep the mask's
            // aspect (e.g. an 8x1 logo strip) and fit the base color to it.
            basePng.Mutate(x => x.Resize(mask.Width, mask.Height));
            for (var y = 0; y < mask.Height; y++)
                for (var x = 0; x < mask.Width; x++)
                {
                    var m = mask[x, y];
                    var p = basePng[x, y];
                    p.A = (byte)((m.R + m.G + m.B) / 3);
                    basePng[x, y] = p;
                }
            basePng.SaveAsPng(pngPath);
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }

    private static string? FindHueMask(string imagePath)
    {
        var dir = Path.GetDirectoryName(imagePath);
        if (dir is null) return null;
        var stem = Path.GetFileNameWithoutExtension(imagePath);
        foreach (var ext in new[] { ".dds", ".tga", ".png" })
        {
            var candidate = Fs.Fix(Path.Combine(dir, stem + "_HueMask" + ext));
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    internal static void ConvertDds(string ddsPath, string pngPath)
    {
        using var dds = Pfim.Pfimage.FromFile(ddsPath);
        var stride = dds.Width * dds.BitsPerPixel / 8;
        var data = dds.Data;
        if (dds.Stride != stride)
        {
            data = new byte[dds.Height * stride];
            for (var y = 0; y < dds.Height; y++)
                Buffer.BlockCopy(dds.Data, y * dds.Stride, data, y * stride, stride);
        }

        using Image img = dds.Format switch
        {
            Pfim.ImageFormat.Rgba32 => Image.LoadPixelData<Bgra32>(data, dds.Width, dds.Height),
            Pfim.ImageFormat.Rgb24 => Image.LoadPixelData<Bgr24>(data, dds.Width, dds.Height),
            Pfim.ImageFormat.R5g6b5 => Image.LoadPixelData<Bgr565>(data, dds.Width, dds.Height),
            Pfim.ImageFormat.R5g5b5a1 => Image.LoadPixelData<Bgra5551>(data, dds.Width, dds.Height),
            Pfim.ImageFormat.Rgb8 => Image.LoadPixelData<L8>(data, dds.Width, dds.Height),
            _ => throw new Exception($"unsupported DDS format {dds.Format}"),
        };

        if (img.Width > 512 || img.Height > 512)
            img.Mutate(x => x.Resize(new ResizeOptions
            {
                // Max = aspect-preserving downscale. The default (Crop)
                // chopped wide strips (the 8x1 TRACKMANIA logo) to their
                // middle letters.
                Size = new Size(512, 512),
                Mode = ResizeMode.Max,
                PremultiplyAlpha = false,
            }));
        img.SaveAsPng(pngPath);
    }

    private static string Sanitize(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var c in s)
            sb.Append(char.IsLetterOrDigit(c) || c is '-' or '_' or '.' ? c : '_');
        return sb.ToString();
    }
}

/// <summary>Accumulates transformed triangles grouped by material and emits an OBJ.</summary>
// TM2020 vegetation items carry no stored mesh — the game generates them at
// runtime from CPlugVegetTreeModel (a class GBX.NET can't even parse). Build
// stylized stand-in trees instead: shape by species, size from the item's
// Veget<H>m<W>m PlaceParam ref, season color via flat materials.
static class VegetProxy
{
    public static void Build(ObjBuilder b, string name, float h, float w)
    {
        var foliage = FoliageMaterial(name);
        if (name.Contains("Palm", StringComparison.OrdinalIgnoreCase))
        {
            Cylinder(b, w * 0.05f, 0, h * 0.85f, "VegetTrunk");
            Fronds(b, h * 0.85f, w * 0.7f, foliage);
        }
        else if (name.Contains("Fir", StringComparison.OrdinalIgnoreCase)
              || name.Contains("Cypress", StringComparison.OrdinalIgnoreCase))
        {
            Cylinder(b, MathF.Max(0.15f, w * 0.05f), 0, h * 0.25f, "VegetTrunk");
            Cone(b, w * 0.5f, h * 0.15f, h, foliage);
        }
        else
        {
            Cylinder(b, MathF.Max(0.15f, w * 0.06f), 0, h * 0.5f, "VegetTrunk");
            Ellipsoid(b, w * 0.5f, h * 0.35f, h * 0.62f, foliage);
        }
    }

    private static string FoliageMaterial(string name)
    {
        if (name.Contains("Spring", StringComparison.OrdinalIgnoreCase)
         || name.Contains("Cherry", StringComparison.OrdinalIgnoreCase)) return "VegetFoliageSpring";
        if (name.Contains("Fall", StringComparison.OrdinalIgnoreCase)) return "VegetFoliageFall";
        if (name.Contains("Frozen", StringComparison.OrdinalIgnoreCase)
         || name.Contains("Winter", StringComparison.OrdinalIgnoreCase)
         || name.Contains("Snow", StringComparison.OrdinalIgnoreCase)) return "VegetFoliageFrozen";
        return "VegetFoliage";
    }

    // Flat colors the renderer applies when a material has no texture.
    public static readonly (string Name, string Color)[] Materials =
    [
        ("VegetTrunk", "#6b4a2f"),
        ("VegetFoliage", "#3e7d3a"),
        ("VegetFoliageSpring", "#dfa2c4"),
        ("VegetFoliageFall", "#c8742e"),
        ("VegetFoliageFrozen", "#dbe7ee"),
    ];

    private static void Cylinder(ObjBuilder b, float r, float y0, float y1, string mat)
    {
        const int seg = 6;
        var verts = new Vector3[seg * 2];
        for (var i = 0; i < seg; i++)
        {
            var a = MathF.Tau * i / seg;
            var (x, z) = (MathF.Cos(a) * r, MathF.Sin(a) * r);
            verts[i] = new Vector3(x, y0, z);
            verts[i + seg] = new Vector3(x * 0.7f, y1, z * 0.7f);
        }
        var idx = new List<int>();
        for (var i = 0; i < seg; i++)
        {
            var j = (i + 1) % seg;
            idx.AddRange([i, i + seg, j, j, i + seg, j + seg]);
        }
        b.AddMesh(verts, [.. idx], mat);
    }

    private static void Cone(ObjBuilder b, float r, float y0, float y1, string mat)
    {
        const int seg = 8;
        var verts = new Vector3[seg + 1];
        for (var i = 0; i < seg; i++)
        {
            var a = MathF.Tau * i / seg;
            verts[i] = new Vector3(MathF.Cos(a) * r, y0, MathF.Sin(a) * r);
        }
        verts[seg] = new Vector3(0, y1, 0);
        var idx = new List<int>();
        for (var i = 0; i < seg; i++)
        {
            var j = (i + 1) % seg;
            idx.AddRange([i, seg, j]);       // side
            idx.AddRange([i, j, (i + 2) % seg]); // rough base fan
        }
        b.AddMesh(verts, [.. idx], mat);
    }

    private static void Ellipsoid(ObjBuilder b, float rxz, float ry, float cy, string mat)
    {
        const int lon = 8, lat = 5;
        var verts = new List<Vector3>();
        for (var la = 0; la <= lat; la++)
        {
            var phi = MathF.PI * la / lat;
            for (var lo = 0; lo < lon; lo++)
            {
                var th = MathF.Tau * lo / lon;
                verts.Add(new Vector3(
                    MathF.Sin(phi) * MathF.Cos(th) * rxz,
                    cy + MathF.Cos(phi) * ry,
                    MathF.Sin(phi) * MathF.Sin(th) * rxz));
            }
        }
        var idx = new List<int>();
        for (var la = 0; la < lat; la++)
            for (var lo = 0; lo < lon; lo++)
            {
                int a = la * lon + lo, bb = la * lon + (lo + 1) % lon;
                int c = a + lon, d = bb + lon;
                idx.AddRange([a, c, bb, bb, c, d]);
            }
        b.AddMesh([.. verts], [.. idx], mat);
    }

    private static void Fronds(ObjBuilder b, float top, float len, string mat)
    {
        const int count = 7;
        var verts = new List<Vector3>();
        var idx = new List<int>();
        for (var i = 0; i < count; i++)
        {
            var a = MathF.Tau * i / count;
            var (dx, dz) = (MathF.Cos(a), MathF.Sin(a));
            var (px, pz) = (-dz, dx); // perpendicular, for frond width
            var half = len * 0.12f;
            var n = verts.Count;
            verts.Add(new Vector3(0, top, 0));
            verts.Add(new Vector3(dx * len * 0.55f + px * half, top + len * 0.18f, dz * len * 0.55f + pz * half));
            verts.Add(new Vector3(dx * len * 0.55f - px * half, top + len * 0.18f, dz * len * 0.55f - pz * half));
            verts.Add(new Vector3(dx * len, top - len * 0.22f, dz * len));
            idx.AddRange([n, n + 1, n + 2, n + 1, n + 3, n + 2]);
        }
        b.AddMesh([.. verts], [.. idx], mat);
    }
}

sealed class ObjBuilder
{
    private readonly StringBuilder v = new();
    private readonly StringBuilder vt = new();
    private readonly Dictionary<string, StringBuilder> facesByMaterial = [];
    private int vertCount;
    public bool IsEmpty => vertCount == 0;

    public void AddVisual(
        CPlugVisualIndexedTriangles visual, Quaternion q, Vector3 t, string material, bool projected = false)
    {
        Vector3[] positions;
        Vec2[]? uvs = null;

        if (visual.VertexStreams.Count > 0)
        {
            var stream = visual.VertexStreams[0];
            if (stream.Positions is null) return;
            positions = stream.Positions.Select(p => new Vector3(p.X, p.Y, p.Z)).ToArray();
            if (stream.UVs.Count > 0 && stream.UVs.TryGetValue(0, out var uvSet)) uvs = uvSet;
        }
        else if (visual.Vertices is { Length: > 0 })
        {
            positions = visual.Vertices.Select(p => new Vector3(p.Position.X, p.Position.Y, p.Position.Z)).ToArray();
            if (visual.TexCoords is { Length: > 0 })
                uvs = visual.TexCoords[0].TexCoords.Select(x => x.UV).ToArray();
        }
        else return;

        var indices = visual.IndexBuffer?.Indices;
        if (indices is null || indices.Length < 3) return;

        if (projected)
        {
            // The game's Py/Pxz shaders ignore mesh UVs and project the
            // texture from WORLD axes (top faces from above, side faces
            // from their dominant horizontal axis). Reproduce that per
            // face — mesh UVs would smear/rotate the pattern on curved
            // tops and cut faces. One texture tile per grid cell (32u).
            const float s = 1f / 32f;
            if (!facesByMaterial.TryGetValue(material, out var pf))
                facesByMaterial[material] = pf = new StringBuilder();
            for (var i = 0; i + 2 < indices.Length; i += 3)
            {
                var w0 = Vector3.Transform(positions[indices[i]], q) + t;
                var w1 = Vector3.Transform(positions[indices[i + 1]], q) + t;
                var w2 = Vector3.Transform(positions[indices[i + 2]], q) + t;
                var n = Vector3.Cross(w1 - w0, w2 - w0);
                var (ax, ay, az) = (MathF.Abs(n.X), MathF.Abs(n.Y), MathF.Abs(n.Z));
                var start = vertCount + 1;
                foreach (var w in new[] { w0, w1, w2 })
                {
                    Grow(w);
                    var uv = ay >= ax && ay >= az ? new Vector2(w.X, w.Z)
                        : ax >= az ? new Vector2(w.Z, w.Y)
                        : new Vector2(w.X, w.Y);
                    v.Append("v ").Append(N(w.X)).Append(' ').Append(N(w.Y)).Append(' ').Append(N(w.Z)).Append('\n');
                    vt.Append("vt ").Append(N(uv.X * s)).Append(' ').Append(N(uv.Y * s)).Append('\n');
                }
                RecordSource(start, 3);
                vertCount += 3;
                pf.Append("f ").Append(F(start)).Append(' ').Append(F(start + 1)).Append(' ').Append(F(start + 2)).Append('\n');
            }
            return;
        }

        var baseIndex = vertCount + 1; // OBJ is 1-based
        for (var i = 0; i < positions.Length; i++)
        {
            var w = Vector3.Transform(positions[i], q) + t;
            Grow(w);
            v.Append("v ").Append(N(w.X)).Append(' ').Append(N(w.Y)).Append(' ').Append(N(w.Z)).Append('\n');
            var uv = uvs is not null && i < uvs.Length ? uvs[i] : default;
            vt.Append("vt ").Append(N(uv.X)).Append(' ').Append(N(uv.Y)).Append('\n');
        }
        RecordSource(vertCount + 1, positions.Length);
        vertCount += positions.Length;

        if (!facesByMaterial.TryGetValue(material, out var f))
            facesByMaterial[material] = f = new StringBuilder();
        for (var i = 0; i + 2 < indices.Length; i += 3)
        {
            f.Append("f ").Append(F(baseIndex + indices[i]))
             .Append(' ').Append(F(baseIndex + indices[i + 1]))
             .Append(' ').Append(F(baseIndex + indices[i + 2])).Append('\n');
        }
    }

    /** Largest Z seen across all added geometry (for clip-depth measuring). */
    public float MaxZ { get; private set; } = float.MinValue;
    /** Full bounds of everything added so far. */
    public Vector3 Min = new(float.MaxValue);
    public Vector3 Max = new(float.MinValue);
    /** Coarse height profiles along X and Z (4-unit buckets, −64..192):
    /// used to ORIENT asymmetric caps against the body they must hug. */
    public readonly float[] MaxYByZ = Enumerable.Repeat(float.MinValue, 64).ToArray();
    public readonly float[] MaxYByX = Enumerable.Repeat(float.MinValue, 64).ToArray();

    private void Grow(Vector3 w)
    {
        Min = Vector3.Min(Min, w);
        Max = Vector3.Max(Max, w);
        if (w.Z > MaxZ) MaxZ = w.Z;
        var zi = Math.Clamp((int)((w.Z + 64f) / 4f), 0, 63);
        var xi = Math.Clamp((int)((w.X + 64f) / 4f), 0, 63);
        if (w.Y > MaxYByZ[zi]) MaxYByZ[zi] = w.Y;
        if (w.Y > MaxYByX[xi]) MaxYByX[xi] = w.Y;
    }

    /** Highest bucket value across a coordinate range (MinValue if none). */
    public static float RangeMax(float[] buckets, float lo, float hi)
    {
        int i0 = Math.Clamp((int)((lo + 64f) / 4f), 0, 63);
        int i1 = Math.Clamp((int)((hi + 64f) / 4f), 0, 63);
        var m = float.MinValue;
        for (var i = i0; i <= i1; i++) m = MathF.Max(m, buckets[i]);
        return m;
    }

    /** Height trend across a coordinate range: maxY(last third) − maxY(first third). */
    public static float Slope(float[] buckets, float lo, float hi)
    {
        int i0 = Math.Clamp((int)((lo + 64f) / 4f), 0, 63);
        int i1 = Math.Clamp((int)((hi + 64f) / 4f), 0, 63);
        if (i1 <= i0) return 0;
        var third = Math.Max(1, (i1 - i0 + 1) / 3);
        float a = float.MinValue, b = float.MinValue;
        for (var i = i0; i < i0 + third; i++) a = MathF.Max(a, buckets[i]);
        for (var i = i1 - third + 1; i <= i1; i++) b = MathF.Max(b, buckets[i]);
        if (a == float.MinValue || b == float.MinValue) return 0;
        return b - a;
    }

    /** Largest axis gap between this builder's bounds and another's
    /// (0 = touching or overlapping). */
    public float GapTo(Vector3 otherMin, Vector3 otherMax)
    {
        var g = 0f;
        for (var i = 0; i < 3; i++)
        {
            g = MathF.Max(g, Index(Min, i) - Index(otherMax, i));
            g = MathF.Max(g, Index(otherMin, i) - Index(Max, i));
        }
        return g;
        static float Index(Vector3 v, int i) => i == 0 ? v.X : i == 1 ? v.Y : v.Z;
    }

    /** Provenance ranges: which vertex spans came from which merge source. */
    public readonly List<(string Src, int Start, int Count)> Sources = [];
    private string source = "mobil";
    public void SetSource(string s) => source = s;
    private void RecordSource(int start, int count)
    {
        if (count > 0) Sources.Add((source, start, count));
    }

    public void AddMesh(Vector3[] positions, int[] indices, string material)
    {
        var baseIndex = vertCount + 1;
        foreach (var p in positions)
        {
            Grow(p);
            v.Append("v ").Append(N(p.X)).Append(' ').Append(N(p.Y)).Append(' ').Append(N(p.Z)).Append('\n');
            vt.Append("vt 0 0\n");
        }
        RecordSource(vertCount + 1, positions.Length);
        vertCount += positions.Length;
        if (!facesByMaterial.TryGetValue(material, out var f))
            facesByMaterial[material] = f = new StringBuilder();
        for (var i = 0; i + 2 < indices.Length; i += 3)
        {
            f.Append("f ").Append(F(baseIndex + indices[i]))
             .Append(' ').Append(F(baseIndex + indices[i + 1]))
             .Append(' ').Append(F(baseIndex + indices[i + 2])).Append('\n');
        }
    }

    private static string N(float x) => x.ToString("0.####", CultureInfo.InvariantCulture);
    private static string F(int i) => $"{i}/{i}";

    public string ToObj()
    {
        var sb = new StringBuilder(v.Length + vt.Length + 64);
        sb.Append(v).Append(vt);
        foreach (var (mat, faces) in facesByMaterial)
            sb.Append("usemtl ").Append(mat).Append('\n').Append(faces);
        return sb.ToString();
    }
}
