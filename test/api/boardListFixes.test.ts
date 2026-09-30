import { describe, expect, it } from "vitest";
import { describeWiql, EMPTY_FILTER, filterToWiql, ItemFilter, wiqlClauseProblem, wiqlSuffix } from "../../src/api/filters";
import { assignMeta, changeParent, openStatesClause, unassignMeta } from "../../src/api/teamboard";
import { WorkItemMeta } from "../../src/api/types";
import { getWorkItems } from "../../src/api/wit";
import { PI_LIMIT_MESSAGE } from "../../src/form/planning";
import { callsTo, fail, fake } from "../fakeAdo";

const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const CHILD = "System.LinkTypes.Hierarchy-Forward";
const url = (id: number) => `${fake.baseUrl}/_apis/wit/workItems/${id}`;
const f = (over: Partial<ItemFilter>): ItemFilter => ({ ...EMPTY_FILTER, ...over });

describe("WIQL clause guard", () => {
  it("accepts balanced clauses, including parentheses and keywords inside literals", () => {
    expect(wiqlClauseProblem("[System.Tags] CONTAINS 'MVP'")).toBeNull();
    expect(wiqlClauseProblem("([a] = 1 OR [b] = 2) AND [c] = 'x)(y'")).toBeNull();
    expect(wiqlClauseProblem("[System.Title] = 'It''s ORDER BY mode'")).toBeNull();
    expect(wiqlClauseProblem('[System.Title] = "a ""(" ')).toBeNull();
    expect(wiqlClauseProblem("[Custom.Model] = 1")).toBeNull();
  });

  it("rejects clauses that could escape the scope or change the statement", () => {
    expect(wiqlClauseProblem("1=1) OR ([System.Id] > 0")).toBe("Unbalanced parentheses in the WIQL clause.");
    expect(wiqlClauseProblem("([a] = 1")).toBe("Unbalanced parentheses in the WIQL clause.");
    expect(wiqlClauseProblem("[a] = 'x")).toBe("Unbalanced quotes in the WIQL clause.");
    expect(wiqlClauseProblem('[a] = "x')).toBe("Unbalanced quotes in the WIQL clause.");
    expect(wiqlClauseProblem("[a] = 1 ORDER BY [b]")).toBe("ORDER BY, ASOF and MODE aren't allowed in a filter clause.");
    expect(wiqlClauseProblem("[a] = 1 asof '2020-01-01'")).toBe("ORDER BY, ASOF and MODE aren't allowed in a filter clause.");
    expect(wiqlClauseProblem("[a] = 1 MODE (Recursive)")).toBe("ORDER BY, ASOF and MODE aren't allowed in a filter clause.");
  });

  it("never sends a clause failing the guard (e.g. from a stored quick filter)", () => {
    const quick = [{ id: "q", name: "bad", filter: f({ wiql: "1=1) OR (1=1" }) }];
    expect(wiqlSuffix(f({ wiql: "[a] = 1", quick }))).toBe(" AND ([a] = 1)");
    expect(filterToWiql(f({ wiql: "[a] = 'x", quick }))).toBe("");
  });
});

describe("Copy WIQL", () => {
  it("expresses Unassigned as an empty AssignedTo, alone or ORed with names", () => {
    expect(filterToWiql(f({ assignees: ["Unassigned"] }))).toBe("[System.AssignedTo] = ''");
    expect(filterToWiql(f({ assignees: ["Ada", "Unassigned"] }))).toBe("([System.AssignedTo] IN ('Ada') OR [System.AssignedTo] = '')");
    expect(filterToWiql(f({ assignees: ["O'Neil"] }))).toBe("[System.AssignedTo] IN ('O''Neil')");
  });

  it("omits facets WIQL can't express and flags them", () => {
    expect(describeWiql(f({ types: ["Feature"] }))).toEqual({ wiql: "[System.WorkItemType] IN ('Feature')", omitted: false });
    expect(describeWiql(f({ types: ["Feature"], iterations: ["Sprint 1"] }))).toEqual({ wiql: "[System.WorkItemType] IN ('Feature')", omitted: true });
    expect(describeWiql(f({ extra: { pis: ["PI 2"] } }))).toEqual({ wiql: "", omitted: true });
    expect(describeWiql(f({ extra: { pis: [] } }))).toEqual({ wiql: "", omitted: false });
    expect(describeWiql(f({ priorities: ["None"] }))).toEqual({ wiql: "", omitted: true });
    expect(describeWiql(f({ priorities: ["2"] }))).toEqual({ wiql: "[Microsoft.VSTS.Common.Priority] IN (2)", omitted: false });
    // Quick filters contribute their facets and flags too.
    const quick = [{ id: "q", name: "x", filter: f({ states: ["New"], iterations: ["S1"] }) }];
    expect(describeWiql(f({ text: "pay", quick }))).toEqual({ wiql: "[System.Title] CONTAINS 'pay' AND [System.State] IN ('New')", omitted: true });
  });
});

