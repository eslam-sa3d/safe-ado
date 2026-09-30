import * as SDK from "azure-devops-extension-sdk";
import type { IExtensionDataManager, IExtensionDataService } from "azure-devops-extension-api/Common/CommonServices";
import { AuditEntry, auditPolicy, AuditStamps, AuditUser, byNewest, currentUser, diffFields, docLabel, entriesToPrune } from "./audit";
import { BACKUP_FORMAT, BACKUP_SCHEMA_VERSION, BackupDoc, ImportMode, SafeBackup } from "./backup";
import { getProject, ServiceIds } from "./client";
import type { QuickFilter } from "./filters";
import type { LeanBusinessCase, PortfolioSettings, ValueStreamBudget } from "./lpm";
import type { ConfidenceVote, ImprovementItem, PlanReview } from "./planning";
import type { PiSnapshot } from "./reports";
import { IterationCapacity, Milestone, OrgNode, PiObjective, Risk, SafeConfig, WorkItemMeta, WorkItemTypeMap } from "./types";
import { getWorkItemTypes } from "./wit";

/**
 * Extension data (config, PI objectives, ROAM risks) lives in the Extension Data Service,
 * which is available on Azure DevOps Services and Server. Everything is scoped per project
 * through the key / collection name so one collection can host many SAFe projects.
 */

let managerPromise: Promise<IExtensionDataManager> | undefined;

function manager(): Promise<IExtensionDataManager> {
  if (!managerPromise) {
    managerPromise = (async () => {
      const svc = await SDK.getService<IExtensionDataService>(ServiceIds.extensionData);
      const token = await SDK.getAccessToken();
      return svc.getExtensionDataManager(SDK.getExtensionContext().id, token);
    })();
  }
  return managerPromise;
}

const configKey = () => `config-${getProject().id}`;
const objectivesCollection = () => `objectives-${getProject().id}`;
const risksCollection = () => `risks-${getProject().id}`;
const collection = (name: string) => () => `${name}-${getProject().id}`;

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

export async function loadConfig(): Promise<SafeConfig | null> {
  const m = await manager();
  const value = await m.getValue<SafeConfig | undefined>(configKey(), { scopeType: "Default" });
  return value ?? null;
}

export async function saveConfig(config: SafeConfig): Promise<SafeConfig> {
  const m = await manager();
  // The previous value gives the change log its diff; failing to read it never blocks the save.
  const before = await loadConfig().catch(() => null);
  const saved = await m.setValue<SafeConfig>(configKey(), config, { scopeType: "Default" });
  const changes = diffFields(before ?? undefined, config);
  if (!before || changes.length) await appendAudit({ collection: "config", docId: "config", action: before ? "update" : "create", changes });
  return saved;
}

/** Picks sensible type/field defaults from whichever process (Agile, Scrum, CMMI, custom) the project uses. */
export async function defaultConfig(): Promise<SafeConfig> {
  const project = getProject();
  const names = new Set((await getWorkItemTypes()).map((t) => t.name));
  const first = (...candidates: string[]) => candidates.find((c) => names.has(c)) ?? "";

  const types: WorkItemTypeMap = {
    epic: first("Epic"),
    capability: first("Capability"),
    feature: first("Feature"),
    story: first("User Story", "Product Backlog Item", "Requirement", "Issue"),
  };
  const storyPointsField =
    types.story === "User Story"
      ? "Microsoft.VSTS.Scheduling.StoryPoints"
      : types.story === "Requirement"
      ? "Microsoft.VSTS.Scheduling.Size"
      : "Microsoft.VSTS.Scheduling.Effort";

  const root: OrgNode = { id: newId(), name: project.name, level: "portfolio", areaPath: project.name, children: [] };
  return { version: 1, root, piRootIteration: project.name, types, storyPointsField };
}

// ---------------------------------------------------------------------------------------------
// Documents (objectives, risks)
// ---------------------------------------------------------------------------------------------

async function getDocs<T>(collection: string): Promise<T[]> {
  const m = await manager();
  try {
    return await m.getDocuments(collection, { scopeType: "Default" });
  } catch (e: any) {
    // The collection does not exist until the first document is written.
    if (e?.status === 404 || /not.?found|does not exist/i.test(String(e?.message ?? e))) return [];
    throw e;
  }
}

/**
 * Writes a document. Audited collections (everything people edit) are stamped with
 * createdBy/createdAt (kept from the stored version) and modifiedBy/modifiedAt, and each change
 * is appended to the change log. This is the one place stamping happens: views never stamp.
 */
