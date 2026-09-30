import { describe, expect, it } from "vitest";
import {
  addHidden,
  cardEdges,
  externalColumn,
  hiddenDetail,
  HiddenPartners,
  idsQuery,
  isPiAssigned,
  ownerMap,
  parentIdOf,
  partnerIds,
  worstCriticality,
} from "../../src/api/artboard";
import { DEFAULT_DEPENDENCY_LINK } from "../../src/api/dependencies";
import { clipRange, inWindow, piIdsFor, renderWindow, roadmapCadences } from "../../src/api/roadmap";
import { ProgramIncrement, WorkItem } from "../../src/api/types";
import { makeConfig } from "../fakeAdo";

const u = (id: number) => `https://x/_apis/wit/workItems/${id}`;
const item = (id: number, rels: [string, number][] = [], fields: Record<string, unknown> = {}): WorkItem => ({
  id,
  fields,
  relations: rels.map(([rel, t]) => ({ rel, url: u(t) })),
});
const SUCC = "System.LinkTypes.Dependency-Forward";
const PRED = "System.LinkTypes.Dependency-Reverse";

describe("artboard v2 helpers", () => {
  it("finds the parent id", () => {
    expect(parentIdOf(item(1, [["System.LinkTypes.Hierarchy-Reverse", 9]]))).toBe(9);
    expect(parentIdOf(item(1))).toBeNull();
    expect(parentIdOf({ id: 2, fields: {} })).toBeNull();
  });

  it("detects PI assignment by id or by path (case-insensitive)", () => {
    const pi = { path: "P\\PIs\\PI 2", identifier: "pi2" };
    expect(isPiAssigned(undefined, pi)).toBe(false);
    expect(isPiAssigned({ assignedPiPaths: [], assignedPiIds: ["pi2"] }, pi)).toBe(true);
    expect(isPiAssigned({ assignedPiPaths: ["p\\pis\\pi 2"] }, pi)).toBe(true);
    expect(isPiAssigned({ assignedPiPaths: ["P\\PIs\\PI 1"], assignedPiIds: ["pi1"] }, pi)).toBe(false);
    expect(isPiAssigned({ assignedPiPaths: [] }, { path: "x", identifier: "" })).toBe(false);
  });

  it("builds an id query limited to type and scope", () => {
    const q = idsQuery([3, 4], ["Feature"], ["P\\A"]);
    expect(q).toContain("[System.Id] IN (3, 4)");
    expect(q).toContain("[System.WorkItemType] IN ('Feature')");
    expect(q).toContain("[System.AreaPath] UNDER 'P\\A'");
    expect(idsQuery([1], ["Feature"], [])).toContain("[System.Id] < 0");
  });

  it("maps children to their card, finds partners and aggregates card edges", () => {
    const f1 = item(1, [[SUCC, 2]]);
    const f2 = item(2);
    const s11 = item(11, [[SUCC, 21], [SUCC, 99], [PRED, 12]]);
    const s12 = item(12);
    const s21 = item(21);
    const children = new Map([
      [1, [s11, s12]],
      [2, [s21, s11]],
    ]);
    const owner = ownerMap([f1, f2], children);
    expect(Object.fromEntries(owner)).toEqual({ 1: 1, 2: 2, 11: 1, 12: 1, 21: 2 });
    const sources = [f1, f2, s11, s12, s21];
    expect(partnerIds(sources, owner, DEFAULT_DEPENDENCY_LINK)).toEqual([99]);
    const edges = cardEdges(sources, owner, new Set([99]), DEFAULT_DEPENDENCY_LINK);
    expect(edges).toEqual([
      { from: 1, to: 2, pairs: [{ provider: 1, consumer: 2 }, { provider: 11, consumer: 21 }], direct: true },
      { from: 1, to: 99, pairs: [{ provider: 11, consumer: 99 }], direct: false },
    ]);
    // Unknown partners are dropped.
    expect(cardEdges(sources, owner, new Set(), DEFAULT_DEPENDENCY_LINK)).toHaveLength(1);
  });

  it("picks the worst criticality", () => {
    expect(worstCriticality(["healthy", "critical", "resolved"])).toBe("critical");
    expect(worstCriticality(["resolved", "healthy"])).toBe("healthy");
    expect(worstCriticality([])).toBe("atRisk");
  });

  it("places external partners by calculated or own sprint", () => {
    const pi = { path: "P\\PI" };
    const S = ["P\\PI\\S1", "P\\PI\\S2"];
    const ext = item(5, [], { "System.IterationPath": "P\\PI\\S1" });
    const kids = [item(6, [], { "System.IterationPath": "P\\PI\\S2" })];
    expect(externalColumn(ext, kids, pi, S, true)).toBe(2);
    expect(externalColumn(ext, kids, pi, S, false)).toBe(1);
    expect(externalColumn(item(7, [], { "System.IterationPath": "P\\PI" }), [], pi, S, true)).toBe(0);
    expect(externalColumn(item(8, [], { "System.IterationPath": "P\\Old" }), [], pi, S, true)).toBeUndefined();
    expect(externalColumn(item(9), [], pi, S, false)).toBeUndefined();
  });

  it("groups hidden partners by criticality without duplicates", () => {
    const map = new Map<number, HiddenPartners[]>();
    addHidden(map, 1, "consumers", 5, "healthy");
    addHidden(map, 1, "consumers", 6, "critical");
    addHidden(map, 1, "consumers", 7, "critical");
    addHidden(map, 1, "consumers", 7, "critical");
    addHidden(map, 1, "providers", 8, "atRisk");
    expect(map.get(1)!.map((h) => h.side)).toEqual(["consumers", "providers"]);
    expect(hiddenDetail(map.get(1)![0])).toBe("Critical: #6, #7\nHealthy: #5");
  });
});

