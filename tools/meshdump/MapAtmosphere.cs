using GBX.NET;
using GBX.NET.Engines.Game;
using GBX.NET.LZO;
using TmEssentials;

namespace Trackedit;

/// <summary>
/// Sky and atmosphere of a map without touching its blocks:
///
/// - `mood=Sunset` rewrites the decoration's mood (Day / Sunset / Night /
///   Sunrise), which picks the game's sky, sun and clouds.
/// - `fog=r,g,b` adds an in-game MediaTracker clip with a Fog block: fog
///   colour, how much of it tints the sky (`sky=`), density (`intensity=`,
///   `distance=`) and cloud opacity (`clouds=`). The clip is triggered on the
///   start block and keeps playing, so it covers the whole run.
///
/// MediaTracker nodes are cloned from donor maps rather than built from
/// nothing, so every chunk version is one the game wrote itself: a clip
/// group donor (any map with an in-game clip) and a fog donor (any map with
/// a Fog block).
/// </summary>
public static class MapAtmosphere
{
    private static readonly string[] Moods = ["Day", "Sunset", "Night", "Sunrise"];

    public static int Run(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine("usage: meshdump atmosphere <in.Map.Gbx> <out.Map.Gbx> [mood=Sunset] [fog=r,g,b groupDonor=<map> fogDonor=<map> sky=0.8 intensity=1 distance=6000 clouds=1] [name=New name]");
            return 1;
        }
        string? Opt(string key) => args.Skip(3).FirstOrDefault(a => a.StartsWith(key + "="))?[(key.Length + 1)..];
        float Num(string key, float fallback) => Opt(key) is { } v && float.TryParse(v, System.Globalization.CultureInfo.InvariantCulture, out var f) ? f : fallback;

        Gbx.LZO = new Lzo();
        var gbx = Gbx.Parse<CGameCtnChallenge>(args[1]);
        var map = gbx.Node;

        if (Opt("name") is { Length: > 0 } name)
        {
            map.MapName = name;
            map.MapUid = Convert.ToBase64String(System.Security.Cryptography.SHA1.HashData(System.Text.Encoding.UTF8.GetBytes("trackedit-atmo:" + name)))
                .Replace('+', '-').Replace('/', '_')[..27];
        }

        if (Opt("mood") is { } mood)
        {
            if (!Moods.Contains(mood)) throw new Exception($"mood must be one of {string.Join(", ", Moods)}");
            var deco = map.Decoration ?? throw new Exception("map has no decoration");
            var id = deco.Id;
            var current = Moods.FirstOrDefault(m => id.EndsWith(m, StringComparison.Ordinal));
            var next = (current is null ? id : id[..^current.Length]) + mood;
            map.Decoration = new Ident(next, deco.Collection, deco.Author);
            Console.WriteLine($"mood: {id} -> {next}");
        }

        if (Opt("fog") is { } fogColor)
        {
            var rgb = fogColor.Split(',').Select(v => float.Parse(v, System.Globalization.CultureInfo.InvariantCulture)).ToArray();
            if (rgb.Length != 3) throw new Exception("fog=r,g,b (0..1 each)");
            var groupDonor = Gbx.ParseNode<CGameCtnChallenge>(Opt("groupDonor") ?? throw new Exception("groupDonor=<map with an in-game clip> required"));
            var fogDonor = Gbx.ParseNode<CGameCtnChallenge>(Opt("fogDonor") ?? throw new Exception("fogDonor=<map with a Fog block> required"));

            var group = groupDonor.ClipGroupInGame ?? throw new Exception("group donor has no in-game clips");
            if (group.Clips.Count == 0) throw new Exception("group donor has no in-game clips");
            var slot = group.Clips[0];
            var fog = Clips(fogDonor).SelectMany(c => c.Tracks).SelectMany(t => t.Blocks).OfType<CGameCtnMediaBlockFog>().FirstOrDefault()
                ?? throw new Exception("fog donor has no Fog block");
            var track = slot.Clip.Tracks.FirstOrDefault() ?? throw new Exception("group donor clip has no track");

            // One hour of constant fog: two identical keys.
            while (fog.Keys.Count > 2) fog.Keys.RemoveAt(fog.Keys.Count - 1);
            while (fog.Keys.Count < 2) fog.Keys.Add(fog.Keys[0]);
            for (var i = 0; i < 2; i++)
            {
                var k = fog.Keys[i];
                k.Time = TimeSingle.FromSeconds(i == 0 ? 0 : 3600);
                k.Intensity = Num("intensity", 1f);
                k.SkyIntensity = Num("sky", 0.8f);
                k.Distance = Num("distance", 6000f);
                k.Coefficient = 1f;
                k.Color = new Vec3(rgb[0], rgb[1], rgb[2]);
                k.CloudsOpacity = Num("clouds", 1f);
                k.CloudsSpeed = 1f;
            }

            track.Name = "Fog";
            track.IsKeepPlaying = true;
            track.Blocks.Clear();
            track.Blocks.Add(fog);
            slot.Clip.Name = "Trackedit atmosphere";
            slot.Clip.Tracks.Clear();
            slot.Clip.Tracks.Add(track);
            slot.Clip.StopWhenLeave = false;
            slot.Clip.StopWhenRespawn = false;

            // Trigger: the cells of every start/spawn block and their
            // neighbours (a block is ClipTriggerSize cells; 3x1x3 by default).
            var size = map.ClipTriggerSize;
            slot.Trigger.Coords.Clear();
            foreach (var b in map.Blocks ?? [])
            {
                var tag = b.WaypointSpecialProperty?.Tag;
                if (tag is not ("Spawn" or "Start" or "StartFinish") && !b.Name.Contains("Start", StringComparison.OrdinalIgnoreCase)) continue;
                if (b.IsFree) continue;
                for (var x = (b.Coord.X - 1) * size.X; x < (b.Coord.X + 2) * size.X; x++)
                    for (var y = (b.Coord.Y - 1) * size.Y; y < (b.Coord.Y + 3) * size.Y; y++)
                        for (var z = (b.Coord.Z - 1) * size.Z; z < (b.Coord.Z + 2) * size.Z; z++)
                            slot.Trigger.Coords.Add(new Int3(x, y, z));
            }
            if (slot.Trigger.Coords.Count == 0) throw new Exception("no grid start block found to trigger the clip on");

            group.Clips.Clear();
            group.Clips.Add(slot);
            map.ClipGroupInGame = group;
            Console.WriteLine($"fog: color {fogColor}, sky {Num("sky", 0.8f)}, {slot.Trigger.Coords.Count} trigger cells");
        }

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(args[2]))!);
        gbx.Save(args[2]);
        var check = Gbx.ParseNode<CGameCtnChallenge>(args[2]);
        Console.WriteLine($"wrote {args[2]}: decoration {check.Decoration?.Id}, in-game clips {check.ClipGroupInGame?.Clips.Count ?? 0}, lightmap frames {check.LightmapFrames?.Count() ?? 0}");
        return 0;
    }

    private static IEnumerable<CGameCtnMediaClip> Clips(CGameCtnChallenge map)
    {
        foreach (var c in new[] { map.ClipIntro, map.ClipAmbiance, map.ClipGlobal, map.ClipPodium })
            if (c is not null) yield return c;
        foreach (var g in new[] { map.ClipGroupInGame, map.ClipGroupEndRace })
            foreach (var ct in g?.Clips ?? [])
                yield return ct.Clip;
    }
}
