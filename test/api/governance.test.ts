import { afterEach, describe, expect, it } from "vitest";
import {
  AuditEntry,
  auditPolicy,
  byNewest,
  compact,
  currentUser,
  diffFields,
  docLabel,
  entriesToPrune,
  sameUser,
  stampText,
  UNKNOWN_USER,
} from "../../src/api/audit";
import { BACKUP_SCHEMA_VERSION, SafeBackup, summarizeBackup, validateBackup } from "../../src/api/backup";
import {
  auditIdle,
  capacityStore,
  DATA_COLLECTIONS,
  exportData,
  importData,
  listAudit,
  loadConfig,
  milestonesStore,
  objectivesStore,
  pruneAuditLog,
  risksStore,
  saveConfig,
  snapshotsStore,
} from "../../src/api/data";
import { canPlanIn, checkPlanIn, dataCapabilities, loadCapabilities } from "../../src/api/permissions";
import { businessOwnersFor, canRateBusinessValue, memberRole, parseRole, roleLabel, SAFE_ROLES, withRole } from "../../src/api/roles";
import { PiObjective } from "../../src/api/types";
import { dataStore, docs, fake, makeConfig, PI2, seedConfig, seedDocs } from "../fakeAdo";
import * as sdk from "../sdkMock";

const objective = (patch: Partial<PiObjective> = {}): PiObjective => ({
  id: "o1",
  piPath: PI2,
  nodeId: "n-red",
  title: "Ship payments",
  committed: true,
  plannedBV: 8,
  actualBV: null,
  featureIds: [],
  ...patch,
});
const entry = (id: string, at: string, patch: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  at,
  collection: "objectives",
  docId: "o1",
  action: "update",
  user: { id: "u1", displayName: "Ada" },
  ...patch,
});
const GRACE = { id: "u-grace", name: "grace@fabrikam.com", displayName: "Grace Hopper" };

const defaults = { ...auditPolicy };
afterEach(() => Object.assign(auditPolicy, defaults, { pruneChance: 0 }));

