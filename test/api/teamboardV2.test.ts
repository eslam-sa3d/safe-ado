import { describe, expect, it } from "vitest";
import {
  assignedPiNames,
  assignPiMeta,
  backlogMarkers,
  boardDependencies,
  boardFacets,
  childIds,
  edgeHints,
  externalIds,
  externalPlacement,
  piOf,
  rolledOverItems,
  sortItems,
} from "../../src/api/teamboard";
import { ProgramIncrement, WorkItem, WorkItemMeta } from "../../src/api/types";

const url = (id: number) => `https://x/_apis/wit/workItems/${id}`;
const wi = (id: number, fields: Record<string, unknown> = {}, rels: [string, number][] = []): WorkItem => ({
  id,
  fields: { "System.Title": `Item ${id}`, "System.WorkItemType": "User Story", "System.State": "New", ...fields },
  relations: rels.map(([rel, t]) => ({ rel, url: url(t) })),
});
const CHILD = "System.LinkTypes.Hierarchy-Forward";
const BLOCKS = { forward: "Custom.Blocks-Forward", reverse: "Custom.Blocks-Reverse" };
const cat = (_t: string, s: string) => (s === "Closed" ? "Completed" : "InProgress");
const IT = "System.IterationPath";
const AREA = "System.AreaPath";

const sprint = (pi: string, n: number, start: string, finish: string) => ({ name: `${pi} S${n}`, path: `P\\${pi}\\S${n}`, identifier: `${pi}-s${n}`, start, finish });
const PI1: ProgramIncrement = {
  name: "PI 1",
  path: "P\\PI 1",
  identifier: "pi-1",
  start: "2026-01-01T00:00:00Z",
  sprints: [sprint("PI 1", 1, "2026-01-01T00:00:00Z", "2026-01-14T00:00:00Z"), sprint("PI 1", 2, "2026-01-15T00:00:00Z", "2026-01-28T00:00:00Z")],
};
const PI2: ProgramIncrement = {
  name: "PI 2",
  path: "P\\PI 2",
  identifier: "pi-2",
  sprints: [sprint("PI 2", 1, "2026-02-01T00:00:00Z", "2026-02-14T00:00:00Z"), sprint("PI 2", 2, "2026-02-15T00:00:00Z", "2026-02-28T00:00:00Z")],
};
const PIS = [PI1, PI2];
const meta = (m: Partial<WorkItemMeta>): WorkItemMeta => ({ id: "1", workItemId: 1, assignedNodeIds: [], assignedPiPaths: [], ...m });

