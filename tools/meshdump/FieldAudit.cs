using System.Collections;
using System.Reflection;
using System.Text.Json;
using GBX.NET;
using GBX.NET.Engines.Game;

/// <summary>
/// meshdump fieldaudit &lt;map.Map.Gbx&gt; [out.json] — every field a map's blocks and items
/// carry, by reflection over what GBX.NET exposes, with how often each is set and to what.
/// Nothing here knows which fields matter: that judgement lives in tools/field_audit.ts,
/// which fails on a field nobody has looked at. The point is that a field the editor
/// ignores (a variant index, a snap, a phase offset) shows up BEFORE it shows as a wrong
/// block.
/// </summary>
static class FieldAudit
{
    sealed class Tally
    {
        public int Set;
        public readonly Dictionary<string, int> Values = [];
    }

    public static int Run(string mapPath, string? outPath)
    {
        var map = Gbx.ParseNode<CGameCtnChallenge>(mapPath);
        var report = new Dictionary<string, object?>
        {
            ["mapName"] = map.MapName,
            ["blocks"] = Audit((map.Blocks ?? []).Where(b => !b.IsFree).Cast<object>().ToList(), b => ((CGameCtnBlock)b).Flags),
            ["freeBlocks"] = Audit((map.Blocks ?? []).Where(b => b.IsFree).Cast<object>().ToList(), b => ((CGameCtnBlock)b).Flags),
            ["items"] = Audit((map.AnchoredObjects ?? []).Cast<object>().ToList(), i => ((CGameCtnAnchoredObject)i).Flags),
            ["bakedBlocks"] = Audit((map.BakedBlocks ?? []).Cast<object>().ToList(), b => ((CGameCtnBlock)b).Flags),
        };
        var json = JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true });
        if (outPath is not null) File.WriteAllText(outPath, json);
        else Console.WriteLine(json);
        return 0;
    }

    static Dictionary<string, object?> Audit(List<object> nodes, Func<object, int> flagsOf)
    {
        var fields = new SortedDictionary<string, Tally>(StringComparer.Ordinal);
        var bits = new int[32];
        foreach (var node in nodes)
        {
            var flags = flagsOf(node);
            for (var b = 0; b < 32; b++) if ((flags & (1 << b)) != 0) bits[b]++;
            foreach (var p in node.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (p.GetIndexParameters().Length > 0 || p.Name is "Chunks" or "Id") continue;
                object? value;
                try { value = p.GetValue(node); } catch { continue; }
                var text = Describe(value);
                if (!fields.TryGetValue(p.Name, out var t)) fields[p.Name] = t = new Tally();
                if (!IsDefault(value)) t.Set++;
                if (t.Values.Count < 400 || t.Values.ContainsKey(text)) t.Values[text] = t.Values.GetValueOrDefault(text) + 1;
            }
        }
        return new Dictionary<string, object?>
        {
            ["count"] = nodes.Count,
            ["flagBits"] = bits.Select((n, b) => (n, b)).Where(x => x.n > 0).ToDictionary(x => x.b.ToString(), x => x.n),
            ["fields"] = fields.ToDictionary(f => f.Key, f => (object?)new Dictionary<string, object?>
            {
                ["set"] = f.Value.Set,
                ["distinct"] = f.Value.Values.Count,
                ["top"] = f.Value.Values.OrderByDescending(v => v.Value).Take(6).ToDictionary(v => v.Key, v => v.Value),
            }),
        };
    }

    /// <summary>Not set: null, false, zero, empty text, an empty list, a zero vector.</summary>
    static bool IsDefault(object? v) => v switch
    {
        null => true,
        bool b => !b,
        string s => s.Length == 0,
        Enum e => Convert.ToInt64(e) == 0,
        ICollection c => c.Count == 0,
        IConvertible n when v.GetType().IsPrimitive => n.ToDouble(null) == 0,
        _ => v.ToString() is "<0, 0, 0>" or "(0, 0, 0)" || (v.GetType().IsValueType && v.Equals(Activator.CreateInstance(v.GetType()))),
    };

    /// <summary>A value as a short label; nodes and structures by type, so they group.</summary>
    static string Describe(object? v) => v switch
    {
        null => "null",
        string s => s.Length > 40 ? s[..40] + "…" : s,
        ICollection c => $"[{c.Count}]",
        _ when v.GetType().IsPrimitive || v is Enum => v.ToString()!,
        _ when v.GetType().IsValueType => v.ToString()!.Length > 40 ? v.GetType().Name : v.ToString()!,
        _ => v.GetType().Name,
    };
}
