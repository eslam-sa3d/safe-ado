import * as SDK from "azure-devops-extension-sdk";
import type { IWorkItemFormNavigationService } from "azure-devops-extension-api/WorkItemTracking/WorkItemTrackingServices";
import { api, chunk, getBaseUrl, getProject, mapLimit, ServiceIds, wiqlString } from "./client";
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

/**
 * WIQL paging. Azure DevOps returns at most 20,000 ids per flat query; when a page is full we
 * continue with "[System.Id] > last" ordered by id, so large backlogs are never cut off silently.
 */
export const wiqlPaging = { pageSize: 20000, maxItems: 200000 };

export class QueryLimitError extends Error {}

/** Index of the top-level " ORDER BY " (outside string literals), or -1. */
export function orderByIndex(query: string): number {
  let inString = false;
  for (let i = 0; i < query.length; i++) {
    if (query[i] === "'") inString = !inString;
    else if (!inString && /^ ORDER BY /i.test(query.slice(i, i + 10))) return i;
  }
  return -1;
}

function insertBeforeOrderBy(query: string, clause: string): string {
  const i = orderByIndex(query);
  return i < 0 ? `${query} ${clause}` : `${query.slice(0, i)} ${clause}${query.slice(i)}`;
}

export async function queryIds(wiql: string): Promise<number[]> {
  const size = wiqlPaging.pageSize;
  const first = await api<WiqlFlatResult>(`${p()}/_apis/wit/wiql?$top=${size}`, { method: "POST", body: { query: wiql } });
  if (first.workItems.length < size) return first.workItems.map((w) => w.id);

  // A full page may be truncated. The first page follows the query's own ORDER BY, so we can't
  // continue from it; restart in id order and walk pages with "[System.Id] > last".
  const cut = orderByIndex(wiql);
  const unordered = cut < 0 ? wiql : wiql.slice(0, cut);
  const ids: number[] = [];
  let last = 0;
  for (;;) {
    const page = await api<WiqlFlatResult>(`${p()}/_apis/wit/wiql?$top=${size}`, {
      method: "POST",
      body: { query: `${insertBeforeOrderBy(unordered, `AND [System.Id] > ${last}`)} ORDER BY [System.Id] ASC` },
    });
    const next = page.workItems.map((w) => w.id).filter((id) => id > last);
    ids.push(...next);
    if (ids.length > wiqlPaging.maxItems) throw new QueryLimitError(`The query matches more than ${wiqlPaging.maxItems} work items. Narrow the scope or filters.`);
    if (page.workItems.length < size || next.length === 0) return ids;
    last = Math.max(...next);
  }
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
  // At most 4 batch requests in flight, to stay clear of Azure DevOps throttling.
  const batches = await mapLimit(chunk(unique, 200), 4, (batch) =>
      api<{ value: WorkItem[] }>(`${p()}/_apis/wit/workitemsbatch`, {
        method: "POST",
        body: withRelations
          ? { ids: batch, $expand: "Relations", errorPolicy: "Omit" }
          : { ids: batch, fields, errorPolicy: "Omit" },
      })
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
export class PiRootNotFoundError extends Error {}

export async function getProgramIncrements(piRoot: string): Promise<ProgramIncrement[]> {
  const tree = await getIterationTree();
  const root = findNode(tree, piRoot);
  // Never fall back silently to the whole project: that would turn every iteration into a "PI".
  if (!root) throw new PiRootNotFoundError(`The PI root iteration "${piRoot}" was not found. It may have been renamed or deleted; choose it again in Setup.`);
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

/** An empty type list (e.g. a level the process doesn't have) matches nothing rather than producing invalid WIQL. */
export function typeIn(types: string[], field = "[System.WorkItemType]"): string {
  const list = Array.from(new Set(types.filter(Boolean))).map(wiqlString).join(", ");
  return list ? `${field} IN (${list})` : "[System.Id] < 0";
}

export function isUnder(path: string | undefined, parent: string): boolean {
  if (!path) return false;
  const a = path.toLowerCase();
  const b = parent.toLowerCase();
  return a === b || a.startsWith(b + "\\");
}

// ---------------------------------------------------------------------------------------------
// Create / iteration maintenance
// ---------------------------------------------------------------------------------------------

/** Creates a work item of `type` with the given fields (POST json-patch). */
export async function createWorkItem(type: string, fields: Record<string, unknown>): Promise<WorkItem> {
  return api<WorkItem>(`${p()}/_apis/wit/workitems/$${encodeURIComponent(type)}`, {
    method: "POST",
    body: Object.entries(fields).map(([k, v]) => ({ op: "add", path: `/fields/${k}`, value: v })),
    contentType: "application/json-patch+json",
  });
}

function iterationUrl(fieldPath: string): string {
  const relative = fieldPath.split("\\").slice(1).map(encodeURIComponent).join("/");
  return `${p()}/_apis/wit/classificationnodes/Iterations${relative ? `/${relative}` : ""}`;
}

/** Renames an iteration and/or changes its dates. */
export async function updateIteration(
  fieldPath: string,
  changes: { name?: string; startDate?: string; finishDate?: string }
): Promise<ClassificationNode> {
  const body: Record<string, unknown> = {};
  if (changes.name) body.name = changes.name;
  if (changes.startDate && changes.finishDate) body.attributes = { startDate: changes.startDate, finishDate: changes.finishDate };
  return api<ClassificationNode>(iterationUrl(fieldPath), { method: "PATCH", body });
}

/**
 * Deletes an iteration (and its children). Work items in it are moved to `reclassifyToId`,
 * the numeric node id Azure DevOps requires for reclassification.
 */
export async function deleteIteration(fieldPath: string, reclassifyToId: number): Promise<void> {
  await api(`${iterationUrl(fieldPath)}?$reclassifyId=${reclassifyToId}`, { method: "DELETE" });
}

/** Returns the numeric id of an iteration node by field path (needed for reclassification). */
export async function getIterationNodeId(fieldPath: string): Promise<number | undefined> {
  const res = await api<ClassificationNode>(iterationUrl(fieldPath));
  return res?.id;
}

export interface TeamIteration {
  id: string;
  name: string;
  path: string;
  attributes?: { startDate?: string; finishDate?: string; timeFrame?: "past" | "current" | "future" };
}

/** Iterations a team is subscribed to (Agile Hive "sprint mapping"). */
export async function getTeamIterations(teamId: string): Promise<TeamIteration[]> {
  const res = await api<{ value: TeamIteration[] }>(`${p()}/${encodeURIComponent(teamId)}/_apis/work/teamsettings/iterations`);
  return res.value;
}

export async function removeTeamIteration(teamId: string, iterationIdentifier: string): Promise<void> {
  await api(`${p()}/${encodeURIComponent(teamId)}/_apis/work/teamsettings/iterations/${iterationIdentifier}`, { method: "DELETE" });
}

/**
 * Checks a user-entered WIQL clause against the server before applying it. Returns the server's
 * error message, or null when the clause is valid.
 */
export async function validateWiqlClause(clause: string): Promise<string | null> {
  try {
    await api(`${p()}/_apis/wit/wiql?$top=1`, {
      method: "POST",
      body: { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND (${clause})` },
    });
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

export interface Identity {
  id: string;
  displayName: string;
  uniqueName: string;
  imageUrl?: string;
}

/** Members of an Azure DevOps team (for assignee and member pickers). */
export async function getTeamMembers(teamId: string): Promise<Identity[]> {
  const res = await api<{ value: { identity: Identity }[] }>(`_apis/projects/${p()}/teams/${encodeURIComponent(teamId)}/members?$top=500`);
  return res.value.map((m) => m.identity);
}

export interface RelationType {
  referenceName: string;
  name: string;
  attributes?: { usage?: string; topology?: string };
}

/** Work item link types (for the dependency link setting). */
export async function getRelationTypes(): Promise<RelationType[]> {
  const res = await api<{ value: RelationType[] }>(`_apis/wit/workitemrelationtypes`);
  return res.value.filter((t) => t.attributes?.usage !== "resourceLink");
}

export interface Revision {
  id: number;
  rev: number;
  fields: Record<string, any>;
}

/**
 * Work item revisions from the reporting API (history for burnups and rolled-over items).
 * Pages through continuation tokens; limited to the given types and fields.
 */
/** Revisions plus whether the page limit cut the history short (then the newest revisions are missing). */
export type RevisionList = Revision[] & { truncated?: boolean };

export const revisionPaging = { maxPages: 50 };

export async function getRevisions(types: string[], fields: string[], startDateTime?: string): Promise<RevisionList> {
  const out: RevisionList = [];
  let token: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= revisionPaging.maxPages) {
      out.truncated = true;
      break;
    }
    const qs = [token ? `continuationToken=${encodeURIComponent(token)}` : "", startDateTime ? `startDateTime=${encodeURIComponent(startDateTime)}` : ""].filter(Boolean).join("&");
    const res = await api<{ values: Revision[]; isLastBatch?: boolean; continuationToken?: string }>(
      `${p()}/_apis/wit/reporting/workitemrevisions${qs ? `?${qs}` : ""}`,
      { method: "POST", body: { types: types.filter(Boolean), fields } }
    );
    out.push(...res.values);
    if (res.isLastBatch !== false || !res.continuationToken) break;
    token = res.continuationToken;
  }
  return out;
}
