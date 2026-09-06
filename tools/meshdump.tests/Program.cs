using System.Text.Json;
using GBX.NET;
using GBX.NET.Engines.Game;
using Trackedit;

// Dependency-free contract tests: asymmetric coordinates and rotations catch
// axis swaps, unwanted world/grid conversion, and degree/radian conversion.
var grid = new CGameCtnBlock
{
    Name = "RoadTechStraight", Coord = new Int3(2, 9, 7), Direction = (Direction)3,
    IsGround = true, Variant = 2, SubVariant = 4, Color = DifficultyColor.Red,
};
var free = new CGameCtnBlock
{
    Name = "RoadTechCurve", IsFree = true,
    AbsolutePositionInMap = new Vec3(12.5f, -8, 96),
    YawPitchRoll = new Vec3(0.25f, -0.5f, 1.5f),
};
var map = new CGameCtnChallenge
{
    MapName = "Contract fixture", Decoration = new Ident("Stadium2020", 26, "Nadeo"),
    Blocks = [grid, free],
    AnchoredObjects = [new CGameCtnAnchoredObject
    {
        ItemModel = new Ident("Custom/My.Item.Gbx", 26, "Builder"),
        AbsolutePositionInMap = new Vec3(-16, 24, 128),
        YawPitchRoll = new Vec3(-0.75f, 0.125f, 0.5f),
        PivotPosition = new Vec3(1, 2, 3), Scale = 1.5f,
    }],
};
using var json = JsonDocument.Parse(MapDump.Serialize(map));
var root = json.RootElement;
Check(root.GetProperty("decoration").GetString() == "Stadium2020", "decoration identifier");
var b = root.GetProperty("blocks")[0];
Check(b.GetProperty("coord").GetRawText() == "[2,9,7]", "grid coordinates");
Check(b.GetProperty("dir").GetInt32() == 3, "grid direction");
Check(b.GetProperty("isGround").GetBoolean(), "ground flag");
Check(b.GetProperty("variant").GetInt32() == 2 && b.GetProperty("subVariant").GetInt32() == 4, "variants");
Check(b.GetProperty("color").GetString() == "Red", "color name");
b = root.GetProperty("blocks")[1];
Check(b.GetProperty("isFree").GetBoolean(), "free flag");
Check(b.GetProperty("absPos").GetRawText() == "[12.5,-8,96]", "free world coordinates");
Check(b.GetProperty("yawPitchRoll").GetRawText() == "[0.25,-0.5,1.5]", "free rotation");
var item = root.GetProperty("items")[0];
Check(item.GetProperty("name").GetString() == "Custom/My.Item.Gbx", "item path");
Check(item.GetProperty("itemAuthor").GetString() == "Builder", "item author");
Check(item.GetProperty("absPos").GetRawText() == "[-16,24,128]", "item world coordinates");
Check(item.GetProperty("yawPitchRoll").GetRawText() == "[-0.75,0.125,0.5]", "item rotation");
Check(item.GetProperty("pivotPos").GetRawText() == "[1,2,3]", "item pivot");
Check(item.GetProperty("scale").GetSingle() == 1.5f, "item scale");
using var empty = JsonDocument.Parse(MapDump.Serialize(new CGameCtnChallenge()));
Check(empty.RootElement.GetProperty("blocks").GetArrayLength() == 0, "empty blocks");
Check(empty.RootElement.GetProperty("items").GetArrayLength() == 0, "empty items");
Console.WriteLine("Map converter contract tests passed.");

// Terrain-modifier plumbing: the pieces that turn a block's modifier
// reference into "which replacement material file" without game data.
Check(TerrainModifiers.Stem(@"Media\Material\DecalSpecialTurbo.Material.Gbx") == "DecalSpecialTurbo", "material stem from path");
Check(TerrainModifiers.Stem("Stadium/Media/Material/Sign.Material.gbx") == "Sign", "material stem, forward slashes");
Check(TerrainModifiers.Stem("PlatformTech") == "PlatformTech", "material stem from bare id");
Check(TerrainModifiers.ModifierFolder(@"Media\Modifier\PlatformDirt\PlatformTech.Material.Gbx") == "PlatformDirt", "direct modifier material folder");
Check(TerrainModifiers.ModifierFolder(@"Modifier\PlatformDirt\PlatformTech.Material.Gbx") == "PlatformDirt", "direct modifier material, relative path (the OpenDirtRoad case)");
Check(TerrainModifiers.ModifierFolder(@"Stadium\Media\Material\PlatformTech.Material.Gbx") is null, "base material has no modifier folder");
Check(TerrainModifiers.ModifierFolder("PlatformTech") is null, "bare id has no modifier folder");
Check(TerrainModifiers.TagFromFileName(@"C:\x\Media\Modifier\NoBrake.TerrainModifier .Gbx") == "NoBrake", "modifier tag from odd file name");
var (skin, folder) = TerrainModifiers.ParseBody(
    "BUUR\0Stadium\\Media\\Modifier\\Fragile\\\0GameSkin\0Media\0Modifier\0Specials.GameSkin.gbx\0");
Check(skin == "Specials", "game skin from modifier body");
Check(folder == "Fragile", "replacement folder from modifier body");
Check(TerrainModifiers.ParseBody("no references here") == (null, null), "modifier body without references");
var slots = TerrainModifiers.ParseSkinSlots(
    "BUUR\0\t\0\0\0TrackWall-\0\0\0Stadium\\Media\\Material\\TrackWall.Material.Gbx\0PIKSf" +
    "\t\0\0\0TrackWall-\0\0\0Stadium\\Media\\Material\\TrackWall.Material.Gbx\0" +
    "\x05\0\0\0Decal\x2D\0\0\0Stadium\\Media\\Material\\DecalSpecialTurbo.Material.Gbx");
Check(slots.Count == 2, "skin slots deduplicated across header and body");
Check(slots[0] == ("TrackWall", @"Stadium\Media\Material\TrackWall.Material.Gbx"), "first skin slot");
Check(slots[1].Slot == "Decal" && slots[1].Path.EndsWith("DecalSpecialTurbo.Material.Gbx"), "second skin slot");
Console.WriteLine("Terrain modifier tests passed.");

static void Check(bool condition, string label)
{
    if (!condition) throw new Exception($"Failed: {label}");
}