describe("Assigned PI metadata", () => {
  const meta = (paths: string[], ids?: string[]): WorkItemMeta => ({ id: "1", workItemId: 1, assignedNodeIds: ["a"], assignedPiPaths: paths, assignedPiIds: ids });

  it("matches PIs by id first (renamed paths) and caps the list at 5", () => {
    const renamed = meta(["Old name"], ["pi-2"]);
    expect(assignMeta(renamed, "b", { path: "New name", identifier: "pi-2" })).toEqual({ ...renamed, assignedNodeIds: ["a", "b"] });
    const full = meta(["1", "2", "3", "4", "5"], ["a", "b", "c", "d", "e"]);
    expect(() => assignMeta(full, "a", { path: "6", identifier: "f" })).toThrow(PI_LIMIT_MESSAGE);
    // Already assigned: no cap problem.
    expect(assignMeta(full, "z", { path: "5", identifier: "e" }).assignedNodeIds).toEqual(["a", "z"]);
  });

  it("removes the PI by id, and leaves metas without the PI alone", () => {
    expect(unassignMeta(meta(["X", "Old"], ["x", "pi-2"]), "a", { path: "New", identifier: "pi-2" })).toMatchObject({
      assignedNodeIds: [],
      assignedPiPaths: ["X"],
      assignedPiIds: ["x"],
    });
    const other = meta(["X"], ["x"]);
    expect(unassignMeta(other, "a", { path: "Y", identifier: "y" })).toEqual({ ...other, assignedNodeIds: [] });
  });
});

describe("changeParent", () => {
  const item = async (id: number) => (await getWorkItems([id], undefined, true))[0];
  const patches = (id: number) => callsTo(new RegExp(`^_apis/wit/workitems/${id}$`), "PATCH").map((c) => c.body);

  it("sends nothing when there is nothing to change", async () => {
    await changeParent(await item(100), 10, 10);
    await changeParent(await item(100), null, null);
    expect(callsTo(/workitems\/100$/, "PATCH")).toEqual([]);
  });

  it("removes an own link and writes fields in one request", async () => {
    // Seed: #10 -> Epic #1 on both sides.
    await changeParent(await item(10), 1, null, { "System.Title": "Renamed" });
    expect(patches(10)).toEqual([[{ op: "add", path: "/fields/System.Title", value: "Renamed" }, { op: "remove", path: expect.stringMatching(/^\/relations\/\d+$/) }]]);
    expect(fake.workItems.get(10)!.relations!.some((r) => r.rel === PARENT)).toBe(false);
  });

  it("removes a parent-side link; a failed removal without a new parent just fails", async () => {
    fake.workItems.get(100)!.relations = [];
    fail(/PATCH _apis\/wit\/workitems\/10$/, 409, "Locked", { once: true });
    await expect(changeParent(await item(100), 10, null)).rejects.toThrow("Locked");
    expect(callsTo(/workitems\/100$/, "PATCH")).toEqual([]);
    await changeParent(await item(100), 10, null);
    expect(fake.workItems.get(10)!.relations!.some((r) => r.rel === CHILD && r.url === url(100))).toBe(false);
  });
});

describe("openStatesClause", () => {
  it("excludes Completed / Removed states per type", async () => {
    expect(await openStatesClause(["User Story", "Bug", ""])).toBe(
      "([System.WorkItemType] = 'User Story' AND [System.State] NOT IN ('Closed', 'Removed')) OR [System.WorkItemType] = 'Bug'"
    );
    expect(await openStatesClause([])).toBe("[System.Id] < 0");
  });
});
