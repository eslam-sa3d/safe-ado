import { describe, expect, it } from "vitest";
import { EXPOSURE_COLOR, EXPOSURE_RANK, exposure, IMPACTS, PROBABILITIES } from "../../src/api/risk";

describe("risk exposure matrix", () => {
  it("matches Agile Hive's matrix", () => {
    const grid = PROBABILITIES.slice(0, 5).map((p) => IMPACTS.slice(0, 5).map((i) => exposure(p, i)));
    expect(grid).toEqual([
      ["EXTREME", "HIGH", "HIGH", "HIGH", "HIGH"],
      ["HIGH", "HIGH", "HIGH", "HIGH", "MEDIUM"],
      ["HIGH", "HIGH", "HIGH", "MEDIUM", "MEDIUM"],
      ["HIGH", "HIGH", "MEDIUM", "MEDIUM", "MEDIUM"],
      ["HIGH", "HIGH", "MEDIUM", "MEDIUM", "LOW"],
    ]);
  });

  it("returns INTERMEDIATE for unspecified or missing inputs", () => {
    expect(exposure("Unspecified", "Major")).toBe("INTERMEDIATE");
    expect(exposure("Likely", "Unspecified")).toBe("INTERMEDIATE");
    expect(exposure(undefined, "Major")).toBe("INTERMEDIATE");
    expect(exposure("Likely", undefined)).toBe("INTERMEDIATE");
  });

  it("ranks and colours every exposure", () => {
    expect(Object.keys(EXPOSURE_RANK).sort()).toEqual(Object.keys(EXPOSURE_COLOR).sort());
    expect(EXPOSURE_RANK.EXTREME).toBeGreaterThan(EXPOSURE_RANK.HIGH);
  });
});
