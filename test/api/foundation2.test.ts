import { describe, expect, it, vi } from "vitest";
import { capacityStore, metaStore, objectivesStore, risksStore } from "../../src/api/data";
import { effectivePiRoot } from "../../src/api/org";
import { loadCapabilities } from "../../src/api/permissions";
import { indexTree, reconcileConfig, reconcileDocs, resolveKey } from "../../src/api/reconcile";
import { formatHash, openInNewTab, parseHash, readUrlState, writeUrlState } from "../../src/api/urlState";
import { getAreaTree, getIterationTree } from "../../src/api/wit";
import { callsTo, dataStore, docs, fake, makeConfig, PI2, PI2_S1, RED, seedDocs } from "../fakeAdo";
import * as sdk from "../sdkMock";

const renameIteration = (path: string[], name: string) => {
  let node = fake.iterationTree;
  for (const p of path) node = node.children!.find((c) => c.name === p)!;
  node.name = name;
  node.path = node.path.replace(/[^\\]+$/, name);
  const fix = (n: typeof node, parentPath: string) => {
    n.path = `${parentPath}\\${n.name}`;
    n.children?.forEach((c) => fix(c, n.path));
  };
  node.children?.forEach((c) => fix(c, node.path));
};

describe("permissions", () => {
  it("checks project, iteration and area permissions", async () => {
    fake.permissions["52d39943-cb85-4d7f-8fa8-c6baac873819/2"] = false;
    const caps = await loadCapabilities("area-root", "iteration-root");
    expect(caps).toEqual({ admin: false, managePis: true, plan: true, known: true });
    const tokens = callsTo(/_apis\/permissions/).map((c) => decodeURIComponent(new URL(c.url).searchParams.get("tokens")!));
    expect(tokens).toEqual([
      "$PROJECT:vstfs:///Classification/TeamProject/p1",
      "vstfs:///Classification/Node/iteration-root",
      "vstfs:///Classification/Node/area-root",
    ]);
  });

  it("allows actions but marks them unverified when the check itself fails; unknown roots are not checked", async () => {
    fake.failures.push({ match: /permissions/, status: 500, message: "x" });
    expect(await loadCapabilities()).toEqual({ admin: true, managePis: true, plan: true, known: true, unverified: ["admin"] });
  });

  it("probes planning rights with a validate-only create that saves nothing", async () => {
    const { canPlanIn } = await import("../../src/api/permissions");
    const before = fake.workItems.size;
    expect(await canPlanIn(RED, "User Story")).toBe(true);
    fake.denyWriteAreas = ["Fabrikam\\ART A"];
    expect(await canPlanIn(RED, "User Story")).toBe(false);
    expect(fake.workItems.size).toBe(before);
    // Unknown when the probe fails for another reason, or nothing to check.
    fake.failures.push({ match: /validateOnly|workitems\/\$/, status: 400, message: "TF401320: rule violation" });
    expect(await canPlanIn("Fabrikam\\ART B", "User Story")).toBe(true);
    expect(await canPlanIn("", "User Story")).toBe(true);
  });
});

