import { Criticality, F, LINK, Sprint, WorkItem, WorkItemMeta } from "./types";
import { criticalityByIteration, dependenciesOf, sprintIndex } from "./dependencies";
import { isUnder, relationTargetId } from "./wit";

/**
 * Pure logic behind the Team Planning Board (Agile Hive's "breakout board"): iteration
 * status, load, parent resolution, swimlane building, sorting and dependency criticality.
 */

export type IterationStatus = "past" | "current" | "future";

/** Today as YYYY-MM-DD (UTC, like the iteration dates Azure DevOps returns). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
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

/** Adds the team and PI to the meta's assignments. */
export function assignMeta(meta: WorkItemMeta, nodeId: string, piPath: string): WorkItemMeta {
  const add = (xs: string[], x: string) => (xs.includes(x) ? xs : [...xs, x]);
  return { ...meta, assignedNodeIds: add(meta.assignedNodeIds, nodeId), assignedPiPaths: add(meta.assignedPiPaths, piPath) };
}

/** Removes the team; the PI goes too when no other team remains assigned. */
export function unassignMeta(meta: WorkItemMeta, nodeId: string, piPath: string): WorkItemMeta {
  const assignedNodeIds = meta.assignedNodeIds.filter((n) => n !== nodeId);
  const assignedPiPaths = assignedNodeIds.length ? meta.assignedPiPaths : meta.assignedPiPaths.filter((p) => p !== piPath);
  return { ...meta, assignedNodeIds, assignedPiPaths };
}

/** WSJF = (Business Value + Time Criticality) / Effort, or undefined when not computable. */
export function wsjf(item: WorkItem): number | undefined {
  const bv = item.fields[F.businessValue];
  const tc = item.fields[F.timeCriticality];
  const effort = Number(item.fields[F.effort]);
  if (bv === undefined && tc === undefined) return undefined;
  if (!effort) return undefined;
  return Math.round(((Number(bv ?? 0) + Number(tc ?? 0)) / effort) * 10) / 10;
}

export type SortKey = "rank" | "priority" | "points" | "id" | "wsjf";

/** Sorts a copy. Priority ascending (1 first), points and WSJF descending; missing values last. */
export function sortItems(items: WorkItem[], by: SortKey, pointsField: string): WorkItem[] {
  const value = (i: WorkItem): number | undefined => {
    switch (by) {
      case "priority":
        return i.fields[F.priority] === undefined ? undefined : Number(i.fields[F.priority]);
      case "points":
        return i.fields[pointsField] === undefined ? undefined : -Number(i.fields[pointsField]);
      case "wsjf": {
        const w = wsjf(i);
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
 */
export function boardDependencies(
  items: WorkItem[],
  lookup: Map<number, WorkItem>,
  sprintPaths: string[],
  category: (type: string, state: string) => string
): BoardDependency[] {
  const idx = (id: number) => sprintIndex(lookup.get(id)?.fields[F.iteration], sprintPaths);
  return dependenciesOf(items).map(({ provider, consumer }) => {
    const p = lookup.get(provider);
    const done = !!p && category(p.fields[F.type], p.fields[F.state]) === "Completed";
    return { provider, consumer, criticality: criticalityByIteration(idx(provider), idx(consumer), done) };
  });
}

/** Ids referenced by dependency links of `items` that are not among them. */
export function externalIds(items: WorkItem[]): number[] {
  const own = new Set(items.map((i) => i.id));
  const out = new Set<number>();
  for (const d of dependenciesOf(items)) {
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