async function setDoc<T extends { id: string }>(collection: string, doc: T, audited?: string): Promise<T> {
  const m = await manager();
  if (!audited) return m.setDocument(collection, doc, { scopeType: "Default" });
  const user = currentUser();
  const at = new Date().toISOString();
  // The stored version keeps the creation stamps and gives the diff; an unreadable one counts as new.
  const before = await getDoc<T & AuditStamps>(collection, doc.id).catch(() => undefined);
  const incoming = doc as T & AuditStamps;
  // Older documents have no creation stamps: those stay unknown rather than credited to this user.
  const createdBy = before ? before.createdBy : incoming.createdBy ?? user;
  const createdAt = before ? before.createdAt ?? incoming.createdAt : incoming.createdAt ?? at;
  const stamped = {
    ...doc,
    ...(createdBy ? { createdBy } : {}),
    ...(createdAt ? { createdAt } : {}),
    modifiedBy: user,
    modifiedAt: at,
  };
  const saved = await m.setDocument(collection, stamped, { scopeType: "Default" });
  const changes = diffFields(before, doc);
  if (!before || changes.length) {
    await appendAudit({ collection: audited, docId: doc.id, action: before ? "update" : "create", label: docLabel(doc), changes }, user, at);
  }
  return saved;
}

async function deleteDoc(collection: string, id: string, audited?: string): Promise<void> {
  const m = await manager();
  const before = audited ? await getDoc<object>(collection, id).catch(() => undefined) : undefined;
  await m.deleteDocument(collection, id, { scopeType: "Default" });
  if (audited) await appendAudit({ collection: audited, docId: id, action: "delete", label: docLabel(before), changes: diffFields(before, undefined) });
}

export const objectivesStore = {
  list: () => getDocs<PiObjective>(objectivesCollection()),
  get: (id: string) => getDoc<PiObjective>(objectivesCollection(), id),
  save: (o: PiObjective) => setDoc(objectivesCollection(), o, "objectives"),
  remove: (id: string) => deleteDoc(objectivesCollection(), id, "objectives"),
};

export const risksStore = {
  list: () => getDocs<Risk>(risksCollection()),
  get: (id: string) => getDoc<Risk>(risksCollection(), id),
  save: (r: Risk) => setDoc(risksCollection(), r, "risks"),
  remove: (id: string) => deleteDoc(risksCollection(), id, "risks"),
};

async function getDoc<T>(collection: string, id: string): Promise<T | undefined> {
  const m = await manager();
  try {
    return await m.getDocument(collection, id, { scopeType: "Default" });
  } catch (e: any) {
    if (e?.status === 404 || /not.?found|does not exist/i.test(String(e?.message ?? e))) return undefined;
    throw e;
  }
}

/** A per-project document collection. People's edits are audited unless `audited` is false (system records). */
function docStore<T extends { id: string }>(name: string, audited = true) {
  const coll = collection(name);
  const log = audited ? name : undefined;
  return {
    list: () => getDocs<T>(coll()),
    /** One document by id (undefined when missing) — avoids loading the whole collection. */
    get: (id: string) => getDoc<T>(coll(), id),
    save: (doc: T) => setDoc(coll(), doc, log),
    remove: (id: string) => deleteDoc(coll(), id, log),
  };
}

export const milestonesStore = docStore<Milestone>("milestones");
export const quickFiltersStore = docStore<QuickFilter>("quickfilters");
export const capacityStore = docStore<IterationCapacity>("capacity");
export const metaStore = docStore<WorkItemMeta>("wimeta");
export const votesStore = docStore<ConfidenceVote>("votes");
export const planReviewsStore = docStore<PlanReview>("planreviews");
export const inspectAdaptStore = docStore<ImprovementItem>("improvements");
// Snapshots are recorded by the reports themselves, not edited by people: not audited.
export const snapshotsStore = docStore<PiSnapshot>("snapshots", false);
/** Lean Portfolio Management (see lpm.ts): Epic business cases, per-node settings, PI budgets. */
export const leanCasesStore = docStore<LeanBusinessCase>("leancases");
export const portfolioSettingsStore = docStore<PortfolioSettings>("lpmsettings");
export const budgetsStore = docStore<ValueStreamBudget>("budgets");

/** Capacity document id: team node + the iteration's stable id (older documents used the path). */
export const capacityId = (nodeId: string, iterationKey: string) => `${nodeId}|${iterationKey}`;

/** Finds a team's capacity for a sprint by iteration id, falling back to the (older) path key. */
export function findCapacity(docs: IterationCapacity[], nodeId: string, sprint: { identifier: string; path: string }): IterationCapacity | undefined {
  const mine = docs.filter((d) => d.nodeId === nodeId);
  return mine.find((d) => d.iterationId === sprint.identifier) ?? mine.find((d) => d.iterationPath.toLowerCase() === sprint.path.toLowerCase());
}

export function emptyMeta(workItemId: number): WorkItemMeta {
  return { id: String(workItemId), workItemId, assignedNodeIds: [], assignedPiPaths: [] };
}

// ---------------------------------------------------------------------------------------------
// Per-user values (starred nodes, view preferences) — follow the user across browsers.
// ---------------------------------------------------------------------------------------------

export async function getUserValue<T>(key: string, fallback: T): Promise<T> {
  const m = await manager();
  const value = await m.getValue<T | undefined>(`${key}-${getProject().id}`, { scopeType: "User" });
  return value ?? fallback;
}

