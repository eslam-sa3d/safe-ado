import { Criticality, F, LINK, ProgramIncrement, Sprint, WorkItem, WorkItemMeta } from "./types";
import {
  calculatedSprintIndex,
  criticalityByIteration,
  DEFAULT_DEPENDENCY_LINK,
  dependenciesOf,
  DependencyLinkTypes,
  sprintIndex,
} from "./dependencies";
import type { ExtraFacet } from "./filters";
import { getBaseUrl } from "./client";
import { getStates, isUnder, relationTargetId, removeLink, updateWorkItem } from "./wit";
import { MAX_ASSIGNED_PIS, PI_LIMIT_MESSAGE } from "../form/planning";
import { localToday, wsjfOf } from "./rules";

/**
 * Pure logic behind the Team Planning Board (Agile Hive's "breakout board"): iteration
 * status, load, parent resolution, swimlane building, sorting and dependency criticality.
 */

export type IterationStatus = "past" | "current" | "future";

/** Today as YYYY-MM-DD (UTC, like the iteration dates Azure DevOps returns). */
export function todayIso(now: Date = new Date()): string {
  return localToday(now);
}

/** An iteration is past once its finish date is before today; undated iterations are future. */
export function iterationStatus(sprint: Pick<Sprint, "start" | "finish">, today: string): IterationStatus {
  const start = sprint.start?.slice(0, 10);
  const finish = sprint.finish?.slice(0, 10);
  if (finish && finish < today) return "past";
  if (start && finish && start <= today) return "current";
  return "future";
}

export function storyPoints(item: WorkItem, field: string): number {
  return Number(item.fields[field] ?? 0) || 0;
}

/** Story points per sprint (index-aligned with `sprintPaths`). */
export function sprintLoads(items: WorkItem[], sprintPaths: string[], field: string): number[] {
  const loads = sprintPaths.map(() => 0);
  for (const item of items) {
    const i = sprintIndex(item.fields[F.iteration], sprintPaths);
    if (i >= 0) loads[i] += storyPoints(item, field);
  }
  return loads;
}

/** Story-level types offered on the board: the configured story type plus Bug when the process has it. */
export function storyLevelTypes(storyType: string, available: string[]): string[] {
  return Array.from(new Set([storyType, ...["Bug"].filter((t) => available.includes(t))].filter(Boolean)));
}

/**
 * Resolves each story's parent among `features`. Uses the story's own Parent link first and
 * falls back to a feature's Child link (either side of the link may be the one returned).
 */
export function parentMap(stories: WorkItem[], features: WorkItem[]): Map<number, number> {
  const featureIds = new Set(features.map((f) => f.id));
  const childToParent = new Map<number, number>();
  for (const f of features) {
    for (const rel of f.relations ?? []) {
      const child = rel.rel === LINK.child ? relationTargetId(rel.url) : null;
      if (child !== null && !childToParent.has(child)) childToParent.set(child, f.id);
    }
  }
  const out = new Map<number, number>();
  for (const s of stories) {
    const own = (s.relations ?? []).find((r) => r.rel === LINK.parent);
    const ownId = own ? relationTargetId(own.url) : null;
    if (ownId !== null) {
      if (featureIds.has(ownId)) out.set(s.id, ownId);
      continue;
    }
    const viaChild = childToParent.get(s.id);
    if (viaChild !== undefined) out.set(s.id, viaChild);
  }
  return out;
}

/** Id of the story's parent according to its own relations (any type), or null. */
export function ownParentId(item: WorkItem): number | null {
  const rel = (item.relations ?? []).find((r) => r.rel === LINK.parent);
  return rel ? relationTargetId(rel.url) : null;
}

export const INDEPENDENT = "independent";

export interface Lane {
  /** Feature id as a string, or INDEPENDENT. */
  key: string;
  title: string;
  feature?: WorkItem;
  stories: WorkItem[];
  /** True when the lane exists only because the feature is assigned to this team and PI. */
  assigned: boolean;
}

export function isAssigned(meta: WorkItemMeta | undefined, nodeId: string, piPath: string): boolean {
  return !!meta && meta.assignedNodeIds.includes(nodeId) && meta.assignedPiPaths.includes(piPath);
}

