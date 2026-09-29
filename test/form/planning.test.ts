import { describe, expect, it } from "vitest";
import { emptyMeta } from "../../src/api/data";
import {
  assignedPiIndex,
  estimatedCompletion,
  isPiAssigned,
  MAX_ASSIGNED_PIS,
  piInvolvement,
  toggleAssignedNode,
  toggleAssignedPi,
} from "../../src/form/planning";

const sprint = (name: string, path: string, finish?: string) => ({ name, path, identifier: name, finish });
const PI_A = { name: "A", path: "P\\A", identifier: "ia", finish: "2026-03-31T00:00:00Z", sprints: [sprint("A1", "P\\A\\A1", "2026-02-14T00:00:00Z"), sprint("A2", "P\\A\\A2")] };
const PI_B = { name: "B", path: "P\\B", identifier: "ib", sprints: [sprint("B1", "P\\B\\B1", "2026-05-01T00:00:00Z")] };

describe("planning helpers", () => {
  it("matches assigned PIs by stable id first, then by path", () => {
    const meta = { ...emptyMeta(1), assignedPiPaths: ["P\\Old name", "P\\B"], assignedPiIds: ["ia"] };
    expect(assignedPiIndex(meta, PI_A)).toBe(0);
    expect(assignedPiIndex(meta, PI_B)).toBe(1);
    expect(isPiAssigned(emptyMeta(1), PI_A)).toBe(false);
  });

  it("toggles PIs keeping ids parallel to paths and enforces the limit", () => {
    const added = toggleAssignedPi({ ...emptyMeta(1), assignedPiPaths: ["P\\X"] }, PI_A)!;
    expect(added).toMatchObject({ assignedPiPaths: ["P\\X", "P\\A"], assignedPiIds: ["", "ia"] });
    const removed = toggleAssignedPi({ ...added, assignedPiPaths: ["P\\Renamed", "P\\X"], assignedPiIds: ["ia", ""] }, PI_A)!;
    expect(removed).toMatchObject({ assignedPiPaths: ["P\\X"], assignedPiIds: [""] });

    const full = { ...emptyMeta(1), assignedPiPaths: Array.from({ length: MAX_ASSIGNED_PIS }, (_, i) => `P\\${i}`) };
    expect(toggleAssignedPi(full, PI_A)).toBeNull();
    expect(toggleAssignedPi({ ...full, assignedPiPaths: [...full.assignedPiPaths.slice(1), "P\\A"] }, PI_A)!.assignedPiPaths).toHaveLength(4);
  });

  it("toggles assigned units", () => {
    const one = toggleAssignedNode(emptyMeta(1), "n1");
    expect(one.assignedNodeIds).toEqual(["n1"]);
    expect(toggleAssignedNode(one, "n1").assignedNodeIds).toEqual([]);
    expect(toggleAssignedNode({ ...emptyMeta(1), assignedNodeIds: undefined as any }, "n2").assignedNodeIds).toEqual(["n2"]);
  });

  it("derives PI involvement and the estimated completion from iterations", () => {
    const pis = [PI_A, PI_B];
    expect(piInvolvement(["P\\B\\B1", undefined, "P\\A"], pis).map((p) => p.name)).toEqual(["A", "B"]);
    expect(piInvolvement([], pis)).toEqual([]);
    expect(estimatedCompletion(["P\\A\\A1", "P\\B\\B1"], pis)).toBe("2026-05-01");
    expect(estimatedCompletion(["P\\B\\B1", "P\\A\\A1"], pis)).toBe("2026-05-01");
    // Sprints without dates and PI-level planning give no estimate.
    expect(estimatedCompletion(["P\\A\\A2", "P\\A"], pis)).toBeUndefined();
    expect(estimatedCompletion([], pis)).toBeUndefined();
  });
});
