import * as SDK from "azure-devops-extension-sdk";
import type { IExtensionDataManager, IExtensionDataService } from "azure-devops-extension-api/Common/CommonServices";
import { getProject, ServiceIds } from "./client";
import type { QuickFilter } from "./filters";
import type { ConfidenceVote, ImprovementItem, PlanReview } from "./planning";
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
  return m.setValue<SafeConfig>(configKey(), config, { scopeType: "Default" });
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

async function setDoc<T extends { id: string }>(collection: string, doc: T): Promise<T> {
  const m = await manager();
  return m.setDocument(collection, doc, { scopeType: "Default" });
}

async function deleteDoc(collection: string, id: string): Promise<void> {
  const m = await manager();
  await m.deleteDocument(collection, id, { scopeType: "Default" });
}

export const objectivesStore = {
  list: () => getDocs<PiObjective>(objectivesCollection()),
  get: (id: string) => getDoc<PiObjective>(objectivesCollection(), id),
  save: (o: PiObjective) => setDoc(objectivesCollection(), o),
  remove: (id: string) => deleteDoc(objectivesCollection(), id),
};

export const risksStore = {
  list: () => getDocs<Risk>(risksCollection()),
  get: (id: string) => getDoc<Risk>(risksCollection(), id),
  save: (r: Risk) => setDoc(risksCollection(), r),
  remove: (id: string) => deleteDoc(risksCollection(), id),
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

function docStore<T extends { id: string }>(name: string) {
  const coll = collection(name);
  return {
    list: () => getDocs<T>(coll()),
    /** One document by id (undefined when missing) — avoids loading the whole collection. */
    get: (id: string) => getDoc<T>(coll(), id),
    save: (doc: T) => setDoc(coll(), doc),
    remove: (id: string) => deleteDoc(coll(), id),
  };
}

export const milestonesStore = docStore<Milestone>("milestones");
export const quickFiltersStore = docStore<QuickFilter>("quickfilters");
export const capacityStore = docStore<IterationCapacity>("capacity");
export const metaStore = docStore<WorkItemMeta>("wimeta");
export const votesStore = docStore<ConfidenceVote>("votes");
export const planReviewsStore = docStore<PlanReview>("planreviews");
export const inspectAdaptStore = docStore<ImprovementItem>("improvements");

export const capacityId = (nodeId: string, iterationPath: string) => `${nodeId}|${iterationPath}`;

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