/**
 * One lane per Feature parent of the team's stories, plus features assigned to the team for
 * the PI, ordered by stack rank then id; the Independent lane comes last.
 */
export function buildLanes(
  stories: WorkItem[],
  features: WorkItem[],
  parents: Map<number, number>,
  metas: Map<number, WorkItemMeta>,
  nodeId: string,
  piPath: string
): Lane[] {
  const byId = new Map(features.map((f) => [f.id, f]));
  const lanes = new Map<number, Lane>();
  const laneFor = (f: WorkItem): Lane => {
    let lane = lanes.get(f.id);
    if (!lane) {
      lane = { key: String(f.id), title: f.fields[F.title], feature: f, stories: [], assigned: false };
      lanes.set(f.id, lane);
    }
    return lane;
  };
  const independent: Lane = { key: INDEPENDENT, title: "Independent", stories: [], assigned: false };
  for (const s of stories) {
    const parent = byId.get(parents.get(s.id) ?? -1);
    (parent ? laneFor(parent) : independent).stories.push(s);
  }
  for (const f of features) {
    if (isAssigned(metas.get(f.id), nodeId, piPath)) laneFor(f).assigned = true;
  }
  const rank = (l: Lane) => Number(l.feature!.fields[F.stackRank] ?? Number.MAX_SAFE_INTEGER);
  const sorted = Array.from(lanes.values()).sort((a, b) => rank(a) - rank(b) || a.feature!.id - b.feature!.id);
  return [...sorted, independent];
}

type PiRef = Pick<Sprint, "path" | "identifier">;

/** Index of the PI among the meta's Assigned PIs: by stable id first, then by path. */
function piIndex(meta: WorkItemMeta, pi: PiRef): number {
  const ids = meta.assignedPiIds ?? [];
  return meta.assignedPiPaths.findIndex((path, i) => (!!ids[i] && ids[i] === pi.identifier) || path.toLowerCase() === pi.path.toLowerCase());
}

/** Assigned PI ids aligned with the paths (legacy metas without ids get blanks). */
const alignedIds = (meta: WorkItemMeta) => meta.assignedPiPaths.map((_, i) => meta.assignedPiIds?.[i] ?? "");

/**
 * Adds the team and PI to the meta's assignments, keeping `assignedPiIds` in step with
 * `assignedPiPaths`. Throws when the item already has the maximum number of Assigned PIs.
 */
export function assignMeta(meta: WorkItemMeta, nodeId: string, pi: PiRef): WorkItemMeta {
  const assignedNodeIds = meta.assignedNodeIds.includes(nodeId) ? meta.assignedNodeIds : [...meta.assignedNodeIds, nodeId];
  if (piIndex(meta, pi) >= 0) return { ...meta, assignedNodeIds };
  if (meta.assignedPiPaths.length >= MAX_ASSIGNED_PIS) throw new Error(PI_LIMIT_MESSAGE);
  return {
    ...meta,
    assignedNodeIds,
    assignedPiPaths: [...meta.assignedPiPaths, pi.path],
    assignedPiIds: [...alignedIds(meta), pi.identifier],
  };
}

/** Removes the team; the PI (path and id) goes too when no other team remains assigned. */
export function unassignMeta(meta: WorkItemMeta, nodeId: string, pi: PiRef): WorkItemMeta {
  const assignedNodeIds = meta.assignedNodeIds.filter((n) => n !== nodeId);
  const i = piIndex(meta, pi);
  if (assignedNodeIds.length || i < 0) return { ...meta, assignedNodeIds };
  const keep = (_: string, j: number) => j !== i;
  return { ...meta, assignedNodeIds, assignedPiPaths: meta.assignedPiPaths.filter(keep), assignedPiIds: alignedIds(meta).filter(keep) };
}

/** WSJF (shared formula in api/rules.ts), or undefined when not computable. */
export function wsjf(item: WorkItem, rroeField?: string): number | undefined {
  return wsjfOf(item.fields, rroeField) ?? undefined;
}

export type SortKey = "rank" | "priority" | "points" | "id" | "wsjf";

