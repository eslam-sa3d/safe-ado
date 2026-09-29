import * as SDK from "azure-devops-extension-sdk";
import type { IWorkItemFormNavigationService } from "azure-devops-extension-api/WorkItemTracking/WorkItemTrackingServices";
import { api, chunk, getBaseUrl, getProject, ServiceIds, wiqlString } from "./client";
import { ProgramIncrement, Sprint, WorkItem } from "./types";

const p = () => encodeURIComponent(getProject().id);

// ---------------------------------------------------------------------------------------------
// WIQL + work items
// ---------------------------------------------------------------------------------------------

interface WiqlFlatResult {
  workItems: { id: number }[];
}

interface WiqlLinkResult {
  workItemRelations: { source: { id: number } | null; target: { id: number }; rel: string | null }[];
}

export async function queryIds(wiql: string): Promise<number[]> {
  const res = await api<WiqlFlatResult>(`${p()}/_apis/wit/wiql?$top=5000`, { method: "POST", body: { query: wiql } });
  return res.workItems.map((w) => w.id);
}

/** Runs a WorkItemLinks query and returns parent -> child edges (roots have parent null). */
export async function queryLinks(wiql: string): Promise<{ parent: number | null; child: number }[]> {
  const res = await api<WiqlLinkResult>(`${p()}/_apis/wit/wiql`, { method: "POST", body: { query: wiql } });
  return res.workItemRelations.map((r) => ({ parent: r.source?.id ?? null, child: r.target.id }));
}

/**
 * Fetches work items in batches of 200 (the REST limit). The batch API rejects `fields`
 * together with `$expand`, so relations mode returns all fields.
 */
export async function getWorkItems(ids: number[], fields?: string[], withRelations = false): Promise<WorkItem[]> {
  const unique = Array.from(new Set(ids));
  const batches = await Promise.all(
    chunk(unique, 200).map((batch) =>
      api<{ value: WorkItem[] }>(`${p()}/_apis/wit/workitemsbatch`, {
        method: "POST",
        body: withRelations
          ? { ids: batch, $expand: "Relations", errorPolicy: "Omit" }
          : { ids: batch, fields, errorPolicy: "Omit" },
      })
    )
  );
  return batches.flatMap((b) => b.value).filter(Boolean);
}

