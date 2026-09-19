import { describe, expect, it } from "vitest";
import { canonicalMaterialName } from "./MeshProvider";

const BS = "\\";

describe("canonicalMaterialName", () => {
  it("keeps library short names as they are", () => {
    expect(canonicalMaterialName("TrackBorders")).toBe("TrackBorders");
    expect(canonicalMaterialName("PlatformIce.PlatformTech")).toBe("PlatformIce.PlatformTech");
  });
  it("strips the game material path used by embedded crystal meshes", () => {
    expect(canonicalMaterialName(["Stadium", "Media", "Material", "TrackBorders"].join(BS))).toBe("TrackBorders");
    expect(canonicalMaterialName("Stadium/Media/Material/TrackWall.Material.Gbx")).toBe("TrackWall");
  });
  it("folds terrain-modifier variants into the folder.name key", () => {
    expect(canonicalMaterialName(["Stadium", "Media", "Modifier", "PlatformIce", "PlatformTech"].join(BS)))
      .toBe("PlatformIce.PlatformTech");
  });
});
