import { describe, expect, it } from "vitest";
import {
  assignMeta,
  boardDependencies,
  buildLanes,
  decodeDrag,
  encodeDrag,
  externalIds,
  groupByArea,
  INDEPENDENT,
  isAssigned,
  isOpen,
  iterationStatus,
  moveChanges,
  ownParentId,
  parentMap,
  searchItems,
  sortItems,
  sprintLoads,
  storyLevelTypes,
  storyPoints,
  todayIso,
  unassignMeta,
  unplannedStories,
  wsjf,
} from "../../src/api/teamboard";
import { WorkItem, WorkItemMeta } from "../../src/api/types";

const SP = "SP";
const url = (id: number) => `https://x/_apis/wit/workItems/${id}`;
const wi = (id: number, fields: Record<string, unknown> = {}, rels: [string, number][] = []): WorkItem => ({
  id,
  fields: { "System.Title": `Item ${id}`, "System.WorkItemType": "User Story", "System.State": "New", ...fields },
  relations: rels.map(([rel, t]) => ({ rel, url: url(t) })),
});
const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const CHILD = "System.LinkTypes.Hierarchy-Forward";
const SUCC = "System.LinkTypes.Dependency-Forward";
const PRED = "System.LinkTypes.Dependency-Reverse";
const S = ["P\\PI\\S1", "P\\PI\\S2", "P\\PI\\S3"];
const cat = (_t: string, s: string) => (s === "Closed" ? "Completed" : s === "Removed" ? "Removed" : "InProgress");