export async function queryWorkItems(wiql: string, fields: string[], withRelations = false): Promise<WorkItem[]> {
  const ids = await queryIds(wiql);
  if (ids.length === 0) return [];
  const items = await getWorkItems(ids, fields, withRelations);
  // Preserve WIQL ordering.
  const order = new Map(ids.map((id, i) => [id, i]));
  return items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

type PatchOp = { op: "add" | "replace" | "remove" | "test"; path: string; value?: unknown };

export function updateWorkItem(id: number, ops: PatchOp[]): Promise<WorkItem> {
  return api<WorkItem>(`_apis/wit/workitems/${id}`, {
    method: "PATCH",
    body: ops,
    contentType: "application/json-patch+json",
  });
}

export async function setFields(id: number, fields: Record<string, unknown>): Promise<WorkItem> {
  return updateWorkItem(
    id,
    Object.entries(fields).map(([k, v]) => ({ op: "add" as const, path: `/fields/${k}`, value: v }))
  );
}

/** Adds a link from `sourceId` to `targetId` (e.g. successor dependency). */
export async function addLink(sourceId: number, targetId: number, rel: string, comment?: string): Promise<WorkItem> {
  const base = await getBaseUrl();
  return updateWorkItem(sourceId, [
    {
      op: "add",
      path: "/relations/-",
      value: { rel, url: `${base}_apis/wit/workItems/${targetId}`, attributes: comment ? { comment } : {} },
    },
  ]);
}

export async function removeLink(sourceId: number, targetId: number, rel: string): Promise<void> {
  const [item] = await getWorkItems([sourceId], undefined, true);
  const index = (item?.relations ?? []).findIndex((r) => r.rel === rel && relationTargetId(r.url) === targetId);
  if (index >= 0) await updateWorkItem(sourceId, [{ op: "remove", path: `/relations/${index}` }]);
}

export function relationTargetId(url: string): number | null {
  const m = /\/workItems\/(\d+)$/i.exec(url);
  return m ? Number(m[1]) : null;
}

export async function openWorkItem(id: number): Promise<void> {
  const nav = await SDK.getService<IWorkItemFormNavigationService>(ServiceIds.workItemForm);
  await nav.openWorkItem(id);
}

export async function openNewWorkItem(type: string, fields: Record<string, string | number>): Promise<void> {
  const nav = await SDK.getService<IWorkItemFormNavigationService>(ServiceIds.workItemForm);
  await nav.openNewWorkItem(type, fields);
}

// ---------------------------------------------------------------------------------------------
// Metadata: types, states, fields
// ---------------------------------------------------------------------------------------------

export interface WitType {
  name: string;
  referenceName: string;
  isDisabled?: boolean;
}

export async function getWorkItemTypes(): Promise<WitType[]> {
  const res = await api<{ value: WitType[] }>(`${p()}/_apis/wit/workitemtypes`);
  return res.value.filter((t) => !t.isDisabled);
}

export interface WitState {
  name: string;
  category: "Proposed" | "InProgress" | "Resolved" | "Completed" | "Removed" | string;
  color: string;
}

const stateCache = new Map<string, Promise<WitState[]>>();

export function getStates(type: string): Promise<WitState[]> {
  if (!type) return Promise.resolve([]);
  if (!stateCache.has(type)) {
    const request = api<{ value: WitState[] }>(`${p()}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states`).then(
      (r) => r.value
    );
    // Don't let a transient failure poison the cache for the rest of the session.
    request.catch(() => stateCache.get(type) === request && stateCache.delete(type));
    stateCache.set(type, request);
  }
  return stateCache.get(type)!;
}

/** Map of "Type|State" -> category, covering the given types. */
export async function getStateCategories(types: string[]): Promise<(type: string, state: string) => string> {
  const map = new Map<string, string>();
  await Promise.all(
    types.filter(Boolean).map(async (t) => (await getStates(t)).forEach((s) => map.set(`${t}|${s.name}`, s.category)))
  );
  return (type, state) => map.get(`${type}|${state}`) ?? "InProgress";
}

export async function getFieldNames(): Promise<{ name: string; referenceName: string; type: string }[]> {
  const res = await api<{ value: { name: string; referenceName: string; type: string }[] }>(`${p()}/_apis/wit/fields`);
  return res.value;
}

// ---------------------------------------------------------------------------------------------
// Classification nodes (areas / iterations)
// ---------------------------------------------------------------------------------------------

export interface ClassificationNode {
  id: number;
  identifier: string;
  name: string;
  path: string;
  hasChildren?: boolean;
  children?: ClassificationNode[];
  attributes?: { startDate?: string; finishDate?: string };
}

/**
 * Classification node paths look like "\\Project\\Iteration\\PI 1\\Sprint 1".
 * Work item fields use "Project\\PI 1\\Sprint 1".
 */
export function nodePathToFieldPath(nodePath: string): string {
  const parts = nodePath.replace(/^\\/, "").split("\\");
  parts.splice(1, 1);
  return parts.join("\\");
}

async function getNodeTree(structure: "Areas" | "Iterations"): Promise<ClassificationNode> {
  return api<ClassificationNode>(`${p()}/_apis/wit/classificationnodes/${structure}?$depth=10`);
}

/** Flattened list of area paths in field form. */
export async function getAreaPaths(): Promise<string[]> {
  const root = await getNodeTree("Areas");
  const out: string[] = [];
  const walk = (n: ClassificationNode) => {
    out.push(nodePathToFieldPath(n.path));
    n.children?.forEach(walk);
  };
  walk(root);
  return out;
}

export async function getAreaTree(): Promise<ClassificationNode> {
  return getNodeTree("Areas");
}

export async function getIterationTree(): Promise<ClassificationNode> {
  return getNodeTree("Iterations");
}

export async function getIterationPaths(): Promise<string[]> {
  const root = await getIterationTree();
  const out: string[] = [];
  const walk = (n: ClassificationNode) => {
    out.push(nodePathToFieldPath(n.path));
    n.children?.forEach(walk);
  };
  walk(root);
  return out;
}

function toSprint(n: ClassificationNode): Sprint {
  return {
    name: n.name,
    path: nodePathToFieldPath(n.path),
    identifier: n.identifier,
    start: n.attributes?.startDate,
    finish: n.attributes?.finishDate,
  };
}

function findNode(root: ClassificationNode, fieldPath: string): ClassificationNode | undefined {
  if (nodePathToFieldPath(root.path).toLowerCase() === fieldPath.toLowerCase()) return root;
  for (const c of root.children ?? []) {
    const hit = findNode(c, fieldPath);
    if (hit) return hit;
  }
  return undefined;
}

/** PIs are the direct children of the PI root iteration; their children are the sprints. */
export async function getProgramIncrements(piRoot: string): Promise<ProgramIncrement[]> {
  const tree = await getIterationTree();
  const root = findNode(tree, piRoot) ?? tree;
  const byStart = (a: Sprint, b: Sprint) => (a.start ?? "9999").localeCompare(b.start ?? "9999");
  return (root.children ?? [])
    .map((pi) => ({ ...toSprint(pi), sprints: (pi.children ?? []).map(toSprint).sort(byStart) }))
    .sort(byStart);
}

/** Creates an iteration under `parentFieldPath` (a field-form path, may be the project root). */
export async function createIteration(
  parentFieldPath: string,
  name: string,
  startDate?: string,
  finishDate?: string
): Promise<ClassificationNode> {
  const relative = parentFieldPath.split("\\").slice(1).map(encodeURIComponent).join("/");
  const attributes = startDate && finishDate ? { startDate, finishDate } : undefined;
  const suffix = relative ? `/${relative}` : "";
  return api<ClassificationNode>(`${p()}/_apis/wit/classificationnodes/Iterations${suffix}`, {
    method: "POST",
    body: { name, attributes },
  });
}

// ---------------------------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------------------------

export interface Team {
  id: string;
  name: string;
}

export async function getTeams(): Promise<Team[]> {
  const res = await api<{ value: Team[] }>(`_apis/projects/${p()}/teams?$top=1000`);
  return res.value.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTeamDefaultArea(teamId: string): Promise<string | undefined> {
  const res = await api<{ defaultValue?: string; field?: { referenceName: string } }>(
    `${p()}/${encodeURIComponent(teamId)}/_apis/work/teamsettings/teamfieldvalues`
  );
  return res.field?.referenceName === "System.AreaPath" ? res.defaultValue : undefined;
}

/** Subscribes a team to an iteration so it shows up in the team's sprint list. */
export async function addTeamIteration(teamId: string, iterationIdentifier: string): Promise<void> {
  await api(`${p()}/${encodeURIComponent(teamId)}/_apis/work/teamsettings/iterations`, {
    method: "POST",
    body: { id: iterationIdentifier },
  });
}

// ---------------------------------------------------------------------------------------------
// WIQL helpers
// ---------------------------------------------------------------------------------------------

/**
 * `field` is a full WIQL field expression, e.g. "[System.AreaPath]" or "[Source].[System.AreaPath]".
 * No paths means nothing is in scope: an unconfigured node must not see the whole project.
 */
export function underAny(field: string, paths: string[]): string {
  if (paths.length === 0) return "[System.Id] < 0";
  return "(" + paths.map((a) => `${field} UNDER ${wiqlString(a)}`).join(" OR ") + ")";
}

export function typeIn(types: string[], field = "[System.WorkItemType]"): string {
  const list = Array.from(new Set(types.filter(Boolean))).map(wiqlString).join(", ");
  return `${field} IN (${list})`;
}

export function isUnder(path: string | undefined, parent: string): boolean {
  if (!path) return false;
  const a = path.toLowerCase();
  const b = parent.toLowerCase();
  return a === b || a.startsWith(b + "\\");
}
