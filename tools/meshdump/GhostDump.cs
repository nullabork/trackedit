using System.Text.Json;
using GBX.NET;
using GBX.NET.Engines.Game;

namespace Trackedit;

/// <summary>
/// Driving path of a ghost: the validation ghost embedded in a Map.Gbx, or
/// the first ghost of a Replay.Gbx (TMX replays), or a bare Ghost.Gbx (a
/// record downloaded from Nadeo's services). Ported from tracko's
/// ghostdump. Positions are game world metres (Y up), the same frame as
/// free-block absPos; the editor lifts them by the decoration's vertical
/// origin on import like it does for items.
/// </summary>
public static class GhostDump
{
    public static int Run(string input, string? output)
    {
        CGameCtnGhost? ghost = Gbx.ParseNode(input) switch
        {
            CGameCtnChallenge map => map.ChallengeParameters?.RaceValidateGhost,
            CGameCtnReplayRecord replay => replay.GetGhosts().FirstOrDefault(),
            CGameCtnGhost bare => bare, // record ghosts downloaded from Nadeo
            _ => null,
        };
        if (ghost is null)
        {
            Console.WriteLine("no ghost");
            return 2;
        }

        var path = new List<float[]>();
        var times = new List<int>();
        // The driver's inputs and the speed per sample, where the ghost has them (TM2020):
        // steer -100..100 (left negative), gas and brake 0..100, speed in km/h. Whole numbers:
        // a two-hour RPG run is 130,000 samples and rides along in the saved map.
        var steer = new List<int>(); var gas = new List<int>(); var brake = new List<int>(); var speed = new List<int>();
        // The car's orientation per sample: a unit quaternion (x, y, z, w) in thousandths,
        // flattened — pitch and roll on banked turns, loops and wall rides, not just heading.
        // Its forward is +z. It is the BODY, not the direction of travel: checked against the
        // path, the two agree to a degree while the car grips and part by 60 degrees and more
        // in a drift (full steer held at 180 km/h), which is exactly what it should show.
        var rot = new List<int>();
        var wheelRot = new List<int>();
        var damper = new List<int>();

        // Older format: decoded samples with a position per record.
        var data = ghost.SampleData;
        if (data is not null)
        {
            foreach (var s in data.Samples)
            {
                path.Add([s.Position.X, s.Position.Y, s.Position.Z]);
                times.Add((int)s.Time.TotalMilliseconds);
            }
        }

        if (path.Count == 0 && ghost.RecordData is not null)
        {
            // TM2020: vehicle states are 107-byte samples with the position at
            // byte 47. The ent type varies (4 in validation ghosts, 6 in
            // replays), so take the ent with the most full-size samples.
            var vehicle = ghost.RecordData.EntList
                .OrderByDescending(e => e.Samples.Count(s => s.Data?.Length >= 59))
                .FirstOrDefault();
            foreach (var s in vehicle?.Samples ?? [])
            {
                var d = s.Data;
                if (d is null || d.Length < 59) continue;
                path.Add([
                    BitConverter.ToSingle(d, 47),
                    BitConverter.ToSingle(d, 51),
                    BitConverter.ToSingle(d, 55),
                ]);
                times.Add((int)s.Time.TotalMilliseconds);
                if (s is GBX.NET.Engines.Scene.CSceneVehicleVis.EntRecordDelta v)
                {
                    steer.Add((int)MathF.Round(Math.Clamp(v.Steer, -1f, 1f) * 100f));
                    gas.Add((int)MathF.Round(Math.Clamp(v.Gas, 0f, 1f) * 100f));
                    brake.Add((int)MathF.Round(Math.Clamp(v.Brake, 0f, 1f) * 100f));
                    speed.Add((int)MathF.Round(MathF.Abs(v.Speed)));
                    var q = v.Rotation;
                    rot.Add((int)MathF.Round(q.X * 1000f)); rot.Add((int)MathF.Round(q.Y * 1000f));
                    rot.Add((int)MathF.Round(q.Z * 1000f)); rot.Add((int)MathF.Round(q.W * 1000f));
                    // Each wheel's angle (radians, cumulative over the run: at speed a wheel turns more
                    // than half a turn between samples, so a wrapped angle could not be interpolated)
                    // and its damper's extension (metres: ~0.03 on the road, ~0.19 hanging in the air).
                    foreach (var a in new[] { v.FLWheelRot, v.FRWheelRot, v.RLWheelRot, v.RRWheelRot }) wheelRot.Add((int)MathF.Round(a * 1000f));
                    foreach (var len in new[] { v.FLDampenLen, v.FRDampenLen, v.RLDampenLen, v.RRDampenLen }) damper.Add((int)MathF.Round(len * 1000f));
                }
            }
        }
        var hasInputs = steer.Count == path.Count && path.Count > 0;
        var hasWheels = wheelRot.Count == path.Count * 4 && path.Count > 0;
        if (Environment.GetEnvironmentVariable("MESHDUMP_GHOST_PROBE") == "1" && ghost.RecordData is not null)
        {
            var vehicle = ghost.RecordData.EntList.OrderByDescending(e => e.Samples.Count(s => s.Data?.Length >= 59)).First();
            var vs = vehicle.Samples.OfType<GBX.NET.Engines.Scene.CSceneVehicleVis.EntRecordDelta>().ToList();
            Console.WriteLine($"probe: {vs.Count} samples; dt {(vs.Count > 1 ? (vs[1].Time - vs[0].Time).TotalMilliseconds : 0)} ms");
            Console.WriteLine($"  FLWheelRot min {vs.Min(v => v.FLWheelRot)} max {vs.Max(v => v.FLWheelRot)}; RLWheelRot min {vs.Min(v => v.RLWheelRot)} max {vs.Max(v => v.RLWheelRot)}");
            Console.WriteLine($"  FLDampenLen min {vs.Min(v => v.FLDampenLen)} max {vs.Max(v => v.FLDampenLen)}; RL min {vs.Min(v => v.RLDampenLen)} max {vs.Max(v => v.RLDampenLen)}");
            var air = vs.Where(v => !v.IsGroundContact).ToList();
            var gnd = vs.Where(v => v.IsGroundContact).ToList();
            Console.WriteLine($"  in the air {air.Count}: FLDampen avg {(air.Count > 0 ? air.Average(v => v.FLDampenLen) : 0):0.###}; on the ground {gnd.Count}: avg {(gnd.Count > 0 ? gnd.Average(v => v.FLDampenLen) : 0):0.###}");
            Console.WriteLine($"  Gear min {vs.Min(v => v.Gear)} max {vs.Max(v => v.Gear)}; RPM min {vs.Min(v => v.RPM)} max {vs.Max(v => v.RPM)}; SideSpeed max {vs.Max(v => MathF.Abs(v.SideSpeed))}");
            Console.WriteLine($"  FLSlipCoef true {vs.Count(v => v.FLSlipCoef)}; IsTurbo {vs.Count(v => v.IsTurbo)}; TurboTime max {vs.Max(v => v.TurboTime)}");
            for (var i = 100; i < Math.Min(vs.Count, 130); i++)
            {
                var v = vs[i];
                Console.WriteLine($"  t {v.Time.TotalMilliseconds} speed {v.Speed:0.#} FLrot {v.FLWheelRot:0.###} RLrot {v.RLWheelRot:0.###} FLdamp {v.FLDampenLen:0.####} RLdamp {v.RLDampenLen:0.####} gnd {v.IsGroundContact} steer {v.Steer:0.##} gas {v.Gas:0.##} brake {v.Brake:0.##}");
            }
        }

        Console.WriteLine($"ghost: {ghost.GhostNickname}, time {ghost.RaceTime}, samples {path.Count}");
        var json = JsonSerializer.Serialize(new
        {
            nickname = ghost.GhostNickname,
            raceTimeMs = ghost.RaceTime?.TotalMilliseconds,
            numSamples = path.Count,
            // The race time at which each checkpoint was taken, in driving order;
            // the last one is the finish. Exact, unlike anything geometry can tell.
            checkpoints = (ghost.Checkpoints ?? []).Where(c => c.Time is not null).Select(c => (int)c.Time!.Value.TotalMilliseconds).ToArray(),
            path,
            times,
            steer = hasInputs ? steer : null,
            wheelRot = hasWheels ? wheelRot : null,
            damper = hasWheels ? damper : null,
            gas = hasInputs ? gas : null,
            brake = hasInputs ? brake : null,
            speed = hasInputs ? speed : null,
            rot = hasInputs && rot.Count == path.Count * 4 ? rot : null,
        });
        if (output is not null) File.WriteAllText(output, json);
        return path.Count > 0 ? 0 : 2;
    }
}
