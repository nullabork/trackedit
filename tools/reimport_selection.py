"""Re-import only the blocks selected in the editor tab, then reload it.

    python tools/reimport_selection.py [--root <GameData/Stadium>] [--no-reload]

Reads the selection from /api/debug/state (Shift+click builds a set), writes
the block names to a temp list and runs `meshdump blocks ... @list`, which
rewrites just those OBJ files (seconds instead of the ~40 min library pass).
Pass names instead of using the selection: `--names A B C`."""
import argparse, json, os, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://localhost:5199")
    ap.add_argument("--root", default=os.path.expandvars(r"%USERPROFILE%\OpenplanetNext\Extract\GameData\Stadium"))
    ap.add_argument("--names", nargs="*", help="block names (default: the editor selection)")
    ap.add_argument("--no-reload", action="store_true", help="leave the tab alone afterwards")
    a = ap.parse_args()

    names = a.names
    if not names:
        with urllib.request.urlopen(f"{a.base}/api/debug/state", timeout=10) as r:
            state = json.load(r)["state"]
        names = sorted({e["block"] for e in state.get("selection", []) if e.get("block")})
    if not names:
        sys.exit("nothing selected — Shift+click blocks in the select tool, or pass --names")
    lst = Path(tempfile.gettempdir()) / "trackedit_reimport.txt"
    lst.write_text("\n".join(names))
    print(f"re-importing {len(names)} block(s): {', '.join(names)}")
    exe = ROOT / "tools" / "meshdump" / "bin" / "Release" / "net8.0" / "meshdump.exe"
    cmd = [str(exe), "blocks", a.root, str(ROOT / "public" / "meshes"), f"@{lst}"] if exe.exists() else \
          ["dotnet", "run", "-c", "Release", "--project", str(ROOT / "tools" / "meshdump"), "--",
           "blocks", a.root, str(ROOT / "public" / "meshes"), f"@{lst}"]
    subprocess.run(cmd, check=True)
    if not a.no_reload:
        # The renderer caches meshes per page load; reload so the new OBJs show.
        try:
            urllib.request.urlopen(f"{a.base}/api/debug/command?action=reload", timeout=15).read()
        except Exception:
            pass  # the reply often races the reload itself
        print("editor tab reloading")


if __name__ == "__main__":
    main()