describe("key reconciliation", () => {
  it("resolves keys by id first, then by path", async () => {
    const index = indexTree(await getIterationTree());
    const pi2Id = index.byPath.get(PI2.toLowerCase())!;
    expect(resolveKey("old path", pi2Id, index)).toEqual({ path: PI2, id: pi2Id });
    expect(resolveKey(PI2.toUpperCase(), undefined, index)).toEqual({ path: PI2.toUpperCase(), id: pi2Id });
    expect(resolveKey("nowhere", "gone", index)).toEqual({ path: "nowhere", id: "gone" });
  });

  it("repairs area paths and PI roots of the config after a rename", async () => {
    const areas = indexTree(await getAreaTree());
    const iterations = indexTree(await getIterationTree());
    const config = makeConfig();
    // First pass fills in ids.
    const withIds = reconcileConfig(config, areas, iterations)!;
    expect(withIds.root.children[0].children[0].areaId).toBe(areas.byPath.get(RED.toLowerCase()));
    expect(withIds.piRootId).toBe(iterations.byPath.get("fabrikam\\pis"));
    expect(reconcileConfig(withIds, areas, iterations)).toBeNull();

    // Rename "Team Red" area and the PIs folder, then reconcile by id.
    const red = fake.areaTree.children![0].children![0];
    red.name = "Team Crimson";
    red.path = red.path.replace("Team Red", "Team Crimson");
    renameIteration(["PIs"], "Increments");
    const healed = reconcileConfig(withIds, indexTree(await getAreaTree()), indexTree(await getIterationTree()))!;
    expect(healed.root.children[0].children[0].areaPath).toBe("Fabrikam\\ART A\\Team Crimson");
    expect(healed.piRootIteration).toBe("Fabrikam\\Increments");
  });

  it("repairs per-unit cadences and detached units", async () => {
    const areas = indexTree(await getAreaTree());
    const iterations = indexTree(await getIterationTree());
    const config = makeConfig();
    config.root.children[1].piRootIteration = "Fabrikam\\PIs";
    config.detached = [{ id: "d1", name: "Loose", level: "team", areaPath: RED, children: [] }];
    const fixed = reconcileConfig(config, areas, iterations)!;
    expect(fixed.root.children[1].piRootId).toBe(iterations.byPath.get("fabrikam\\pis"));
    expect(fixed.detached![0].areaId).toBe(areas.byPath.get(RED.toLowerCase()));
  });

  it("repairs objectives, risks, capacity and PI assignments after a PI rename", async () => {
    const before = indexTree(await getIterationTree());
    const pi2Id = before.byPath.get(PI2.toLowerCase())!;
    const s1Id = before.byPath.get(PI2_S1.toLowerCase())!;
    seedDocs("objectives", [{ id: "o1", nodeId: "n-red", piPath: PI2, title: "x", committed: true, plannedBV: 5, actualBV: null, featureIds: [] }]);
    seedDocs("risks", [{ id: "r1", nodeId: "n-red", piPath: PI2, piId: pi2Id, title: "r", description: "", owner: "", impact: "Low", status: "Owned", createdAt: "" }]);
    await capacityStore.save({ id: `n-red|${PI2_S1}`, nodeId: "n-red", iterationPath: PI2_S1, capacity: 10 });
    await metaStore.save({ id: "10", workItemId: 10, assignedNodeIds: ["n-red"], assignedPiPaths: [PI2, "Fabrikam\\Gone"] });

    // First pass: add ids to old records.
    expect(await reconcileDocs(before)).toBe(3);
    expect((await objectivesStore.list())[0].piId).toBe(pi2Id);
    expect((await capacityStore.list())[0].iterationId).toBe(s1Id);
    expect((await metaStore.list())[0].assignedPiIds).toEqual([pi2Id, ""]);
    expect(await reconcileDocs(before)).toBe(0);

    // Rename PI 2 in Azure DevOps: records follow the id.
    renameIteration(["PIs", "PI 2"], "PI 2026.4");
    const after = indexTree(await getIterationTree());
    expect(await reconcileDocs(after)).toBe(4);
    expect((await objectivesStore.list())[0].piPath).toBe("Fabrikam\\PIs\\PI 2026.4");
    expect((await risksStore.list())[0].piPath).toBe("Fabrikam\\PIs\\PI 2026.4");
    expect((await capacityStore.list())[0].iterationPath).toBe("Fabrikam\\PIs\\PI 2026.4\\PI 2 Sprint 1");
    expect((await metaStore.list())[0].assignedPiPaths).toEqual(["Fabrikam\\PIs\\PI 2026.4", "Fabrikam\\Gone"]);
  });

  it("skips records another user changed meanwhile", async () => {
    seedDocs("objectives", [{ id: "o1", nodeId: "n-red", piPath: PI2, title: "x", committed: true, plannedBV: 5, actualBV: null, featureIds: [] }]);
    dataStore.failures.push({ op: "setDocument", error: new Error("etag") });
    expect(await reconcileDocs(indexTree(await getIterationTree()))).toBe(0);
    expect(docs("objectives")[0].piId).toBeUndefined();
  });
});

describe("cadence per unit", () => {
  it("uses the nearest unit's own PI root, else the project's", () => {
    const config = makeConfig();
    config.root.children[0].piRootIteration = "Fabrikam\\ART A PIs";
    expect(effectivePiRoot(config, "n-red")).toBe("Fabrikam\\ART A PIs");
    expect(effectivePiRoot(config, "n-arta")).toBe("Fabrikam\\ART A PIs");
    expect(effectivePiRoot(config, "n-green")).toBe("Fabrikam\\PIs");
    expect(effectivePiRoot(config, "missing")).toBe("Fabrikam\\PIs");
  });
});

describe("URL state", () => {
  it("parses and formats the hash", () => {
    expect(parseHash("#node=n-red&view=board&pi=abc")).toEqual({ node: "n-red", view: "board", pi: "abc" });
    expect(parseHash("")).toEqual({});
    expect(formatHash({ node: "n red", view: "reports" })).toBe("node=n+red&view=reports");
  });

  it("reads and writes through the host navigation service", async () => {
    fake.hash = "node=n-blue&view=risks";
    expect(await readUrlState()).toEqual({ node: "n-blue", view: "risks" });
    await writeUrlState({ node: "n-red", view: "board", pi: "x" });
    expect(fake.hash).toBe("node=n-red&view=board&pi=x");
    await openInNewTab("https://example.com/x");
    expect(sdk.hostNavigation.openNewWindow).toHaveBeenCalledWith("https://example.com/x", "");
  });

  it("degrades gracefully without the service", async () => {
    sdk.getService.mockRejectedValueOnce(new Error("no service"));
    expect(await readUrlState()).toEqual({});
    sdk.getService.mockRejectedValueOnce(new Error("no service"));
    await writeUrlState({ node: "x" });
    sdk.getService.mockRejectedValueOnce(new Error("no service"));
    const open = (window.open = vi.fn() as any);
    await openInNewTab("https://example.com/y");
    expect(open).toHaveBeenCalledWith("https://example.com/y", "_blank", "noopener");
  });

  it("survives a failing hash read", async () => {
    sdk.hostNavigation.getHash.mockImplementationOnce(async () => {
      throw new Error("x");
    });
    expect(await readUrlState()).toEqual({});
  });
});

