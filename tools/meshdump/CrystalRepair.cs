using System.Text;

namespace Trackedit;

/// <summary>
/// Repairs Mesh Modeler items GBX.NET cannot read. The crystal's geometry
/// layer parses; what breaks are trailing *modifier* layers (a Deformation
/// layer version GBX.NET's reader does not consume fully) and the lightmap
/// chunk that follows. The exporter only uses the geometry layer, so the
/// repair drops, in order, the last modifier layer(s), then the lightmap
/// chunk 0x09003006, then chunk 0x09003007 — each step a new candidate the
/// caller tries to parse. Works on an uncompressed Gbx image.
/// </summary>
public static class CrystalRepair
{
    private const uint LayersChunk = 0x09003005;
    private const uint LightmapChunk = 0x09003006;
    private const uint Chunk7 = 0x09003007;
    private const uint Facade = 0xFACADE01;

    public static IEnumerable<byte[]> Candidates(byte[] gbx)
    {
        // Minimal repair first: at each number of dropped modifier layers
        // (none, one, two, …) try removing the lightmap chunk, then chunk 7,
        // before dropping another layer. Modifier layers are dropped last-first
        // and the first (geometry) layer never.
        var level = gbx;
        for (var dropped = 0; dropped < 8; dropped++)
        {
            if (dropped > 0) yield return level;
            var noLightmap = RemoveChunk(level, LightmapChunk, [Chunk7, Facade]);
            if (noLightmap is not null)
            {
                yield return noLightmap;
                var noChunk7 = RemoveChunk(noLightmap, Chunk7, [Facade]);
                if (noChunk7 is not null) yield return noChunk7;
            }
            var next = DropLastLayer(level);
            if (next is null) break;
            level = next;
        }
    }

    private static int Find(byte[] d, uint value, int from = 0)
    {
        var pat = BitConverter.GetBytes(value);
        for (var i = Math.Max(0, from); i + 4 <= d.Length; i++)
            if (d[i] == pat[0] && d[i + 1] == pat[1] && d[i + 2] == pat[2] && d[i + 3] == pat[3]) return i;
        return -1;
    }

    private static int NextChunk(byte[] d, int from, uint[] ids)
    {
        var best = -1;
        foreach (var id in ids)
        {
            var p = Find(d, id, from);
            if (p >= 0 && (best < 0 || p < best)) best = p;
        }
        return best;
    }

    /// <summary>Layer headers: [type:int][version:int][0][0x40000000][name][typeName].</summary>
    private static List<(int Start, int Type, string Name)> LayerStarts(byte[] d, int from, int to)
    {
        var starts = new List<(int, int, string)>();
        for (var p = from; p + 24 < to; p++)
        {
            if (BitConverter.ToUInt32(d, p + 8) != 0 || BitConverter.ToUInt32(d, p + 12) != 0x40000000) continue;
            var n = BitConverter.ToInt32(d, p + 16);
            if (n < 1 || n > 32 || p + 20 + n > to) continue;
            var ok = true;
            for (var k = 0; k < n; k++) if (d[p + 20 + k] < 32 || d[p + 20 + k] > 126) { ok = false; break; }
            if (!ok) continue;
            starts.Add((p, BitConverter.ToInt32(d, p), Encoding.ASCII.GetString(d, p + 20, n)));
        }
        return starts;
    }

    private static byte[]? DropLastLayer(byte[] d)
    {
        var c5 = Find(d, LayersChunk);
        if (c5 < 0 || c5 + 12 > d.Length) return null;
        var count = BitConverter.ToInt32(d, c5 + 8);
        if (count < 2) return null;
        var end = NextChunk(d, c5 + 4, [LightmapChunk, Chunk7, Facade]);
        if (end < 0) return null;
        var layers = LayerStarts(d, c5 + 12, end);
        if (layers.Count != count) return null;
        var last = layers[^1];
        if (last.Type == 0) return null; // geometry: keep
        var outBytes = new byte[last.Start + (d.Length - end)];
        Buffer.BlockCopy(d, 0, outBytes, 0, last.Start);
        Buffer.BlockCopy(d, end, outBytes, last.Start, d.Length - end);
        BitConverter.GetBytes(count - 1).CopyTo(outBytes, c5 + 8);
        Console.Error.WriteLine($"  crystal repair: dropped modifier layer \"{last.Name}\" (type {last.Type})");
        return outBytes;
    }

    private static byte[]? RemoveChunk(byte[] d, uint id, uint[] followers)
    {
        var start = Find(d, id);
        if (start < 0) return null;
        var end = NextChunk(d, start + 4, followers);
        if (end < 0) return null;
        var outBytes = new byte[d.Length - (end - start)];
        Buffer.BlockCopy(d, 0, outBytes, 0, start);
        Buffer.BlockCopy(d, end, outBytes, start, d.Length - end);
        Console.Error.WriteLine($"  crystal repair: removed chunk 0x{id:X8}");
        return outBytes;
    }
}