/** Sorts a copy. Priority ascending (1 first), points and WSJF descending; missing values last. */
export function sortItems(items: WorkItem[], by: SortKey, pointsField: string, rroeField?: string): WorkItem[] {
  const value = (i: WorkItem): number | undefined => {
    switch (by) {
      case "priority":
        return i.fields[F.priority] === undefined ? undefined : Number(i.fields[F.priority]);
      case "points":
        return i.fields[pointsField] === undefined ? undefined : -Number(i.fields[pointsField]);
      case "wsjf": {
        const w = wsjf(i, rroeField);
        return w === undefined ? undefined : -w;
      }
      case "id":
        return i.id;
      default:
        return undefined;
    }
  };
  if (by === "rank") return [...items];
  return [...items].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === vb) return a.id - b.id;
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    return va - vb;
  });
}

export function searchItems(items: WorkItem[], query: string): WorkItem[] {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (!q) return items;
  return items.filter((i) => String(i.fields[F.title] ?? "").toLowerCase().includes(q) || String(i.id).includes(q));
}

/** Items on the team backlog that are not planned in any of the PI's sprints and still open. */
export function unplannedStories(items: WorkItem[], sprintPaths: string[], category: (type: string, state: string) => string): WorkItem[] {
  return items.filter((i) => {
    const cat = category(i.fields[F.type], i.fields[F.state]);
    return cat !== "Completed" && cat !== "Removed" && sprintIndex(i.fields[F.iteration], sprintPaths) < 0;
  });
}

export function isOpen(item: WorkItem, category: (type: string, state: string) => string): boolean {
  const cat = category(item.fields[F.type], item.fields[F.state]);
  return cat !== "Completed" && cat !== "Removed";
}

export interface BoardDependency {
  provider: number;
  consumer: number;
  criticality: Criticality;
}

/**
 * Dependencies touching `items`, rated by sprint index. `lookup` resolves both ends (board
 * items and external items); pairs with an unknown end are rated with index -1 (at risk).
 * `link` is the configured dependency link type; `indexOf` overrides an item's placement
 * (e.g. external features placed by their children or target date).
 */
export function boardDependencies(
  items: WorkItem[],
  lookup: Map<number, WorkItem>,
  sprintPaths: string[],
  category: (type: string, state: string) => string,
  link: DependencyLinkTypes = DEFAULT_DEPENDENCY_LINK,
  indexOf?: (id: number) => number | undefined
): BoardDependency[] {
  const idx = (id: number) => indexOf?.(id) ?? sprintIndex(lookup.get(id)?.fields[F.iteration], sprintPaths);
  return dependenciesOf(items, link).map(({ provider, consumer }) => {
    const p = lookup.get(provider);
    const done = !!p && category(p.fields[F.type], p.fields[F.state]) === "Completed";
    return { provider, consumer, criticality: criticalityByIteration(idx(provider), idx(consumer), done) };
  });
}

/** Ids referenced by dependency links of `items` that are not among them. */
export function externalIds(items: WorkItem[], link: DependencyLinkTypes = DEFAULT_DEPENDENCY_LINK): number[] {
  const own = new Set(items.map((i) => i.id));
  const out = new Set<number>();
  for (const d of dependenciesOf(items, link)) {
    if (!own.has(d.provider)) out.add(d.provider);
    if (!own.has(d.consumer)) out.add(d.consumer);
  }
  return Array.from(out).sort((a, b) => a - b);
}

export interface ExternalGroup {
  area: string;
  items: WorkItem[];
}

/** External items grouped by area path (sorted). */
export function groupByArea(items: WorkItem[]): ExternalGroup[] {
  const map = new Map<string, WorkItem[]>();
  for (const i of items) {
    const area = String(i.fields[F.area] ?? "");
    map.set(area, [...(map.get(area) ?? []), i]);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([area, list]) => ({ area, items: list }));
}

/** Drag payloads: "story:<id>" (team backlog / board card) or "feature:<id>" (ART backlog). */
export type DragPayload = { kind: "story" | "feature"; id: number };

export function encodeDrag(p: DragPayload): string {
  return `${p.kind}:${p.id}`;
}

