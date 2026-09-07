using System.Numerics;
using GBX.NET;
using GBX.NET.Engines.Plug;

namespace Trackedit;

/// <summary>
/// What could be recovered from a prefab GBX.NET can't parse in full.
/// </summary>
public sealed class SalvageResult
{
    /// <summary>Meshes embedded in the prefab. Their entity placement is not
    /// recoverable (it follows the unreadable node), so they are assumed at
    /// the prefab origin — true for the single-mesh road bodies this hits.</summary>
    public List<CPlugSolid2Model> Inline { get; } = [];

    /// <summary>Entities whose model is an external file (sub-prefabs such as
    /// a finish arch or barrier supports), with their exact placement.</summary>
    public List<(string RelativePath, Quaternion Rotation, Vector3 Position)> External { get; } = [];
}

/// <summary>
/// A handful of game files (the RoadTech finish, the v2 ramps, the podium)
/// carry a collision-surface chunk newer than GBX.NET 2.4.4 knows, and the
/// whole prefab fails to load. The bytes are intact though: each entity's
/// CPlugSolid2Model precedes the failing surface, and entities that use
/// external models are just a node index followed by rotation + position.
/// This reads the reference table by hand, re-wraps every inline mesh as
/// its own Gbx (same header and reference table, so material references
/// still resolve) and scans for external-model entities.
/// </summary>
public static class Salvage
{
    private const uint Solid2ModelClass = 0x090BB000;
    private const int HeaderClassOffset = 9;   // "GBX" + version(2) + 4 format bytes

    public static SalvageResult Read(string prefabPath)
    {
        var result = new SalvageResult();
        var trace = Environment.GetEnvironmentVariable("MESHDUMP_TRACE_SALVAGE") is not null;
        byte[] bytes;
        using (var ms = new MemoryStream())
        {
            Gbx.Decompress(prefabPath, ms);
            bytes = ms.ToArray();
        }
        if (bytes.Length < 24 || bytes[0] != 'G' || bytes[1] != 'B' || bytes[2] != 'X') return result;
        var userDataSize = BitConverter.ToInt32(bytes, HeaderClassOffset + 4);
        var numNodesAt = HeaderClassOffset + 8 + userDataSize;
        if (numNodesAt + 4 > bytes.Length) return result;
        var numNodes = BitConverter.ToInt32(bytes, numNodesAt);

        // Reference table (version 6 layout): folders in pre-order (numbered
        // from 1), then files with their node index. Everything up to the
        // body is kept verbatim for the synthetic meshes.
        var pos = numNodesAt + 4;
        int I32() { var v = BitConverter.ToInt32(bytes, pos); pos += 4; return v; }
        string Str() { var n = I32(); var s = System.Text.Encoding.UTF8.GetString(bytes, pos, n); pos += n; return s; }
        var folderPaths = new List<string> { "" };
        void Folders(string parent)
        {
            var n = I32();
            for (var k = 0; k < n; k++)
            {
                var name = Str();
                var path = parent.Length == 0 ? name : parent + "/" + name;
                folderPaths.Add(path);
                Folders(path);
            }
        }
        var files = new List<(string Path, int NodeIndex)>();
        int bodyStart;
        try
        {
            var numExt = I32();
            if (numExt > 0)
            {
                I32(); // ancestor level
                Folders("");
                for (var k = 0; k < numExt; k++)
                {
                    var flags = I32();
                    var name = (flags & 4) == 0 ? Str() : $"resource#{I32()}";
                    var nodeIndex = I32();
                    I32(); // use file
                    var folder = (flags & 4) == 0 ? I32() : 0;
                    var dir = folder >= 0 && folder < folderPaths.Count ? folderPaths[folder] : "";
                    files.Add((dir.Length == 0 ? name : dir + "/" + name, nodeIndex));
                }
            }
            bodyStart = pos;
        }
        catch (ArgumentOutOfRangeException) { return result; }
        if (trace) Console.Error.WriteLine($"  salvage {Path.GetFileName(prefabPath)}: {bytes.Length} bytes, nodes {numNodes}, {files.Count} refs, body at {bodyStart}");

        // Header without user data (those chunks belong to the prefab class)
        // + node count + reference table.
        var prefix = new List<byte>();
        prefix.AddRange(bytes.AsSpan(0, HeaderClassOffset).ToArray());
        prefix.AddRange(BitConverter.GetBytes(Solid2ModelClass));
        prefix.AddRange(BitConverter.GetBytes(0));
        prefix.AddRange(bytes.AsSpan(numNodesAt, bodyStart - numNodesAt).ToArray());

        // Inline meshes: [node index][class id][chunks…].
        var pattern = BitConverter.GetBytes(Solid2ModelClass);
        var prefabDir = Path.GetDirectoryName(Path.GetFullPath(prefabPath))!;
        for (var i = bodyStart + 4; i + 4 <= bytes.Length; i++)
        {
            if (bytes[i] != pattern[0] || bytes[i + 1] != pattern[1] || bytes[i + 2] != pattern[2] || bytes[i + 3] != pattern[3]) continue;
            var index = BitConverter.ToInt32(bytes, i - 4);
            if (index <= 0 || index >= numNodes) continue;
            var synthetic = new byte[prefix.Count + (bytes.Length - (i + 4))];
            prefix.CopyTo(synthetic, 0);
            Buffer.BlockCopy(bytes, i + 4, synthetic, prefix.Count, bytes.Length - (i + 4));
            // Next to the prefab, so relative material references resolve.
            var temp = Path.Combine(prefabDir, $"~salvage-{Guid.NewGuid():N}.Solid2Model.Gbx");
            try
            {
                File.WriteAllBytes(temp, synthetic);
                if (Gbx.ParseNode(temp) is CPlugSolid2Model model && model.Visuals is { Length: > 0 })
                {
                    result.Inline.Add(model);
                    if (trace) Console.Error.WriteLine($"    inline mesh at {i}: {model.Visuals.Length} visuals");
                }
            }
            catch (Exception ex)
            {
                if (trace) Console.Error.WriteLine($"    inline candidate at {i} failed: {ex.Message}");
            }
            finally
            {
                try { File.Delete(temp); } catch { /* best effort */ }
            }
        }

        // External-model entities: [node index of a ref-table file][unit
        // quaternion][position]. Any byte alignment (strings precede them).
        foreach (var (path, nodeIndex) in files)
        {
            if (!path.EndsWith(".Gbx", StringComparison.OrdinalIgnoreCase) || path.Contains(".Material.", StringComparison.OrdinalIgnoreCase)) continue;
            for (var i = bodyStart; i + 32 <= bytes.Length; i++)
            {
                if (BitConverter.ToInt32(bytes, i) != nodeIndex) continue;
                var q = new Quaternion(BitConverter.ToSingle(bytes, i + 4), BitConverter.ToSingle(bytes, i + 8),
                                       BitConverter.ToSingle(bytes, i + 12), BitConverter.ToSingle(bytes, i + 16));
                var len = q.Length();
                if (float.IsNaN(len) || MathF.Abs(len - 1f) > 0.01f) continue;
                var p = new Vector3(BitConverter.ToSingle(bytes, i + 20), BitConverter.ToSingle(bytes, i + 24), BitConverter.ToSingle(bytes, i + 28));
                if (float.IsNaN(p.X) || MathF.Abs(p.X) > 4096 || MathF.Abs(p.Y) > 4096 || MathF.Abs(p.Z) > 4096) continue;
                result.External.Add((path, q, p));
                if (trace) Console.Error.WriteLine($"    external {path} at {p} rot {q}");
                i += 28;
            }
        }
        return result;
    }
}
