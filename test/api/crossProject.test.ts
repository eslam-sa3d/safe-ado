import { describe, expect, it } from "vitest";
import { canPlanIn } from "../../src/api/permissions";
import { crossProjectKey, foreignNodes, matchIteration, mirrorPairs, NO_CROSS_PROJECT, prepareCrossProject } from "../../src/api/crossProject";
import { effectivePiRoot, foreignPiRoot } from "../../src/api/org";
import {
  crossProjectActive,
  CrossProjectError,
  expandIteration,
  foreignProjectOf,
  getMirrors,
  getProjects,
  isForeignNode,
  nodeProject,
  PROJECT_ITERATION,
  projectClause,
  projectOfPath,
  resetCrossProject,
  scopeProjects,
  toCadencePath,
  toProjectPath,
} from "../../src/api/projects";
import { loadTree, scopeQuery } from "../../src/api/queries";
import { indexTree, reconcileConfig } from "../../src/api/reconcile";
import { SafeConfig } from "../../src/api/types";
import {
  createWorkItem,
  getAreaTree,
  getIterationTree,
  getProgramIncrements,
  getRevisions,
  getTeamDefaultArea,
  getTeamMembers,
  getTeams,
  getWorkItems,
  openNewWorkItem,
  queryWorkItems,
  setFields,
} from "../../src/api/wit";
import {
  ART_A,
  ART_C,
  C_PI2,
  C_PI2_S1,
  C_PI2_S2,
  C_ROOT,
  callsTo,
  fake,
  makeConfig,
  makeCrossConfig,
  ORANGE,
  PI1,
  PI2,
  PI2_IP,
  PI2_S1,
  PI2_S2,
  RED,
  seedCrossProject,
} from "../fakeAdo";
import * as sdk from "../sdkMock";

const HOST_ROOT = "Fabrikam\\PIs";

async function crossSetup(config: SafeConfig = makeCrossConfig()) {
  seedCrossProject();
  const status = await prepareCrossProject(config);
  return { config, status };
}

describe("project helpers", () => {
  it("derives projects from paths and tells host from foreign units", () => {
    expect(projectOfPath("Contoso\\ART C")).toBe("Contoso");
    expect(projectOfPath(undefined)).toBe("");
    expect(scopeProjects([RED, ORANGE, "fabrikam\\x", ART_C, ""])).toEqual(["Fabrikam", "Contoso"]);
    expect(isForeignNode({})).toBe(false);
    expect(isForeignNode({ projectId: fake.projectId })).toBe(false);
    expect(isForeignNode({ projectId: "p2" })).toBe(true);
    expect(nodeProject({})).toEqual({ id: "p1", name: "Fabrikam" });
    expect(nodeProject({ projectId: "p2", projectName: "Contoso" })).toEqual({ id: "p2", name: "Contoso" });
    expect(nodeProject({ projectId: "p2" })).toEqual({ id: "p2", name: "p2" });
  });

  it("lists the collection's projects sorted by name", async () => {
    expect(await getProjects()).toEqual([{ id: "p1", name: "Fabrikam" }]);
    seedCrossProject();
    expect(await getProjects()).toEqual([
      { id: "p2", name: "Contoso" },
      { id: "p1", name: "Fabrikam" },
    ]);
    expect(callsTo(/^_apis\/projects$/)[0].url).toContain("api-version=7.0");
  });

  it("keeps @project for single-project configurations, even with odd paths", () => {
    expect(crossProjectActive()).toBe(false);
    expect(projectClause([ORANGE, RED])).toBe("[System.TeamProject] = @project");
    expect(foreignProjectOf(ORANGE)).toBeUndefined();
  });
});

