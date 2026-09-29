import { describe, expect, it } from "vitest";
import {
  capacityId,
  capacityStore,
  emptyMeta,
  getUserValue,
  metaStore,
  milestonesStore,
  setUserValue,
} from "../../src/api/data";
import {
  calculatedSprintIndex,
  CRITICALITY_COLOR,
  CRITICALITY_LABEL,
  criticalityByDates,
  criticalityByIteration,
  dependenciesOf,
  sprintIndex,
} from "../../src/api/dependencies";
import {
  applyFilter,
  EMPTY_FILTER,
  facetOptions,
  filterToWiql,
  isFilterActive,
  matchesFilter,
  tagsOf,
  withWiqlFilter,
} from "../../src/api/filters";
import { WorkItem } from "../../src/api/types";
import {
  createWorkItem,
  deleteIteration,
  getIterationNodeId,
  getTeamIterations,
  removeTeamIteration,
  updateIteration,
  addTeamIteration,
} from "../../src/api/wit";
import { callsTo, dataManager, fail, fake, PI2, PI2_IP, PI2_S1, PI2_S2, RED } from "../fakeAdo";

const url = (id: number) => `https://dev.azure.com/org/_apis/wit/workItems/${id}`;
const item = (id: number, fields: Record<string, unknown> = {}, relations: [string, number][] = []): WorkItem => ({
  id,
  fields: { "System.Title": `Item ${id}`, "System.WorkItemType": "Feature", "System.State": "New", ...fields },
  relations: relations.map(([rel, to]) => ({ rel, url: url(to) })),
});

describe("dependency engine", () => {
  it("collects provider→consumer pairs from both link directions without duplicates", () => {
    const items = [
      item(1, {}, [["System.LinkTypes.Dependency-Forward", 2], ["System.LinkTypes.Hierarchy-Forward", 9]]),
      item(2, {}, [["System.LinkTypes.Dependency-Reverse", 1], ["System.LinkTypes.Dependency-Reverse", 3]]),
      item(3, {}, [["System.LinkTypes.Dependency-Forward", 3]]), // self-link ignored
      { id: 4, fields: {}, relations: [{ rel: "System.LinkTypes.Dependency-Forward", url: "https://x/other/abc" }] },
      { id: 5, fields: {} },
    ];
    expect(dependenciesOf(items)).toEqual([
      { provider: 1, consumer: 2 },
      { provider: 3, consumer: 2 },
    ]);
  });

  it("rates criticality by iteration order", () => {
    expect(criticalityByIteration(0, 1)).toBe("healthy");
    expect(criticalityByIteration(1, 1)).toBe("atRisk");
    expect(criticalityByIteration(2, 1)).toBe("critical");
    expect(criticalityByIteration(-1, 1)).toBe("atRisk");
    expect(criticalityByIteration(1, -1)).toBe("atRisk");
    expect(criticalityByIteration(5, 1, true)).toBe("resolved");
  });

  it("rates criticality by planned dates", () => {
    const consumer = { start: "2026-03-01", end: "2026-03-31" };
    expect(criticalityByDates({ end: "2026-02-28" }, consumer)).toBe("healthy");
    expect(criticalityByDates({ end: "2026-03-15" }, consumer)).toBe("atRisk");
    expect(criticalityByDates({ end: "2026-03-31" }, consumer)).toBe("atRisk");
    expect(criticalityByDates({ end: "2026-04-02" }, consumer)).toBe("critical");
    expect(criticalityByDates({}, consumer)).toBe("atRisk");
    expect(criticalityByDates({ end: "2026-01-01" }, { start: "2026-03-01" })).toBe("atRisk");
    expect(criticalityByDates({ end: "2026-09-01" }, consumer, true)).toBe("resolved");
  });

  it("labels and colours every criticality", () => {
    expect(Object.keys(CRITICALITY_LABEL)).toEqual(["healthy", "atRisk", "critical", "resolved"]);
    expect(Object.keys(CRITICALITY_COLOR)).toEqual(Object.keys(CRITICALITY_LABEL));
  });

  it("finds sprint indexes with UNDER semantics", () => {
    const sprints = [PI2_S1, PI2_S2, PI2_IP];
    expect(sprintIndex(PI2_S2, sprints)).toBe(1);
    expect(sprintIndex(PI2_S1.toLowerCase() + "\\Sub", sprints)).toBe(0);
    expect(sprintIndex(PI2, sprints)).toBe(-1);
    expect(sprintIndex(undefined, sprints)).toBe(-1);
  });

  it("places ART items at the last planned child's sprint, else their own", () => {
    const sprints = [PI2_S1, PI2_S2, PI2_IP];
    expect(calculatedSprintIndex(PI2_S1, [PI2_S1, PI2_IP, undefined], sprints)).toBe(2);
    expect(calculatedSprintIndex(PI2_S2, [PI2, undefined], sprints)).toBe(1);
    expect(calculatedSprintIndex(PI2, [], sprints)).toBe(-1);
  });
});

