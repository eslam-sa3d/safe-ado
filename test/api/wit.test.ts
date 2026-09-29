import { describe, expect, it } from "vitest";
import {
  addLink,
  addTeamIteration,
  createIteration,
  getAreaPaths,
  getAreaTree,
  getFieldNames,
  getIterationPaths,
  getProgramIncrements,
  getStateCategories,
  getStates,
  getTeamDefaultArea,
  getTeams,
  getWorkItems,
  getWorkItemTypes,
  isUnder,
  nodePathToFieldPath,
  openNewWorkItem,
  openWorkItem,
  queryIds,
  queryLinks,
  queryWorkItems,
  relationTargetId,
  removeLink,
  setFields,
  typeIn,
  underAny,
  updateWorkItem,
} from "../../src/api/wit";
import { ART_A, BLUE, callsTo, fail, fake, PI2, RED } from "../fakeAdo";
import * as sdk from "../sdkMock";

describe("path helpers", () => {
  it("converts classification node paths to field paths", () => {
    expect(nodePathToFieldPath("\\Fabrikam\\Iteration\\PI 1\\Sprint 1")).toBe("Fabrikam\\PI 1\\Sprint 1");
    expect(nodePathToFieldPath("\\Fabrikam\\Area")).toBe("Fabrikam");
    expect(nodePathToFieldPath("Fabrikam\\Area\\X")).toBe("Fabrikam\\X");
  });

  it("checks UNDER semantics case-insensitively without prefix false positives", () => {
    expect(isUnder(RED, ART_A)).toBe(true);
    expect(isUnder(ART_A, ART_A)).toBe(true);
    expect(isUnder("fabrikam\\art a", ART_A)).toBe(true);
    expect(isUnder("Fabrikam\\ART AB", ART_A)).toBe(false);
    expect(isUnder(undefined, ART_A)).toBe(false);
  });

  it("builds WIQL clauses", () => {
    expect(underAny("[System.AreaPath]", ["A", "B's"])).toBe("([System.AreaPath] UNDER 'A' OR [System.AreaPath] UNDER 'B''s')");
    expect(underAny("[System.AreaPath]", [])).toBe("[System.Id] < 0");
    expect(typeIn(["Epic", "", "Feature", "Epic"])).toBe("[System.WorkItemType] IN ('Epic', 'Feature')");
    expect(typeIn(["Feature"], "[Target].[System.WorkItemType]")).toBe("[Target].[System.WorkItemType] IN ('Feature')");
  });

  it("extracts relation targets", () => {
    expect(relationTargetId("https://x/_apis/wit/workItems/42")).toBe(42);
    expect(relationTargetId("https://x/_apis/wit/workitems/7")).toBe(7);
    expect(relationTargetId("https://x/_apis/git/repos/1/commits/abc")).toBeNull();
  });
});