describe("PI roots across projects", () => {
  it("keeps the cadence in the host project and finds each unit's root in its own project", () => {
    const config = makeCrossConfig();
    expect(effectivePiRoot(config, "n-orange")).toBe(HOST_ROOT);
    expect(effectivePiRoot(config, "n-artc")).toBe(HOST_ROOT);
    expect(foreignPiRoot(config, "n-artc")).toBe(C_ROOT);
    // The team inherits its ART's root in the same project.
    expect(foreignPiRoot(config, "n-orange")).toBe(C_ROOT);
    // Without any root in the project: the cadence's path in that project.
    delete config.root.children[2].piRootIteration;
    expect(foreignPiRoot(config, "n-orange")).toBe("Contoso\\PIs");
    config.piRootIteration = "Fabrikam";
    expect(foreignPiRoot(config, "n-orange")).toBe("Contoso");
  });

  it("uses a host ancestor's own cadence as the cadence of foreign units below it", () => {
    const config = makeCrossConfig();
    config.root.children[2].piRootIteration = undefined;
    config.root.piRootIteration = "Fabrikam\\Train";
    expect(effectivePiRoot(config, "n-orange")).toBe("Fabrikam\\Train");
    expect(foreignPiRoot(config, "n-orange")).toBe("Contoso\\Train");
  });

  it("matches iterations by name, else by identical dates", () => {
    const a = { name: "PI 2", path: "a", identifier: "a", start: "2026-01-01T00:00:00Z", finish: "2026-02-01T00:00:00Z" };
    expect(matchIteration(a, [{ ...a, name: "pi 2", path: "x" }])?.path).toBe("x");
    expect(matchIteration(a, [{ ...a, name: "Other", path: "y" }])?.path).toBe("y");
    expect(matchIteration(a, [{ ...a, name: "Other", path: "z", finish: "2026-03-01" }])).toBeUndefined();
    expect(matchIteration({ ...a, start: undefined }, [{ ...a, name: "Other" }])).toBeUndefined();
  });

  it("pairs root, PIs and sprints and lists what has no match", async () => {
    seedCrossProject();
    const [cadence, foreign] = await Promise.all([getProgramIncrements(HOST_ROOT), getProgramIncrements(C_ROOT)]);
    const { pairs, unmatched } = mirrorPairs(HOST_ROOT, cadence, C_ROOT, foreign);
    expect(pairs).toEqual([
      { host: HOST_ROOT, foreign: C_ROOT },
      { host: PI2, foreign: C_PI2 },
      { host: PI2_S1, foreign: C_PI2_S1 },
      { host: PI2_S2, foreign: C_PI2_S2 },
    ]);
    expect(unmatched).toEqual(["PI 1", "PI 2 IP"]);
  });
});