export function decodeDrag(raw: string): DragPayload | null {
  const m = /^(story|feature):(\d+)$/.exec(raw.trim());
  if (m) return { kind: m[1] as DragPayload["kind"], id: Number(m[2]) };
  const n = Number(raw);
  return raw.trim() && Number.isInteger(n) && n > 0 ? { kind: "story", id: n } : null;
}

/** Fields to write when a story is dropped into `sprintPath` of the team whose area is `teamArea`. */
export function moveChanges(item: WorkItem, sprintPath: string, teamArea: string | undefined): Record<string, string> {
  const changes: Record<string, string> = {};
  if (item.fields[F.iteration] !== sprintPath) changes[F.iteration] = sprintPath;
  if (teamArea && !isUnder(item.fields[F.area], teamArea)) changes[F.area] = teamArea;
  return changes;
}

// ---------------------------------------------------------------------------------------------
// Team board v2: PI markers, rolled-over items, edge indicators, external placement, facets
// ---------------------------------------------------------------------------------------------

/** The PI whose iteration subtree contains `iteration`, if any. */
export function piOf<T extends Pick<Sprint, "path">>(iteration: string | undefined, pis: T[]): T | undefined {
  return iteration ? pis.find((p) => isUnder(iteration, p.path)) : undefined;
}

/** Names of the meta's Assigned PIs: matched by stable id first, then by path; unknown paths show their last segment. */
export function assignedPiNames(meta: WorkItemMeta | undefined, pis: Pick<ProgramIncrement, "path" | "name" | "identifier">[]): string[] {
  if (!meta) return [];
  const out: string[] = [];
  meta.assignedPiPaths.forEach((path, i) => {
    const id = meta.assignedPiIds?.[i];
    const pi = (id ? pis.find((p) => p.identifier === id) : undefined) ?? pis.find((p) => p.path.toLowerCase() === path.toLowerCase());
    const name = pi ? pi.name : path.split("\\").pop() || path;
    if (!out.includes(name)) out.push(name);
  });
  return out;
}

/** Adds the PI (path and stable id) to the meta's Assigned PIs. */
export function assignPiMeta(meta: WorkItemMeta, pi: Pick<Sprint, "path" | "identifier">): WorkItemMeta {
  if (meta.assignedPiPaths.includes(pi.path)) return meta;
  const ids = meta.assignedPiIds ?? meta.assignedPiPaths.map(() => "");
  return { ...meta, assignedPiPaths: [...meta.assignedPiPaths, pi.path], assignedPiIds: [...ids, pi.identifier] };
}

export type MarkerKind = "otherPi" | "noSprint" | "assignedHere" | "assignedOther";

export interface BacklogMarker {
  kind: MarkerKind;
  label: string;
}

/**
 * Sidebar markers (why an item is where it is): "Planned in <other PI>" when the item's
 * iteration lies under another PI of the cadence, "In <PI>, no sprint" for stories on the
 * current PI without a sprint, and "Assigned here" / "Assigned to <team>" from the planning meta.
 */
export function backlogMarkers(
  item: WorkItem,
  opts: {
    pis: ProgramIncrement[];
    pi: ProgramIncrement;
    meta?: WorkItemMeta;
    teamId: string;
    nodeName: (id: string) => string | undefined;
    story: boolean;
  }
): BacklogMarker[] {
  const out: BacklogMarker[] = [];
  const iteration = item.fields[F.iteration];
  const planned = piOf(iteration, opts.pis);
  if (planned && planned.path !== opts.pi.path) out.push({ kind: "otherPi", label: `Planned in ${planned.name}` });
  else if (opts.story && isUnder(iteration, opts.pi.path) && sprintIndex(iteration, opts.pi.sprints.map((s) => s.path)) < 0) {
    out.push({ kind: "noSprint", label: `In ${opts.pi.name}, no sprint` });
  }
  const nodes = opts.meta?.assignedNodeIds ?? [];
  if (nodes.includes(opts.teamId)) out.push({ kind: "assignedHere", label: "Assigned here" });
  const others = nodes.filter((n) => n !== opts.teamId).map((n) => opts.nodeName(n) ?? n);
  if (others.length) out.push({ kind: "assignedOther", label: `Assigned to ${others.join(", ")}` });
  return out;
}

