using System.Globalization;
using System.Text.Json;
using GBX.NET;
using GBX.NET.Engines.Game;
using GBX.NET.Engines.GameData;
using GBX.NET.LZO;

namespace Trackedit;

/// <summary>
/// Writes the editor's placements (src/io/trackoJson.ts dialect, the same
/// JSON `meshdump map` emits) into a real .Map.Gbx, using an existing map as
/// the template: decoration, embedded items, palette, metadata and thumbnail
/// all come from it.
///
/// A save only applies CHANGES. Every placement that came from the template
/// carries the index of its original object (`idx`, from `meshdump map`):
/// - unchanged (same name and pose) -> the ORIGINAL object, untouched, so
///   everything the editor does not model — skins, waypoint data, macroblock
///   links, item snapping, variants — survives bit for bit;
/// - moved or rotated -> the original object with only its pose patched;
/// - gone from the editor -> removed; new in the editor -> constructed.
/// Placements without an index (tracks imported before it existed, copies)
/// fall back to matching an unused original by name and pose. Originals keep
/// their order in the file; new objects are appended. The summary reports
/// the four counts, so an unexpected "removed" or "moved" shows up at once.
///
/// The template's lightmap (computed shadows) is kept when nothing changed
/// and dropped otherwise: it was baked for the old geometry. The game recomputes it (editor ▸ compute shadows, or the
/// Batch Compute Shadows Openplanet plugin for a whole folder).
/// </summary>
public static class MapBuild
{
    private static readonly string[] Moods = ["Day", "Sunset", "Night", "Sunrise"];