export async function setUserValue<T>(key: string, value: T): Promise<T> {
  const m = await manager();
  return m.setValue<T>(`${key}-${getProject().id}`, value, { scopeType: "User" });
}

// ---------------------------------------------------------------------------------------------
// Change log (audit-<projectId>). The Extension Data Service keeps no history, so this log is
// the record of who changed ScaleLane's data. It never blocks the change it describes.
// ---------------------------------------------------------------------------------------------

const auditCollection = collection("audit");
let pruning: Promise<void> = Promise.resolve();
let auditSeq = 0;

/** Appends one entry; failures are swallowed. Now and then, prunes old entries in the background. */
async function appendAudit(entry: Omit<AuditEntry, "id" | "user" | "at">, user: AuditUser = currentUser(), at = new Date().toISOString()) {
  try {
    const m = await manager();
    // Ids start with the timestamp and a per-session counter so they sort chronologically.
    const seq = (auditSeq++ % 1296).toString(36).padStart(2, "0");
    const id = `${Date.parse(at).toString(36).padStart(9, "0")}-${seq}${Math.random().toString(36).slice(2, 8)}`;
    await m.setDocument(auditCollection(), { id, ...entry, user, at }, { scopeType: "Default" });
    if (Math.random() < auditPolicy.pruneChance) pruning = pruneAuditLog().then(() => undefined);
  } catch {
    /* the change log is best effort: the change itself has been saved */
  }
}

/** The change log, newest first. */
export async function listAudit(filter: { collection?: string; docId?: string } = {}): Promise<AuditEntry[]> {
  const all = await getDocs<AuditEntry>(auditCollection());
  return all
    .filter((e) => (!filter.collection || e.collection === filter.collection) && (!filter.docId || e.docId === filter.docId))
    .sort(byNewest);
}

/** Deletes entries beyond the retention policy (capped per pass). Returns how many were removed. */
export async function pruneAuditLog(now = Date.now()): Promise<number> {
  try {
    const m = await manager();
    const drop = entriesToPrune(await getDocs<AuditEntry>(auditCollection()), now);
    for (const e of drop) await m.deleteDocument(auditCollection(), e.id, { scopeType: "Default" });
    return drop.length;
  } catch {
    return 0;
  }
}

/** Resolves when a background pruning pass (if any) has finished. */
export const auditIdle = () => pruning;

// ---------------------------------------------------------------------------------------------
// Backup / restore. One JSON file with the configuration and every document collection of this
// project — the only way to keep ScaleLane's data when the extension is uninstalled.
// ---------------------------------------------------------------------------------------------

/** Every per-project document collection by name. Features that add a collection add it here. */
export const DATA_COLLECTIONS = [
  "objectives",
  "risks",
  "milestones",
  "quickfilters",
  "capacity",
  "wimeta",
  "votes",
  "planreviews",
  "improvements",
  "snapshots",
  "leancases",
  "lpmsettings",
  "budgets",
  "audit",
];

export async function exportData(): Promise<SafeBackup> {
  const project = getProject();
  const lists = await Promise.all(DATA_COLLECTIONS.map((name) => getDocs<BackupDoc>(collection(name)())));
  const collections: Record<string, BackupDoc[]> = {};
  // Etags belong to this organization's copy; a restore writes fresh ones.
  DATA_COLLECTIONS.forEach((name, i) => (collections[name] = lists[i].map(({ __etag, ...doc }) => doc as BackupDoc)));
  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: currentUser(),
    project: { id: project.id, name: project.name },
    config: await loadConfig(),
    collections,
  };
}

/**
 * Restores the documents of a validated backup (the configuration is saved separately, through
 * the shell, so every view picks it up). "merge" adds and replaces documents by id; "overwrite"
 * also deletes documents missing from the backup. The change log is merged, never deleted.
 */
export async function importData(backup: SafeBackup, mode: ImportMode): Promise<{ written: number; deleted: number }> {
  const m = await manager();
  let written = 0;
  let deleted = 0;
  for (const name of DATA_COLLECTIONS) {
    const docs = backup.collections[name] ?? [];
    const coll = collection(name)();
    if (mode === "overwrite" && name !== "audit") {
      const keep = new Set(docs.map((d) => d.id));
      for (const existing of await getDocs<BackupDoc>(coll)) {
        if (keep.has(existing.id)) continue;
        await m.deleteDocument(coll, existing.id, { scopeType: "Default" });
        deleted++;
      }
    }
    // __etag -1 overwrites whatever version is stored.
    for (const doc of docs) {
      await m.setDocument(coll, { ...doc, __etag: -1 }, { scopeType: "Default" });
      written++;
    }
  }
  await appendAudit({
    collection: "backup",
    docId: "import",
    action: "import",
    label: `Restored ${written} document${written === 1 ? "" : "s"} (${mode}) from ${backup.project.name} · ${backup.exportedAt}`,
  });
  return { written, deleted };
}