describe("filters", () => {
  const items = [
    item(1, { "System.WorkItemType": "Feature", "System.State": "New", "System.Tags": "MVP; Payments", "System.AssignedTo": { displayName: "Ada" } }),
    item(2, { "System.WorkItemType": "Epic", "System.State": "Active", "System.Title": "Checkout" }),
    item(3, { "System.WorkItemType": "Feature", "System.State": "Closed", "System.Tags": "Payments" }),
  ];

  it("detects active filters", () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, text: "  " })).toBe(false);
    for (const k of ["types", "states", "assignees", "tags"] as const) expect(isFilterActive({ ...EMPTY_FILTER, [k]: ["x"] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, wiql: "[x] = 1" })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, text: "a" })).toBe(true);
  });

  it("matches text (title or exact id) and every facet", () => {
    expect(applyFilter(items, { ...EMPTY_FILTER, text: "check" }).map((i) => i.id)).toEqual([2]);
    expect(applyFilter(items, { ...EMPTY_FILTER, text: "3" }).map((i) => i.id)).toEqual([3]);
    expect(applyFilter(items, { ...EMPTY_FILTER, types: ["Feature"] }).map((i) => i.id)).toEqual([1, 3]);
    expect(applyFilter(items, { ...EMPTY_FILTER, states: ["Active"] }).map((i) => i.id)).toEqual([2]);
    expect(applyFilter(items, { ...EMPTY_FILTER, assignees: ["Unassigned"] }).map((i) => i.id)).toEqual([2, 3]);
    expect(applyFilter(items, { ...EMPTY_FILTER, tags: ["MVP"] }).map((i) => i.id)).toEqual([1]);
    expect(matchesFilter({ id: 9, fields: {} }, { ...EMPTY_FILTER, text: "x" })).toBe(false);
    expect(tagsOf({ id: 9, fields: {} })).toEqual([]);
  });

  it("derives sorted facet options", () => {
    expect(facetOptions(items)).toEqual({
      types: ["Epic", "Feature"],
      states: ["Active", "Closed", "New"],
      assignees: ["Ada", "Unassigned"],
      tags: ["MVP", "Payments"],
    });
    expect(facetOptions([{ id: 1, fields: {} }]).types).toEqual([]);
  });

  it("injects the WIQL clause before ORDER BY or at the end", () => {
    const f = { ...EMPTY_FILTER, wiql: " [System.Tags] CONTAINS 'MVP' " };
    expect(withWiqlFilter("SELECT x WHERE a ORDER BY b", f)).toBe("SELECT x WHERE a AND ([System.Tags] CONTAINS 'MVP') ORDER BY b");
    expect(withWiqlFilter("SELECT x WHERE a", f)).toBe("SELECT x WHERE a AND ([System.Tags] CONTAINS 'MVP')");
    expect(withWiqlFilter("SELECT x", EMPTY_FILTER)).toBe("SELECT x");
  });

  it("renders the filter as WIQL", () => {
    expect(
      filterToWiql({ text: "O'Neil", types: ["Feature"], states: ["New", "Active"], assignees: ["Ada"], tags: ["MVP", "X"], wiql: "[a] = 1" })
    ).toBe(
      "[System.Title] CONTAINS 'O''Neil' AND [System.WorkItemType] IN ('Feature') AND [System.State] IN ('New', 'Active') AND [System.AssignedTo] IN ('Ada') AND ([System.Tags] CONTAINS 'MVP' OR [System.Tags] CONTAINS 'X') AND ([a] = 1)"
    );
    expect(filterToWiql(EMPTY_FILTER)).toBe("");
  });
});