describe("audit helpers", () => {
  it("reads the signed-in user from the SDK, with a fallback outside the host", () => {
    expect(currentUser()).toEqual({ id: "u-ada", displayName: "Ada Lovelace", uniqueName: "ada@fabrikam.com" });
    sdk.getUser.mockImplementationOnce(() => {
      throw new Error("SDK not initialized");
    });
    expect(currentUser()).toBe(UNKNOWN_USER);
    sdk.getUser.mockImplementationOnce(() => undefined as any);
    expect(currentUser()).toBe(UNKNOWN_USER);
    sdk.getUser.mockImplementationOnce(() => ({ id: "x", name: "", displayName: "", descriptor: "", imageUrl: "" }));
    expect(currentUser()).toEqual({ id: "x", displayName: "Unknown user" });
  });

  it("matches people by id or sign-in name", () => {
    expect(sameUser({ id: "a" }, { id: "a" })).toBe(true);
    expect(sameUser({ id: "a", uniqueName: "X@f.com" }, { id: "b", uniqueName: "x@F.com" })).toBe(true);
    expect(sameUser({ id: "a" }, { id: "b" })).toBe(false);
    expect(sameUser({}, {})).toBe(false);
  });

  it("diffs top-level fields compactly and ignores bookkeeping", () => {
    const long = "x".repeat(300);
    expect(
      diffFields(
        { title: "A", plannedBV: 5, __etag: 3, modifiedAt: "t1", tags: [1], gone: true, same: 1 },
        { title: "B", plannedBV: 5, __etag: 4, modifiedAt: "t2", tags: [1, 2], note: long, same: 1 }
      )
    ).toEqual([
      { field: "gone", from: true },
      { field: "note", to: "x".repeat(119) + "…" },
      { field: "tags", from: "[1]", to: "[1,2]" },
      { field: "title", from: "A", to: "B" },
    ]);
    // Big objects that differ only after the cut are logged as "changed".
    expect(diffFields({ root: { a: long, b: 1 } }, { root: { a: long, b: 2 } })).toEqual([{ field: "root" }]);
    expect(diffFields(undefined, undefined)).toEqual([]);
    expect(compact(null)).toBeNull();
    expect(compact({ a: 1 })).toBe('{"a":1}');
  });

  it("labels documents by title, name or improvement text", () => {
    expect(docLabel({ title: "T" })).toBe("T");
    expect(docLabel({ name: "N" })).toBe("N");
    expect(docLabel({ improvement: "Fewer handoffs" })).toBe("Fewer handoffs");
    expect(docLabel({ id: "x" })).toBeUndefined();
    expect(docLabel(undefined)).toBeUndefined();
  });

  it("prunes by age and count, oldest first, capped per pass", () => {
    const now = Date.parse("2026-09-30T00:00:00Z");
    const recent = (i: number) => entry(`r${i}`, new Date(now - i * 60_000).toISOString());
    const old = entry("old", "2026-01-01T00:00:00Z");
    auditPolicy.maxEntries = 3;
    auditPolicy.maxDeletesPerPrune = 10;
    const drop = entriesToPrune([recent(0), recent(1), old, recent(2), recent(3), recent(4)], now);
    expect(drop.map((e) => e.id)).toEqual(["old", "r4", "r3"]);
    auditPolicy.maxDeletesPerPrune = 1;
    expect(entriesToPrune([recent(0), recent(1), old, recent(2), recent(3), recent(4)], now).map((e) => e.id)).toEqual(["old"]);
    expect(entriesToPrune([recent(0)], now)).toEqual([]);
  });

  it("sorts newest first and formats stamps", () => {
    const a = entry("a", "2026-01-01T00:00:00Z");
    const b = entry("b", "2026-01-02T00:00:00Z");
    const c = entry("c", "2026-01-02T00:00:00Z");
    expect([a, b, c].sort(byNewest).map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(stampText({ id: "1", displayName: "Ada" }, "2026-01-02T10:00:00Z")).toMatch(/^Ada · .*2026/);
    expect(stampText(undefined, undefined)).toBe("");
  });
});

describe("audit stamps and change log (document stores)", () => {
  it("stamps creation and modification, keeping the creation stamps on update", async () => {
    const created = await objectivesStore.save(objective());
    expect(created).toMatchObject({
      createdBy: { id: "u-ada", displayName: "Ada Lovelace", uniqueName: "ada@fabrikam.com" },
      modifiedBy: { id: "u-ada" },
    });
    expect(created.createdAt).toBe(created.modifiedAt);

    fake.user = GRACE;
    await new Promise((r) => setTimeout(r, 2));
    const updated = await objectivesStore.save({ ...created, title: "Ship payments v2", createdBy: undefined, createdAt: undefined });
    expect(updated.createdBy).toEqual(created.createdBy);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.modifiedBy).toEqual({ id: "u-grace", displayName: "Grace Hopper", uniqueName: "grace@fabrikam.com" });
    expect(updated.modifiedAt! > created.modifiedAt!).toBe(true);

    const log = await listAudit({ collection: "objectives", docId: "o1" });
    expect(log.map((e) => [e.action, e.user.displayName])).toEqual([
      ["update", "Grace Hopper"],
      ["create", "Ada Lovelace"],
    ]);
    expect(log[0].changes).toEqual([{ field: "title", from: "Ship payments", to: "Ship payments v2" }]);
    expect(log[0].label).toBe("Ship payments v2");
  });

  it("does not credit older documents' creation to the current user", async () => {
    seedDocs("risks", [{ id: "r1", title: "Legacy", createdAt: "2025-01-01T00:00:00Z" }]);
    const saved = await risksStore.save({ ...(docs("risks")[0] as any), title: "Legacy (edited)" });
    expect(saved.createdBy).toBeUndefined();
    expect(saved.createdAt).toBe("2025-01-01T00:00:00Z");
    expect(saved.modifiedBy).toMatchObject({ id: "u-ada" });
  });

  it("logs deletions with the removed values and skips no-op updates", async () => {
    const saved = await milestonesStore.save({ id: "m1", nodeId: "n-arta", title: "Release", date: "2026-10-01" });
    await milestonesStore.save(saved);
    await milestonesStore.remove("m1");
    const log = await listAudit({ collection: "milestones" });
    expect(log.map((e) => e.action)).toEqual(["delete", "create"]);
    expect(log[0].label).toBe("Release");
    expect(log[0].changes).toContainEqual({ field: "date", from: "2026-10-01" });
    // Deleting something that is already gone is still logged.
    await capacityStore.remove("nothing");
    expect((await listAudit({ collection: "capacity" }))[0]).toMatchObject({ action: "delete", docId: "nothing" });
  });

  it("does not audit or stamp system records (snapshots)", async () => {
    const saved = await snapshotsStore.save({ id: "s1" } as any);
    expect(saved).not.toHaveProperty("modifiedBy");
    await snapshotsStore.remove("s1");
    expect(docs("audit")).toEqual([]);
  });

  it("saves even when the stored version can't be read for the diff", async () => {
    dataStore.failures.push({ op: "getDocument", error: Object.assign(new Error("read failed"), { status: 500 }) });
    const saved = await objectivesStore.save(objective());
    expect(saved.title).toBe("Ship payments");
    dataStore.failures.push({ op: "getDocument", error: Object.assign(new Error("read failed"), { status: 500 }) });
    await objectivesStore.remove("o1");
    expect(docs("objectives")).toEqual([]);
    expect((await listAudit({ docId: "o1" })).map((e) => e.action)).toEqual(["delete", "create"]);
  });

  it("swallows audit write failures after a successful save", async () => {
    const { dataManager } = await import("../fakeAdo");
    const original = dataManager.setDocument.getMockImplementation()!;
    dataManager.setDocument.mockImplementation(async (collection: string, doc: any) => {
      if (collection.startsWith("audit-")) throw new Error("audit store unavailable");
      return original(collection, doc);
    });
    try {
      const saved = await risksStore.save({ id: "r9", title: "Kept" } as any);
      expect(saved.title).toBe("Kept");
      await risksStore.remove("r9");
      await saveConfig(makeConfig());
      expect(docs("risks")).toEqual([]);
      expect(docs("audit")).toEqual([]);
    } finally {
      dataManager.setDocument.mockImplementation(original);
    }
  });

  it("logs configuration changes with a diff", async () => {
    await saveConfig(makeConfig());
    await saveConfig(makeConfig({ storyPointsField: "Microsoft.VSTS.Scheduling.Effort" }));
    await saveConfig(makeConfig({ storyPointsField: "Microsoft.VSTS.Scheduling.Effort" }));
    const log = await listAudit({ collection: "config" });
    expect(log.map((e) => e.action)).toEqual(["update", "create"]);
    expect(log[0].changes).toEqual([
      { field: "storyPointsField", from: "Microsoft.VSTS.Scheduling.StoryPoints", to: "Microsoft.VSTS.Scheduling.Effort" },
    ]);
    // An unreadable previous value never blocks the save.
    dataStore.failures.push({ op: "getValue", error: new Error("read failed") });
    await saveConfig(makeConfig({ storyPointsField: "X" }));
    expect((await loadConfig())!.storyPointsField).toBe("X");
  });

  it("prunes opportunistically in the background", async () => {
    const now = Date.now();
    seedDocs(
      "audit",
      Array.from({ length: 5 }, (_, i) => entry(`e${i}`, new Date(now - (i + 1) * 60_000).toISOString()))
    );
    auditPolicy.maxEntries = 3;
    auditPolicy.pruneChance = 1;
    await objectivesStore.save(objective());
    await auditIdle();
    // 5 seeded + 1 new, keep 3 newest.
    expect(docs("audit").map((e) => e.id).sort()).toHaveLength(3);
    expect(docs("audit").some((e) => e.docId === "o1" && e.action === "create")).toBe(true);
  });

  it("prunes old entries directly and survives failures", async () => {
    seedDocs("audit", [entry("old", "2020-01-01T00:00:00Z"), entry("new", new Date().toISOString())]);
    expect(await pruneAuditLog()).toBe(1);
    expect(docs("audit").map((e) => e.id)).toEqual(["new"]);
    dataStore.failures.push({ op: "getDocuments", error: new Error("boom") });
    expect(await pruneAuditLog()).toBe(0);
    // No log yet: nothing to prune.
    dataStore.collections.clear();
    expect(await pruneAuditLog()).toBe(0);
  });
});

