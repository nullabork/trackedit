import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { createMapConverter } from "./mapConverter";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
type Reply = (error: Error | null, stdout: string, stderr: string) => void;
const finish = (index: number, error: Error | null = null, stderr = "") =>
  (execFile.mock.calls[index][3] as Reply)(error, "", stderr);

beforeEach(() => execFile.mockReset());

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

  it("preserves the external converter override and surfaces failures", async () => {
    const convert = createMapConverter(".");
    const result = convert("map.Gbx", "out.json", "/custom tools/gbxdump");
    expect(execFile.mock.calls[0].slice(0, 2)).toEqual([
      "/custom tools/gbxdump", ["map.Gbx", "out.json"],
    ]);
    const rejected = expect(result).rejects.toThrow("invalid GBX");
    finish(0, new Error("exit 1"), "invalid GBX");
    await rejected;
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