describe("new REST helpers", () => {
  it("creates work items with json-patch", async () => {
    const created = await createWorkItem("User Story", { "System.Title": "New story", "System.AreaPath": RED });
    const call = callsTo(/workitems\/\$/, "POST")[0];
    expect(call.path).toBe("p1/_apis/wit/workitems/$User%20Story");
    expect(call.headers["Content-Type"]).toBe("application/json-patch+json");
    expect(created.fields["System.Title"]).toBe("New story");
    expect(fake.workItems.get(created.id)!.fields["System.State"]).toBe("New");
  });

  it("surfaces invalid type errors on create", async () => {
    await expect(createWorkItem("Nope", {})).rejects.toThrow(/Invalid work item type/);
  });

  it("renames and re-dates iterations", async () => {
    await updateIteration("Fabrikam\\PIs\\PI 2", { name: "PI 2b", startDate: "2027-01-01T00:00:00Z", finishDate: "2027-02-01T00:00:00Z" });
    const call = callsTo(/classificationnodes/, "PATCH")[0];
    expect(call.path).toBe("p1/_apis/wit/classificationnodes/Iterations/PIs/PI%202");
    expect(call.body).toEqual({ name: "PI 2b", attributes: { startDate: "2027-01-01T00:00:00Z", finishDate: "2027-02-01T00:00:00Z" } });
    // A start date without a finish date is ignored (both are required together)
    await updateIteration("Fabrikam\\PIs", { startDate: "2027-01-01T00:00:00Z" });
    expect(callsTo(/classificationnodes/, "PATCH")[1]).toMatchObject({ path: "p1/_apis/wit/classificationnodes/Iterations/PIs", body: {} });
  });

  it("looks up node ids and deletes iterations with reclassification", async () => {
    const id = await getIterationNodeId("Fabrikam\\PIs");
    expect(typeof id).toBe("number");
    expect(await getIterationNodeId("Fabrikam")).toBe(fake.iterationTree.id);
    await deleteIteration("Fabrikam\\PIs\\PI 1", id!);
    expect(fake.deletedIterations).toEqual([{ path: "\\Fabrikam\\Iteration\\PIs\\PI 1", reclassifyId: id }]);
    expect(callsTo(/classificationnodes/, "DELETE")[0].url).toContain(`?$reclassifyId=${id}&api-version=7.0`);
  });

  it("lists and removes team iteration subscriptions", async () => {
    const pi2 = fake.iterationTree.children![0].children![0];
    await addTeamIteration("t-red", pi2.children![1].identifier);
    const list = await getTeamIterations("t-red");
    expect(list).toEqual([expect.objectContaining({ name: "PI 2 Sprint 1", path: PI2_S1 })]);
    await removeTeamIteration("t-red", list[0].id);
    expect(await getTeamIterations("t-red")).toEqual([]);
  });

  it("returns 404s for unknown iteration nodes", async () => {
    await expect(getIterationNodeId("Fabrikam\\Nope")).rejects.toThrow(/not found/);
    fail(/teamsettings\/iterations$/, 500, "down");
    await expect(getTeamIterations("t-red")).rejects.toThrow("down");
  });
});

describe("planning stores", () => {
  it("stores milestones, capacity and work item meta per project", async () => {
    await milestonesStore.save({ id: "m1", nodeId: "n-arta", title: "Beta", date: "2026-10-01" });
    await capacityStore.save({ id: capacityId("n-red", PI2_S1), nodeId: "n-red", iterationPath: PI2_S1, capacity: 20 });
    await metaStore.save({ ...emptyMeta(10), owningNodeId: "n-red" });
    expect((await milestonesStore.list()).map((m) => m.title)).toEqual(["Beta"]);
    expect((await capacityStore.list())[0].id).toBe(`n-red|${PI2_S1}`);
    expect(await metaStore.list()).toEqual([expect.objectContaining({ id: "10", workItemId: 10, owningNodeId: "n-red", assignedNodeIds: [], assignedPiPaths: [] })]);
    expect(dataManager.setDocument).toHaveBeenCalledWith("wimeta-p1", expect.anything(), { scopeType: "Default" });
    await milestonesStore.remove("m1");
    expect(await milestonesStore.list()).toEqual([]);
  });

  it("keeps per-user values in the User scope with a fallback", async () => {
    expect(await getUserValue("starred", [] as string[])).toEqual([]);
    await setUserValue("starred", ["n-red"]);
    expect(await getUserValue("starred", [] as string[])).toEqual(["n-red"]);
    expect(dataManager.setValue).toHaveBeenCalledWith("starred-p1", ["n-red"], { scopeType: "User" });
  });
});