describe("backup / restore", () => {
  const backupOf = async () => JSON.parse(JSON.stringify(await exportData())) as SafeBackup;

  it("exports the configuration and every collection without etags", async () => {
    seedConfig();
    seedDocs("objectives", [objective()]);
    seedDocs("risks", [{ id: "r1", title: "Risk" }]);
    const backup = await exportData();
    expect(backup).toMatchObject({
      format: "scalelane-backup",
      schemaVersion: BACKUP_SCHEMA_VERSION,
      project: { id: "p1", name: "Fabrikam" },
      exportedBy: { displayName: "Ada Lovelace" },
    });
    expect(backup.config!.root.id).toBe("n-root");
    expect(Object.keys(backup.collections)).toEqual(DATA_COLLECTIONS);
    expect(backup.collections.objectives).toEqual([objective()]);
    expect(backup.collections.milestones).toEqual([]);
    expect(validateBackup(JSON.parse(JSON.stringify(backup))).backup).toBeDefined();
  });

  it("merges: adds and replaces documents, keeps the rest, and logs the import", async () => {
    seedDocs("objectives", [objective()]);
    const backup = await backupOf();
    backup.collections.objectives = [objective({ title: "From backup" }), objective({ id: "o2", title: "New" })] as any[];
    seedDocs("objectives", [objective({ title: "Changed since" }), objective({ id: "o3", title: "Only here" })]);
    expect(await importData(backup, "merge")).toEqual({ written: 2, deleted: 0 });
    expect(docs("objectives").map((o) => o.title).sort()).toEqual(["From backup", "New", "Only here"]);
    const [last] = await listAudit({ collection: "backup" });
    expect(last).toMatchObject({ action: "import", label: expect.stringMatching(/Restored 2 documents \(merge\) from Fabrikam/) });
  });

  it("overwrites: deletes documents missing from the backup but never the audit log", async () => {
    const backup = await backupOf();
    backup.collections.risks = [{ id: "r1", title: "Backed up" }];
    backup.collections.audit = [entry("a-old", "2026-01-01T00:00:00Z") as any];
    seedDocs("risks", [{ id: "r2", title: "Extra" }]);
    seedDocs("audit", [entry("a-now", new Date().toISOString())]);
    expect(await importData(backup, "overwrite")).toEqual({ written: 2, deleted: 1 });
    expect(docs("risks").map((r) => r.title)).toEqual(["Backed up"]);
    expect(docs("audit").map((e) => e.id)).toEqual(expect.arrayContaining(["a-now", "a-old"]));
    // Single-document import message.
    const one = await backupOf();
    Object.keys(one.collections).forEach((k) => (one.collections[k] = []));
    one.collections.votes = [{ id: "v1" }];
    await importData(one, "merge");
    expect((await listAudit({ collection: "backup" }))[0].label).toMatch(/Restored 1 document \(merge\)/);
  });

  it("validates the file before anything is written", () => {
    const good = {
      format: "scalelane-backup",
      schemaVersion: 1,
      exportedAt: "2026-01-01T00:00:00Z",
      project: { id: "p1", name: "Fabrikam" },
      config: makeConfig(),
      collections: { objectives: [{ id: "o1" }] },
    };
    expect(validateBackup(good).backup).toBe(good);
    expect(validateBackup({ ...good, config: null }).backup).toBeDefined();
    // Backups made under the old name (SAFe Ado) still import: that is how installs migrate.
    expect(validateBackup({ ...good, format: "safe-ado-backup" }).backup).toBeDefined();
    const bad: [unknown, RegExp][] = [
      [null, /not a ScaleLane backup/],
      [[], /not a ScaleLane backup/],
      [{ ...good, format: "x" }, /not a ScaleLane backup/],
      [{ ...good, schemaVersion: "1" }, /no valid schema version/],
      [{ ...good, schemaVersion: 0 }, /no valid schema version/],
      [{ ...good, schemaVersion: 99 }, /newer version .*schema 99/],
      [{ ...good, project: undefined }, /which project/],
      [{ ...good, config: { types: {}, piRootIteration: "x", root: { id: "r", name: "R", level: "portfolio" } } }, /configuration .* damaged/],
      [{ ...good, config: { types: {}, piRootIteration: 1 } }, /configuration .* damaged/],
      [{ ...good, config: "x" }, /configuration .* damaged/],
      [{ ...good, collections: [] }, /no document collections/],
      [{ ...good, collections: { "Bad-Name": [] } }, /Invalid collection name/],
      [{ ...good, collections: { risks: {} } }, /documents without an id/],
      [{ ...good, collections: { risks: [{ id: "" }] } }, /documents without an id/],
      [{ ...good, collections: { risks: [null] } }, /documents without an id/],
    ];
    for (const [value, error] of bad) expect(validateBackup(value).error).toMatch(error);
  });

  it("summarises what a restore would do", () => {
    const backup = {
      format: "scalelane-backup",
      schemaVersion: 1,
      exportedAt: "2026-01-01T00:00:00Z",
      exportedBy: { id: "u", displayName: "Ada" },
      project: { id: "other", name: "Contoso" },
      config: null,
      collections: { objectives: [{ id: "o1" }, { id: "o2" }], future: [{ id: "f" }] },
    } as SafeBackup;
    expect(summarizeBackup(backup, ["objectives", "risks"], "p1")).toEqual({
      project: { id: "other", name: "Contoso" },
      exportedAt: "2026-01-01T00:00:00Z",
      exportedBy: "Ada",
      hasConfig: false,
      counts: [
        { name: "objectives", count: 2 },
        { name: "risks", count: 0 },
      ],
      total: 2,
      unknown: ["future"],
      otherProject: true,
    });
    const nameless = { ...backup, project: { id: "p1" } } as unknown as SafeBackup;
    expect(summarizeBackup(nameless, [], "p1")).toMatchObject({ project: { id: "p1", name: "p1" }, otherProject: false });
  });
});

