"""Developer check: how good is the extractor's cap SHAPE FIT, measured against the game?

A block's top and bottom clips carry no direction in the game's definitions, so the
extractor orients them. For every cap the game has shown us (tools/meshdump/cap_turns.json,
harvested from the clips baked into map files by `npm run cliptruth -- --harvest`) it uses
the game's own quarter turn; for the rest it still fits shapes. A block extraction run with
MESHDUMP_CAP_REPORT=<file> records both for each cap, and this script says:

- how often the fit agrees with the game where the game is known — which is the fit's
  expected accuracy on the caps where it is NOT known;
- which rule would have done better: the fit as shipped (a turn only when it is decisively
  better than no turn), or plainly the lowest error;
- the blocks still oriented by fit alone — what a map containing them would settle.

usage: python tools/cap_fit_check.py [cap_report.json]          (npm run capfit)
"""
import collections
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "sheets/cap_report.json"
rows = json.load(open(path, encoding="utf-8"))
known = [r for r in rows if r.get("gameTurn") is not None and r.get("turn") is not None]
fit_only = [r for r in rows if r.get("gameTurn") is None]
unfit = [r for r in rows if r.get("gameTurn") is not None and r.get("turn") is None]
print(f"{len(rows)} caps placed: {len(known) + len(unfit)} by the game's direction ({len(unfit)} of them on body-less blocks the fit cannot do), {len(fit_only)} by shape fit alone")
if not known:
    sys.exit("no cap has both a fit and a game direction - was the extraction run with cap_turns.json in place?")


def same(r, turn):
    """AllDir clips look the same every way round; SymmetricalDirs the same half way round."""
    multi = r.get("multiDir")
    if multi == "AllDir":
        return True
    if multi == "SymmetricalDirs":
        return (turn - r["gameTurn"]) % 2 == 0
    return turn == r["gameTurn"]


shipped = sum(same(r, r["turn"]) for r in known)
lowest = sum(same(r, min(range(4), key=lambda k: r["errs"][k])) for r in known)
print(f"where the game is known: the fit as shipped agrees on {shipped}/{len(known)} ({100 * shipped / len(known):.1f}%), plain lowest-error on {lowest}/{len(known)} ({100 * lowest / len(known):.1f}%)")

wrong = collections.Counter()
for r in known:
    if not same(r, r["turn"]):
        wrong[(r["clip"], "body" if r.get("hasBody") else "shell")] += 1
print("the fit's misses, by clip (now corrected by the game's direction):")
for (clip, kind), n in wrong.most_common(15):
    print(f"   {n:4} x {clip} ({kind})")

by_block = collections.Counter(r["block"] for r in fit_only if r.get("multiDir") != "AllDir")
print(f"blocks with a direction-sensitive cap still oriented by fit alone: {len(by_block)} (expect about {100 - 100 * shipped / len(known):.0f}% of their caps to be wrong)")
for block, n in by_block.most_common(12):
    print(f"   {n:3} caps  {block}")
