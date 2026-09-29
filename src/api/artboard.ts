import { calculatedSprintIndex, sprintIndex } from "./dependencies";
import { F, LINK, Milestone, OrgNode, SafeConfig, Sprint, WorkItem } from "./types";
import { isUnder, relationTargetId } from "./wit";

/**
 * Pure helpers for the ART / Solution Planning Board's Agile Hive "calculated" mode:
 * features are placed by the plans of their children (stories), not by their own iteration.
 */

export interface BoardRow {
  key: string;
  title: string;
  areaPath?: string;
  node?: OrgNode;
}

/** Ids of the Parent/Child children of `item` (Hierarchy-Forward links). */
export function childIdsOf(item: WorkItem): number[] {
  return (item.relations ?? [])
    .filter((r) => r.rel === LINK.child)
    .map((r) => relationTargetId(r.url))
    .filter((id): id is number => id !== null);
}

/** The work item type one level below `type` in the configured chain (Feature → Story, ...). */
export function childTypeOf(config: SafeConfig, type: string): string {
  const { epic, capability, feature, story } = config.types;
  const chain = Array.from(new Set([epic, capability, feature, story].filter(Boolean)));
  const i = chain.indexOf(type);
  return i >= 0 ? chain[i + 1] ?? "" : "";
}

/** Row whose area path contains `area`; the longest (most specific) match wins. */
export function rowForArea(area: string | undefined, rows: BoardRow[]): string | undefined {
  return rows
    .filter((r) => r.areaPath && isUnder(area, r.areaPath))
    .sort((a, b) => b.areaPath!.length - a.areaPath!.length)[0]?.key;
}

export interface CalculatedPlacement {
  /** Row key, or undefined when no row owns the feature. */
  row: string | undefined;
  /** Sprint index within the PI, -1 = PI backlog. */
  sprint: number;
  /** Keys of the rows (teams) that own at least one child, in row order. */
  involved: string[];
  /** Children not planned in any of the PI's sprints. */
  unplanned: WorkItem[];
}

/**
 * Agile Hive calculated placement:
 * - column: the latest sprint any child is planned in, else the feature's own sprint;
 * - row: the Owning Unit when it is a row, else the row owning the last planned child
 *   (ties → alphabetically first row name), else the feature's own area row.
 */
export function calculatePlacement(
  feature: WorkItem,
  children: WorkItem[],
  rows: BoardRow[],
  sprintPaths: string[],
  owningNodeId?: string
): CalculatedPlacement {
  const idx = children.map((c) => sprintIndex(c.fields[F.iteration], sprintPaths));
  const childRows = children.map((c) => rowForArea(c.fields[F.area], rows));
  const sprint = calculatedSprintIndex(
    feature.fields[F.iteration],
    children.map((c) => c.fields[F.iteration]),
    sprintPaths
  );
  const involved = rows.filter((r) => childRows.includes(r.key)).map((r) => r.key);
  const unplanned = children.filter((_, i) => idx[i] < 0);

  let row: string | undefined;
  if (owningNodeId && rows.some((r) => r.key === owningNodeId)) {
    row = owningNodeId;
  } else {
    const last = Math.max(-1, ...idx.filter((_, i) => childRows[i] !== undefined));
    if (last >= 0) {
      const candidates = new Set(childRows.filter((r, i) => r !== undefined && idx[i] === last));
      row = rows.filter((r) => candidates.has(r.key)).sort((a, b) => a.title.localeCompare(b.title))[0].key;
    } else {
      row = rowForArea(feature.fields[F.area], rows);
    }
  }
  return { row, sprint, involved, unplanned };
}

const day = (iso?: string) => (iso ?? "").slice(0, 10);

/** Index of the sprint whose date range contains `date` (YYYY-MM-DD), or -1. */
export function sprintIndexForDate(date: string, sprints: Sprint[]): number {
  const d = day(date);
  return sprints.findIndex((s) => !!s.start && !!s.finish && day(s.start) <= d && d <= day(s.finish));
}

/** Milestones of `node` and its ancestors (`nodeIds`) grouped by sprint index. */
export function milestonesBySprint(milestones: Milestone[], nodeIds: string[], sprints: Sprint[]): Map<number, Milestone[]> {
  const ids = new Set(nodeIds);
  const out = new Map<number, Milestone[]>();
  for (const m of [...milestones].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!ids.has(m.nodeId)) continue;
    const i = sprintIndexForDate(m.date, sprints);
    if (i < 0) continue;
    out.set(i, [...(out.get(i) ?? []), m]);
  }
  return out;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
