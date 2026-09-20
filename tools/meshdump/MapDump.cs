using System.Text.Json;
using GBX.NET;
using GBX.NET.Engines.Game;
using GBX.NET.Engines.GameData;

namespace Trackedit;

/// <summary>
/// Adapts GBX.NET to src/io/trackoJson.ts. Positions remain in game metres,
/// grid coordinates in cells, and rotations in radians in yaw/pitch/roll order.
/// The editor applies its own vertical-origin conversion on import.
/// This is a placement dump, not a lossless serialization of every GBX chunk.
/// </summary>
public static class MapDump
{
    /// <summary>
    /// Palette rows of the game's colour target tables, in the order the map
    /// stores its choice (chunk 0x0304306C: int version, byte index — absent
    /// on maps saved before palettes existed, which use Classic).
    /// </summary>
    public static readonly string[] PaletteNames =
        ["Classic", "Stunt", "Red", "Orange", "Yellow", "Lime", "Green", "Cyan", "Blue", "Purple", "Pink", "White", "Black"];

    /// <summary>
    /// The map's block-colour palette name (Classic when unset). Read from
    /// the raw body: GBX.NET parses the chunk but exposes nothing of it.
    /// Layout: id 0x0304306C, "PIKS", size, int version, byte palette index.
    /// </summary>
    public static string ColorPalette(string mapPath)
    {
        try
        {
            using var ms = new MemoryStream();
            Gbx.Decompress(mapPath, ms);
            var d = ms.ToArray();
            var pattern = new byte[] { 0x6C, 0x30, 0x04, 0x03, (byte)'P', (byte)'I', (byte)'K', (byte)'S' };
            for (var i = d.Length - pattern.Length - 9; i >= 0; i--)
            {
                var hit = true;
                for (var k = 0; k < pattern.Length && hit; k++) hit = d[i + k] == pattern[k];
                if (!hit) continue;
                var size = BitConverter.ToInt32(d, i + 8);
                if (size < 5 || i + 12 + size > d.Length) return "Classic";
                int index = d[i + 12 + 4];
                return index >= 0 && index < PaletteNames.Length ? PaletteNames[index] : "Classic";
            }
        }
        catch { /* unreadable: default */ }
        return "Classic";
    }

    public static string Serialize(CGameCtnChallenge map, string? mapPath = null) => JsonSerializer.Serialize(new
    {
        mapName = map.MapName,
        mapUid = map.MapUid,
        colorPalette = mapPath is null ? "Classic" : ColorPalette(mapPath),
        decoration = map.Decoration?.Id,
        mod = Pack(map.ModPackDesc),
        blocks = (map.Blocks ?? []).Select((b, index) => new
        {
            // Position in the file's own list: lets a save find THIS object again
            // (MapBuild), however many identical blocks share its pose.
            idx = index,
            name = b.Name,
            coord = new[] { b.Coord.X, b.Coord.Y, b.Coord.Z },
            dir = (int)b.Direction,
            isGround = b.IsGround,
            isClip = b.IsClip,
            isFree = b.IsFree,
            absPos = Vector(b.AbsolutePositionInMap),
            yawPitchRoll = Vector(b.YawPitchRoll),
            flags = b.Flags,
            variant = b.Variant,
            subVariant = b.SubVariant,
            color = b.Color.ToString(),
            lightmapQuality = b.LightmapQuality.ToString(),
            waypoint = Waypoint(b.WaypointSpecialProperty),
            skin = b.Skin is null ? null : new
            {
                text = b.Skin.Text,
                pack = Pack(b.Skin.PackDesc),
                parentPack = Pack(b.Skin.ParentPackDesc),
                foregroundPack = Pack(b.Skin.ForegroundPackDesc),
            },
        }),
        items = (map.AnchoredObjects ?? []).Select((i, index) => new
        {
            idx = index,
            name = i.ItemModel.Id,
            itemAuthor = i.ItemModel.Author,
            absPos = Vector(i.AbsolutePositionInMap),
            yawPitchRoll = Vector(i.YawPitchRoll),
            pivotPos = Vector(i.PivotPosition),
            scale = i.Scale,
            flags = i.Flags,
            color = i.Color.ToString(),
            lightmapQuality = i.LightmapQuality.ToString(),
            waypoint = Waypoint(i.WaypointSpecialProperty),
            // An item's skin: the image on a sign or screen (a game file or a URL).
            skin = i.PackDesc is null && i.ForegroundPackDesc is null ? null : new
            {
                pack = Pack(i.PackDesc),
                foregroundPack = Pack(i.ForegroundPackDesc),
            },
        }),
    });

    private static float[]? Vector(Vec3? v) => v is { } p ? [p.X, p.Y, p.Z] : null;
    private static object? Pack(PackDesc? p) => p is null ? null : new
    {
        file = p.FilePath,
        url = p.LocatorUrl,
    };
    private static object? Waypoint(CGameWaypointSpecialProperty? w) => w is null ? null : new
    {
        tag = w.Tag,
        order = w.Order,
        spawn = w.Spawn,
    };
}
