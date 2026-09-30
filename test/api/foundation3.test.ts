import { describe, expect, it } from "vitest";
import { metaStore, objectivesStore, risksStore } from "../../src/api/data";
import { DEFAULT_DEPENDENCY_LINK, dependenciesOf, dependencyLinkTypes } from "../../src/api/dependencies";
import { hubUrl, queryUrl, teamBacklogUrl, teamBoardUrl, workItemUrl } from "../../src/api/links";
import { getRelationTypes, getRevisions, getTeamMembers, setFields } from "../../src/api/wit";
import { callsTo, dataStore, fake, seedDocs } from "../fakeAdo";

describe("shared helpers for the parity work", () => {
  it("reads single documents without loading the collection", async () => {
    expect(await metaStore.get("10")).toBeUndefined();
    await metaStore.save({ id: "10", workItemId: 10, assignedNodeIds: [], assignedPiPaths: [] });
    expect((await metaStore.get("10"))?.workItemId).toBe(10);
    seedDocs("objectives", [{ id: "o1", nodeId: "n", piPath: "x", title: "t", committed: true, plannedBV: 1, actualBV: null, featureIds: [] }]);
    expect((await objectivesStore.get("o1"))?.title).toBe("t");
    expect(await risksStore.get("nope")).toBeUndefined();
    dataStore.failures.push({ op: "getDocument", error: Object.assign(new Error("denied"), { status: 403 }) });
    await expect(metaStore.get("10")).rejects.toThrow("denied");
  });

  it("lists team members and link types", async () => {
    expect((await getTeamMembers("t-red")).map((m) => m.displayName)).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(await getTeamMembers("t-green")).toEqual([]);
    const types = await getRelationTypes();
    expect(types.map((t) => t.referenceName)).toContain("Custom.Blocks-Forward");
  });

  it("reads revision history, including changes made through the API", async () => {
    await setFields(101, { "System.State": "Closed" });
    const revs = await getRevisions(["User Story"], ["System.State", "System.ChangedDate"]);
    const of101 = revs.filter((r) => r.id === 101);
    expect(of101.map((r) => r.fields["System.State"])).toEqual(["Active", "Closed"]);
    expect(Object.keys(of101[0].fields).sort()).toEqual(["System.ChangedDate", "System.State"]);
    expect(revs.some((r) => r.id === 1)).toBe(false);
  });

  it("pages through revision continuation tokens", async () => {
    (globalThis.fetch as any)
      .mockImplementationOnce(async () => new Response(JSON.stringify({ values: [{ id: 1, rev: 1, fields: {} }], isLastBatch: false, continuationToken: "t1" })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ values: [{ id: 2, rev: 1, fields: {} }], isLastBatch: true })));
    const revs = await getRevisions(["Epic", ""], ["System.State"], "2026-01-01T00:00:00Z");
    expect(revs.map((r) => r.id)).toEqual([1, 2]);
    const calls = (globalThis.fetch as any).mock.calls.slice(-2).map((c: any[]) => String(c[0]));
    expect(calls[0]).toContain("startDateTime=2026-01-01T00%3A00%3A00Z");
    expect(calls[1]).toContain("continuationToken=t1");
  });

  it("builds Azure DevOps URLs", async () => {
    expect(await workItemUrl(10)).toBe("https://dev.azure.com/org/Fabrikam/_workitems/edit/10");
    expect(await teamBacklogUrl("Team Red")).toBe("https://dev.azure.com/org/Fabrikam/_backlogs/backlog/Team%20Red");
    expect(await teamBoardUrl("Team Red")).toBe("https://dev.azure.com/org/Fabrikam/_boards/board/t/Team%20Red");
    expect(await queryUrl("SELECT [System.Id] FROM WorkItems")).toContain("/_queries/query/?wiql=SELECT%20");
    expect(await hubUrl("node=n-red")).toBe("https://dev.azure.com/org/Fabrikam/_apps/hub/ScaleLane.scalelane.safe-hub#node=n-red");
    expect(await hubUrl("")).not.toContain("#");
  });

  it("uses the configured dependency link type", () => {
    expect(dependencyLinkTypes()).toBe(DEFAULT_DEPENDENCY_LINK);
    const custom = { forward: "Custom.Blocks-Forward", reverse: "Custom.Blocks-Reverse" };
    expect(dependencyLinkTypes({ dependencyLink: custom })).toBe(custom);
    const url = (id: number) => `${fake.baseUrl}/_apis/wit/workItems/${id}`;
    const items = [
      { id: 1, fields: {}, relations: [{ rel: "Custom.Blocks-Forward", url: url(2) }, { rel: "System.LinkTypes.Dependency-Forward", url: url(3) }] },
    ];
    expect(dependenciesOf(items, custom)).toEqual([{ provider: 1, consumer: 2 }]);
    expect(dependenciesOf(items)).toEqual([{ provider: 1, consumer: 3 }]);
    expect(callsTo(/./)).toHaveLength(0);
  });
});

