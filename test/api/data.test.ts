import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, newId, objectivesStore, risksStore, saveConfig } from "../../src/api/data";
import { PiObjective, Risk } from "../../src/api/types";
import { dataManager, dataStore, docs, fake, makeConfig } from "../fakeAdo";

const objective = (over: Partial<PiObjective> = {}): PiObjective => ({
  id: "o1",
  piPath: "Fabrikam\\PIs\\PI 2",
  nodeId: "n-red",
  title: "Ship payments",
  committed: true,
  plannedBV: 8,
  actualBV: null,
  featureIds: [10],
  ...over,
});

describe("config storage", () => {
  it("returns null when nothing is saved, then round-trips per project", async () => {
    expect(await loadConfig()).toBeNull();
    const cfg = makeConfig();
    await saveConfig(cfg);
    expect(dataStore.values.has("config-p1")).toBe(true);
    expect(await loadConfig()).toEqual(cfg);
    expect(dataManager.getValue).toHaveBeenCalledWith("config-p1", { scopeType: "Default" });
    expect(dataManager.setValue).toHaveBeenCalledWith("config-p1", cfg, { scopeType: "Default" });
  });
});

describe("defaultConfig", () => {
  const setTypes = (...names: string[]) => (fake.types = names.map((name) => ({ name, referenceName: name })));

  it("detects the Agile process", async () => {
    const cfg = await defaultConfig();
    expect(cfg.types).toEqual({ epic: "Epic", capability: "", feature: "Feature", story: "User Story" });
    expect(cfg.storyPointsField).toBe("Microsoft.VSTS.Scheduling.StoryPoints");
    expect(cfg.piRootIteration).toBe("Fabrikam");
    expect(cfg.root).toMatchObject({ name: "Fabrikam", level: "portfolio", areaPath: "Fabrikam", children: [] });
    expect(cfg.version).toBe(1);
  });

  it("detects Scrum (PBI + Effort)", async () => {
    setTypes("Epic", "Feature", "Product Backlog Item");
    const cfg = await defaultConfig();
    expect(cfg.types.story).toBe("Product Backlog Item");
    expect(cfg.storyPointsField).toBe("Microsoft.VSTS.Scheduling.Effort");
  });

  it("detects CMMI (Requirement + Size)", async () => {
    setTypes("Epic", "Feature", "Requirement");
    const cfg = await defaultConfig();
    expect(cfg.types.story).toBe("Requirement");
    expect(cfg.storyPointsField).toBe("Microsoft.VSTS.Scheduling.Size");
  });

  it("detects custom SAFe processes with Capability, and Basic with Issue", async () => {
    setTypes("Epic", "Capability", "Feature", "User Story");
    expect((await defaultConfig()).types.capability).toBe("Capability");
    setTypes("Epic", "Issue");
    const basic = await defaultConfig();
    expect(basic.types).toEqual({ epic: "Epic", capability: "", feature: "", story: "Issue" });
  });
});

describe("document stores", () => {
  it("returns an empty list when the collection does not exist yet", async () => {
    expect(await objectivesStore.list()).toEqual([]);
    expect(await risksStore.list()).toEqual([]);
  });

  it("treats 'not found' messages without a status as empty", async () => {
    dataStore.failures.push({ op: "getDocuments", error: new Error("Collection not found") });
    expect(await objectivesStore.list()).toEqual([]);
    dataStore.failures.push({ op: "getDocuments", error: "does not exist" as any });
    expect(await objectivesStore.list()).toEqual([]);
  });

  it("rethrows other storage errors", async () => {
    dataStore.failures.push({ op: "getDocuments", error: Object.assign(new Error("Forbidden"), { status: 403 }) });
    await expect(risksStore.list()).rejects.toThrow("Forbidden");
  });

  it("saves, lists and deletes objectives in a per-project collection", async () => {
    const saved = await objectivesStore.save(objective());
    expect(saved.__etag).toBe(1);
    expect(dataManager.setDocument).toHaveBeenCalledWith("objectives-p1", expect.objectContaining({ id: "o1" }), { scopeType: "Default" });
    expect(await objectivesStore.list()).toHaveLength(1);
    await objectivesStore.remove("o1");
    expect(docs("objectives")).toEqual([]);
  });

  it("rejects stale etags (optimistic concurrency)", async () => {
    const saved = await objectivesStore.save(objective());
    await objectivesStore.save({ ...saved, title: "v2" });
    await expect(objectivesStore.save({ ...saved, title: "stale" })).rejects.toThrow(/etag/);
  });

  it("saves and deletes risks", async () => {
    const risk: Risk = {
      id: "r1",
      piPath: "x",
      nodeId: "n-red",
      title: "Vendor delay",
      description: "",
      owner: "",
      impact: "High",
      status: "Unroamed",
      createdAt: "2026-01-01",
    };
    await risksStore.save(risk);
    expect(docs("risks")[0]).toMatchObject({ id: "r1", __etag: 1 });
    await risksStore.remove("r1");
    expect(dataManager.deleteDocument).toHaveBeenCalledWith("risks-p1", "r1", { scopeType: "Default" });
  });
});

describe("newId", () => {
  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 500 }, newId));
    expect(ids.size).toBe(500);
  });
});