describe("permissions fail closed for extension data", () => {
  it("reports checks that could not be answered as unverified", async () => {
    fake.failures.push({ match: /permissions\/52d39943/, status: 500, message: "x" });
    expect(await loadCapabilities("area", "iteration")).toEqual({ admin: true, managePis: true, plan: true, known: true, unverified: ["admin"] });
    fake.failures.length = 0;
    fake.failures.push({ match: /permissions/, status: 503, message: "x" });
    expect((await loadCapabilities("area", "iteration")).unverified).toEqual(["admin", "managePis", "plan"]);
  });

  it("denies unverified capabilities for extension-data writes only", () => {
    const can = { admin: true, managePis: true, plan: true, known: true, unverified: ["admin" as const, "plan" as const] };
    expect(dataCapabilities(can)).toMatchObject({ admin: false, managePis: true, plan: false });
    const all = { ...can, unverified: ["managePis" as const] };
    expect(dataCapabilities(all).managePis).toBe(false);
    const verified = { admin: true, managePis: true, plan: true };
    expect(dataCapabilities(verified)).toBe(verified);
    // A definite "no" stays a no.
    expect(dataCapabilities({ admin: false, managePis: true, plan: true, unverified: [] }).admin).toBe(false);
  });

  it("tells a failed planning probe apart from a denial", async () => {
    fake.failures.push({ match: /validateOnly|workitems\/\$/, status: 500, message: "server down" });
    expect(await checkPlanIn("Fabrikam\\ART A", "User Story")).toBeUndefined();
    fake.failures.length = 0;
    fake.failures.push({ match: /validateOnly|workitems\/\$/, status: 500, message: "server down" });
    // Work item writes stay fail-open.
    expect(await canPlanIn("Fabrikam\\ART A", "User Story")).toBe(true);
    fake.failures.length = 0;
    fake.denyWriteAreas = ["Fabrikam\\ART A"];
    expect(await checkPlanIn("Fabrikam\\ART A", "User Story")).toBe(false);
    fake.denyWriteAreas = [];
    expect(await checkPlanIn("Fabrikam\\ART A", "User Story")).toBe(true);
  });
});