import { applyFilter, EMPTY_FILTER, filterToWiql, isFilterActive, iterationOf, priorityOf, withWiqlFilter } from "../../src/api/filters";

describe("extended filters", () => {
  const items = [
    { id: 1, fields: { "System.Title": "A", "System.WorkItemType": "Feature", "System.State": "New", "Microsoft.VSTS.Common.Priority": 1, "System.IterationPath": "P\\PI 2\\S1" } },
    { id: 2, fields: { "System.Title": "B", "System.WorkItemType": "Feature", "System.State": "Active", "System.IterationPath": "P\\PI 2\\S2" } },
  ];
  const extra = [{ key: "team", label: "Team", options: ["Red"], values: (i: any) => (i.id === 1 ? ["Red"] : []) }];

  it("matches priority, iteration, extra facets and quick filters (AND)", () => {
    expect(priorityOf(items[1] as any)).toBe("None");
    expect(iterationOf(items[0] as any)).toBe("S1");
    expect(iterationOf({ id: 3, fields: {} } as any)).toBe("");
    expect(applyFilter(items as any, { ...EMPTY_FILTER, priorities: ["1"] }).map((i) => i.id)).toEqual([1]);
    expect(applyFilter(items as any, { ...EMPTY_FILTER, iterations: ["S2"] }).map((i) => i.id)).toEqual([2]);
    expect(applyFilter(items as any, { ...EMPTY_FILTER, extra: { team: ["Red"] } }, extra).map((i) => i.id)).toEqual([1]);
    const quick = [{ id: "q", name: "New", filter: { ...EMPTY_FILTER, states: ["New"] } }];
    expect(applyFilter(items as any, { ...EMPTY_FILTER, quick }).map((i) => i.id)).toEqual([1]);
    expect(applyFilter(items as any, { ...EMPTY_FILTER, states: ["Active"], quick }).map((i) => i.id)).toEqual([]);
  });

  it("treats every new facet as an active filter", () => {
    expect(isFilterActive({ ...EMPTY_FILTER, priorities: ["1"] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, iterations: ["S1"] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, extra: { team: [] } })).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, extra: { team: ["Red"] } })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, quick: [{ id: "q", name: "x", filter: EMPTY_FILTER }] })).toBe(true);
  });

  it("combines WIQL clauses of quick filters and renders them for Copy WIQL", () => {
    const quick = [{ id: "q", name: "MVP", filter: { ...EMPTY_FILTER, wiql: "[System.Tags] CONTAINS 'MVP'" } }];
    const f = { ...EMPTY_FILTER, wiql: "[System.State] = 'New'", quick, priorities: ["1", "None"], iterations: ["S1"] };
    expect(withWiqlFilter("SELECT x WHERE a ORDER BY b", f)).toBe("SELECT x WHERE a AND ([System.State] = 'New') AND ([System.Tags] CONTAINS 'MVP') ORDER BY b");
    expect(filterToWiql(f)).toBe(
      "[Microsoft.VSTS.Common.Priority] IN (1) AND ([System.State] = 'New') AND ([System.Tags] CONTAINS 'MVP')"
    );
  });
});