describe("work items", () => {
  it("queries ids, capped at 5000", async () => {
    const ids = await queryIds("SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] IN ('Epic')");
    expect(ids).toEqual([1, 2, 3, 4]);
    expect(fake.calls[0].url).toContain("wiql?$top=5000&api-version=7.0");
  });

  it("returns parent/child edges from link queries", async () => {
    const edges = await queryLinks(
      "SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.WorkItemType] = 'Feature' AND [Source].[System.AreaPath] UNDER 'Fabrikam\\ART A\\Team Blue' AND [Source].[System.IterationPath] UNDER 'Fabrikam\\PIs\\PI 2') AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') AND ([Target].[System.WorkItemType] IN ('User Story')) MODE (Recursive)"
    );
    expect(edges).toEqual([
      { parent: null, child: 11 },
      { parent: 11, child: 105 },
      { parent: null, child: 14 },
      { parent: 14, child: 102 },
    ]);
  });

  it("batches work item reads in chunks of 200 and de-duplicates ids", async () => {
    for (let i = 1000; i < 1450; i++) fake.workItems.set(i, { id: i, fields: { "System.Title": `x${i}` } });
    const ids = Array.from({ length: 450 }, (_, i) => 1000 + i);
    const items = await getWorkItems([...ids, 1000, 1001], ["System.Title"]);
    expect(items).toHaveLength(450);
    const batches = callsTo(/workitemsbatch/);
    expect(batches.map((b) => b.body.ids.length)).toEqual([200, 200, 50]);
    expect(batches[0].body).toMatchObject({ fields: ["System.Title"], errorPolicy: "Omit" });
  });

  it("requests relations without a field list (the API rejects both together)", async () => {
    const [item] = await getWorkItems([10], ["System.Title"], true);
    expect(callsTo(/workitemsbatch/)[0].body).toEqual({ ids: [10], $expand: "Relations", errorPolicy: "Omit" });
    expect(item.relations?.length).toBeGreaterThan(0);
  });

  it("drops null entries returned for deleted items", async () => {
    (globalThis.fetch as any).mockImplementationOnce(async () => new Response(JSON.stringify({ value: [null, { id: 1, fields: {} }] })));
    expect(await getWorkItems([999, 1])).toEqual([{ id: 1, fields: {} }]);
  });

  it("preserves WIQL order and short-circuits empty results", async () => {
    fake.wiqlOverride = () => ({ workItems: [{ id: 11 }, { id: 10 }] });
    const items = await queryWorkItems("q", ["System.Title"]);
    expect(items.map((i) => i.id)).toEqual([11, 10]);

    fake.wiqlOverride = () => ({ workItems: [] });
    fake.calls = [];
    expect(await queryWorkItems("q", ["System.Title"])).toEqual([]);
    expect(callsTo(/workitemsbatch/)).toHaveLength(0);
  });

  it("orders unknown ids last-stable when the batch returns extra items", async () => {
    fake.wiqlOverride = () => ({ workItems: [{ id: 10 }] });
    (globalThis.fetch as any)
      .mockImplementationOnce(async () => new Response(JSON.stringify({ workItems: [{ id: 10 }] })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ value: [{ id: 99, fields: {} }, { id: 10, fields: {} }] })));
    const items = await queryWorkItems("q", []);
    expect(items.map((i) => i.id)).toEqual([99, 10]);
  });

  it("patches fields with json-patch", async () => {
    await setFields(10, { "System.State": "Closed", "System.IterationPath": PI2 });
    const call = callsTo(/workitems\/10/, "PATCH")[0];
    expect(call.headers["Content-Type"]).toBe("application/json-patch+json");
    expect(call.body).toEqual([
      { op: "add", path: "/fields/System.State", value: "Closed" },
      { op: "add", path: "/fields/System.IterationPath", value: PI2 },
    ]);
    expect(fake.workItems.get(10)!.fields["System.State"]).toBe("Closed");
  });

  it("adds links with and without a comment", async () => {
    await addLink(12, 14, "System.LinkTypes.Dependency-Forward", "why");
    await addLink(12, 15, "System.LinkTypes.Dependency-Forward");
    const [a, b] = callsTo(/workitems\/12/, "PATCH");
    expect(a.body[0].value).toEqual({
      rel: "System.LinkTypes.Dependency-Forward",
      url: "https://dev.azure.com/org/_apis/wit/workItems/14",
      attributes: { comment: "why" },
    });
    expect(b.body[0].value.attributes).toEqual({});
  });

  it("removes the matching link by index", async () => {
    await removeLink(10, 11, "System.LinkTypes.Dependency-Forward");
    const patch = callsTo(/workitems\/10/, "PATCH")[0];
    expect(patch.body).toEqual([{ op: "remove", path: "/relations/3" }]);
    expect(fake.workItems.get(10)!.relations!.some((r) => r.url.endsWith("/11"))).toBe(false);
  });

  it("does nothing when the link to remove is missing", async () => {
    await removeLink(10, 999, "System.LinkTypes.Dependency-Forward");
    await removeLink(3, 1, "System.LinkTypes.Dependency-Forward");
    expect(callsTo(/workitems/, "PATCH")).toHaveLength(0);
  });

  it("handles work items without relations when removing links", async () => {
    (globalThis.fetch as any).mockImplementationOnce(async () => new Response(JSON.stringify({ value: [] })));
    await removeLink(12345, 1, "x");
    expect(callsTo(/workitems/, "PATCH")).toHaveLength(0);
  });

  it("passes raw patch operations through", async () => {
    await updateWorkItem(10, [{ op: "test", path: "/rev", value: 1 }]);
    expect(callsTo(/workitems\/10/, "PATCH")[0].body).toEqual([{ op: "test", path: "/rev", value: 1 }]);
  });

  it("opens work item dialogs through the host service", async () => {
    await openWorkItem(10);
    await openNewWorkItem("Feature", { "System.AreaPath": RED });
    expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(10);
    expect(sdk.workItemForm.openNewWorkItem).toHaveBeenCalledWith("Feature", { "System.AreaPath": RED });
  });
});

