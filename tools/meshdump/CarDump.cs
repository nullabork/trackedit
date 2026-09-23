using System.Numerics;
using System.Text.Json;
using GBX.NET;
using GBX.NET.Engines.Plug;

/// <summary>
/// meshdump car &lt;GameDataRoot&gt; &lt;meshesDir&gt; — the car, for playing driving lines back.
///
/// The model is not part of the block/item extraction: it sits under
/// GameData/Skins/Models/CarSport (the extract plugin's "find &amp; extract the car model" walks
/// the game's file tree for it). Desert / Rally / Snow carry a MainBody.Mesh.gbx each; the
/// Stadium car's body is the one under Stadium/Prestige/Ranked, its textures under
/// Stadium/Common. Every model is a CPlugSolid2Model with four LODs — the second is written
/// as car/&lt;Name&gt;.obj, the base-colour textures (&lt;Material&gt;_B.dds) as PNGs, and car/index.json
/// lists what there is. Without the extraction nothing is written and the editor keeps its box.
/// </summary>
static class CarDump
{
    public static int Run(string gameDataStadium, string meshesDir)
    {
        // The argument is …/Extract/GameData/Stadium like every other command's.
        var models = Path.GetFullPath(Path.Combine(gameDataStadium, "..", "Skins", "Models", "CarSport"));
        if (!Directory.Exists(models))
        {
            Console.WriteLine($"car: nothing under {models} — run \"Trackedit Extract (find & extract the car model)\" in the game");
            return 0;
        }
        var outDir = Path.Combine(meshesDir, "car");
        Directory.CreateDirectory(outDir);
        var index = new Dictionary<string, object?>();
        foreach (var (name, mesh, textures) in new[]
        {
            ("Stadium", Path.Combine(models, "Stadium", "Prestige", "Ranked", "MainBody.Mesh.gbx"), Path.Combine(models, "Stadium", "Common")),
            ("Snow", Path.Combine(models, "Snow", "MainBody.Mesh.gbx"), Path.Combine(models, "Snow")),
            ("Rally", Path.Combine(models, "Rally", "MainBody.Mesh.gbx"), Path.Combine(models, "Rally")),
            ("Desert", Path.Combine(models, "Desert", "MainBody.Mesh.gbx"), Path.Combine(models, "Desert")),
        })
        {
            if (!File.Exists(mesh)) continue;
            try
            {
                if (Gbx.ParseNode(mesh) is not CPlugSolid2Model model) continue;
                var entry = Export(model, name, textures, outDir);
                if (entry is not null) index[name] = entry;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"  car {name}: {ex.Message}");
            }
        }
        File.WriteAllText(Path.Combine(outDir, "index.json"), JsonSerializer.Serialize(index));
        Console.WriteLine($"car: {index.Count} models -> {outDir}");
        return 0;
    }

    /// <summary>What the mesh is made of, for finding the wheels, the spoiler and the driver.</summary>
    public static int Probe(string meshPath)
    {
        if (meshPath.EndsWith(".Skel.Gbx", StringComparison.OrdinalIgnoreCase))
        {
            var skel = Gbx.ParseNode(meshPath) as CPlugSkel;
            if (skel is null) { Console.WriteLine("not a CPlugSkel"); return 1; }
            Console.WriteLine($"skel {skel.Name}");
            // GBX.NET 2.4.4 reads the joints but does not expose them.
            var joints = skel.GetType().GetField("joints", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)?.GetValue(skel) as CPlugSkel.Joint[];
            foreach (var j in joints ?? []) Console.WriteLine($"  joint {j.Name} parent {j.ParentIndex} q {j.GlobalJoint} U01 {j.U01} U02 {j.U02}");
            var sockets = skel.GetType().GetField("sockets", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)?.GetValue(skel) as CPlugSkel.Socket[];
            foreach (var so in sockets ?? []) Console.WriteLine($"  socket {so.Name} {so.U01} {so.U02}");
            return 0;
        }
        if (Gbx.ParseNode(meshPath) is not CPlugSolid2Model model) { Console.WriteLine("not a CPlugSolid2Model"); return 1; }
        Console.WriteLine($"joints: {(model.Joints is null ? "none" : string.Join(", ", model.Joints))}");
        Console.WriteLine($"skel: {(model.Skel is null ? "none" : model.Skel.Name)}");
        if (model.Skel is not null)
        {
            foreach (var f in model.Skel.GetType().GetProperties())
            {
                var v = f.GetValue(model.Skel);
                if (v is System.Collections.IEnumerable e and not string)
                {
                    var items = e.Cast<object?>().ToList();
                    Console.WriteLine($"  skel.{f.Name}: {items.Count} x {items.FirstOrDefault()?.GetType().Name}");
                    foreach (var it in items.Take(80))
                    {
                        if (it is CPlugSkel.Joint j) Console.WriteLine($"    joint {j.Name} parent {j.ParentIndex} pos {j.U01} q {j.GlobalJoint}");
                        else if (it is CPlugSkel.Socket so) Console.WriteLine($"    socket {so.Name} {so.U01}");
                    }
                }
                else Console.WriteLine($"  skel.{f.Name}: {v}");
            }
        }
        Console.WriteLine($"visuals: {model.Visuals?.Length}, geoms: {model.ShadedGeoms?.Length}");
        for (var i = 0; i < (model.Visuals?.Length ?? 0); i++)
        {
            if (model.Visuals![i] is not CPlugVisualIndexedTriangles v) { Console.WriteLine($"  visual {i}: {model.Visuals[i]?.GetType().Name}"); continue; }
            var geoms = model.ShadedGeoms!.Where(g => g.VisualIndex == i).Select(g => $"mat {MaterialName(model, g.MaterialIndex)} lod {g.LodMask}");
            var stream = v.VertexStreams.FirstOrDefault();
            var n = stream?.Positions?.Length ?? v.Vertices?.Length ?? 0;
            Vector3 min = new(float.MaxValue), max = new(float.MinValue);
            foreach (var pnt in stream?.Positions ?? Array.Empty<Vec3>()) { min = Vector3.Min(min, new(pnt.X, pnt.Y, pnt.Z)); max = Vector3.Max(max, new(pnt.X, pnt.Y, pnt.Z)); }
            var skin = v.SkinData;
            Console.WriteLine($"  visual {i}: {n} verts, tris {v.IndexBuffer?.Indices?.Length / 3}, {string.Join("; ", geoms)}, bounds {min:0.##}..{max:0.##}, subvisuals {v.SubVisuals?.Length}, splits {v.Splits?.Length}");
            if (skin is not null) Console.WriteLine($"    skin bones: {string.Join(", ", skin.Bones ?? [])} U02 {skin.U02} U07 {string.Join(",", skin.U07 ?? [])} U05 {skin.U05?.Length}");
            if (stream is not null)
            {
                foreach (var f in stream.GetType().GetProperties())
                {
                    var val = f.GetValue(stream);
                    if (val is Array arr && arr.Length > 0 && f.Name != "Positions") Console.WriteLine($"    stream.{f.Name}: {arr.Length} x {arr.GetType().GetElementType()?.Name} e.g. {arr.GetValue(0)}");
                    else if (val is System.Collections.IDictionary d && d.Count > 0) Console.WriteLine($"    stream.{f.Name}: {d.Count} sets");
                }
            }
        }
        return 0;
    }

    static Dictionary<string, object?>? Export(CPlugSolid2Model model, string name, string textureDir, string outDir)
    {
        var geoms = model.ShadedGeoms;
        if (geoms is null || model.Visuals is null) return null;
        var builder = new ObjBuilder();
        // The second LOD when there is one: a marker seen from a chase camera does not need the
        // showroom mesh (7 MB of OBJ), and the silhouette is the same.
        var lod = geoms.Any(g => (g.LodMask & 2) != 0) ? 2 : 1;
        var used = new SortedSet<string>(StringComparer.Ordinal);
        // The mesh names its joints (FLWheel, FLSusp, SpoilerTop…) but this GBX.NET does not read
        // the vertex bindings, nor the skeleton file's joint positions. The wheels are found from
        // the geometry instead: every connected piece of the model, and the tyres (the "Wheels"
        // texture set) clustered into four; any piece that lies within a tyre's cylinder — rim,
        // hub, disc — turns with it. Each wheel is written about its own axle as "wheel:<FL|FR|RL|RR>".
        var pieces = new List<Piece>();
        foreach (var geom in geoms)
        {
            if ((geom.LodMask & lod) == 0) continue;
            if (model.Visuals[geom.VisualIndex] is not CPlugVisualIndexedTriangles visual) continue;
            var material = MaterialName(model, geom.MaterialIndex);
            if (material is null) continue;
            used.Add(material);
            pieces.AddRange(Pieces(visual, material));
        }
        if (pieces.Count == 0) return null;
        var wheels = FindWheels(pieces);
        foreach (var piece in pieces)
        {
            var wheel = wheels.FirstOrDefault(w => w.Holds(piece));
            builder.SetSource(wheel is null ? "body" : $"wheel:{wheel.Name}");
            builder.AddVisualTriangles(piece.Visual, piece.Tris, piece.Material, wheel?.Center ?? Vector3.Zero);
        }
        if (builder.IsEmpty) return null;
        File.WriteAllText(Path.Combine(outDir, name + ".obj"), builder.ToObj());
        Console.WriteLine($"  car {name}: {pieces.Count} pieces; wheels {string.Join(", ", wheels.Select(w => $"{w.Name} at {w.Center:0.###} r {w.Radius:0.###} ({pieces.Count(w.Holds)} pieces)"))}");

        // Base colour per material: "<Material>_B.dds" beside the model (Skin, Details, Wheels; Glass has none).
        var materials = new Dictionary<string, string?>();
        foreach (var m in used)
        {
            var dds = Directory.Exists(textureDir)
                ? Directory.EnumerateFiles(textureDir, "*.dds").FirstOrDefault(f => Path.GetFileName(f).Equals(m + "_B.dds", StringComparison.OrdinalIgnoreCase))
                : null;
            string? png = null;
            if (dds is not null)
            {
                try
                {
                    Dumper.ConvertDds(dds, Path.Combine(outDir, $"{name}_{m}.png"));
                    png = $"car/{name}_{m}.png";
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"  car texture {m}: {ex.Message}");
                }
            }
            materials[m] = png;
        }
        Console.WriteLine($"  car {name}: bounds x {builder.Min.X:0.##}..{builder.Max.X:0.##} y {builder.Min.Y:0.##}..{builder.Max.Y:0.##} z {builder.Min.Z:0.##}..{builder.Max.Z:0.##}; materials {string.Join(", ", materials.Select(kv => kv.Key + (kv.Value is null ? " (flat)" : "")))}");
        return new Dictionary<string, object?>
        {
            ["obj"] = $"car/{name}.obj",
            ["materials"] = materials,
            ["min"] = new[] { builder.Min.X, builder.Min.Y, builder.Min.Z },
            ["max"] = new[] { builder.Max.X, builder.Max.Y, builder.Max.Z },
            // Where each wheel's axle is (model space; the wheel's own vertices are about it).
            ["wheels"] = wheels.ToDictionary(w => w.Name, w => (object)new { center = new[] { w.Center.X, w.Center.Y, w.Center.Z }, radius = w.Radius }),
        };
    }

    /// <summary>A connected run of triangles of one visual: what the geometry alone can tell apart.</summary>
    sealed record Piece(CPlugVisualIndexedTriangles Visual, string Material, int[] Tris, Vector3 Min, Vector3 Max)
    {
        public Vector3 Center => (Min + Max) / 2f;
    }

    static IEnumerable<Piece> Pieces(CPlugVisualIndexedTriangles visual, string material)
    {
        var stream = visual.VertexStreams.FirstOrDefault();
        var indices = visual.IndexBuffer?.Indices;
        if (stream?.Positions is null || indices is null) yield break;
        var pos = stream.Positions;
        // Vertices are welded by POSITION, not index: seams duplicate vertices for UV or normal
        // splits, and a wheel is one piece however its UV islands fall.
        var byPos = new Dictionary<(int, int, int), int>();
        var parent = new int[pos.Length];
        for (var i = 0; i < pos.Length; i++)
        {
            var key = ((int)MathF.Round(pos[i].X * 2000f), (int)MathF.Round(pos[i].Y * 2000f), (int)MathF.Round(pos[i].Z * 2000f));
            parent[i] = byPos.TryGetValue(key, out var first) ? first : i;
            byPos.TryAdd(key, i);
        }
        int Find(int i) { while (parent[i] != i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
        void Union(int a, int b) { a = Find(a); b = Find(b); if (a != b) parent[a] = b; }
        for (var t = 0; t + 2 < indices.Length; t += 3) { Union(indices[t], indices[t + 1]); Union(indices[t], indices[t + 2]); }
        var groups = new Dictionary<int, (List<int> Tris, Vector3 Min, Vector3 Max)>();
        for (var t = 0; t + 2 < indices.Length; t += 3)
        {
            var root = Find(indices[t]);
            if (!groups.TryGetValue(root, out var g)) groups[root] = g = ([], new Vector3(float.MaxValue), new Vector3(float.MinValue));
            g.Tris.Add(t);
            for (var k = 0; k < 3; k++)
            {
                var p = pos[indices[t + k]];
                g.Min = Vector3.Min(g.Min, new(p.X, p.Y, p.Z));
                g.Max = Vector3.Max(g.Max, new(p.X, p.Y, p.Z));
            }
            groups[root] = g;
        }
        foreach (var g in groups.Values) yield return new Piece(visual, material, g.Tris.ToArray(), g.Min, g.Max);
    }

    sealed record Wheel(string Name, Vector3 Center, float Radius, float HalfWidth)
    {
        /// <summary>
        /// A piece lies within this wheel: as wide as the tyre, and within the tyre's own box about
        /// the axle. The box, not the circle: a round tyre's bounding box reaches 1.41 r at its corners,
        /// and the first version measured that and left every tyre on the body while its hub turned.
        /// </summary>
        public bool Holds(Piece p)
        {
            if (p.Min.X < Center.X - HalfWidth - 0.03f || p.Max.X > Center.X + HalfWidth + 0.03f) return false;
            float dy = MathF.Max(MathF.Abs(p.Min.Y - Center.Y), MathF.Abs(p.Max.Y - Center.Y));
            float dz = MathF.Max(MathF.Abs(p.Min.Z - Center.Z), MathF.Abs(p.Max.Z - Center.Z));
            return MathF.Max(dy, dz) <= Radius * 1.03f;
        }
    }

    /// <summary>The four tyres: the "Wheels" pieces, by side (x) and end (z, about the wheelbase's middle).</summary>
    static List<Wheel> FindWheels(List<Piece> pieces)
    {
        var tyres = pieces.Where(p => p.Material == "Wheels").ToList();
        if (tyres.Count == 0) return [];
        var zMid = (tyres.Min(p => p.Min.Z) + tyres.Max(p => p.Max.Z)) / 2f;
        var wheels = new List<Wheel>();
        foreach (var (name, left, front) in new[] { ("FL", true, true), ("FR", false, true), ("RL", true, false), ("RR", false, false) })
        {
            // The tyre is the biggest "Wheels" piece in its quarter of the car; the set also holds
            // smaller things in that texture (a mudflap, a rim's inner ring) that would stretch a union.
            var tyre = tyres.Where(p => (p.Center.X < 0) == left && (p.Center.Z > zMid) == front)
                .OrderByDescending(p => (p.Max.Y - p.Min.Y) * (p.Max.Z - p.Min.Z)).FirstOrDefault();
            if (tyre is null) continue;
            var (min, max) = (tyre.Min, tyre.Max);
            wheels.Add(new Wheel(name, (min + max) / 2f, MathF.Max(max.Y - min.Y, max.Z - min.Z) / 2f, (max.X - min.X) / 2f));
        }
        return wheels;
    }

    /// <summary>
    /// The texture set a car material draws from — "Skin", "Details", "Wheels", "Glass", "Gem"… —
    /// which is the last word of its name ("_SkinDmg_Skin", "_DetailsDmgNormal_Wheels"). The
    /// middle word is the SHADER, not a kind of part: "…DmgDecal…" parts are ordinary panels
    /// whose shader also takes stickers — "_SkinDmgDecal_Skin" is the cover over the engine
    /// bay, "_DetailsDmgDecal_Details" the rear grille. Leaving them out leaves holes. Null
    /// only for the prestige skin's gems.
    /// </summary>
    static string? MaterialName(CPlugSolid2Model model, int i)
    {
        string? raw = null;
        if (model.MaterialIds?.Length > i) raw = model.MaterialIds[i];
        else if (model.CustomMaterials?.ElementAtOrDefault(i)?.MaterialName is { Length: > 0 } custom) raw = custom;
        else if (model.Materials?.Length > i) raw = model.Materials[i].File?.FilePath;
        if (string.IsNullOrEmpty(raw)) return $"Material{i}";
        var stem = Path.GetFileName(raw.Replace('\\', '/'));
        var dot = stem.IndexOf('.');
        var name = new string((dot > 0 ? stem[..dot] : stem).Where(c => char.IsLetterOrDigit(c) || c == '_').ToArray());
        var set = name[(name.LastIndexOf('_') + 1)..];
        // The Stadium body comes from the ranked prestige skin, the only place it ships as a
        // mesh. Its GEMS are that skin's ornaments and are left out. "PrestigeMedal" is NOT an
        // ornament, whatever the name says: 21,000 vertices spanning the whole car — the rear
        // cover and other body panels the skin draws in its medal metal. Without it the car has
        // holes; it has no base-colour texture, the editor paints it like the body.
        return set.StartsWith("Gem", StringComparison.Ordinal) ? null : set;
    }
}
