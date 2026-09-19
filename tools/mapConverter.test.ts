import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { DUMP_FIELDS, createMapConverter as create, dumpProblems } from "./mapConverter";

/** The converter under test, with the output check stubbed (no files exist here). */
let verdict: string[] = [];
let built = false;
const createMapConverter = (root: string) => create(root, { verify: () => verdict, hasBuild: () => built });

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
type Reply = (error: Error | null, stdout: string, stderr: string) => void;
const finish = (index: number, error: Error | null = null, stderr = "") =>
  (execFile.mock.calls[index][3] as Reply)(error, "", stderr);

beforeEach(() => {
  execFile.mockReset();
  verdict = [];
  built = false;
});

describe("bundled map conversion", () => {
  it("shares a build across imports and passes paths as separate arguments", async () => {
    const root = join("workspace with spaces", "trackedit");
    const convert = createMapConverter(root);
    const first = convert("first map.Gbx", "first out.json");
    const second = convert("second map.Gbx", "second out.json");
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0][1]).toContain(join(root, "tools", "meshdump", "meshdump.csproj"));
    finish(0);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(3));
    expect(execFile.mock.calls[1].slice(0, 2)).toEqual(["dotnet", [
      join(root, "tools", "meshdump", "bin", "Release", "net8.0", "meshdump.dll"),
      "map", "first map.Gbx", "first out.json",
    ]]);
    finish(1);
    finish(2);
    await Promise.all([first, second]);
  });

  it("reports a missing SDK and permits a later retry", async () => {
    const convert = createMapConverter(".");
    const first = convert("map.Gbx", "out.json");
    const rejected = expect(first).rejects.toThrow(".NET 8 SDK");
    finish(0, Object.assign(new Error("spawn dotnet ENOENT"), { code: "ENOENT" }));
    await rejected;
    const retry = convert("map.Gbx", "out.json");
    expect(execFile).toHaveBeenCalledTimes(2);
    finish(1);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(3));
    finish(2);
    await retry;
  });

  it("prefers the bundled converter over an external override", async () => {
    const convert = createMapConverter(".");
    const result = convert("map.Gbx", "out.json", "/custom tools/gbxdump");
    expect(execFile.mock.calls[0][0]).toBe("dotnet");
    finish(0);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(2));
    expect(execFile.mock.calls[1][1]).toContain("map");
    finish(1);
    await result;
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("falls back to the external converter when the bundled one cannot run, surfacing its failures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const convert = createMapConverter(".");
    const result = convert("map.Gbx", "out.json", "/custom tools/gbxdump");
    finish(0, Object.assign(new Error("spawn dotnet ENOENT"), { code: "ENOENT" }));
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(2));
    expect(execFile.mock.calls[1].slice(0, 2)).toEqual([
      "/custom tools/gbxdump", ["map.Gbx", "out.json"],
    ]);
    const rejected = expect(result).rejects.toThrow("invalid GBX");
    finish(1, new Error("exit 1"), "invalid GBX");
    await rejected;
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("refuses a dump that lacks what the editor places by, instead of importing it quietly", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    verdict = ["items carry no pivotPos (where each item is anchored)"];
    const convert = createMapConverter(".");
    const result = convert("map.Gbx", "out.json", "/old/gbxdump");
    const rejected = expect(result).rejects.toThrow("items carry no pivotPos");
    finish(0, Object.assign(new Error("spawn dotnet ENOENT"), { code: "ENOENT" }));
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(2));
    finish(1);
    await rejected;
  });
});

describe("a locked rebuild", () => {
  it("uses the build that is already there instead of an older external converter", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    built = true;
    const convert = createMapConverter(".");
    const result = convert("map.Gbx", "out.json", "/old/gbxdump");
    finish(0, new Error("exit 1"), "MSB3027: could not copy meshdump.dll: the file is locked");
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(2));
    expect(execFile.mock.calls[1][0]).toBe("dotnet");
    expect(execFile.mock.calls[1][1]).toContain("map");
    finish(1);
    await result;
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});

describe("dumpProblems", () => {
  const record = (fields: readonly string[]) => Object.fromEntries(fields.map((f) => [f, null]));

  it("accepts the bundled converter's dialect, null values included", () => {
    const good = { ...record(DUMP_FIELDS.map), blocks: [record(DUMP_FIELDS.block)], items: [record(DUMP_FIELDS.item)] };
    expect(dumpProblems(good)).toEqual([]);
    expect(dumpProblems({ ...record(DUMP_FIELDS.map), blocks: [], items: [] })).toEqual([]);
  });

  it("names every field an old dump lacks — one record is enough", () => {
    const item = record(DUMP_FIELDS.item);
    const { pivotPos: _p, idx: _i, ...oldItem } = item;
    const { idx: _b, ...oldBlock } = record(DUMP_FIELDS.block);
    const { colorPalette: _c, ...top } = record(DUMP_FIELDS.map);
    expect(dumpProblems({ ...top, blocks: [record(DUMP_FIELDS.block), oldBlock], items: [item, { ...oldItem, blockCoord: [1, 2, 3] }] })).toEqual([
      "the map record lacks colorPalette",
      "blocks lack idx",
      "items lack idx, pivotPos",
    ]);
  });
});
