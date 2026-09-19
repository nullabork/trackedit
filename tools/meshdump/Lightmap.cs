using GBX.NET;
using GBX.NET.Engines.Game;
using GBX.NET.LZO;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.PixelFormats;

namespace Trackedit;

/// <summary>
/// A map's computed shadows are stored as lightmap frames: WebP images
/// (frame 0 carries three — Data, Data2, Data3 — plus a probe grid; the other
/// frames one each) and a CHmsLightMapCache that maps every object into the
/// atlas. `extract` writes the images out as PNG for inspection or editing;
/// `inject` writes edited PNGs back into a copy of the map. That is the
/// cheapest test of whether the game honours a lightmap it did not bake.
/// </summary>
public static class Lightmap
{
    private static readonly string[] Slots = ["Data", "Data2", "Data3"];

    public static int Extract(string mapPath, string outDir)
    {
        Gbx.LZO = new Lzo();
        var map = Gbx.ParseNode<CGameCtnChallenge>(mapPath);
        var frames = map.LightmapFrames?.ToList();
        if (frames is null || frames.Count == 0)
        {
            Console.WriteLine("no lightmap frames (shadows not computed)");
            return 2;
        }
        Directory.CreateDirectory(outDir);
        for (var i = 0; i < frames.Count; i++)
        {
            foreach (var slot in Slots)
            {
                if (frames[i].GetType().GetProperty(slot)?.GetValue(frames[i]) is not byte[] { Length: > 0 } data) continue;
                var stem = Path.Combine(outDir, $"frame{i}_{slot}");
                File.WriteAllBytes(stem + ".webp", data);
                using var img = Image.Load<Rgba32>(data);
                img.SaveAsPng(stem + ".png");
                Console.WriteLine($"frame{i}_{slot}: {img.Width}x{img.Height}, {data.Length} bytes webp");
            }
        }
        return 0;
    }

    /// <summary>Replace frame images with the PNGs found in <paramref name="dir"/> (same names as extract writes).</summary>
    public static int Inject(string mapPath, string dir, string outPath, bool lossless, string? name = null)
    {
        Gbx.LZO = new Lzo();
        var gbx = Gbx.Parse<CGameCtnChallenge>(mapPath);
        if (!string.IsNullOrEmpty(name))
        {
            // Its own identity, so the game neither reuses a cached lightmap
            // of the source map nor mixes up records.
            gbx.Node.MapName = name;
            gbx.Node.MapUid = Convert.ToBase64String(System.Security.Cryptography.SHA1.HashData(System.Text.Encoding.UTF8.GetBytes("trackedit-lm:" + name)))
                .Replace('+', '-').Replace('/', '_')[..27];
        }
        var frames = gbx.Node.LightmapFrames?.ToList();
        if (frames is null || frames.Count == 0)
        {
            Console.Error.WriteLine("the map has no lightmap to replace — compute shadows in the game first");
            return 2;
        }
        var replaced = 0;
        for (var i = 0; i < frames.Count; i++)
        {
            foreach (var slot in Slots)
            {
                var png = Path.Combine(dir, $"frame{i}_{slot}.png");
                var prop = frames[i].GetType().GetProperty(slot);
                if (!File.Exists(png) || prop?.GetValue(frames[i]) is not byte[] { Length: > 0 }) continue;
                using var img = Image.Load<Rgba32>(png);
                using var ms = new MemoryStream();
                img.Save(ms, new WebpEncoder
                {
                    FileFormat = lossless ? WebpFileFormatType.Lossless : WebpFileFormatType.Lossy,
                    Quality = 90,
                });
                prop.SetValue(frames[i], ms.ToArray());
                replaced++;
                Console.WriteLine($"frame{i}_{slot}: {img.Width}x{img.Height} -> {ms.Length} bytes webp");
            }
        }
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
        gbx.Save(outPath);
        var check = Gbx.ParseNode<CGameCtnChallenge>(outPath);
        Console.WriteLine($"wrote {outPath}: {replaced} image(s) replaced, {check.LightmapFrames?.Count() ?? 0} frames, {new FileInfo(outPath).Length} bytes");
        return replaced > 0 ? 0 : 2;
    }
}