describe("roadmap v2 helpers", () => {
  const pi = (path: string, identifier: string): ProgramIncrement => ({ name: path, path, identifier, sprints: [] });

  it("keeps PI ids parallel to the paths", () => {
    const pis = [pi("A", "a"), pi("B", "b")];
    expect(piIdsFor(["A", "X", "B", "Y"], pis, ["X"], ["x"])).toEqual(["a", "x", "b", ""]);
    expect(piIdsFor([], pis)).toEqual([]);
  });

  it("computes the render window", () => {
    expect(renderWindow({ left: 100, width: 0 })).toBeUndefined();
    expect(renderWindow({ left: 100, width: 50 })).toEqual({ from: 50, to: 200 });
    expect(inWindow(0, 10, undefined)).toBe(true);
    expect(inWindow(40, 10, { from: 50, to: 200 })).toBe(true);
    expect(inWindow(30, 10, { from: 50, to: 200 })).toBe(false);
    expect(inWindow(201, 10, { from: 50, to: 200 })).toBe(false);
    expect(clipRange({ start: "2026-01-01", end: "2026-12-31" }, "2026-03-01", "2027-01-01")).toEqual({ start: "2026-03-01", end: "2026-12-31" });
    expect(clipRange({ start: "2026-01-01", end: "2026-12-31" }, "2025-03-01", "2026-02-01")).toEqual({ start: "2026-01-01", end: "2026-02-01" });
  });

  it("finds the own and the ancestor cadence", () => {
    const config = makeConfig();
    // Everyone on the project cadence: one band owned by the unit itself.
    expect(roadmapCadences(config, "n-arta")).toEqual({ own: { root: "Fabrikam\\PIs", owner: config.root.children[0] } });
    // ART with its own cadence under a portfolio on the project cadence.
    config.root.children[0].piRootIteration = "Fabrikam\\ART PIs";
    const c = roadmapCadences(config, "n-arta");
    expect(c.own).toEqual({ root: "Fabrikam\\ART PIs", owner: config.root.children[0] });
    expect(c.ancestor).toEqual({ root: "Fabrikam\\PIs", owner: config.root });
    // The portfolio defines the project cadence explicitly.
    config.root.piRootIteration = "Fabrikam\\PIs";
    expect(roadmapCadences(config, "n-artb").own.owner).toBe(config.root);
  });
});