describe("teamboard logic", () => {
  it("computes today and iteration status", () => {
    expect(todayIso(new Date("2026-03-04T15:00:00Z"))).toBe("2026-03-04");
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const sprint = { start: "2026-03-01T00:00:00Z", finish: "2026-03-10T00:00:00Z" };
    expect(iterationStatus(sprint, "2026-03-11")).toBe("past");
    expect(iterationStatus(sprint, "2026-03-10")).toBe("current");
    expect(iterationStatus(sprint, "2026-03-01")).toBe("current");
    expect(iterationStatus(sprint, "2026-02-28")).toBe("future");
    expect(iterationStatus({}, "2026-03-01")).toBe("future");
    expect(iterationStatus({ finish: "2026-01-01" }, "2026-03-01")).toBe("past");
  });

  it("sums points and loads per sprint", () => {
    expect(storyPoints(wi(1, { SP: "3" }), SP)).toBe(3);
    expect(storyPoints(wi(1, { SP: "x" }), SP)).toBe(0);
    expect(storyPoints(wi(1), SP)).toBe(0);
    const items = [
      wi(1, { SP: 3, "System.IterationPath": S[0] }),
      wi(2, { SP: 5, "System.IterationPath": S[0] + "\\Sub" }),
      wi(3, { SP: 8, "System.IterationPath": S[2] }),
      wi(4, { SP: 1, "System.IterationPath": "P\\Other" }),
    ];
    expect(sprintLoads(items, S, SP)).toEqual([8, 0, 8]);
  });

  it("lists story-level types", () => {
    expect(storyLevelTypes("User Story", ["User Story", "Bug", "Task"])).toEqual(["User Story", "Bug"]);
    expect(storyLevelTypes("Product Backlog Item", ["Task"])).toEqual(["Product Backlog Item"]);
    expect(storyLevelTypes("Bug", ["Bug"])).toEqual(["Bug"]);
  });

  it("resolves parents from either side of the link", () => {
    const features = [wi(10, {}, [[CHILD, 1], [CHILD, 2]]), wi(11, {}, [[CHILD, 2], [SUCC, 3]])];
    const stories = [wi(1), wi(2, {}, [[PARENT, 11]]), wi(3, {}, [[PARENT, 99]]), wi(4, {}, [["Other", 10]])];
    const map = parentMap(stories, features);
    expect(Array.from(map.entries())).toEqual([
      [1, 10],
      [2, 11],
    ]);
    expect(ownParentId(stories[1])).toBe(11);
    expect(ownParentId(stories[0])).toBeNull();
    expect(ownParentId({ id: 5, fields: {} })).toBeNull();
    expect(parentMap([{ id: 5, fields: {} }], [{ id: 6, fields: {} }]).size).toBe(0);
  });

  it("builds lanes from parents and assignments, ordered by stack rank", () => {
    const f10 = wi(10, { "System.Title": "Ten", "Microsoft.VSTS.Common.StackRank": 5 });
    const f11 = wi(11, { "System.Title": "Eleven", "Microsoft.VSTS.Common.StackRank": 1 });
    const f12 = wi(12, { "System.Title": "Twelve" });
    const f13 = wi(13, { "System.Title": "Thirteen" });
    const stories = [wi(1), wi(2), wi(3)];
    const parents = new Map([
      [1, 10],
      [2, 10],
      [3, 77],
    ]);
    const meta = (id: number, nodes: string[], pis: string[]): [number, WorkItemMeta] => [
      id,
      { id: String(id), workItemId: id, assignedNodeIds: nodes, assignedPiPaths: pis },
    ];
    const metas = new Map([meta(11, ["t"], ["PI"]), meta(12, ["t"], ["Other"]), meta(10, ["t"], ["PI"]), meta(13, ["t"], ["PI"])]);
    const lanes = buildLanes(stories, [f10, f11, f12, f13], parents, metas, "t", "PI");
    expect(lanes.map((l) => [l.key, l.title, l.stories.map((s) => s.id), l.assigned])).toEqual([
      ["11", "Eleven", [], true],
      ["10", "Ten", [1, 2], true],
      ["13", "Thirteen", [], true],
      [INDEPENDENT, "Independent", [3], false],
    ]);
    expect(isAssigned(undefined, "t", "PI")).toBe(false);
    // Same rank → by id
    const tie = buildLanes([wi(1), wi(2)], [wi(21), wi(20)], new Map([[1, 21], [2, 20]]), new Map(), "t", "PI");
    expect(tie.map((l) => l.key)).toEqual(["20", "21", INDEPENDENT]);
  });

  it("assigns and unassigns metadata", () => {
    const m: WorkItemMeta = { id: "1", workItemId: 1, assignedNodeIds: ["a"], assignedPiPaths: ["PI"] };
    expect(assignMeta(m, "a", "PI")).toEqual(m);
    expect(assignMeta(m, "b", "PI2")).toMatchObject({ assignedNodeIds: ["a", "b"], assignedPiPaths: ["PI", "PI2"] });
    expect(unassignMeta({ ...m, assignedNodeIds: ["a", "b"] }, "a", "PI")).toMatchObject({ assignedNodeIds: ["b"], assignedPiPaths: ["PI"] });
    expect(unassignMeta(m, "a", "PI")).toMatchObject({ assignedNodeIds: [], assignedPiPaths: [] });
  });

  it("computes WSJF", () => {
    const f = (bv?: number, tc?: number, e?: number) =>
      wi(1, {
        "Microsoft.VSTS.Common.BusinessValue": bv,
        "Microsoft.VSTS.Common.TimeCriticality": tc,
        "Microsoft.VSTS.Scheduling.Effort": e,
      });
    expect(wsjf(f(8, 5, 13))).toBe(1);
    expect(wsjf(f(10, undefined, 3))).toBe(3.3);
    expect(wsjf(f(undefined, 4, 2))).toBe(2);
    expect(wsjf(f(undefined, undefined, 2))).toBeUndefined();
    expect(wsjf(f(3, 3, 0))).toBeUndefined();
    expect(wsjf(f(3, 3))).toBeUndefined();
  });

  it("sorts and searches", () => {
    const P = "Microsoft.VSTS.Common.Priority";
    const items = [
      wi(3, { [P]: 2, SP: 1, "System.Title": "Gamma" }),
      wi(1, { SP: 8, "System.Title": "Alpha", "Microsoft.VSTS.Common.BusinessValue": 9, "Microsoft.VSTS.Scheduling.Effort": 1 }),
      wi(2, { [P]: 1, "System.Title": "Beta", "Microsoft.VSTS.Common.BusinessValue": 2, "Microsoft.VSTS.Scheduling.Effort": 1 }),
      wi(4, { [P]: 1, "System.Title": "Delta" }),
    ];
    const ids = (xs: WorkItem[]) => xs.map((x) => x.id);
    expect(ids(sortItems(items, "rank", SP))).toEqual([3, 1, 2, 4]);
    expect(ids(sortItems(items, "priority", SP))).toEqual([2, 4, 3, 1]);
    expect(ids(sortItems(items, "points", SP))).toEqual([1, 3, 2, 4]);
    expect(ids(sortItems(items, "id", SP))).toEqual([1, 2, 3, 4]);
    expect(ids(sortItems(items, "wsjf", SP))).toEqual([1, 2, 3, 4]);
    expect(ids(searchItems(items, "  "))).toEqual([3, 1, 2, 4]);
    expect(ids(searchItems(items, "ALP"))).toEqual([1]);
    expect(ids(searchItems(items, "#4"))).toEqual([4]);
    expect(ids(searchItems([{ id: 9, fields: {} }], "x"))).toEqual([]);
  });

  it("filters unplanned and open items", () => {
    const items = [
      wi(1, { "System.IterationPath": S[0] }),
      wi(2, { "System.IterationPath": "P\\PI" }),
      wi(3, { "System.IterationPath": "P", "System.State": "Closed" }),
      wi(4, { "System.IterationPath": "P", "System.State": "Removed" }),
      wi(5, {}),
    ];
    expect(unplannedStories(items, S, cat).map((i) => i.id)).toEqual([2, 5]);
    expect(items.filter((i) => isOpen(i, cat)).map((i) => i.id)).toEqual([1, 2, 5]);
  });

  it("rates dependencies and finds external ends", () => {
    const items = [
      wi(1, { "System.IterationPath": S[1] }, [[SUCC, 2], [SUCC, 5]]),
      wi(2, { "System.IterationPath": S[0] }, [[PRED, 3]]),
      wi(3, { "System.IterationPath": S[0], "System.State": "Closed" }, [[SUCC, 2]]),
    ];
    const lookup = new Map(items.map((i) => [i.id, i]));
    expect(boardDependencies(items, lookup, S, cat)).toEqual([
      { provider: 1, consumer: 2, criticality: "critical" },
      { provider: 1, consumer: 5, criticality: "atRisk" },
      { provider: 3, consumer: 2, criticality: "resolved" },
    ]);
    expect(externalIds(items)).toEqual([5]);
    expect(externalIds([wi(1, {}, [[PRED, 9], [SUCC, 7]])])).toEqual([7, 9]);
  });

  it("groups external items by area", () => {
    const groups = groupByArea([wi(1, { "System.AreaPath": "B" }), wi(2, { "System.AreaPath": "A" }), wi(3, { "System.AreaPath": "B" }), wi(4)]);
    expect(groups.map((g) => [g.area, g.items.map((i) => i.id)])).toEqual([
      ["", [4]],
      ["A", [2]],
      ["B", [1, 3]],
    ]);
  });

  it("encodes and decodes drag payloads", () => {
    expect(encodeDrag({ kind: "feature", id: 12 })).toBe("feature:12");
    expect(decodeDrag("story:5")).toEqual({ kind: "story", id: 5 });
    expect(decodeDrag(" feature:12 ")).toEqual({ kind: "feature", id: 12 });
    expect(decodeDrag("42")).toEqual({ kind: "story", id: 42 });
    expect(decodeDrag("")).toBeNull();
    expect(decodeDrag("0")).toBeNull();
    expect(decodeDrag("epic:1")).toBeNull();
    expect(decodeDrag("1.5")).toBeNull();
  });

  it("computes move changes", () => {
    const item = wi(1, { "System.IterationPath": S[0], "System.AreaPath": "P\\Red\\Sub" });
    expect(moveChanges(item, S[0], "P\\Red")).toEqual({});
    expect(moveChanges(item, S[1], "P\\Red")).toEqual({ "System.IterationPath": S[1] });
    expect(moveChanges(item, S[0], "P\\Blue")).toEqual({ "System.AreaPath": "P\\Blue" });
    expect(moveChanges(item, S[0], undefined)).toEqual({});
  });
});