describe("SAFe roles", () => {
  it("maps free-text roles case-insensitively, else Other", () => {
    expect(parseRole("RTE")).toBe("rte");
    expect(parseRole("  release   Train engineer ")).toBe("rte");
    expect(parseRole("Scrum Master / Team Coach")).toBe("scrumMaster");
    expect(parseRole("product owner")).toBe("productOwner");
    expect(parseRole("Business Owner")).toBe("businessOwner");
    expect(parseRole("LPM")).toBe("lpm");
    expect(parseRole("Dev")).toBe("teamMember");
    expect(parseRole("Chief Happiness Officer")).toBe("other");
    expect(parseRole(undefined)).toBe("other");
    expect(SAFE_ROLES.map((r) => r.key)).toHaveLength(11);
  });

  it("prefers the stored role and keeps custom labels for Other", () => {
    expect(memberRole({ name: "A", role: "RTE", safeRole: "businessOwner" })).toBe("businessOwner");
    expect(memberRole({ name: "A", role: "po" })).toBe("productOwner");
    expect(roleLabel("epicOwner")).toBe("Epic Owner");
    expect(roleLabel("nope" as any)).toBe("Other");
    expect(withRole({ name: "A", role: "po" }, "rte")).toEqual({ name: "A", role: "RTE", safeRole: "rte" });
    // Switching to Other keeps an unrecognised label, drops a recognised one.
    expect(withRole({ name: "A", role: "Coach of coaches" }, "other")).toEqual({ name: "A", role: "Coach of coaches", safeRole: "other" });
    expect(withRole({ name: "A", role: "po" }, "other")).toEqual({ name: "A", role: "", safeRole: "other" });
    expect(withRole({ name: "A", role: "po" }, "other", "Custom")).toEqual({ name: "A", role: "Custom", safeRole: "other" });
  });

  it("finds Business Owners on the unit and its ancestors", () => {
    const config = makeConfig();
    config.root.children[0].members = [
      { name: "Grace", role: "Business Owner", id: "u-grace", uniqueName: "grace@fabrikam.com" },
      { name: "Rita", role: "RTE" },
    ];
    config.root.children[0].children[0].members = [{ name: "Bob", role: "x", safeRole: "businessOwner", uniqueName: "bob@fabrikam.com" }];
    expect(businessOwnersFor(config.root, "n-red").map((m) => m.name)).toEqual(["Grace", "Bob"]);
    expect(businessOwnersFor(config.root, "n-green")).toEqual([]);
    expect(canRateBusinessValue(config.root, "n-red", { id: "u-grace" }).allowed).toBe(true);
    expect(canRateBusinessValue(config.root, "n-red", { id: "u-x", uniqueName: "BOB@fabrikam.com" }).allowed).toBe(true);
    expect(canRateBusinessValue(config.root, "n-blue", { id: "u-ada", uniqueName: "ada@fabrikam.com" })).toMatchObject({ allowed: false });
    expect(canRateBusinessValue(config.root, "n-green", { id: "u-ada" })).toEqual({ allowed: true, owners: [] });
  });
});
