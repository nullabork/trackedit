using System.Numerics;
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

// Mobil geometry transforms: the wall checkpoints reuse the flat ground
// checkpoint prefab (x 0..32, y 0..~10, z 0..32) and stand it against the
// wall through GeomRotation/GeomTranslation. Every variant must land
// inside its cell, upright, protruding from the wall at z=32.
static bool Near(System.Numerics.Vector3 a, float x, float y, float z) =>
    MathF.Abs(a.X - x) < 0.01f && MathF.Abs(a.Y - y) < 0.01f && MathF.Abs(a.Z - z) < 0.01f;
var down = MobilGeom.Compose(new(-90, 0, 180), new(32, 32, 32));
Check(Near(MobilGeom.Apply(down, new(0, 0, 0)), 32, 32, 32), "Down checkpoint: origin corner");
Check(Near(MobilGeom.Apply(down, new(32, 10, 32)), 0, 0, 22), "Down checkpoint: arch top protrudes from the wall");
var up = MobilGeom.Compose(new(-90, 0, 0), new(0, 0, 32));
Check(Near(MobilGeom.Apply(up, new(32, 10, 32)), 32, 32, 22), "Up checkpoint: arch top");
var left = MobilGeom.Compose(new(-90, 0, -90), new(0, 32, 32));
Check(Near(MobilGeom.Apply(left, new(32, 10, 32)), 32, 0, 22), "Left checkpoint: arch top");
var right = MobilGeom.Compose(new(-90, 0, 90), new(32, 0, 32));
Check(Near(MobilGeom.Apply(right, new(32, 10, 32)), 0, 32, 22), "Right checkpoint: arch top");
var lift = MobilGeom.Compose(new(0, 0, 0), new(0, 8, 0));
Check(Near(MobilGeom.Apply(lift, new(1, 2, 3)), 1, 10, 3), "translation-only FCB lift");

// Vertical clip rows: which wall segment shows depends on the stack.
Check(MobilGeom.WallSegment(above: false, below: false) == "TopBottom", "lone wall segment");
Check(MobilGeom.WallSegment(above: true, below: false) == "Bottom", "bottom of a stack");
Check(MobilGeom.WallSegment(above: false, below: true) == "Top", "top of a stack");
Check(MobilGeom.WallSegment(above: true, below: true) == "Middle", "middle of a stack");
Check(MobilGeom.SegmentKind(@"Media\Prefab\X\VFCCornerInLeft_TopBottom_Air.Prefab.Gbx") == "TopBottom", "TopBottom row by name");
Check(MobilGeom.SegmentKind("Base_VFCMiddle2.Prefab.Gbx") == "Middle", "merged middle row by name");
Check(MobilGeom.SegmentKind("VFC_Bottom.Prefab.Gbx") == "Bottom", "bottom row by name");
Check(MobilGeom.SegmentKind("WallStraight_VFCLeftTop_Air.Prefab.Gbx") == "Top", "top row by name");
Check(MobilGeom.SegmentKind("Curve1.Prefab.Gbx") == "", "unnamed row");
Console.WriteLine("Mobil geometry tests passed.");

static void Check(bool condition, string label)
{
    if (!condition) throw new Exception($"Failed: {label}");
}
