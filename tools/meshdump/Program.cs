// meshdump: builds trackedit's block/item geometry + texture library from the
// user's own TM2020 game data (extracted once via Openplanet's Pack Explorer —
// the pak files themselves are encrypted with keys only the running game has).
//
// usage:
//   meshdump probe  <file.pak>                     - check pak readability
//   meshdump blocks <GameDataRoot> <outDir> [filter]
//   meshdump items  <GameDataRoot> <outDir> [filter]
//   meshdump map    <input.Map.Gbx> <output.json>
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
    case "map":
        if (args.Length != 3)
        {
            Console.Error.WriteLine("usage: meshdump map <input.Map.Gbx> <output.json>");
            return 2;
        }
        try
        {
            var map = Gbx.ParseNode<CGameCtnChallenge>(args[1]);
            var json = Trackedit.MapDump.Serialize(map);
            File.WriteAllText(args[2], json);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"map conversion failed: {ex.Message}");
            return 1;
        }
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
    case "clipinfo":
        // meshdump clipinfo <GameDataRoot> <ClipId> — raw (unplaced) bounds of a
        // clip's geometry per variant, for checking attachment conventions.
        if (args.Length < 3)
        {
            Console.Error.WriteLine("usage: meshdump clipinfo <GameDataRoot> <ClipId>");
            return 1;
        }
        return new Dumper(args[1], Path.GetTempPath(), null).ClipInfo(args[2]);
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
                        var file = mob?.PrefabFidFile?.FilePath ?? mob?.SolidFidFile?.FilePath ?? "";
                        Console.WriteLine($"  [{a}][{b}] {solid} {prefab} {Path.GetFileName(file)}{mats}");
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
            void DumpProps(object obj, string indent)
            {
                foreach (var p in obj.GetType().GetProperties())
                {
                    object? v;
                    try { v = p.GetValue(obj); } catch { continue; }
                    if (v is null || p.Name is "Chunks" or "GameVersion") continue;
                    var desc = v is System.Collections.ICollection col ? $"[{col.Count}]" : v.ToString();
                    Console.WriteLine($"{indent}.{p.Name}: {p.PropertyType.Name} = {desc}");
                    // One level into small collections so links (pillars, base
                    // blocks, external fids) show up without a dedicated command.
                    if (v is System.Collections.ICollection { Count: > 0 and <= 8 } items && v is not string)
                        foreach (var item in items)
                            if (item is not null && !item.GetType().IsPrimitive && item is not string)
                            {
                                Console.WriteLine($"{indent}  - {item}");
                                if (item is GBX.NET.Engines.MwFoundations.CMwNod or System.Runtime.CompilerServices.ITuple || item.GetType().IsValueType)
                                    DumpProps(item, indent + "      ");
                                else if (item is System.Collections.ICollection { Count: > 0 and <= 8 } inner)
                                    foreach (var sub in inner)
                                        if (sub is GBX.NET.Engines.MwFoundations.CMwNod)
                                        {
                                            Console.WriteLine($"{indent}    - {sub}");
                                            DumpProps(sub, indent + "        ");
                                        }
                            }
                }
            }
            DumpProps(node, "  ");
            if (node is CGameCtnBlockInfo bi)
            {
                foreach (var (tag, v) in new (string, CGameCtnBlockInfoVariant?)[] { ("air", bi.VariantBaseAir), ("ground", bi.VariantBaseGround) })
                {
                    if (v is null) continue;
                    Console.WriteLine($"[{tag}] {v.GetType().Name}");
                    foreach (var ch in v.Chunks) Console.WriteLine($"    chunk 0x{ch.Id:X8} {ch.GetType().Name}");
                    DumpProps(v, "    ");
                }
            }
            return 0;
        }
    case "geomxf":
        {
            // Survey: which block/clip mobils carry a geometry transform
            // (HasGeomTransformation) � the game rotates/translates the
            // referenced prefab before placing it.
            var n = 0; var total = 0;
            foreach (var f in Directory.EnumerateFiles(Path.Combine(args[1], "GameCtnBlockInfo"), "*.Gbx", SearchOption.AllDirectories))
            {
                CGameCtnBlockInfo? bi;
                try { bi = Gbx.ParseNode(f) as CGameCtnBlockInfo; } catch { continue; }
                if (bi is null) continue;
                total++;
                foreach (var (tag, v) in new (string, CGameCtnBlockInfoVariant?)[] { ("air", bi.VariantBaseAir), ("ground", bi.VariantBaseGround) })
                    foreach (var row in v?.Mobils ?? [])
                        foreach (var mob in row)
                            if (mob is { HasGeomTransformation: true })
                            {
                                n++;
                                var file = Path.GetFileName(mob.PrefabFidFile?.FilePath ?? mob.SolidFidFile?.FilePath ?? "?");
                                Console.WriteLine($"{bi.Name}	{tag}	{mob.GeomTranslation}	{mob.GeomRotation}	{file}");
                            }
            }
            Console.Error.WriteLine($"geomxf: {n} transformed mobils in {total} block infos");
            return 0;
        }
    case "clipobj":
        {
            // Raw geometry of one clip mobil row (air/ground) as OBJ, in the
            // clip's own frame: meshdump clipobj <root> <ClipId> <air|ground> <row> <out.obj>
            var d = new Dumper(args[1], Path.GetTempPath(), null);
            return d.ClipObj(args[2], args[3], int.Parse(args[4]), args[5]);
        }
    case "icons":
        {
            // Dump every block's editor icon (the game's own render of the
            // block) as <outDir>/<Name>.webp � ground truth for what a block
            // should look like when reviewing our exports.
            var outDir = args[2];
            Directory.CreateDirectory(outDir);
            var n = 0;
            foreach (var f in Directory.EnumerateFiles(Path.Combine(args[1], "GameCtnBlockInfo"), "*.Gbx", SearchOption.AllDirectories))
            {
                try
                {
                    if (Gbx.ParseHeaderNode(f) is not CGameCtnBlockInfo bi || bi.IconWebP is not { Length: > 0 } webp) continue;
                    File.WriteAllBytes(Path.Combine(outDir, bi.Name + ".webp"), webp);
                    n++;
                }
                catch (Exception ex) { Console.Error.WriteLine($"{Path.GetFileName(f)}: {ex.Message}"); }
            }
            Console.WriteLine($"icons: {n} written to {outDir}");
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
                    Console.WriteLine($"  unit {u.RelativeOffset} dir={u.Dir} multi={u.MultiDir}: {string.Join(" | ", clipProps)}");
                    if (Environment.GetEnvironmentVariable("MESHDUMP_UNIT_CHUNKS") is not null)
                        foreach (var ch in u.Chunks)
                        {
                            var raw = ch.GetType().GetProperty("Data")?.GetValue(ch) as byte[];
                            var hex = raw is null ? "" : " " + BitConverter.ToString(raw.Take(96).ToArray()).Replace("-", "");
                            Console.WriteLine($"      chunk 0x{ch.Id:X8} {ch.GetType().Name}{hex}");
                        }
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

/// <summary>Pure helpers for the terrain-modifier files (kept free of game
/// data so the contract tests can cover them).</summary>
/// <summary>Mobil geometry transforms and vertical-clip row selection �
/// pure functions, pinned by tools/meshdump.tests.</summary>
public static class MobilGeom
{
    /// <summary>GeomRotation is (x, y, z) degrees applied in that order
    /// (right-handed, System.Numerics conventions); the translation follows.
    /// Verified on the wall checkpoints: the flat ground checkpoint prefab
    /// rotated (-90, 0, 180) and moved (32, 32, 32) stands on the wall
    /// inside the cell for the "Down" variant.</summary>
    public static (Quaternion Q, Vector3 T) Compose(Vector3 rotDeg, Vector3 translation)
    {
        const float d2r = MathF.PI / 180f;
        var q = Quaternion.Concatenate(
            Quaternion.Concatenate(
                Quaternion.CreateFromAxisAngle(Vector3.UnitX, rotDeg.X * d2r),
                Quaternion.CreateFromAxisAngle(Vector3.UnitY, rotDeg.Y * d2r)),
            Quaternion.CreateFromAxisAngle(Vector3.UnitZ, rotDeg.Z * d2r));
        return (q, translation);
    }

    public static Vector3 Apply((Quaternion Q, Vector3 T) xf, Vector3 p) =>
        Vector3.Transform(p, xf.Q) + xf.T;

    /// <summary>Which wall segment a vertical clip shows on a unit, from
    /// whether the same wall continues on the unit above / below.</summary>
    public static string WallSegment(bool above, bool below) =>
        above && below ? "Middle" : below ? "Top" : above ? "Bottom" : "TopBottom";

    /// <summary>Segment kind encoded in a clip prefab's file name
    /// ("VFCCornerInLeft_TopBottom_Air", "Base_VFCMiddle2"), "" if none.</summary>
    public static string SegmentKind(string prefabFileName)
    {
        var f = Path.GetFileNameWithoutExtension(prefabFileName ?? "");
        if (f.Contains("TopBottom", StringComparison.OrdinalIgnoreCase)) return "TopBottom";
        if (f.Contains("Middle", StringComparison.OrdinalIgnoreCase)) return "Middle";
        if (f.Contains("Bottom", StringComparison.OrdinalIgnoreCase)) return "Bottom";
        if (f.Contains("Top", StringComparison.OrdinalIgnoreCase)) return "Top";
        return "";
    }
}

public static class TerrainModifiers
{
    /// <summary>"Media\Material\DecalSpecialTurbo.Material.Gbx" -> "DecalSpecialTurbo".</summary>
    public static string Stem(string pathOrId)
    {
        var name = Path.GetFileName(pathOrId.Replace('\\', '/'));
        foreach (var suffix in new[] { ".Material.Gbx", ".Material.gbx", ".gbx", ".Gbx" })
            if (name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                return name[..^suffix.Length];
        return name;
    }

    /// <summary>The modifier folder a material path lives in, or null:
    /// "Media\Modifier\PlatformDirt\PlatformTech.Material.Gbx" -> "PlatformDirt".</summary>
    public static string? ModifierFolder(string pathOrId)
    {
        var m = System.Text.RegularExpressions.Regex.Match(
            pathOrId, @"(?:^|[\\/])Modifier[\\/]([A-Za-z0-9_ ]+)[\\/][^\\/]+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return m.Success ? m.Groups[1].Value.Trim() : null;
    }

    /// <summary>"…/NoBrake.TerrainModifier .Gbx" -> "NoBrake" (the folder name).</summary>
    public static string TagFromFileName(string path)
    {
        var name = Path.GetFileName(path.Replace('\\', '/'));
        var dot = name.IndexOf('.');
        return (dot > 0 ? name[..dot] : name).Trim();
    }

    /// <summary>Reads the game-skin name and modifier folder out of a
    /// decompressed CPlugGameSkinAndFolder body, e.g. "Specials" and
    /// "Fragile" from "…Specials.GameSkin.gbx…Media\Modifier\Fragile\\".</summary>
    public static (string? Skin, string? Folder) ParseBody(string body)
    {
        var skin = System.Text.RegularExpressions.Regex.Match(body, @"([A-Za-z0-9_]+)\.GameSkin\.gbx", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var folder = System.Text.RegularExpressions.Regex.Match(body, @"Modifier[\\/]([A-Za-z0-9_ ]+)[\\/]");
        return (skin.Success ? skin.Groups[1].Value : null,
                folder.Success ? folder.Groups[1].Value.Trim() : null);
    }

    /// <summary>Slot entries of a decompressed CPlugGameSkin body: each slot
    /// name is followed (after a 4-byte length prefix) by the material path it
    /// normally uses, e.g. "TrackWall" then "Stadium\Media\Material\TrackWall.Material.Gbx".
    /// Header and body repeat the list; duplicates are dropped.</summary>
    public static List<(string Slot, string Path)> ParseSkinSlots(string body)
    {
        var result = new List<(string, string)>();
        var rx = new System.Text.RegularExpressions.Regex(
            @"([A-Za-z][A-Za-z0-9_]*)[^A-Za-z0-9_\\]{1,8}((?:[A-Za-z0-9_]+\\)+[A-Za-z0-9_]+\.(?:Material|Light)\.Gbx)",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        foreach (System.Text.RegularExpressions.Match m in rx.Matches(body))
        {
            var entry = (m.Groups[1].Value, m.Groups[2].Value);
            if (!result.Contains(entry)) result.Add(entry);
        }
        return result;
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
    /// <summary>[filter] is a name substring, or "@file" naming a file with
    /// one exact block name per line (re-export a hand-picked set).</summary>
    private readonly HashSet<string>? filterNames = filter is { Length: > 1 } && filter[0] == '@'
        ? File.ReadAllLines(filter[1..]).Select(l => l.Trim()).Where(l => l.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase)
        : null;

    private bool MatchesFilter(string name) =>
        filterNames is not null ? filterNames.Contains(name)
        : filter is null || name.Contains(filter, StringComparison.OrdinalIgnoreCase);

    /// <summary>Material name -> diffuse image full path (null = looked up, none found).</summary>
    private readonly Dictionary<string, string?> materialImages = [];
    /// <summary>Material name -> opacity-mask image (decal lettering etc.).</summary>
    private readonly Dictionary<string, string> materialOpacity = [];
    /// <summary>Materials whose shader projects the texture from world axes:
    /// name -> texture repeats per world unit (from the bitmap's
    /// DefaultTexCoordScale; 1/32 = one tile per grid cell).</summary>
    private readonly Dictionary<string, float> materialProjected = [];
    /// <summary>Material name -> shader file stem (drives decal/additive flags).</summary>
    private readonly Dictionary<string, string> materialShader = [];
    /// <summary>"Null" materials (no shader, no textures) — the game draws
    /// nothing for these, e.g. the platform edge strip on special blocks.</summary>
    private readonly HashSet<string> materialInvisible = [];
    /// <summary>Terrain modifiers of the block being exported, in application
    /// order (MaterialModifier, then MaterialModifier2 — the later wins).</summary>
    private readonly List<TerrainModifier> activeModifiers = [];
    private readonly Dictionary<string, TerrainModifier?> modifierCache = [];
    private Dictionary<string, Dictionary<string, List<string>>>? skinSlots;
    /// <summary>Block (or item) currently being exported, for diagnostics.</summary>
    private string currentBlock = "";
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
                if (!MatchesFilter(name)) { skipped++; continue; }

                var size = UnitsSize(info.VariantBaseAir) ?? UnitsSize(info.VariantBaseGround);
                var blockDir = Path.Combine(outDir, name);
                currentBlock = name;
                // Variant blocks (PlatformDirt*, *SpecialFragile*, …) share the
                // base mesh and swap materials through terrain modifiers.
                SetModifiers(info.MaterialModifierFile?.FilePath, info.MaterialModifier2File?.FilePath);
                string? air, ground;
                try
                {
                    air = ExportVariant(info.VariantBaseAir, blockDir, "air");
                    ground = ExportVariant(info.VariantBaseGround, blockDir, "ground");
                }
                finally
                {
                    activeModifiers.Clear();
                }
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
                if (!MatchesFilter(name)) { skipped++; continue; }

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

        if (tag == "ground")
        {
            // Ground bodies carry terrain-blend skirts (GrassFence & co.) that
            // reach a whole cell past the footprint; in-game they merge into
            // the terrain, in isolation they are stray green slabs. Trim
            // them like the ground clips.
            var c = UnitsSize(variant) ?? [1, 1, 1];
            builder.ClipBox = (new Vector3(0f, float.MinValue, 0f),
                               new Vector3(c[0] * 32f, float.MaxValue, c[2] * 32f));
        }
        AddMobil(builder, mobil, Quaternion.Identity, Vector3.Zero);
        builder.ClipBox = null;

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

    /// <summary>A mobil's own placement: the game rotates/translates the
    /// referenced geometry before attaching it (HasGeomTransformation). The
    /// wall checkpoints reuse the flat ground checkpoint prefab stood up
    /// against the wall this way; most FCB caps carry a plain +8 lift.
    /// Rotation is (x, y, z) degrees applied in that order.</summary>
    private static (Quaternion Q, Vector3 T) MobilTransform(CGameCtnBlockInfoMobil mob)
    {
        if (!mob.HasGeomTransformation) return (Quaternion.Identity, Vector3.Zero);
        var r = mob.GeomRotation;
        var t = mob.GeomTranslation;
        return MobilGeom.Compose(new Vector3(r.X, r.Y, r.Z), new Vector3(t.X, t.Y, t.Z));
    }

    /// <summary>Emit a mobil's solid/prefab with its geometry transform folded
    /// into the placement (q, t).</summary>
    private void AddMobil(ObjBuilder b, CGameCtnBlockInfoMobil mob, Quaternion q, Vector3 t)
    {
        var (gq, gt) = MobilTransform(mob);
        var cq = Quaternion.Concatenate(gq, q);
        var ct = Vector3.Transform(gt, q) + t;
        if (mob.SolidFid is CPlugSolid solid) AddSolid(b, solid, cq, ct);
        if (mob.PrefabFid is CPlugPrefab prefab) AddPrefab(b, prefab, cq, ct);
    }

    private static bool HasGeometry(CGameCtnBlockInfoMobil? m) =>
        m?.SolidFid is CPlugSolid || m?.PrefabFid is CPlugPrefab;

    /// <summary>Which row of a vertical clip's mobil table to show. Rows are
    /// [Middle, Top, Bottom, TopBottom, -, Middle x2, x3, x4, x8, x16, x32] in
    /// air and [Bottom, TopBottom] on the ground (prefab names confirm the
    /// order for every family checked); the segment shown on a unit depends
    /// on whether the same wall continues on the unit above/below.</summary>
    private static CGameCtnBlockInfoMobil? WallRowMobil(CGameCtnBlockInfo clip, bool preferGround, bool above, bool below)
    {
        var want = MobilGeom.WallSegment(above, below);
        var variants = preferGround
            ? new CGameCtnBlockInfoVariant?[] { clip.VariantBaseGround, clip.VariantBaseAir }
            : [clip.VariantBaseAir, clip.VariantBaseGround];
        foreach (var v in variants)
        {
            var rows = v?.Mobils;
            if (rows is null || rows.Length == 0) continue;
            // By name first: "...TopBottom..." must not match "Top"/"Bottom".
            static string Kind(CGameCtnBlockInfoMobil? m) =>
                MobilGeom.SegmentKind(m?.PrefabFidFile?.FilePath ?? m?.SolidFidFile?.FilePath ?? "");
            var byName = rows.Select(r => r.Length > 0 ? r[0] : null)
                .FirstOrDefault(m => HasGeometry(m) && Kind(m) == want);
            if (byName is not null) return byName;
            // Positional fallback (ground tables have no Middle/Top rows).
            int[] order = rows.Length >= 4
                ? want switch { "Middle" => [0], "Top" => [1], "Bottom" => [2], _ => [3] }
                : want switch { "Middle" or "Bottom" => [0], _ => [1, 0] };
            foreach (var i in order)
                if (i < rows.Length && rows[i].Length > 0 && HasGeometry(rows[i][0])) return rows[i][0];
        }
        return DensestWallRow(clip, preferGround);
    }

    private static CGameCtnBlockInfoMobil? FirstMobilWithGeometry(CGameCtnBlockInfoVariant? v)
    {
        var cm = v?.Mobils is { Length: > 0 } m && m[0].Length > 0 ? m[0][0] : null;
        return cm?.SolidFid is CPlugSolid || cm?.PrefabFid is CPlugPrefab ? cm : null;
    }

    /** The mobil row with the most prefab ents = the standalone wall look. */
    /// <summary>Debug: print each variant's raw geometry bounds for a clip, the
    /// way AddUnitClips would probe it (wall prefab rows vs mobil solids).</summary>
    public int ClipObj(string clipId, string tag, int row, string outPath)
    {
        var clipDir = Path.Combine(root, "GameCtnBlockInfo", "GameCtnBlockInfoClip");
        var file = Directory.EnumerateFiles(clipDir, clipId + ".ED*Clip.Gbx", SearchOption.AllDirectories).FirstOrDefault();
        if (file is null || Gbx.ParseNode(file) is not CGameCtnBlockInfo clip) { Console.WriteLine("clip not found"); return 1; }
        var v = tag == "ground" ? (CGameCtnBlockInfoVariant?)clip.VariantBaseGround : clip.VariantBaseAir;
        var mob = v?.Mobils is { } m && row < m.Length && m[row].Length > 0 ? m[row][0] : null;
        if (mob is null) { Console.WriteLine("no such row"); return 1; }
        var b = new ObjBuilder();
        AddMobil(b, mob, Quaternion.Identity, Vector3.Zero);
        File.WriteAllText(outPath, b.ToObj());
        File.WriteAllText(outPath + ".src.json", "[{\"src\":\"clip\",\"start\":1,\"count\":999999}]");
        Console.WriteLine($"{clipId} {tag} row {row}: x {b.Min.X:0.#}..{b.Max.X:0.#} y {b.Min.Y:0.#}..{b.Max.Y:0.#} z {b.Min.Z:0.#}..{b.Max.Z:0.#} -> {outPath}");
        return 0;
    }

    public int ClipInfo(string clipId)
    {
        var clipDir = Path.Combine(root, "GameCtnBlockInfo", "GameCtnBlockInfoClip");
        var file = new[] { ".EDVerticalClip.Gbx", ".EDClip.Gbx", ".EDHorizontalClip.Gbx" }
            .Select(ext => Fs.Fix(Path.Combine(clipDir, clipId + ext)))
            .FirstOrDefault(File.Exists);
        if (file is null || Gbx.ParseNode(file) is not CGameCtnBlockInfo clip)
        {
            Console.Error.WriteLine($"clip {clipId} not found under {clipDir}");
            return 1;
        }
        Console.WriteLine($"{clip.Ident.Id}: {clip.GetType().Name} ({Path.GetFileName(file)})");
        foreach (var (tag, variant) in new (string, CGameCtnBlockInfoVariant?)[] { ("air", clip.VariantBaseAir), ("ground", clip.VariantBaseGround) })
        {
            Console.WriteLine($"[{tag}] mobil rows: {variant?.Mobils?.Length ?? 0}");
            var rowIndex = 0;
            foreach (var row in variant?.Mobils ?? [])
            {
                var mob = row.Length > 0 ? row[0] : null;
                var b = new ObjBuilder();
                if (mob?.SolidFid is CPlugSolid s) AddSolid(b, s, Quaternion.Identity, Vector3.Zero);
                if (mob?.PrefabFid is CPlugPrefab p) AddPrefab(b, p, Quaternion.Identity, Vector3.Zero);
                var ents = (mob?.PrefabFid as CPlugPrefab)?.Ents?.Length ?? 0;
                Console.WriteLine(b.IsEmpty
                    ? $"  row {rowIndex}: (no geometry) solid={mob?.SolidFid is not null} prefab ents={ents}"
                    : $"  row {rowIndex}: ents={ents} bounds x {b.Min.X:0.#}..{b.Max.X:0.#} y {b.Min.Y:0.#}..{b.Max.Y:0.#} z {b.Min.Z:0.#}..{b.Max.Z:0.#}");
                if (mob?.PrefabFid is CPlugPrefab pf)
                    foreach (var ent in pf.Ents ?? [])
                        Console.WriteLine($"      ent {ent.Model?.GetType().Name} pos={ent.Position} rot={ent.Rotation}");
                rowIndex++;
            }
            var wall = DensestWallRow(clip, tag == "ground")?.PrefabFid as CPlugPrefab;
            if (wall is not null)
            {
                var wb = new ObjBuilder();
                AddPrefab(wb, wall, Quaternion.Identity, Vector3.Zero);
                Console.WriteLine($"  densest wall row: ents={wall.Ents?.Length ?? 0} bounds x {wb.Min.X:0.#}..{wb.Max.X:0.#} y {wb.Min.Y:0.#}..{wb.Max.Y:0.#} z {wb.Min.Z:0.#}..{wb.Max.Z:0.#}");
            }
        }
        return 0;
    }

    private static CGameCtnBlockInfoMobil? DensestWallRow(CGameCtnBlockInfo clip, bool preferGround)
    {
        CGameCtnBlockInfoMobil? best = null;
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
                    best = mob;
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

    private float WallDepth(string clipId, CGameCtnBlockInfoMobil wall)
    {
        if (wallDepths.TryGetValue(clipId, out var d)) return d;
        var scratch = new ObjBuilder();
        AddMobil(scratch, wall, Quaternion.Identity, Vector3.Zero);
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
        // The block's own cells: caps are trimmed to this box (terrain
        // blending skirts on ground undersides spread far beyond it).
        var cells = UnitsSize(variant) ?? [1, 1, 1];
        var footprint = (new Vector3(0f, float.MinValue, 0f),
                         new Vector3(cells[0] * 32f, float.MaxValue, cells[2] * 32f));
        // The block body (mobil) as it was before any clip: the seat test
        // below measures against THIS, not against clips merged earlier �
        // on mesh-less blocks (deco cliffs, stage supports) the first wall
        // otherwise rejects every wall on the far faces.
        var hasBody = !builder.IsEmpty;
        var bodyMin = builder.Min;
        var bodyMax = builder.Max;
        var blockBox = (new Vector3(0f, 0f, 0f),
                        new Vector3(cells[0] * 32f, cells[1] * 8f, cells[2] * 32f));
        var units = (variant.BlockUnitModels ?? []).Where(u => u is not null).ToList();
        // Cells (4u) already covered by committed top/bottom caps: a cap
        // shared by several units (chicanes, diagonals) is one plate split
        // into point-symmetric halves � each copy must land on its own half.
        var capCover = new Dictionary<string, bool[,]>();
        // Does the same vertical wall continue on the unit above/below this
        // one (same face, same clip group)? Picks the wall segment row.
        bool Continues(CGameCtnBlockUnitInfo u, string face, CGameCtnBlockInfo clip, int dy)
        {
            var o = u.RelativeOffset;
            var n = units.FirstOrDefault(x => x.RelativeOffset.X == o.X && x.RelativeOffset.Y == o.Y + dy && x.RelativeOffset.Z == o.Z);
            if (n is null) return false;
            var list = face switch
            {
                "north" => n.ClipsNorth, "south" => n.ClipsSouth,
                "east" => n.ClipsEast, "west" => n.ClipsWest, _ => null,
            };
            var group = (clip as CGameCtnBlockInfoClipVertical)?.VerticalClipGroupId;
            foreach (var ext in list ?? [])
            {
                if (ext.Node is not CGameCtnBlockInfo other) continue;
                if (other.Ident.Id == clip.Ident.Id) return true;
                if (!string.IsNullOrEmpty(group) && (other as CGameCtnBlockInfoClipVertical)?.VerticalClipGroupId == group) return true;
            }
            return false;
        }
        foreach (var unit in units)
        {
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
                    CGameCtnBlockInfoMobil? wall = null;
                    var above = false; var below = false;
                    if (isWall)
                    {
                        above = Continues(unit, face, clip, +1);
                        below = Continues(unit, face, clip, -1);
                        // Ground rows only exist for the segment that touches
                        // the ground; stacked units above it use the air table.
                        wall = WallRowMobil(clip, preferGround && unit.RelativeOffset.Y == 0, above, below);
                        if (wall is not null)
                            emitRaw = b => AddMobil(b, wall, Quaternion.Identity, Vector3.Zero);
                    }
                    else if (cm is not null)
                    {
                        emitRaw = b => AddMobil(b, cm, Quaternion.Identity, Vector3.Zero);
                    }
                    if (emitRaw is null) continue;
                    var (rawMin, rawMax) = ProbeBounds(
                        $"{clip.Ident.Id}|{preferGround}|{(isWall ? $"w{(above ? 1 : 0)}{(below ? 1 : 0)}{(unit.RelativeOffset.Y == 0 ? "g" : "a")}" : "m")}", emitRaw);
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
                        float Err(Quaternion cq)
                        {
                            var ct = off + extraEff + center - Vector3.Transform(center, cq);
                            var sc = new ObjBuilder { ClipBox = footprint };
                            AddMobil(sc, cm, cq, ct);
                            // First of all a cap must sit OVER the body: a thin
                            // wall's coping strip turned 90° runs along the
                            // empty edge of the cell, matching every height
                            // test while covering nothing.
                            // Every cap must MEET the body per cell of its
                            // footprint: a top cap's underside against the
                            // body's top, a bottom cap's top against the
                            // body's underside. Mirrored or quarter-turned
                            // placements have nothing, or the wrong height,
                            // beneath them (a twisted tilt-transition
                            // underside only fits one way).
                            var err = sc.CapMismatch(builder, face == "top");
                            // Plates belong inside the block (what the clip
                            // box trims away is lost) and must not stack on
                            // a copy already placed on this face.
                            var su = new ObjBuilder();
                            AddMobil(su, cm, cq, ct);
                            if (su.FootprintCells > 0)
                            {
                                var lost = (su.FootprintCells - sc.FootprintCells) / (float)su.FootprintCells;
                                var overlap = capCover.TryGetValue(face, out var cov) ? sc.OverlapCells(cov) / (float)Math.Max(1, sc.FootprintCells) : 0f;
                                err += 16f * MathF.Max(0f, lost) + 16f * overlap;
                            }
                            if (tall)
                            {
                                // Tall shells must also RISE where the body
                                // rises — a cheap tiebreaker for symmetric
                                // profiles.
                                var zs = ObjBuilder.Slope(sc.MaxYByZ, zLo, zHi);
                                var xs = ObjBuilder.Slope(sc.MaxYByX, xLo, xHi);
                                err += MathF.Abs(zs - bodyZs) + MathF.Abs(xs - bodyXs);
                            }
                            return err;
                        }
                        // Try every quarter turn, not just the mirror: a
                        // sideways-tilted platform reuses the straight
                        // slope's underside, which must turn 90° to follow
                        // the tilt (unturned it pokes up through the deck).
                        var best = q;
                        var bestErr = Err(q) - 0.5f; // keep the default unless clearly better
                        foreach (var deg in new[] { 90f, 180f, 270f })
                        {
                            var cand = Quaternion.Concatenate(
                                Quaternion.CreateFromAxisAngle(Vector3.UnitY, deg * MathF.PI / 180f), q);
                            var e = Err(cand);
                            if (e < bestErr) { bestErr = e; best = cand; }
                        }
                        q = best;
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
                        emit = b =>
                        {
                            // Ground rows of these compositions add terrain
                            // skirts that reach into the neighbouring cells.
                            if (preferGround) b.ClipBox = footprint;
                            AddMobil(b, w, qc, tc);
                            b.ClipBox = null;
                        };
                    }
                    else if (isWall)
                    {
                        // One-piece wall panels (shaped loop/deco profiles) are
                        // authored like face caps: on the z=32 plane, looking
                        // INTO the adjoining cell. Turn them inward about the
                        // face centre exactly like the mobil caps below —
                        // asymmetric panels (the 48-wide loop-start walls
                        // overhang one end) otherwise land end-for-end
                        // reversed, hanging outside the block.
                        var w = wall!;
                        var wq = Quaternion.Concatenate(
                            Quaternion.CreateFromAxisAngle(Vector3.UnitY, MathF.PI), q);
                        var wt = t + Vector3.Transform(new Vector3(32f, 0f, 64f), q);
                        emit = b =>
                        {
                            if (preferGround) b.ClipBox = footprint;
                            AddMobil(b, w, wq, wt);
                            b.ClipBox = null;
                        };
                    }
                    else
                    {
                        var c = cm!;
                        var cq = q;
                        var ct = t;
                        if (face is "north" or "south" or "east" or "west")
                        {
                            // Face-cap mobils look into the adjoining cell.
                            // Turn them inward about the FACE centre (16,0,32),
                            // not the unit centre: preserve the attachment plane
                            // while swapping the ends of asymmetric/banked caps.
                            cq = Quaternion.Concatenate(
                                Quaternion.CreateFromAxisAngle(Vector3.UnitY, MathF.PI), q);
                            ct += Vector3.Transform(new Vector3(32f, 0f, 64f), q);
                        }
                        var trim = face is "bottom" or "top" || preferGround;
                        emit = b =>
                        {
                            if (trim) b.ClipBox = footprint;
                            AddMobil(b, c, cq, ct);
                            b.ClipBox = null;
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
                    // Bodied blocks: the clip must touch the body. Mesh-less
                    // blocks: it must at least reach the block's own cells.
                    if (hasBody ? scratch.GapTo(bodyMin, bodyMax) > 1.5f
                                : scratch.GapTo(blockBox.Item1, blockBox.Item2) > 8f) continue;

                    builder.SetSource(
                        $"clip:{clip.Ident.Id}:{face}:{unit.RelativeOffset.X},{unit.RelativeOffset.Y},{unit.RelativeOffset.Z}");
                    emit(builder);
                    if (face is "top" or "bottom")
                    {
                        if (!capCover.TryGetValue(face, out var cov)) capCover[face] = cov = new bool[64, 64];
                        scratch.MarkCells(cov);
                    }
                }
            }

            Quaternion Yaw(float deg) =>
                Quaternion.CreateFromAxisAngle(Vector3.UnitY, deg * MathF.PI / 180f);

            void Sides()
            {
                Merge(unit.ClipsNorth, Quaternion.Identity, Vector3.Zero, "north");
                Merge(unit.ClipsSouth, Yaw(180f), Vector3.Zero, "south");
                // GBX east is the x=0 face, west is x=32. Positive Y yaw
                // moves our canonical z=32 clip to x=32 (west), not east.
                Merge(unit.ClipsEast, Yaw(-90f), Vector3.Zero, "east");
                Merge(unit.ClipsWest, Yaw(90f), Vector3.Zero, "west");
            }
            void Caps()
            {
                Merge(unit.ClipsBottom, Quaternion.Identity, new Vector3(0, -8f, 0), "bottom");
                // Top caps are modeled at y=0; the top face sits at y=8.
                Merge(unit.ClipsTop, Quaternion.Identity, new Vector3(0, 8f, 0), "top");
            }
            // Blocks assembled purely from clips (deco walls, arches, tilt
            // transitions) have no body for the cap-orientation test to
            // read — so seat the side walls first and test caps against
            // them. Blocks with a body keep caps first: their walls would
            // only muddy the body's height map.
            if (builder.IsEmpty) { Sides(); Caps(); }
            else { Caps(); Sides(); }
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
            if (!materialInvisible.Contains(mat))
                b.AddVisual(visual, q, t, mat, ProjectedScale(mat));
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

            if (materialInvisible.Contains(mat)) continue;
            b.AddVisual(visual, q, t, mat, ProjectedScale(mat));
        }
    }

    private float? ProjectedScale(string mat) =>
        materialProjected.TryGetValue(mat, out var s) ? s : null;

    // --- terrain modifiers ---

    /// <summary>One block-level material swap: a game-skin names the material
    /// SLOTS (slot name -> the material file it normally uses) and a folder
    /// holds replacements named after those slots.</summary>
    private sealed record TerrainModifier(string Tag, string Folder, Dictionary<string, List<string>> SlotsByStem);

    private void SetModifiers(params string?[] modifierFiles)
    {
        activeModifiers.Clear();
        foreach (var rel in modifierFiles)
        {
            if (string.IsNullOrEmpty(rel)) continue;
            var mod = LoadModifier(rel);
            if (mod is not null) activeModifiers.Add(mod);
        }
    }

    private TerrainModifier? LoadModifier(string rel)
    {
        if (modifierCache.TryGetValue(rel, out var cached)) return cached;
        TerrainModifier? result = null;
        try
        {
            var path = Fs.Fix(Path.Combine(root, rel.Replace('\\', Path.DirectorySeparatorChar)));
            if (File.Exists(path))
            {
                // GBX.NET can't parse CPlugGameSkinAndFolder, but the body is
                // tiny: read the skin + folder references straight from it.
                using var body = new MemoryStream();
                Gbx.Decompress(path, body);
                var (skin, folder) = TerrainModifiers.ParseBody(Encoding.Latin1.GetString(body.ToArray()));
                var tag = folder ?? TerrainModifiers.TagFromFileName(path);
                var dir = Fs.Fix(Path.Combine(Path.GetDirectoryName(path)!, tag));
                if (Directory.Exists(dir))
                    result = new TerrainModifier(tag, dir, SkinSlots(skin));
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"  modifier {rel}: {ex.Message}");
        }
        modifierCache[rel] = result;
        return result;
    }

    /// <summary>Slot table of one game-skin (material file stem -> slot names).
    /// An unknown skin swaps nothing: guessing (e.g. the union of all skins)
    /// once turned 146 tech platforms grass because the one-slot
    /// TrackWallToDecoCliff skin was unreadable.</summary>
    private Dictionary<string, List<string>> SkinSlots(string? skin)
    {
        skinSlots ??= LoadSkins();
        if (skin is not null && skinSlots.TryGetValue(skin, out var one)) return one;
        if (skin is not null)
            Console.Error.WriteLine($"  gameskin {skin}: unknown, modifier applies no swaps");
        return new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
    }

    private Dictionary<string, Dictionary<string, List<string>>> LoadSkins()
    {
        var skins = new Dictionary<string, Dictionary<string, List<string>>>(StringComparer.OrdinalIgnoreCase);
        var dir = Fs.Fix(Path.Combine(root, "GameSkin"));
        if (!Directory.Exists(dir)) return skins;
        var fromRaw = 0;
        foreach (var file in Directory.EnumerateFiles(dir, "*.GameSkin.gbx", Fs.Recurse))
        {
            var name = Path.GetFileName(file);
            var key = name[..name.IndexOf('.')];
            var table = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
            void Add(string slot, string materialPath)
            {
                var stem = TerrainModifiers.Stem(materialPath);
                var list = table.GetValueOrDefault(stem) ?? (table[stem] = []);
                if (!list.Contains(slot)) list.Add(slot);
            }
            try
            {
                if (Gbx.ParseNode(file) is CPlugGameSkin gs)
                    foreach (var fid in gs.HeaderFids ?? [])
                        if (fid?.Name is not null && !string.IsNullOrEmpty(fid.Directory))
                            Add(fid.Name, fid.Directory);
            }
            catch (Exception)
            {
                // A few skins carry chunks GBX.NET can't read (e.g.
                // TrackWallToDecoCliff). Their slot list is still plain in
                // the decompressed bytes: "<Slot> … <Media\Material\X.Material.Gbx>".
                try
                {
                    using var body = new MemoryStream();
                    Gbx.Decompress(file, body);
                    foreach (var (slot, path) in TerrainModifiers.ParseSkinSlots(Encoding.Latin1.GetString(body.ToArray())))
                        Add(slot, path);
                    fromRaw++;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"  gameskin {name}: {ex.Message}");
                }
            }
            skins[key] = table;
        }
        Console.WriteLine($"gameskins: {skins.Count} loaded ({fromRaw} from raw bytes)");
        return skins;
    }

    /// <summary>The replacement for material <paramref name="stem"/> under the
    /// active modifiers, or null when none applies.</summary>
    private (string Path, string Tag)? ResolveOverride(string stem)
    {
        (string, string)? hit = null;
        foreach (var mod in activeModifiers)
        {
            if (!mod.SlotsByStem.TryGetValue(stem, out var slots)) continue;
            foreach (var slot in slots)
            {
                var candidate = Fs.Fix(Path.Combine(mod.Folder, slot + ".Material.Gbx"));
                if (File.Exists(candidate)) { hit = (candidate, mod.Tag); break; }
            }
        }
        return hit;
    }

    // --- material/texture library ---

    /// <summary>Normalizes a material reference to a short name and records its diffuse texture once.</summary>
    private string RegisterMaterial(string? pathOrId, CPlugMaterial? node)
    {
        if (string.IsNullOrEmpty(pathOrId)) return "default";
        var name = Sanitize(TerrainModifiers.Stem(pathOrId));

        string? overridePath = null;
        if (TerrainModifiers.ModifierFolder(pathOrId) is string direct)
        {
            // A mesh that references a replacement material directly (e.g.
            // OpenDirtRoadToRoadInGrass -> Modifier\PlatformDirt\PlatformTech)
            // must not be exported under the BASE name: that would hand every
            // plain tech platform the dirt texture. No further swap applies —
            // the skins key on the base material paths only.
            name = Sanitize($"{direct}.{name}");
        }
        else if (ResolveOverride(name) is var (ovr, tag))
        {
            // Terrain modifier in effect for this block? Export the
            // replacement under its own name so blocks sharing the base mesh
            // don't collide.
            overridePath = ovr;
            name = Sanitize($"{tag}.{TerrainModifiers.Stem(ovr)}");
        }

        if (!materialImages.ContainsKey(name))
        {
            materialImages[name] = null;
            try
            {
                // Materials referenced by id alone carry no node — load their
                // .Material.Gbx from the extracted game data instead.
                var mat = overridePath is not null
                    ? Gbx.ParseNode(overridePath) as CPlugMaterial
                    : node ?? LoadMaterial(name);
                // A material with neither shader nor textures draws nothing
                // in-game (modifiers use these to hide parts of the base mesh).
                if (mat is not null && mat.CustomMaterial is null &&
                    string.IsNullOrEmpty(mat.ShaderFile?.FilePath) && mat.Shader is null)
                {
                    materialInvisible.Add(name);
                    materialImages.Remove(name); // nothing to export for it
                    return name;
                }
                var (img, slot) = FindDiffuse(mat);
                materialImages[name] = img;
                // MESHDUMP_TRACE_MATERIAL=<name>: which block/reference first
                // registered a material (for "wrong texture on X" hunts).
                if (string.Equals(Environment.GetEnvironmentVariable("MESHDUMP_TRACE_MATERIAL"), name, StringComparison.OrdinalIgnoreCase))
                    Console.WriteLine($"trace {name}: block={currentBlock} ref={pathOrId} node={(node is null ? "none" : "given")} override={overridePath ?? "-"} image={img}");
                var shader = mat?.ShaderFile?.FilePath;
                if (!string.IsNullOrEmpty(shader))
                    materialShader[name] = Path.GetFileName(shader.Replace('\\', '/'));
                // Py*/Pxz* slots = the shader projects the texture from
                // world axes; mesh UVs are meaningless for these. The bitmap
                // carries the tiling (repeats per world unit).
                if (slot is not null &&
                    (slot.StartsWith("Py", StringComparison.Ordinal) ||
                     slot.StartsWith("Pxz", StringComparison.Ordinal)))
                {
                    var bmp = mat?.CustomMaterial?.Textures?
                        .FirstOrDefault(x => x.Name == slot)?.Texture as CPlugBitmap;
                    var scale = bmp?.DefaultTexCoordScale.X ?? 0f;
                    materialProjected[name] = scale > 0f ? scale : 1f / 32f;
                }
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

        // Sign/chrono panels (Tech3 *_DispIn shaders) show their content —
        // arrows, checkpoint digits — through the MulInside slot; the
        // BaseColor is just the LED-cell backdrop. Blank slots hold Rgba0000.
        var r = byName(n => n is "MulInside");
        if (r.Item1 is not null && Path.GetFileName(r.Item1).StartsWith("Rgba0000", StringComparison.OrdinalIgnoreCase))
            r = (null, null);
        if (r.Item1 is null) r = byName(n => n is "BaseColor" or "BaseColorOp" or "Diffuse");
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
            // Which game image this PNG was made from: a re-import after a
            // slot-selection change (or game update) must not keep a stale
            // PNG just because a file of that name exists.
            var source = Path.GetRelativePath(root, image).Replace('\\', '/') +
                         (opacity is null ? "" : "+" + Path.GetFileName(opacity));
            var previous = json[name]?["source"]?.GetValue<string>();
            // Opacity-masked materials always regenerate: the mask must be
            // baked into the PNG's alpha (decal lettering, cut-outs).
            if (!File.Exists(pngPath) || opacity is not null || previous != source)
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
            var entry = new JsonObject { ["texture"] = pngRel, ["source"] = source };
            // Shader-driven render hints for the editor: decal shaders draw
            // an alpha layer ON a surface (needs depth bias, no z-fight with
            // the base); TAdd shaders are additive glow strips.
            if (materialShader.TryGetValue(name, out var shader))
            {
                if (shader.Contains("Decal", StringComparison.OrdinalIgnoreCase)) entry["decal"] = true;
                if (shader.Contains("TAdd", StringComparison.OrdinalIgnoreCase)) entry["blend"] = "add";
            }
            // Water surfaces ship a normal map as their only image (no
            // diffuse) and glass walls an alpha texture: flag them so the
            // editor draws them translucent instead of as opaque grey.
            var srcName = Path.GetFileNameWithoutExtension(source ?? "");
            if (srcName.Contains("Water", StringComparison.OrdinalIgnoreCase) && srcName.EndsWith("SxSySz", StringComparison.OrdinalIgnoreCase))
                entry["water"] = true;
            else if (srcName.EndsWith("_T", StringComparison.OrdinalIgnoreCase))
                entry["translucent"] = true;
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

    /** When set, triangles whose centre lies outside this XZ box (1u slack)
     * are dropped. Used for caps: the game's ground undersides carry terrain
     * blending skirts that spread several cells into the neighbours. */
    public (Vector3 Min, Vector3 Max)? ClipBox;

    /** Clips one triangle to ClipBox in XZ (Sutherland–Hodgman, 1u slack).
     * null = untouched (no box, or fully inside); an empty list = fully
     * outside; otherwise the polygon that remains, UVs interpolated. Big
     * skirt triangles straddling the edge keep their inside part instead of
     * being dropped or kept whole. */
    private List<(Vector3 P, Vector2 UV)>? ClipTriangle((Vector3 P, Vector2 UV) a, (Vector3 P, Vector2 UV) b, (Vector3 P, Vector2 UV) c)
    {
        if (ClipBox is not var (lo, hi)) return null;
        float x0 = lo.X - 1f, x1 = hi.X + 1f, z0 = lo.Z - 1f, z1 = hi.Z + 1f;
        bool Inside(Vector3 p) => p.X >= x0 && p.X <= x1 && p.Z >= z0 && p.Z <= z1;
        if (Inside(a.P) && Inside(b.P) && Inside(c.P)) return null;
        var poly = new List<(Vector3 P, Vector2 UV)> { a, b, c };
        foreach (var f in new Func<Vector3, float>[] { p => p.X - x0, p => x1 - p.X, p => p.Z - z0, p => z1 - p.Z })
        {
            if (poly.Count == 0) break;
            var next = new List<(Vector3 P, Vector2 UV)>();
            for (var i = 0; i < poly.Count; i++)
            {
                var cur = poly[i];
                var prev = poly[(i + poly.Count - 1) % poly.Count];
                float fc = f(cur.P), fp = f(prev.P);
                if (fc >= 0f)
                {
                    if (fp < 0f) next.Add(Lerp(prev, cur, fp / (fp - fc)));
                    next.Add(cur);
                }
                else if (fp >= 0f) next.Add(Lerp(prev, cur, fp / (fp - fc)));
            }
            poly = next;
        }
        return poly;
    }

    private static (Vector3 P, Vector2 UV) Lerp((Vector3 P, Vector2 UV) a, (Vector3 P, Vector2 UV) b, float t) =>
        (Vector3.Lerp(a.P, b.P, t), Vector2.Lerp(a.UV, b.UV, t));

    /** Appends a polygon as new vertices + a triangle fan, tagged with the
     * current source. */
    private void EmitPolygon(StringBuilder faces, List<(Vector3 P, Vector2 UV)> poly)
    {
        if (poly.Count < 3) return;
        var start = vertCount + 1;
        foreach (var (p, uv) in poly)
        {
            Grow(p);
            v.Append("v ").Append(N(p.X)).Append(' ').Append(N(p.Y)).Append(' ').Append(N(p.Z)).Append('\n');
            vt.Append("vt ").Append(N(uv.X)).Append(' ').Append(N(uv.Y)).Append('\n');
        }
        RecordSource(start, poly.Count);
        vertCount += poly.Count;
        for (var i = 1; i + 1 < poly.Count; i++)
        {
            Cover(poly[0].P, poly[i].P, poly[i + 1].P);
            faces.Append("f ").Append(F(start)).Append(' ').Append(F(start + i)).Append(' ').Append(F(start + i + 1)).Append('\n');
        }
    }

    public void AddVisual(
        CPlugVisualIndexedTriangles visual, Quaternion q, Vector3 t, string material, float? projectedScale = null)
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

        if (projectedScale is float s)
        {
            // The game's Py/Pxz shaders ignore mesh UVs and project the
            // texture from WORLD axes (top faces from above, side faces
            // from their dominant horizontal axis). Reproduce that per
            // face — mesh UVs would smear/rotate the pattern on curved
            // tops and cut faces. `s` = repeats per world unit (1/32 = one
            // tile per grid cell) from the bitmap's DefaultTexCoordScale.
            if (!facesByMaterial.TryGetValue(material, out var pf))
                facesByMaterial[material] = pf = new StringBuilder();
            for (var i = 0; i + 2 < indices.Length; i += 3)
            {
                var w0 = Vector3.Transform(positions[indices[i]], q) + t;
                var w1 = Vector3.Transform(positions[indices[i + 1]], q) + t;
                var w2 = Vector3.Transform(positions[indices[i + 2]], q) + t;
                var n = Vector3.Cross(w1 - w0, w2 - w0);
                var (ax, ay, az) = (MathF.Abs(n.X), MathF.Abs(n.Y), MathF.Abs(n.Z));
                Vector2 Proj(Vector3 w) => (ay >= ax && ay >= az ? new Vector2(w.X, w.Z)
                    : ax >= az ? new Vector2(w.Z, w.Y)
                    : new Vector2(w.X, w.Y)) * s;
                var tri = new List<(Vector3 P, Vector2 UV)> { (w0, Proj(w0)), (w1, Proj(w1)), (w2, Proj(w2)) };
                EmitPolygon(pf, ClipTriangle(tri[0], tri[1], tri[2]) ?? tri);
            }
            return;
        }

        var baseIndex = vertCount + 1; // OBJ is 1-based
        var world = new Vector3[positions.Length];
        for (var i = 0; i < positions.Length; i++)
        {
            var w = world[i] = Vector3.Transform(positions[i], q) + t;
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
            int i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
            if (ClipBox is not null)
            {
                Vector2 Uv(int k) => uvs is not null && k < uvs.Length ? new Vector2(uvs[k].X, uvs[k].Y) : default;
                var poly = ClipTriangle((world[i0], Uv(i0)), (world[i1], Uv(i1)), (world[i2], Uv(i2)));
                if (poly is not null)
                {
                    // Straddles or lies outside the box: the surviving part
                    // goes in as fresh vertices (fan), the original triangle
                    // is dropped.
                    EmitPolygon(f, poly);
                    continue;
                }
            }
            Cover(world[i0], world[i1], world[i2]);
            f.Append("f ").Append(F(baseIndex + i0))
             .Append(' ').Append(F(baseIndex + i1))
             .Append(' ').Append(F(baseIndex + i2)).Append('\n');
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
    /** Coarse XZ height map (4-unit cells, −64..192): per cell the highest
     * and lowest Y of any triangle touching it. Rasterised from triangle
     * bounding boxes, not vertices, so a four-vertex slab still counts as
     * covered inside. Unset cells hold MinValue / MaxValue. */
    public readonly float[,] CellMaxY = NewGrid(float.MinValue);
    public readonly float[,] CellMinY = NewGrid(float.MaxValue);
    private int footprintCells;
    public int FootprintCells => footprintCells;

    /** Cells this builder occupies that are already set in <paramref name="cov"/>. */
    public int OverlapCells(bool[,] cov)
    {
        var n = 0;
        for (var xi = 0; xi < 64; xi++)
            for (var zi = 0; zi < 64; zi++)
                if (CellMaxY[xi, zi] != float.MinValue && cov[xi, zi]) n++;
        return n;
    }

    public void MarkCells(bool[,] cov)
    {
        for (var xi = 0; xi < 64; xi++)
            for (var zi = 0; zi < 64; zi++)
                if (CellMaxY[xi, zi] != float.MinValue) cov[xi, zi] = true;
    }

    private static float[,] NewGrid(float fill)
    {
        var g = new float[64, 64];
        for (var i = 0; i < 64; i++) for (var j = 0; j < 64; j++) g[i, j] = fill;
        return g;
    }

    private static int Bucket(float v) => Math.Clamp((int)((v + 64f) / 4f), 0, 63);

    private void Cover(Vector3 a, Vector3 b, Vector3 c)
    {
        int x0 = Bucket(MathF.Min(a.X, MathF.Min(b.X, c.X))), x1 = Bucket(MathF.Max(a.X, MathF.Max(b.X, c.X)));
        int z0 = Bucket(MathF.Min(a.Z, MathF.Min(b.Z, c.Z))), z1 = Bucket(MathF.Max(a.Z, MathF.Max(b.Z, c.Z)));
        float yLo = MathF.Min(a.Y, MathF.Min(b.Y, c.Y)), yHi = MathF.Max(a.Y, MathF.Max(b.Y, c.Y));
        for (var xi = x0; xi <= x1; xi++)
            for (var zi = z0; zi <= z1; zi++)
            {
                if (CellMaxY[xi, zi] == float.MinValue) footprintCells++;
                if (yHi > CellMaxY[xi, zi]) CellMaxY[xi, zi] = yHi;
                if (yLo < CellMinY[xi, zi]) CellMinY[xi, zi] = yLo;
            }
    }

    /** Fraction (0..1) of this geometry's footprint cells with nothing of
     * <paramref name="body"/> beneath them — 0 when it sits fully over the body. */
    public float UncoveredBy(ObjBuilder body)
    {
        if (footprintCells == 0) return 0f;
        var missing = 0;
        for (var xi = 0; xi < 64; xi++)
            for (var zi = 0; zi < 64; zi++)
                if (CellMaxY[xi, zi] != float.MinValue && body.CellMaxY[xi, zi] == float.MinValue) missing++;
        return (float)missing / footprintCells;
    }

    /** How badly this flat cap misses the body it should sit on, per cell of
     * its own footprint: a top cap's underside against the body's top, a
     * bottom cap's top against the body's underside. Cells with no body at
     * all count as a full 32-unit miss. Orientation-sensitive where range
     * maxima are not: a coping strip turned 90° along a quarter pipe's side
     * floats above the curve for most of its length. */
    public float CapMismatch(ObjBuilder body, bool top)
    {
        if (footprintCells == 0) return 0f;
        var sum = 0f;
        for (var xi = 0; xi < 64; xi++)
            for (var zi = 0; zi < 64; zi++)
            {
                if (CellMaxY[xi, zi] == float.MinValue) continue;
                if (body.CellMaxY[xi, zi] == float.MinValue) { sum += 32f; continue; }
                sum += top
                    ? MathF.Abs(CellMinY[xi, zi] - body.CellMaxY[xi, zi])
                    : MathF.Abs(CellMaxY[xi, zi] - body.CellMinY[xi, zi]);
            }
        return sum / footprintCells;
    }

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
            Cover(positions[indices[i]], positions[indices[i + 1]], positions[indices[i + 2]]);
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
