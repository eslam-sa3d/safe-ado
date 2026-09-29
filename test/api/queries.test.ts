import { describe, expect, it } from "vitest";
import { baseFields, loadTree, scopeQuery, TreeNode, typeChain } from "../../src/api/queries";
import { ART_A, BLUE, callsTo, fake, makeConfig, P, PI2, RED } from "../fakeAdo";

const config = makeConfig();

const summary = (n: TreeNode): any => ({
  id: n.item.id,
  cat: n.category,
  pts: `${n.donePoints}/${n.points}`,
  cnt: `${n.doneCount}/${n.count}`,
  kids: n.children.map(summary),
});

describe("scopeQuery", () => {
  it("builds a project-scoped flat query", () => {
    expect(scopeQuery(["Feature"], [RED, BLUE], PI2)).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('Feature') AND ([System.AreaPath] UNDER 'Fabrikam\\ART A\\Team Red' OR [System.AreaPath] UNDER 'Fabrikam\\ART A\\Team Blue') AND [System.IterationPath] UNDER 'Fabrikam\\PIs\\PI 2' ORDER BY [Microsoft.VSTS.Common.StackRank] ASC, [System.Id] ASC"
    );
    expect(scopeQuery(["Epic"], [P], undefined, "System.Title")).not.toContain("IterationPath");
    expect(scopeQuery(["Epic"], [P], undefined, "System.Title")).toContain("ORDER BY [System.Title]");
  });

  it("lists base fields including the configured size field", () => {
    expect(baseFields(config)).toContain("Microsoft.VSTS.Scheduling.StoryPoints");
    expect(baseFields({ ...config, storyPointsField: "Custom.Size" })).toContain("Custom.Size");
  });
});

describe("typeChain", () => {
  it("skips missing levels and duplicates", () => {
    expect(typeChain(config)).toEqual(["Epic", "Feature", "User Story"]);
    expect(typeChain({ ...config, types: { epic: "Epic", capability: "Capability", feature: "Feature", story: "Feature" } })).toEqual([
      "Epic",
      "Capability",
      "Feature",
    ]);
  });
});

describe("loadTree", () => {
  it("builds Feature → Story trees with point roll-ups, ignoring Removed items", async () => {
    const roots = await loadTree(config, "Feature", [ART_A], PI2);
    expect(roots.map(summary)).toEqual([
      {
        id: 10,
        cat: "InProgress",
        pts: "5/8",
        cnt: "1/2",
        kids: [
          { id: 100, cat: "Completed", pts: "5/5", cnt: "1/1", kids: [] },
          { id: 101, cat: "InProgress", pts: "0/3", cnt: "0/1", kids: [] },
        ],
      },
      { id: 11, cat: "Proposed", pts: "0/0", cnt: "1/1", kids: [{ id: 105, cat: "Completed", pts: "0/0", cnt: "1/1", kids: [] }] },
      { id: 12, cat: "Proposed", pts: "0/0", cnt: "0/1", kids: [] },
      { id: 14, cat: "Proposed", pts: "0/8", cnt: "0/1", kids: [{ id: 102, cat: "Proposed", pts: "0/8", cnt: "0/1", kids: [] }] },
    ]);
    const wiql = callsTo(/wiql/)[0].body.query as string;
    expect(wiql).toContain("FROM WorkItemLinks");
    expect(wiql).toContain("MODE (Recursive)");
    expect(wiql).toContain("[Target].[System.WorkItemType] IN ('User Story')");
    expect(wiql).toContain("[Source].[System.IterationPath] UNDER 'Fabrikam\\PIs\\PI 2'");
  });

  it("rolls up through multiple levels from Epics without a PI filter", async () => {
    const roots = await loadTree(config, "Epic", [P]);
    const epic1 = roots.find((r) => r.item.id === 1)!;
    expect(summary(epic1).pts).toBe("5/16");
    expect(epic1.children.map((c) => c.item.id)).toEqual([10, 11, 14, 12]);
    expect(roots.map((r) => r.item.id)).toEqual([1, 2, 3]); // Removed epic 4 dropped
    expect(callsTo(/wiql/)[0].body.query).not.toContain("IterationPath");
  });

  it("uses a flat query when the root type is the lowest level", async () => {
    const roots = await loadTree(config, "User Story", [RED], PI2);
    expect(roots.map((r) => r.item.id)).toEqual([100, 101]);
    expect(callsTo(/wiql/)[0].body.query).toContain("FROM WorkItems");
  });

  it("returns [] without fetching items when nothing matches", async () => {
    expect(await loadTree(config, "Feature", ["Fabrikam\\Nowhere"])).toEqual([]);
    expect(callsTo(/workitemsbatch/)).toHaveLength(0);
  });

  it("de-duplicates repeated edges and ignores edges to unknown parents", async () => {
    fake.wiqlOverride = () => ({
      workItemRelations: [
        { source: null, target: { id: 10 }, rel: null },
        { source: { id: 10 }, target: { id: 100 }, rel: "x" },
        { source: { id: 10 }, target: { id: 100 }, rel: "x" },
        { source: { id: 777 }, target: { id: 101 }, rel: "x" },
        { source: null, target: { id: 888 }, rel: null },
      ],
    });
    const roots = await loadTree(config, "Feature", [P]);
    expect(roots.map(summary)).toEqual([{ id: 10, cat: "InProgress", pts: "5/5", cnt: "1/1", kids: [{ id: 100, cat: "Completed", pts: "5/5", cnt: "1/1", kids: [] }] }]);
  });

  it("treats missing or non-numeric points as zero", async () => {
    fake.workItems.get(100)!.fields["Microsoft.VSTS.Scheduling.StoryPoints"] = "abc";
    const [feature] = await loadTree(config, "Feature", [RED], PI2);
    expect(feature.points).toBe(3);
  });
});