describe("metadata", () => {
  it("lists enabled work item types only", async () => {
    const types = await getWorkItemTypes();
    expect(types.map((t) => t.name)).not.toContain("Shared Steps");
    expect(types).toHaveLength(5);
  });

  it("caches states per type and maps categories", async () => {
    const a = await getStates("Feature");
    fake.calls = [];
    const b = await getStates("Feature");
    expect(b).toBe(a);
    expect(callsTo(/states/)).toHaveLength(0);
    expect(await getStates("")).toEqual([]);

    const cat = await getStateCategories(["Feature", "", "Epic"]);
    expect(cat("Feature", "Closed")).toBe("Completed");
    expect(cat("Feature", "Removed")).toBe("Removed");
    expect(cat("Feature", "Unknown")).toBe("InProgress");
  });

  it("does not cache failed state lookups", async () => {
    fail(/workitemtypes\/Bug\/states/, 503, "Service unavailable", { once: true });
    await expect(getStates("Bug")).rejects.toThrow("Service unavailable");
    fake.states.Bug = [{ name: "Active", category: "InProgress", color: "x" }];
    expect((await getStates("Bug")).map((s) => s.name)).toEqual(["Active"]);
  });

  it("URL-encodes work item type names", async () => {
    await getStates("User Story");
    expect(fake.calls.at(-1)?.path).toBe("p1/_apis/wit/workitemtypes/User%20Story/states");
  });

  it("lists fields", async () => {
    expect((await getFieldNames()).map((f) => f.referenceName)).toContain("Microsoft.VSTS.Scheduling.StoryPoints");
  });
});

describe("classification nodes", () => {
  it("flattens area and iteration paths", async () => {
    expect(await getAreaPaths()).toEqual(["Fabrikam", ART_A, RED, BLUE, "Fabrikam\\ART B", "Fabrikam\\ART B\\Team Green"]);
    const iters = await getIterationPaths();
    expect(iters[0]).toBe("Fabrikam");
    expect(iters).toContain("Fabrikam\\PIs\\PI 2\\PI 2 IP");
    expect(fake.calls[0].url).toContain("Areas?$depth=10&api-version=7.0");
    expect((await getAreaTree()).name).toBe("Fabrikam");
  });

  it("reads PIs under the root, sorted by start date with sprints sorted", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    expect(pis.map((p) => p.name)).toEqual(["PI 1", "PI 2"]);
    expect(pis[1].sprints.map((s) => s.name)).toEqual(["PI 2 Sprint 1", "PI 2 Sprint 2", "PI 2 IP"]);
    expect(pis[1].path).toBe(PI2);
    expect(pis[1].start).toMatch(/T00:00:00Z$/);
  });

  it("matches the PI root case-insensitively and falls back to the project root", async () => {
    expect((await getProgramIncrements("fabrikam\\pis")).length).toBe(2);
    const fromRoot = await getProgramIncrements("Fabrikam\\Missing");
    expect(fromRoot.map((p) => p.name)).toEqual(["PIs", "Undated"]);
    // Undated nodes sort last and have no sprints.
    expect(fromRoot[1].sprints).toEqual([]);
  });

  it("creates iterations under nested parents and under the project root", async () => {
    const node = await createIteration("Fabrikam\\PIs", "PI 3", "2027-01-01T00:00:00Z", "2027-02-01T00:00:00Z");
    expect(node.name).toBe("PI 3");
    expect(callsTo(/classificationnodes/, "POST")[0].path).toBe("p1/_apis/wit/classificationnodes/Iterations/PIs");
    expect(callsTo(/classificationnodes/, "POST")[0].body).toEqual({
      name: "PI 3",
      attributes: { startDate: "2027-01-01T00:00:00Z", finishDate: "2027-02-01T00:00:00Z" },
    });

    await createIteration("Fabrikam", "Loose");
    const rootCall = callsTo(/classificationnodes/, "POST")[1];
    expect(rootCall.path).toBe("p1/_apis/wit/classificationnodes/Iterations");
    expect(rootCall.body.attributes).toBeUndefined();

    await createIteration("Fabrikam\\PIs\\PI 3", "PI 3 Sprint #1");
    expect(callsTo(/classificationnodes/, "POST")[2].path).toBe("p1/_apis/wit/classificationnodes/Iterations/PIs/PI%203");
  });
});

describe("teams", () => {
  it("lists teams sorted by name", async () => {
    expect((await getTeams()).map((t) => t.name)).toEqual(["ART A Team", "Fabrikam Team", "Team Blue", "Team Green", "Team Red"]);
  });

  it("returns the team's default area only when the team field is Area Path", async () => {
    expect(await getTeamDefaultArea("t-red")).toBe(RED);
    fake.teamFieldRef = "Custom.Team";
    expect(await getTeamDefaultArea("t-red")).toBeUndefined();
  });

  it("subscribes a team to an iteration", async () => {
    await addTeamIteration("t-red", "it-1");
    expect(fake.teamIterations["t-red"]).toEqual(["it-1"]);
    expect(callsTo(/teamsettings\/iterations/, "POST")[0].body).toEqual({ id: "it-1" });
  });

  it("surfaces REST errors", async () => {
    fail(/teams/, 401, "Unauthorized");
    await expect(getTeams()).rejects.toThrow("Unauthorized");
  });
});