export interface RevisionLike {
  id: number;
  fields: Record<string, any>;
}

export interface RolledOver {
  id: number;
  /** Completed sprint the item was in. */
  sprintIndex: number;
}

/**
 * Rolled-over items (shadow cards): items that were in a completed sprint of the team (area
 * under `teamArea` at that revision) and are now in a later sprint. `laterOutside` decides for
 * current iterations outside the PI (e.g. a later PI).
 */
export function rolledOverItems(
  revisions: RevisionLike[],
  current: Map<number, WorkItem>,
  sprintPaths: string[],
  past: boolean[],
  teamArea: string | undefined,
  laterOutside: (iteration: string | undefined) => boolean = () => false
): RolledOver[] {
  const seen = new Set<string>();
  const out: RolledOver[] = [];
  for (const r of revisions) {
    const i = sprintIndex(r.fields[F.iteration], sprintPaths);
    if (i < 0 || !past[i]) continue;
    if (teamArea && !isUnder(r.fields[F.area], teamArea)) continue;
    const now = current.get(r.id);
    if (!now) continue;
    const ci = sprintIndex(now.fields[F.iteration], sprintPaths);
    const later = ci >= 0 ? ci > i : laterOutside(now.fields[F.iteration]);
    const key = `${r.id}|${i}`;
    if (!later || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: r.id, sprintIndex: i });
  }
  return out.sort((a, b) => a.sprintIndex - b.sprintIndex || a.id - b.id);
}

export interface EdgeHint {
  /** "providers" = left edge (items this card needs), "consumers" = right edge (items needing it). */
  side: "providers" | "consumers";
  byCrit: Map<Criticality, number[]>;
}

export const CRITICALITY_RANK: Record<Criticality, number> = { critical: 0, atRisk: 1, healthy: 2, resolved: 3 };

/** Edge indicators for dependencies whose partner is not drawn (collapsed, filtered out, elsewhere). */
export function edgeHints(deps: BoardDependency[], drawn: (id: number) => boolean): Map<number, EdgeHint[]> {
  const out = new Map<number, EdgeHint[]>();
  const add = (card: number, side: EdgeHint["side"], other: number, crit: Criticality) => {
    const list = out.get(card) ?? [];
    let h = list.find((x) => x.side === side);
    if (!h) list.push((h = { side, byCrit: new Map() }));
    const ids = h.byCrit.get(crit) ?? [];
    if (!ids.includes(other)) h.byCrit.set(crit, [...ids, other]);
    out.set(card, list);
  };
  for (const d of deps) {
    if (drawn(d.provider) && !drawn(d.consumer)) add(d.provider, "consumers", d.consumer, d.criticality);
    if (drawn(d.consumer) && !drawn(d.provider)) add(d.consumer, "providers", d.provider, d.criticality);
  }
  return out;
}

export const DUE_DATE = "Microsoft.VSTS.Scheduling.DueDate";

export interface Placement {
  /** Sprint index, or -1 when the item can't be placed in the PI. */
  index: number;
  via?: "sprint" | "children" | "date";
  /** Target / due date (YYYY-MM-DD) when it decided (or failed to decide) the placement. */
  date?: string;
}

/** Child ids of an item according to its own Child links. */
export function childIds(item: WorkItem): number[] {
  return (item.relations ?? [])
    .filter((r) => r.rel === LINK.child)
    .map((r) => relationTargetId(r.url))
    .filter((id): id is number => id !== null);
}

/**
 * Where an external dependency partner goes: its own sprint; else (features / epics) the latest
 * sprint of its planned children; else the sprint containing its Target Date or Due Date.
 */