describe("team board v2 logic", () => {
  it("finds the PI of an iteration", () => {
    expect(piOf("P\\PI 2\\S1", PIS)).toBe(PI2);
    expect(piOf("p\\pi 1", PIS)).toBe(PI1);
    expect(piOf("P\\Other", PIS)).toBeUndefined();
    expect(piOf(undefined, PIS)).toBeUndefined();
  });

  it("names assigned PIs by id, then path, else the last path segment", () => {
    expect(assignedPiNames(undefined, PIS)).toEqual([]);
    expect(
      assignedPiNames(meta({ assignedPiPaths: ["P\\Renamed", "p\\pi 1", "P\\PI 9", "P\\PI 1"], assignedPiIds: ["pi-2"] }), PIS)
    ).toEqual(["PI 2", "PI 1", "PI 9"]);
    expect(assignedPiNames(meta({ assignedPiPaths: [""] }), PIS)).toEqual([""]);
  });

  it("adds a PI with its stable id to the meta", () => {
    expect(assignPiMeta(meta({}), PI2)).toMatchObject({ assignedPiPaths: ["P\\PI 2"], assignedPiIds: ["pi-2"] });
    // Legacy metas without ids keep their positions aligned
    expect(assignPiMeta(meta({ assignedPiPaths: ["P\\PI 1"] }), PI2)).toMatchObject({ assignedPiPaths: ["P\\PI 1", "P\\PI 2"], assignedPiIds: ["", "pi-2"] });
    expect(assignPiMeta(meta({ assignedPiPaths: ["P\\PI 1"], assignedPiIds: ["pi-1"] }), PI2).assignedPiIds).toEqual(["pi-1", "pi-2"]);
    const same = meta({ assignedPiPaths: ["P\\PI 2"] });
    expect(assignPiMeta(same, PI2)).toBe(same);
  });

  it("marks backlog items planned elsewhere and their team assignments", () => {
    const opts = { pis: PIS, pi: PI2, teamId: "red", nodeName: (id: string) => (id === "blue" ? "Team Blue" : undefined), story: true };
    expect(backlogMarkers(wi(1, { [IT]: "P\\PI 1\\S2" }), opts)).toEqual([{ kind: "otherPi", label: "Planned in PI 1" }]);
    expect(backlogMarkers(wi(1, { [IT]: "P\\PI 2" }), opts)).toEqual([{ kind: "noSprint", label: "In PI 2, no sprint" }]);
    expect(backlogMarkers(wi(1, { [IT]: "P\\PI 2" }), { ...opts, story: false })).toEqual([]);
    expect(backlogMarkers(wi(1, { [IT]: "P" }), opts)).toEqual([]);
    expect(
      backlogMarkers(wi(1, { [IT]: "P" }), { ...opts, meta: meta({ assignedNodeIds: ["red", "blue", "gone"] }) }).map((m) => m.label)
    ).toEqual(["Assigned here", "Assigned to Team Blue, gone"]);
  });

  it("finds rolled-over items from revisions", () => {
    const paths = PI1.sprints.map((s) => s.path);
    const current = new Map([
      [1, wi(1, { [IT]: "P\\PI 1\\S2" })],
      [2, wi(2, { [IT]: "P\\PI 1\\S1" })],
      [3, wi(3, { [IT]: "P\\PI 2\\S1" })],
      [4, wi(4, { [IT]: "P\\Backlog" })],
      [5, wi(5, { [IT]: "P\\PI 1\\S2" })],
    ]);
    const revs = [
      { id: 1, fields: { [IT]: "P\\PI 1\\S1", [AREA]: "P\\Red" } },
      { id: 1, fields: { [IT]: "P\\PI 1\\S1", [AREA]: "P\\Red\\Sub" } }, // duplicate
      { id: 2, fields: { [IT]: "P\\PI 1\\S2", [AREA]: "P\\Red" } }, // moved back: not later
      { id: 3, fields: { [IT]: "P\\PI 1\\S1", [AREA]: "P\\Red" } }, // later PI
      { id: 4, fields: { [IT]: "P\\PI 1\\S1", [AREA]: "P\\Red" } }, // back to backlog
      { id: 5, fields: { [IT]: "P\\PI 1\\S1", [AREA]: "P\\Blue" } }, // other team
      { id: 6, fields: { [IT]: "P\\PI 1\\S1", [AREA]: "P\\Red" } }, // unknown now
      { id: 1, fields: { [IT]: "P\\Elsewhere", [AREA]: "P\\Red" } },
      { id: 1, fields: { [IT]: "P\\PI 1\\S2", [AREA]: "P\\Red" } }, // not a completed sprint
    ];
    const later = (it: string | undefined) => !!it?.startsWith("P\\PI 2");
    expect(rolledOverItems(revs, current, paths, [true, false], "P\\Red", later)).toEqual([
      { id: 1, sprintIndex: 0 },
      { id: 3, sprintIndex: 0 },
    ]);
    // Default: nothing outside the PI counts as later; no team area = any area
    expect(rolledOverItems(revs, current, paths, [true, false], undefined).map((r) => r.id)).toEqual([1, 5]);
  });

  it("builds edge hints for undrawn partners grouped by criticality", () => {
    const deps = [
      { provider: 1, consumer: 2, criticality: "critical" as const },
      { provider: 1, consumer: 3, criticality: "healthy" as const },
      { provider: 1, consumer: 3, criticality: "healthy" as const },
      { provider: 4, consumer: 1, criticality: "atRisk" as const },
      { provider: 5, consumer: 6, criticality: "resolved" as const },
    ];
    const hints = edgeHints(deps, (id) => id === 1 || id === 5 || id === 6);
    expect(hints.get(1)!.map((h) => [h.side, Object.fromEntries(h.byCrit)])).toEqual([
      ["consumers", { critical: [2], healthy: [3] }],
      ["providers", { atRisk: [4] }],
    ]);
    expect(hints.has(5)).toBe(false);
  });

  it("places external items by sprint, children, or target / due date", () => {
    expect(childIds(wi(1, {}, [[CHILD, 7], ["System.LinkTypes.Related", 8]]))).toEqual([7]);
    expect(childIds({ id: 1, fields: {}, relations: [{ rel: CHILD, url: "bad" }] })).toEqual([]);
    expect(childIds({ id: 1, fields: {} })).toEqual([]);
    const sprints = PI2.sprints;
    expect(externalPlacement(wi(1, { [IT]: "P\\PI 2\\S2" }), sprints)).toEqual({ index: 1, via: "sprint" });
    expect(externalPlacement(wi(1, { [IT]: "P\\PI 2" }), sprints, ["P\\PI 2\\S1", undefined])).toEqual({ index: 0, via: "children" });
    expect(externalPlacement(wi(1, { "Microsoft.VSTS.Scheduling.TargetDate": "2026-02-20T00:00:00Z" }), sprints)).toEqual({
      index: 1,
      via: "date",
      date: "2026-02-20",
    });
    expect(externalPlacement(wi(1, { "Microsoft.VSTS.Scheduling.DueDate": "2026-02-01" }), sprints)).toEqual({ index: 0, via: "date", date: "2026-02-01" });
    expect(externalPlacement(wi(1, { "Microsoft.VSTS.Scheduling.DueDate": "2027-01-01" }), sprints)).toEqual({ index: -1, date: "2027-01-01" });
    expect(externalPlacement(wi(1, { "Microsoft.VSTS.Scheduling.DueDate": "2026-02-01" }), [{ name: "x", path: "P\\x", identifier: "x" }])).toEqual({
      index: -1,
      date: "2026-02-01",
    });
    expect(externalPlacement(wi(1), sprints)).toEqual({ index: -1 });
  });

  it("builds Parent feature and Assigned PIs facets", () => {
    const f = wi(10, { "System.Title": "Payments", "System.WorkItemType": "Feature" });
    const s1 = wi(1, { [IT]: "P\\PI 2\\S1" });
    const s2 = wi(2, { [IT]: "P\\Backlog" });
    const s3 = wi(3, { [IT]: "P\\PI 2\\S2" });
    const metas = new Map([
      [2, meta({ workItemId: 2, assignedPiPaths: ["P\\PI 1"] })],
      [3, meta({ workItemId: 3, assignedPiPaths: ["P\\PI 2"] })],
    ]);
    const [parent, pis] = boardFacets([s1, s2, s3], [f], new Map([[1, 10], [3, 99]]), metas, PIS);
    expect(parent).toMatchObject({ key: "parent", label: "Parent feature", options: ["#10 Payments", "None"] });
    expect([s1, s2, s3].map((s) => parent.values(s))).toEqual([["#10 Payments"], ["None"], ["None"]]);
    expect(pis).toMatchObject({ key: "pis", label: "Assigned PIs", options: ["PI 1", "PI 2"] });
    expect([s1, s2, s3].map((s) => pis.values(s))).toEqual([["PI 2"], ["PI 1"], ["PI 2"]]);
  });

  it("uses the configured dependency link and placement overrides", () => {
    const items = [wi(1, { [IT]: "P\\PI 2\\S2" }, [["Custom.Blocks-Forward", 2], ["System.LinkTypes.Dependency-Forward", 3]])];
    expect(externalIds(items, BLOCKS)).toEqual([2]);
    const lookup = new Map([[1, items[0]], [2, wi(2, { [IT]: "P\\PI 2\\S1" })]]);
    const paths = PI2.sprints.map((s) => s.path);
    expect(boardDependencies(items, lookup, paths, cat, BLOCKS)).toEqual([{ provider: 1, consumer: 2, criticality: "critical" }]);
    // Item 2 placed by its children in a later sprint → at risk (same sprint)
    expect(boardDependencies(items, lookup, paths, cat, BLOCKS, (id) => (id === 2 ? 1 : undefined))[0].criticality).toBe("atRisk");
  });

  it("sorts by WSJF with the configured RR/OE field", () => {
    const a = wi(1, { "Microsoft.VSTS.Common.BusinessValue": 1, "Microsoft.VSTS.Scheduling.Effort": 1 });
    const b = wi(2, { "Microsoft.VSTS.Common.BusinessValue": 1, "Microsoft.VSTS.Scheduling.Effort": 1, "Custom.RR": 10 });
    expect(sortItems([a, b], "wsjf", "SP").map((i) => i.id)).toEqual([1, 2]);
    expect(sortItems([a, b], "wsjf", "SP", "Custom.RR").map((i) => i.id)).toEqual([2, 1]);
  });
});