describe("prepareCrossProject", () => {
  it("does nothing (and clears old state) for configurations without other projects", async () => {
    await crossSetup();
    expect(crossProjectActive()).toBe(true);
    expect(await prepareCrossProject(makeConfig())).toBe(NO_CROSS_PROJECT);
    expect(crossProjectActive()).toBe(false);
    expect(getMirrors()).toEqual([]);
    expect(crossProjectKey(makeConfig())).toBe("");
    expect(foreignNodes(makeConfig())).toEqual([]);
  });

  it("installs the mirrors and reports unmatched iterations", async () => {
    const { config, status } = await crossSetup();
    expect(foreignNodes(config).map((n) => n.id)).toEqual(["n-artc", "n-orange"]);
    expect(crossProjectKey(config)).toContain("n-orange");
    expect(status.projects).toEqual(["Contoso"]);
    expect(status.notes).toEqual([
      'Project Contoso has no iteration matching PI 1, PI 2 IP under "Contoso\\Cadence" (matched by name, else by dates); items there don\'t show in those PIs or sprints.',
    ]);
    expect(getMirrors()).toHaveLength(1);
    expect(getMirrors()[0]).toMatchObject({ project: "Contoso", foreignRoot: C_ROOT, cadenceRoot: HOST_ROOT, areas: [ART_C, ORANGE] });
  });

  it("shortens long lists of unmatched iterations", async () => {
    seedCrossProject();
    const many = Array.from({ length: 7 }, (_, i) => ({ name: `PI ${i + 10}`, path: `x${i}`, identifier: `x${i}`, sprints: [] }));
    const { unmatched } = mirrorPairs(HOST_ROOT, many, C_ROOT, []);
    expect(unmatched).toHaveLength(7);
    fake.iterationTree.children![0].children!.push(
      ...Array.from({ length: 6 }, (_, i) => ({ id: 9000 + i, identifier: `extra-${i}`, name: `PI ${i + 10}`, path: `\\Fabrikam\\Iteration\\PIs\\PI ${i + 10}` }))
    );
    const status = await prepareCrossProject(makeCrossConfig());
    expect(status.notes[0]).toContain("and 3 more");
  });

  it("notes a missing PI root and still spans the projects", async () => {
    const config = makeCrossConfig();
    config.root.children[2].piRootIteration = "Contoso\\Nope";
    const { status } = await crossSetup(config);
    expect(status.notes[0]).toBe(
      'ART C, Team Orange (project Contoso): the PI root "Contoso\\Nope" was not found, so their items are left out of PI views. Set the unit\'s PI root in Setup.'
    );
    expect(crossProjectActive()).toBe(true);
    expect(getMirrors()[0].pairs).toEqual([]);
    expect(projectClause([ART_A, ART_C])).toBe("[System.TeamProject] IN ('Fabrikam', 'Contoso')");
  });

  it("notes a missing cadence root", async () => {
    const config = makeCrossConfig({ piRootIteration: "Fabrikam\\Gone" });
    const { status } = await crossSetup(config);
    expect(status.notes[0]).toContain('the PI root "Fabrikam\\Gone" was not found');
  });

  it("groups units by project, foreign root and cadence", async () => {
    const config = makeCrossConfig();
    config.detached = [{ id: "n-det", name: "Detached", level: "team", areaPath: ORANGE, projectId: "p2", projectName: "Contoso", piRootIteration: "Contoso\\Other", children: [] }];
    await crossSetup(config);
    expect(getMirrors().map((m) => m.foreignRoot)).toEqual([C_ROOT, "Contoso\\Other"]);
  });
});

describe("iteration mapping", () => {
  it("maps foreign paths onto the cadence and back", async () => {
    await crossSetup();
    expect(toCadencePath(C_PI2_S1)).toBe(PI2_S1);
    expect(toCadencePath("contoso\\cadence\\pi 2")).toBe(PI2);
    // Below a matched PI but not itself matched: the PI (its backlog).
    expect(toCadencePath(`${C_PI2}\\Hardening`)).toBe(PI2);
    expect(toCadencePath("Contoso\\Elsewhere")).toBe("Contoso\\Elsewhere");
    expect(toCadencePath(PI2_S1)).toBe(PI2_S1);
    expect(toCadencePath("")).toBe("");
    expect(expandIteration(PI2)).toEqual([PI2, C_PI2]);
    expect(expandIteration(PI1)).toEqual([PI1]);
    expect(toProjectPath(PI2_S2, "Contoso", ORANGE)).toBe(C_PI2_S2);
    expect(toProjectPath(HOST_ROOT, "Contoso")).toBe(C_ROOT);
    expect(toProjectPath(PI2_S2, "Fabrikam")).toBe(PI2_S2);
    expect(toProjectPath(C_PI2, "Contoso")).toBe(C_PI2);
    expect(() => toProjectPath(PI2_IP, "Contoso", ORANGE)).toThrow(CrossProjectError);
    expect(() => toProjectPath(PI2_IP, "Contoso", ORANGE)).toThrow(
      'Project "Contoso" has no iteration matching "Fabrikam\\PIs\\PI 2\\PI 2 IP". Create it under "Contoso\\Cadence" with the same name or dates, or set the unit\'s PI root in Setup.'
    );
    expect(() => toProjectPath(PI2, "Elsewhere")).toThrow('Create it under "Elsewhere\\…"');
    resetCrossProject();
    expect(toCadencePath(C_PI2_S1)).toBe(C_PI2_S1);
    expect(expandIteration(PI2)).toEqual([PI2]);
  });

  it("prefers the mirror of the unit that owns the item's area", async () => {
    const config = makeCrossConfig();
    config.root.children[2].children.push({ id: "n-lime", name: "Team Lime", level: "team", areaPath: "Contoso\\Lime", projectId: "p2", projectName: "Contoso", piRootIteration: "Contoso\\Lime PIs", children: [] });
    seedCrossProject();
    await prepareCrossProject(config);
    // "Contoso\\Lime PIs" does not exist: the Lime mirror has no pairs, so writes fall back to the other mirror.
    expect(toProjectPath(PI2_S1, "Contoso", "Contoso\\Lime")).toBe(C_PI2_S1);
  });
});