export function externalPlacement(item: WorkItem, sprints: Sprint[], childIterations: (string | undefined)[] = []): Placement {
  const paths = sprints.map((s) => s.path);
  const own = sprintIndex(item.fields[F.iteration], paths);
  if (own >= 0) return { index: own, via: "sprint" };
  const viaChildren = calculatedSprintIndex(undefined, childIterations, paths);
  if (viaChildren >= 0) return { index: viaChildren, via: "children" };
  const raw = item.fields[F.targetDate] ?? item.fields[DUE_DATE];
  if (!raw) return { index: -1 };
  const date = String(raw).slice(0, 10);
  const index = sprints.findIndex((s) => !!s.start && !!s.finish && s.start.slice(0, 10) <= date && date <= s.finish.slice(0, 10));
  return index >= 0 ? { index, via: "date", date } : { index: -1, date };
}

/**
 * SAFe facets for the board's filter bar: "Parent feature" (the swimlane parent) and
 * "Assigned PIs" (the PI the item is planned in plus the PIs of its planning metadata).
 */
export function boardFacets(
  stories: WorkItem[],
  features: WorkItem[],
  parents: Map<number, number>,
  metas: Map<number, WorkItemMeta>,
  pis: ProgramIncrement[]
): ExtraFacet[] {
  const byId = new Map(features.map((f) => [f.id, f]));
  const parentLabel = (i: WorkItem) => {
    const f = byId.get(parents.get(i.id) ?? -1);
    return f ? `#${f.id} ${f.fields[F.title]}` : "None";
  };
  const piNames = (i: WorkItem) => {
    const names = assignedPiNames(metas.get(i.id), pis);
    const planned = piOf(i.fields[F.iteration], pis)?.name;
    return planned && !names.includes(planned) ? [planned, ...names] : names;
  };
  const uniq = (xs: string[]) => Array.from(new Set(xs)).sort((a, b) => a.localeCompare(b));
  return [
    { key: "parent", label: "Parent feature", options: uniq(stories.map(parentLabel)), values: (i) => [parentLabel(i)] },
    { key: "pis", label: "Assigned PIs", options: uniq(stories.flatMap(piNames)), values: piNames },
  ];
}

// ---------------------------------------------------------------------------------------------
// Parent changes and server-side open-state filtering
// ---------------------------------------------------------------------------------------------

/**
 * Moves `item` (fetched with relations) from parent `from` to parent `to` (null = none) and
 * writes `fields`. When the old link is on the item, removal, addition and fields go in ONE
 * json-patch request, so the change is atomic. When the old link exists only on the parent's
 * side, the new link (and fields) are written first and the old link removed afterwards; if that
 * removal fails, the new link is rolled back and the error rethrown.
 */
export async function changeParent(item: WorkItem, from: number | null, to: number | null, fields: Record<string, unknown> = {}): Promise<void> {
  const same = from === to;
  const ops: Parameters<typeof updateWorkItem>[1] = Object.entries(fields).map(([k, v]) => ({ op: "add" as const, path: `/fields/${k}`, value: v }));
  const own = from === null || same ? -1 : (item.relations ?? []).findIndex((r) => r.rel === LINK.parent && relationTargetId(r.url) === from);
  if (own >= 0) ops.push({ op: "remove", path: `/relations/${own}` });
  if (to !== null && !same) {
    const base = await getBaseUrl();
    ops.push({ op: "add", path: "/relations/-", value: { rel: LINK.parent, url: `${base}_apis/wit/workItems/${to}`, attributes: {} } });
  }
  if (ops.length) await updateWorkItem(item.id, ops);
  if (from === null || same || own >= 0) return;
  try {
    await removeLink(from, item.id, LINK.child);
  } catch (e) {
    if (to !== null) await removeLink(item.id, to, LINK.parent).catch(() => undefined);
    throw e;
  }
}

/**
 * WIQL clause keeping only items whose state is not in the Completed or Removed category, per
 * type (state names differ between types). Types without such states are kept as a whole.
 */
export async function openStatesClause(types: string[]): Promise<string> {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const parts = await Promise.all(
    types.filter(Boolean).map(async (t) => {
      const closed = (await getStates(t)).filter((s) => s.category === "Completed" || s.category === "Removed").map((s) => q(s.name));
      return closed.length ? `([System.WorkItemType] = ${q(t)} AND [System.State] NOT IN (${closed.join(", ")}))` : `[System.WorkItemType] = ${q(t)}`;
    })
  );
  return parts.length ? parts.join(" OR ") : "[System.Id] < 0";
}