    public static int Run(string templatePath, string placementsPath, string outPath)
    {
        Gbx.LZO = new Lzo();
        var gbx = Gbx.Parse<CGameCtnChallenge>(templatePath);
        var map = gbx.Node;
        var doc = JsonDocument.Parse(File.ReadAllText(placementsPath)).RootElement;

        var originals = (map.Blocks ?? throw new Exception("template has no block list")).ToList();
        var origItems = map.AnchoredObjects?.ToList() ?? [];
        var itemProto = origItems.FirstOrDefault();

        // --- index the template's own objects by pose -----------------------
        var gridPool = new Dictionary<string, Queue<CGameCtnBlock>>();
        var freePool = new Dictionary<string, Queue<CGameCtnBlock>>();
        var clips = new List<CGameCtnBlock>();
        foreach (var b in originals)
        {
            if (b.IsClip) { clips.Add(b); continue; }
            var pool = b.IsFree ? freePool : gridPool;
            var key = b.IsFree
                ? FreeKey(b.Name, b.AbsolutePositionInMap ?? default, b.YawPitchRoll ?? default)
                : GridKey(b.Name, b.Coord.X, b.Coord.Y, b.Coord.Z, (int)b.Direction);
            (pool.TryGetValue(key, out var q) ? q : pool[key] = new()).Enqueue(b);
        }
        var itemPool = new Dictionary<string, Queue<CGameCtnAnchoredObject>>();
        foreach (var it in origItems)
        {
            var key = FreeKey(it.ItemModel.Id, it.AbsolutePositionInMap, it.YawPitchRoll);
            (itemPool.TryGetValue(key, out var q) ? q : itemPool[key] = new()).Enqueue(it);
        }

        // --- blocks -----------------------------------------------------------
        var outBlocks = new List<CGameCtnBlock>();
        var occupied = new HashSet<(int, int, int)>();
        int reused = 0, built = 0, moved = 0, recoloured = 0;
        var usedBlocks = new HashSet<CGameCtnBlock>(ReferenceEqualityComparer.Instance);
        var blockOrder = new Dictionary<CGameCtnBlock, int>(ReferenceEqualityComparer.Instance);
        for (var i = 0; i < originals.Count; i++) blockOrder[originals[i]] = i;
        // The original a placement came from, if it still names the same block.
        CGameCtnBlock? OriginalBlock(JsonElement p, string name) =>
            p.TryGetProperty("idx", out var ix) && ix.ValueKind == JsonValueKind.Number && ix.GetInt32() is var n
            && n >= 0 && n < originals.Count && originals[n] is { IsClip: false } o && o.Name == name && !usedBlocks.Contains(o) ? o : null;
        CGameCtnBlock? TakeBlock(Dictionary<string, Queue<CGameCtnBlock>> pool, string key)
        {
            while (Take(pool, key) is { } candidate)
                if (usedBlocks.Add(candidate)) return candidate;
            return null;
        }
        foreach (var p in doc.TryGetProperty("blocks", out var blocksEl) ? blocksEl.EnumerateArray() : default)
        {
            if (Bool(p, "isClip")) continue;
            var name = p.GetProperty("name").GetString()!;
            CGameCtnBlock? block;
            if (Bool(p, "isFree"))
            {
                var pos = Vec(p, "absPos");
                var rot = Vec(p, "yawPitchRoll");
                var own = OriginalBlock(p, name);
                if (own is { IsFree: true })
                {
                    // Its own original: untouched when the pose still matches, else only moved.
                    block = own;
                    usedBlocks.Add(own);
                    if (FreeKey(name, own.AbsolutePositionInMap ?? default, own.YawPitchRoll ?? default) == FreeKey(name, pos, rot)) reused++;
                    else { own.AbsolutePositionInMap = pos; own.YawPitchRoll = rot; moved++; }
                }
                else block = TakeBlock(freePool, FreeKey(name, pos, rot));
                if (block is not null && own is null) reused++;
                if (block is null)
                {
                    block = NewBlock(name, p);
                    block.IsFree = true;
                    block.Coord = new Int3(-1, 0, -1);
                    block.AbsolutePositionInMap = pos;
                    block.YawPitchRoll = rot;
                    built++;
                }
            }
            else
            {
                var c = p.GetProperty("coord");
                int x = c[0].GetInt32(), y = c[1].GetInt32(), z = c[2].GetInt32();
                var dir = p.TryGetProperty("dir", out var d) && d.ValueKind == JsonValueKind.Number ? d.GetInt32() : 0;
                var own = OriginalBlock(p, name);
                if (own is { IsFree: false })
                {
                    block = own;
                    usedBlocks.Add(own);
                    if (GridKey(name, own.Coord.X, own.Coord.Y, own.Coord.Z, (int)own.Direction) == GridKey(name, x, y, z, dir)) reused++;
                    else { own.Coord = new Int3(x, y, z); own.Direction = (Direction)dir; moved++; }
                }
                else block = TakeBlock(gridPool, GridKey(name, x, y, z, dir));
                if (block is not null && own is null) reused++;
                if (block is null)
                {
                    block = NewBlock(name, p);
                    block.Coord = new Int3(x, y, z);
                    block.Direction = (Direction)dir;
                    if (p.TryGetProperty("isGround", out var g) && g.ValueKind is JsonValueKind.True or JsonValueKind.False)
                        block.IsGround = g.GetBoolean();
                    built++;
                }
                occupied.Add((x, y, z));
            }
            // Repainting in the editor must stick on reused blocks too.
            if (Enum_<DifficultyColor>(p, "color") is { } color && block.Color != color) { block.Color = color; recoloured++; }
            outBlocks.Add(block);
        }

        // Clip blocks are generated by the game next to the blocks they cap;
        // keep the template's where their neighbourhood still exists.
        var clipsKept = 0;
        foreach (var clip in clips)
        {
            var near = false;
            for (var dx = -1; dx <= 1 && !near; dx++)
                for (var dy = -1; dy <= 1 && !near; dy++)
                    for (var dz = -1; dz <= 1 && !near; dz++)
                        near = occupied.Contains((clip.Coord.X + dx, clip.Coord.Y + dy, clip.Coord.Z + dz));
            if (!near) continue;
            outBlocks.Add(clip);
            clipsKept++;
        }
        var blocksRemoved = originals.Count(o => !o.IsClip && !usedBlocks.Contains(o));
        // Originals stay where they were in the file; new blocks follow.
        outBlocks = outBlocks.OrderBy(b => blockOrder.TryGetValue(b, out var at) ? at : int.MaxValue).ToList();

        // --- items ------------------------------------------------------------
        var outItems = new List<CGameCtnAnchoredObject>();
        int itemsReused = 0, itemsBuilt = 0, itemsSkipped = 0, itemsMoved = 0;
        var usedItems = new HashSet<CGameCtnAnchoredObject>(ReferenceEqualityComparer.Instance);
        var itemOrder = new Dictionary<CGameCtnAnchoredObject, int>(ReferenceEqualityComparer.Instance);
        for (var i = 0; i < origItems.Count; i++) itemOrder[origItems[i]] = i;
        foreach (var p in doc.TryGetProperty("items", out var itemsEl) ? itemsEl.EnumerateArray() : default)
        {
            var name = p.GetProperty("name").GetString()!;
            var pos = Vec(p, "absPos");
            var rot = Vec(p, "yawPitchRoll");
            CGameCtnAnchoredObject? item = null;
            if (p.TryGetProperty("idx", out var ix) && ix.ValueKind == JsonValueKind.Number && ix.GetInt32() is var n
                && n >= 0 && n < origItems.Count && origItems[n].ItemModel.Id == name && usedItems.Add(origItems[n]))
            {
                item = origItems[n];
                if (FreeKey(name, item.AbsolutePositionInMap, item.YawPitchRoll) == FreeKey(name, pos, rot)) itemsReused++;
                else
                {
                    item.AbsolutePositionInMap = pos;
                    item.YawPitchRoll = rot;
                    item.BlockUnitCoord = new Byte3((byte)Math.Clamp((int)(pos.X / 32f), 0, 255), (byte)Math.Clamp((int)(pos.Y / 8f), 0, 255), (byte)Math.Clamp((int)(pos.Z / 32f), 0, 255));
                    itemsMoved++;
                }
            }
            else
            {
                while (Take(itemPool, FreeKey(name, pos, rot)) is { } candidate)
                    if (usedItems.Add(candidate)) { item = candidate; itemsReused++; break; }
            }
            if (item is null)
            {
                if (itemProto is null) { itemsSkipped++; continue; }
                var author = p.TryGetProperty("itemAuthor", out var a) && a.ValueKind == JsonValueKind.String
                    ? a.GetString()! : itemProto.ItemModel.Author;
                item = new CGameCtnAnchoredObject
                {
                    ItemModel = new Ident(name, itemProto.ItemModel.Collection, author),
                    AbsolutePositionInMap = pos,
                    YawPitchRoll = rot,
                    BlockUnitCoord = new Byte3((byte)Math.Clamp((int)(pos.X / 32f), 0, 255), (byte)Math.Clamp((int)(pos.Y / 8f), 0, 255), (byte)Math.Clamp((int)(pos.Z / 32f), 0, 255)),
                    PivotPosition = p.TryGetProperty("pivotPos", out var pv) && pv.ValueKind == JsonValueKind.Array ? Vec(p, "pivotPos") : default,
                    Scale = p.TryGetProperty("scale", out var sc) && sc.ValueKind == JsonValueKind.Number ? sc.GetSingle() : 1f,
                };
                // New items inherit valid serialization data from a real one.
                foreach (var chunk in itemProto.Chunks) item.Chunks.Add(chunk);
                itemsBuilt++;
            }
            if (Enum_<DifficultyColor>(p, "color") is { } color && item.Color != color) { item.Color = color; recoloured++; }
            outItems.Add(item);
        }
        var itemsRemoved = origItems.Count(o => !usedItems.Contains(o));
        outItems = outItems.OrderBy(it => itemOrder.TryGetValue(it, out var at) ? at : int.MaxValue).ToList();
        var changed = built + moved + recoloured + blocksRemoved + itemsBuilt + itemsMoved + itemsRemoved > 0;

        // --- write ------------------------------------------------------------
        map.Blocks!.Clear();
        foreach (var b in outBlocks) map.Blocks.Add(b);
        if (map.AnchoredObjects is not null)
        {
            map.AnchoredObjects.Clear();
            foreach (var it in outItems) map.AnchoredObjects.Add(it);
        }
        map.BakedBlocks?.Clear();

        if (doc.TryGetProperty("mapName", out var nameEl) && nameEl.ValueKind == JsonValueKind.String)
            map.MapName = nameEl.GetString() ?? map.MapName;
        if (doc.TryGetProperty("mapUid", out var uidEl) && uidEl.ValueKind == JsonValueKind.String && uidEl.GetString() is { Length: > 0 } uid)
            map.MapUid = uid;

        // The editor's mood (the decoration's suffix); the base stays the template's.
        if (doc.TryGetProperty("decoration", out var decoEl) && decoEl.GetString() is { } wanted && map.Decoration is { } deco)
        {
            string? MoodOf(string id) => Moods.FirstOrDefault(m => id.EndsWith(m, StringComparison.Ordinal));
            if (MoodOf(wanted) is { } mood && MoodOf(deco.Id) is { } current && mood != current)
            {
                map.Decoration = new Ident(deco.Id[..^current.Length] + mood, deco.Collection, deco.Author);
                changed = true; // another mood is another light: the baked shadows no longer fit
            }
        }

        // A mood mod carrying the editor's sun (see MoodMod). A map has room
        // for one mod only, so a template that already has a texture pack keeps it.
        var sunModSkipped = false;
        if (doc.TryGetProperty("sunMod", out var modEl) && modEl.GetString() is { Length: > 0 } sunMod)
        {
            var own = map.ModPackDesc;
            var ownIsSun = own?.FilePath?.Contains("TrackeditSun", StringComparison.OrdinalIgnoreCase) ?? false;
            if (own is null || ownIsSun || (string.IsNullOrEmpty(own.FilePath) && string.IsNullOrEmpty(own.LocatorUrl)))
            {
                // A different sun than the one the shadows were baked under.
                if (own?.FilePath != sunMod) changed = true;
                map.ModPackDesc = new PackDesc(sunMod, null, doc.TryGetProperty("sunModUrl", out var urlEl) ? urlEl.GetString() ?? "" : "");
            }
            else sunModSkipped = true;
        }

        // Baked shadows are only valid for the geometry they were baked for.
        var hadLightmap = map.LightmapCache is not null;
        if (changed) DropLightmap(map);

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
        gbx.Save(outPath);

        // Prove the file reads back before telling anyone it is a map.
        var check = Gbx.ParseNode<CGameCtnChallenge>(outPath);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            path = Path.GetFullPath(outPath),
            bytes = new FileInfo(outPath).Length,
            mapUid = check.MapUid,
            blocks = check.Blocks?.Count ?? 0,
            blocksReused = reused,
            blocksBuilt = built,
            blocksMoved = moved,
            blocksRemoved,
            itemsMoved,
            itemsRemoved,
            recoloured,
            changed,
            clipsKept,
            items = check.AnchoredObjects?.Count ?? 0,
            itemsReused,
            itemsBuilt,
            itemsSkipped,
            lightmapDropped = hadLightmap && changed,
            lightmapKept = hadLightmap && !changed,
            decoration = check.Decoration?.Id,
            mod = check.ModPackDesc?.FilePath,
            modUrl = check.ModPackDesc?.LocatorUrl,
            sunModSkipped,
        }));
        return 0;
    }

    /// <summary>Remove the baked shadows: stale for edited geometry.</summary>
    private static void DropLightmap(CGameCtnChallenge map)
    {
        map.LightmapCache = null;
        foreach (var chunk in map.Chunks.ToList())
            if (chunk.Id is 0x0304303D or 0x0304305B) map.Chunks.Remove(chunk);
    }

    private static CGameCtnBlock NewBlock(string name, JsonElement p)
    {
        var block = new CGameCtnBlock { Name = name };
        // Flags carries variant / sub-variant / ground / pillar bits: restore
        // it FIRST so the derived properties follow.
        if (p.TryGetProperty("flags", out var fl) && fl.ValueKind == JsonValueKind.Number) block.Flags = fl.GetInt32();
        if (p.TryGetProperty("variant", out var va) && va.ValueKind == JsonValueKind.Number) block.Variant = va.GetByte();
        if (p.TryGetProperty("subVariant", out var sv) && sv.ValueKind == JsonValueKind.Number) block.SubVariant = sv.GetByte();
        if (Enum_<LightmapQuality>(p, "lightmapQuality") is { } lq) block.LightmapQuality = lq;
        // Waypoints: without these a map has no start/finish.
        if (p.TryGetProperty("waypoint", out var wp))
        {
            string? tag = null;
            var order = 0;
            if (wp.ValueKind == JsonValueKind.String) tag = wp.GetString();
            else if (wp.ValueKind == JsonValueKind.Object)
            {
                tag = wp.TryGetProperty("tag", out var t) ? t.GetString() : null;
                if (wp.TryGetProperty("order", out var o) && o.ValueKind == JsonValueKind.Number) order = o.GetInt32();
            }
            if (p.TryGetProperty("waypointOrder", out var wo) && wo.ValueKind == JsonValueKind.Number) order = wo.GetInt32();
            if (!string.IsNullOrEmpty(tag))
            {
                block.WaypointSpecialProperty = new CGameWaypointSpecialProperty { Tag = tag, Order = order };
                block.WaypointSpecialProperty.CreateChunk<CGameWaypointSpecialProperty.Chunk2E009001>();
            }
        }
        return block;
    }

    private static T? Take<T>(Dictionary<string, Queue<T>> pool, string key) where T : class =>
        pool.TryGetValue(key, out var q) && q.Count > 0 ? q.Dequeue() : null;

    private static string GridKey(string name, int x, int y, int z, int dir) => $"{name}|{x},{y},{z}|{dir}";

    // "+ 0f" folds the file's -0.0 into 0: JSON cannot carry the sign of a zero,
    // and a pose that only differs by it has not moved.
    private static string FreeKey(string name, Vec3 pos, Vec3 rot) =>
        string.Create(CultureInfo.InvariantCulture,
            $"{name}|{MathF.Round(pos.X, 2) + 0f},{MathF.Round(pos.Y, 2) + 0f},{MathF.Round(pos.Z, 2) + 0f}|{MathF.Round(rot.X, 3) + 0f},{MathF.Round(rot.Y, 3) + 0f},{MathF.Round(rot.Z, 3) + 0f}");

    private static bool Bool(JsonElement p, string name) =>
        p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    private static Vec3 Vec(JsonElement p, string name) =>
        p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array && v.GetArrayLength() == 3
            ? new Vec3(v[0].GetSingle(), v[1].GetSingle(), v[2].GetSingle())
            : default;

    private static T? Enum_<T>(JsonElement p, string name) where T : struct, Enum =>
        p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && Enum.TryParse<T>(v.GetString(), out var e) ? e : null;
}