describe("cross-project queries", () => {
  it("widens the project clause and the PI clause, and runs at collection level", async () => {
    await crossSetup();
    const q = scopeQuery(["Feature"], [ART_A, ART_C], PI2);
    expect(q).toContain("WHERE [System.TeamProject] IN ('Fabrikam', 'Contoso')");
    expect(q).toContain(`([System.IterationPath] UNDER 'Fabrikam\\PIs\\PI 2' OR [System.IterationPath] UNDER 'Contoso\\Cadence\\PI 2')`);
    const items = await queryWorkItems(q, ["System.Id", "System.Title", "System.AreaPath", "System.IterationPath"]);
    expect(items.map((i) => i.id)).toEqual([10, 11, 12, 13, 14, 300]);
    expect(callsTo(/wiql/).map((c) => c.path)).toEqual(["_apis/wit/wiql"]);
    expect(callsTo(/workitemsbatch/).map((c) => c.path)).toEqual(["_apis/wit/workitemsbatch"]);
    const partner = items.find((i) => i.id === 300)!;
    expect(partner.fields["System.IterationPath"]).toBe(PI2_S1);
    expect(partner.fields[PROJECT_ITERATION]).toBe(C_PI2_S1);
  });

  it("keeps a subtree inside the host project on @project and the project route", async () => {
    await crossSetup();
    const q = scopeQuery(["Feature"], [ART_A], PI1);
    expect(q).toContain("[System.TeamProject] = @project");
    await queryWorkItems(q, ["System.Id"]);
    expect(callsTo(/wiql/).map((c) => c.path)).toEqual(["p1/_apis/wit/wiql"]);
  });

  it("rejects @project at collection level like Azure DevOps", async () => {
    await expect(queryWorkItems("SELECT [System.Id] FROM WorkItems WHERE [System.Id] > 0 AND [System.TeamProject] = @project", [])).resolves.toBeTruthy();
    fake.calls = [];
    const { api } = await import("../../src/api/client");
    await expect(
      api("_apis/wit/wiql", { method: "POST", body: { query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project" } })
    ).rejects.toThrow(/TF51011/);
  });

  it("loads a hierarchy across projects (host Epic → Contoso Feature → stories)", async () => {
    await crossSetup();
    const config = makeCrossConfig();
    const roots = await loadTree(config, "Epic", ["Fabrikam", ART_C]);
    const epic = roots.find((r) => r.item.id === 1)!;
    const partner = epic.children.find((c) => c.item.id === 300)!;
    expect(partner.children.map((c) => c.item.id)).toEqual([301, 302]);
    expect(partner.points).toBe(8);
    expect(callsTo(/wiql/)[0].body.query).toContain("[Source].[System.TeamProject] IN ('Fabrikam', 'Contoso')");
    const storiesInPi = await loadTree(config, "Feature", [ART_C], PI2);
    expect(storiesInPi.map((r) => r.item.id)).toEqual([300]);
    expect(callsTo(/wiql/)[1].body.query).toContain("[Source].[System.IterationPath] UNDER 'Contoso\\Cadence\\PI 2'");
  });

  it("reads revisions of every project and maps their iterations", async () => {
    await crossSetup();
    const revs = await getRevisions(["User Story"], ["System.IterationPath", "System.AreaPath"]);
    expect(callsTo(/workitemrevisions/)[0].path).toBe("_apis/wit/reporting/workitemrevisions");
    expect(revs.find((r) => r.id === 301)!.fields["System.IterationPath"]).toBe(PI2_S1);
  });

  it("reads trees, teams and members of another project", async () => {
    seedCrossProject();
    expect((await getAreaTree("p2")).name).toBe("Contoso");
    expect((await getIterationTree("Contoso")).children![0].name).toBe("Cadence");
    expect((await getProgramIncrements(C_ROOT)).map((p) => p.path)).toEqual([C_PI2]);
    expect(await getTeams("p2")).toEqual([{ id: "t-orange", name: "Team Orange" }]);
    expect(await getTeamDefaultArea("t-orange", "p2")).toBe(ORANGE);
    expect((await getTeamMembers("t-orange", "p2")).map((m) => m.displayName)).toEqual(["Linus Torvalds"]);
    expect(callsTo(/^_apis\/projects\/.*teams/).map((c) => c.path)).toEqual(["_apis/projects/p2/teams", "_apis/projects/p2/teams/t-orange/members"]);
  });
});

describe("cross-project writes", () => {
  it("re-plans a foreign item with its own project's iteration", async () => {
    await crossSetup();
    await getWorkItems([300], ["System.Id", "System.AreaPath", "System.IterationPath"]);
    const updated = await setFields(300, { "System.IterationPath": PI2_S2 });
    expect(callsTo(/workitems\/300/, "PATCH")[0].body).toEqual([{ op: "add", path: "/fields/System.IterationPath", value: C_PI2_S2 }]);
    expect(fake.workItems.get(300)!.fields["System.IterationPath"]).toBe(C_PI2_S2);
    // The response is mapped back onto the cadence.
    expect(updated.fields["System.IterationPath"]).toBe(PI2_S2);
  });

  it("looks up an item's project before mapping a write to an item it hasn't read", async () => {
    await crossSetup();
    await setFields(302, { "System.IterationPath": PI2_S1 });
    expect(callsTo(/workitemsbatch/)[0].body).toMatchObject({ ids: [302], fields: ["System.Id", "System.AreaPath", "System.TeamProject"] });
    expect(fake.workItems.get(302)!.fields["System.IterationPath"]).toBe(C_PI2_S1);
    // Host items keep host paths; a state change needs no lookup.
    await setFields(10, { "System.IterationPath": PI2_S2 });
    await setFields(303, { "System.State": "Active" });
    expect(fake.workItems.get(10)!.fields["System.IterationPath"]).toBe(PI2_S2);
    expect(callsTo(/workitemsbatch/)).toHaveLength(2);
  });

  it("refuses iterations without a match and moves between projects", async () => {
    await crossSetup();
    await getWorkItems([300, 10], ["System.Id", "System.AreaPath", "System.IterationPath"]);
    await expect(setFields(300, { "System.IterationPath": PI2_IP })).rejects.toThrow(CrossProjectError);
    await expect(setFields(300, { "System.AreaPath": RED })).rejects.toThrow(
      '#300 belongs to project "Contoso" and can\'t be moved to "Fabrikam" here. Use "Move to team project" in Azure Boards.'
    );
    await expect(setFields(10, { "System.AreaPath": ORANGE })).rejects.toThrow(CrossProjectError);
    // Within the project the area may change, and later writes use the new area.
    await setFields(300, { "System.AreaPath": ART_C, "System.IterationPath": PI2_S1 });
    expect(fake.workItems.get(300)!.fields).toMatchObject({ "System.AreaPath": ART_C, "System.IterationPath": C_PI2_S1 });
    expect(callsTo(/workitems\//, "PATCH")).toHaveLength(1);
  });

  it("the fake rejects paths of the wrong project (TF401347), as Azure DevOps does", async () => {
    seedCrossProject();
    await expect(setFields(300, { "System.IterationPath": PI2_S1 })).rejects.toThrow(/TF401347/);
    await expect(setFields(300, { "System.IterationPath": "Contoso\\Missing" })).rejects.toThrow(/TF401347/);
  });

  it("creates items in the area's project with its iteration", async () => {
    await crossSetup();
    const created = await createWorkItem("User Story", { "System.Title": "New", "System.AreaPath": ORANGE, "System.IterationPath": PI2_S1 });
    const post = callsTo(/workitems\/\$/, "POST")[0];
    expect(post.path).toBe("Contoso/_apis/wit/workitems/$User%20Story");
    expect(post.body).toContainEqual({ op: "add", path: "/fields/System.IterationPath", value: C_PI2_S1 });
    expect(fake.workItems.get(created.id)!.fields["System.TeamProject"]).toBe("Contoso");
    expect(created.fields["System.IterationPath"]).toBe(PI2_S1);
    // Host areas stay in the host project.
    await createWorkItem("User Story", { "System.Title": "Host", "System.AreaPath": RED, "System.IterationPath": PI2_S1 });
    expect(callsTo(/workitems\/\$/, "POST")[1].path).toBe("p1/_apis/wit/workitems/$User%20Story");
    await expect(createWorkItem("User Story", { "System.AreaPath": ORANGE, "System.IterationPath": PI2_IP })).rejects.toThrow(CrossProjectError);
  });

  it("opens the other project's new-item page for a foreign area", async () => {
    await crossSetup();
    await openNewWorkItem("Feature", { "System.AreaPath": ORANGE, "System.IterationPath": PI2 });
    expect(sdk.workItemForm.openNewWorkItem).not.toHaveBeenCalled();
    expect(sdk.hostNavigation.openNewWindow).toHaveBeenLastCalledWith(
      "https://dev.azure.com/org/Contoso/_workitems/create/Feature?%5BSystem.AreaPath%5D=Contoso%5CART%20C%5CTeam%20Orange&%5BSystem.IterationPath%5D=Contoso%5CCadence%5CPI%202",
      ""
    );
    await openNewWorkItem("Feature", { "System.AreaPath": RED });
    expect(sdk.workItemForm.openNewWorkItem).toHaveBeenCalledWith("Feature", { "System.AreaPath": RED });
  });

  it("checks planning permissions in the area's own project", async () => {
    await crossSetup();
    expect(await canPlanIn(ORANGE, "User Story")).toBe(true);
    expect(callsTo(/validateOnly|workitems\/\$/, "POST")[0].path).toBe("Contoso/_apis/wit/workitems/$User%20Story");
  });
});

describe("old configurations (no projectId)", () => {
  it("query, read and write exactly as before", async () => {
    const config = makeConfig();
    expect(await prepareCrossProject(config)).toBe(NO_CROSS_PROJECT);
    const q = scopeQuery(["Feature"], [ART_A], PI2);
    expect(q).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('Feature') AND ([System.AreaPath] UNDER 'Fabrikam\\ART A') AND [System.IterationPath] UNDER 'Fabrikam\\PIs\\PI 2' ORDER BY [Microsoft.VSTS.Common.StackRank] ASC, [System.Id] ASC"
    );
    const items = await queryWorkItems(q, ["System.Id", "System.IterationPath"]);
    expect(items.every((i) => !(PROJECT_ITERATION in i.fields))).toBe(true);
    expect(callsTo(/wiql/)[0].path).toBe("p1/_apis/wit/wiql");
    await setFields(10, { "System.IterationPath": PI2_S2 });
    expect(callsTo(/workitemsbatch/)).toHaveLength(1);
    expect(effectivePiRoot(config, "n-red")).toBe(HOST_ROOT);
  });

  it("reconcile leaves units of other projects untouched", async () => {
    const config = makeCrossConfig();
    const areas = indexTree(await getAreaTree());
    const iterations = indexTree(await getIterationTree());
    const fixed = reconcileConfig(config, areas, iterations);
    const artc = fixed!.root.children.find((c) => c.id === "n-artc")!;
    expect(artc).toMatchObject({ areaPath: ART_C, piRootIteration: C_ROOT });
    expect(artc.areaId).toBeUndefined();
    expect(fixed!.root.children[0].areaId).toBeDefined();
  });
});
