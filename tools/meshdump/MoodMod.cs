using System.Globalization;
using System.IO.Compression;
using System.Text.RegularExpressions;

namespace Trackedit;

/// <summary>
/// A texture mod that only carries mood SETTINGS: the game's own
/// `Moods/&lt;Mood&gt;/Mood.MoodSetting.xml` with the sun moved and recoloured.
/// No sky images are shipped, so the stock sky stays (tools/sky_mod.py builds
/// mods that replace it).
///
/// The sun runs along a great circle: it rises due East at DayTime01 0.5 and
/// sets due West at 0.75, and Latitude tilts the circle away from the zenith
/// (docs/NOTES-lightmap-baking.md, section 8; src/core/sun.ts solves the two
/// numbers from a direction). Colours keep each mood's own brightness: a
/// picked colour is scaled to the luminance of the light it replaces, times
/// the multiplier — so a mood whose sun is black (Night) stays sunless and a
/// daytime moon stays off.
/// </summary>
public static class MoodMod
{
    private static readonly string[] Moods = ["Day", "Sunset", "Night", "Sunrise"];

    public static int Run(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine("usage: meshdump moodmod <Stadium/Media/Moods dir> <out.zip> [daytime01=0.6] [latitude=45] [sun=#rrggbb] [sunX=1] [moon=#rrggbb] [moonX=1]");
            return 1;
        }
        string? Opt(string key) => args.Skip(3).FirstOrDefault(a => a.StartsWith(key + "="))?[(key.Length + 1)..];
        double? Num(string key) => Opt(key) is { } v ? double.Parse(v, CultureInfo.InvariantCulture) : null;

        var moodsDir = args[1];
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(args[2]))!);
        if (File.Exists(args[2])) File.Delete(args[2]);
        using var zip = ZipFile.Open(args[2], ZipArchiveMode.Create);
        foreach (var mood in Moods)
        {
            var path = Path.Combine(moodsDir, mood, "Mood.MoodSetting.xml");
            if (!File.Exists(path)) throw new Exception($"{path} not found — extract the game data first");
            var xml = File.ReadAllText(path);
            if (Num("daytime01") is { } t) xml = SetLightAttribute(xml, "DayTime01", t);
            if (Num("latitude") is { } lat) xml = SetLightAttribute(xml, "Latitude", lat);
            xml = Recolour(xml, "LDirSun", Opt("sun"), Num("sunX") ?? 1);
            xml = Recolour(xml, "LDirMoon", Opt("moon"), Num("moonX") ?? 1);
            var entry = zip.CreateEntry($"Moods/{mood}/Mood.MoodSetting.xml");
            using var w = new StreamWriter(entry.Open());
            w.Write(xml);
        }
        Console.WriteLine($"wrote {args[2]}");
        return 0;
    }

    public static string SetLightAttribute(string xml, string name, double value)
    {
        var re = new Regex($"(<Light [^>]*?[ ]{name}=\")[^\"]*(\")");
        if (!re.IsMatch(xml)) throw new Exception($"mood settings have no {name} on <Light>");
        return re.Replace(xml, m => m.Groups[1].Value + value.ToString("0.######", CultureInfo.InvariantCulture) + m.Groups[2].Value, 1);
    }

    /// <summary>Replace a light's HdrColor, keeping its luminance (times <paramref name="scale"/>).</summary>
    public static string Recolour(string xml, string element, string? hex, double scale)
    {
        if (hex is null && scale == 1) return xml;
        var re = new Regex($"(<{element} HdrColor=\")([^\"]*)(\")");
        var m = re.Match(xml);
        if (!m.Success) throw new Exception($"mood settings have no <{element} HdrColor>");
        var stock = m.Groups[2].Value.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(v => double.Parse(v, CultureInfo.InvariantCulture)).ToArray();
        var rgb = stock;
        if (hex is not null)
        {
            var lin = HexToLinear(hex);
            var lum = Luminance(lin);
            rgb = lum <= 0 ? [0, 0, 0] : lin.Select(c => c / lum * Luminance(stock)).ToArray();
        }
        var text = string.Join(' ', rgb.Select(c => (c * scale).ToString("0.######", CultureInfo.InvariantCulture)));
        return re.Replace(xml, mm => mm.Groups[1].Value + text + mm.Groups[3].Value, 1);
    }

    private static double Luminance(double[] c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

    private static double[] HexToLinear(string hex)
    {
        hex = hex.TrimStart('#');
        if (hex.Length != 6) throw new Exception("colours are #rrggbb");
        return Enumerable.Range(0, 3).Select(i =>
        {
            var s = int.Parse(hex.Substring(i * 2, 2), NumberStyles.HexNumber) / 255.0;
            return s <= 0.04045 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4);
        }).ToArray();
    }
}
