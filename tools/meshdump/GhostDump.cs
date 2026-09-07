using System.Text.Json;
using GBX.NET;
using GBX.NET.Engines.Game;

namespace Trackedit;

/// <summary>
/// Driving path of a ghost: the validation ghost embedded in a Map.Gbx, or
/// the first ghost of a Replay.Gbx (TMX replays). Ported from tracko's
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
            _ => null,
        };
        if (ghost is null)
        {
            Console.WriteLine("no ghost");
            return 2;
        }

        var path = new List<float[]>();
        var times = new List<int>();

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
            }
        }

        Console.WriteLine($"ghost: {ghost.GhostNickname}, time {ghost.RaceTime}, samples {path.Count}");
        var json = JsonSerializer.Serialize(new
        {
            nickname = ghost.GhostNickname,
            raceTimeMs = ghost.RaceTime?.TotalMilliseconds,
            numSamples = path.Count,
            path,
            times,
        });
        if (output is not null) File.WriteAllText(output, json);
        return path.Count > 0 ? 0 : 2;
    }
}
