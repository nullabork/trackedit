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
    public static string Serialize(CGameCtnChallenge map) => JsonSerializer.Serialize(new
    {
        mapName = map.MapName,
        mapUid = map.MapUid,
        decoration = map.Decoration?.Id,
        mod = Pack(map.ModPackDesc),
        blocks = (map.Blocks ?? []).Select(b => new
        {
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
        items = (map.AnchoredObjects ?? []).Select(i => new
        {
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
