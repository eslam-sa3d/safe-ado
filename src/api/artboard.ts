import { chunk } from "./client";
import { metaStore, milestonesStore } from "./data";
import { calculatedSprintIndex, CRITICALITY_LABEL, dependenciesOf, DependencyLinkTypes, sprintIndex } from "./dependencies";
import { ItemFilter, withWiqlFilter } from "./filters";
import { scopeQuery } from "./queries";
import { Criticality, F, LINK, Milestone, OrgNode, ProgramIncrement, SafeConfig, Sprint, WorkItem, WorkItemMeta } from "./types";
import { getStateCategories, getWorkItems, isUnder, queryWorkItems, relationTargetId, typeIn, underAny } from "./wit";
import { localToday } from "./rules";

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
  return localToday();
}

// ---------------------------------------------------------------------------------------------
// Item set (A4): own iteration in the PI + parents of stories planned in the PI + PI-assigned
// ---------------------------------------------------------------------------------------------

/** Id of the Parent (Hierarchy-Reverse) of `item`, or null. */
export function parentIdOf(item: WorkItem): number | null {
  const rel = (item.relations ?? []).find((r) => r.rel === LINK.parent);
  return rel ? relationTargetId(rel.url) : null;
}

/** True when the item's planning metadata assigns it to `pi` (by stable id or by path). */
export function isPiAssigned(
  meta: Pick<WorkItemMeta, "assignedPiPaths" | "assignedPiIds"> | undefined,
  pi: Pick<ProgramIncrement, "path" | "identifier">
): boolean {
  if (!meta) return false;
  if (pi.identifier && (meta.assignedPiIds ?? []).includes(pi.identifier)) return true;
  return (meta.assignedPiPaths ?? []).some((p) => p.toLowerCase() === pi.path.toLowerCase());
}

/** Flat query for specific ids, limited to `types` inside `areas`. */
export function idsQuery(ids: number[], types: string[], areas: string[]): string {
  return [
    `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project`,
    `AND [System.Id] IN (${ids.join(", ")})`,
    `AND ${typeIn(types)}`,
    `AND ${underAny("[System.AreaPath]", areas)}`,
    `ORDER BY [${F.stackRank}] ASC, [System.Id] ASC`,
  ].join(" ");
}

export type Category = (type: string, state: string) => string;

export interface ArtBoardData {
  /** Board items (deduplicated, Removed excluded): own iteration in the PI first, then the others. */
  items: WorkItem[];
  /** Children of the child type per board item (Removed excluded). */
  children: Map<number, WorkItem[]>;
  category: Category;
  meta: Map<number, WorkItemMeta>;
  milestones: Milestone[];
  /** Dependency partners that are not on the board (Removed excluded). */
  external: WorkItem[];
  /** Children of external items of the board type (for their calculated sprint). */
  externalChildren: Map<number, WorkItem[]>;
}

const CHILD_FIELDS = [F.id, F.title, F.type, F.state, F.area, F.iteration];

/**
 * Loads the ART / Solution board (Agile Hive parity): items of the board type in scope whose own
 * iteration is in the PI, plus those with children planned in the PI's iterations, plus those
 * whose planning metadata assigns this PI. The WIQL filter clause applies server-side to all of them.
 */
export async function loadArtBoard(opts: {
  type: string;
  childType: string;
  areas: string[];
  pi: ProgramIncrement;
  filter: ItemFilter;
  link: DependencyLinkTypes;
}): Promise<ArtBoardData> {
  const { type, childType, areas, pi, filter, link } = opts;
  const [own, stories, category0, metas, milestones] = await Promise.all([
    queryWorkItems(withWiqlFilter(scopeQuery([type], areas, pi.path), filter), [], true),
    childType ? queryWorkItems(scopeQuery([childType], areas, pi.path), [], true) : Promise.resolve([] as WorkItem[]),
    getStateCategories([type, childType]),
    // Planning metadata is optional: the board still works without it.
    metaStore.list().catch(() => [] as WorkItemMeta[]),
    milestonesStore.list().catch(() => [] as Milestone[]),
  ]);
  const notRemoved = (cat: Category) => (i: WorkItem) => cat(i.fields[F.type], i.fields[F.state]) !== "Removed";
  const ownIds = new Set(own.map((i) => i.id));
  const candidates = new Set<number>();
  for (const s of stories) {
    const parent = parentIdOf(s);
    if (parent !== null && notRemoved(category0)(s)) candidates.add(parent);
  }
  for (const m of metas) if (isPiAssigned(m, pi)) candidates.add(m.workItemId);
  const extraIds = Array.from(candidates)
    .filter((id) => !ownIds.has(id))
    .sort((a, b) => a - b);
  const extra = (
    await Promise.all(chunk(extraIds, 200).map((ids) => queryWorkItems(withWiqlFilter(idsQuery(ids, [type], areas), filter), [], true)))
  ).flat();
  const items = [...own, ...extra].filter(notRemoved(category0));

  // Children (with relations, for story-level dependencies); stories in the PI are already loaded.
  const loaded = new Map(stories.map((s) => [s.id, s]));
  const missing = childType ? Array.from(new Set(items.flatMap(childIdsOf))).filter((id) => !loaded.has(id)) : [];
  if (missing.length) (await getWorkItems(missing, undefined, true)).forEach((c) => loaded.set(c.id, c));
  const childrenOf = (i: WorkItem, pool: Map<number, WorkItem>, cat: Category) =>
    childIdsOf(i)
      .map((id) => pool.get(id))
      .filter((c): c is WorkItem => !!c && c.fields[F.type] === childType && notRemoved(cat)(c));
  const children = new Map(items.map((i) => [i.id, childType ? childrenOf(i, loaded, category0) : []]));

  // Dependency partners outside the board.
  const owner = ownerMap(items, children);
  const sources = [...items, ...Array.from(children.values()).flat()];
  const extIds = partnerIds(sources, owner, link);
  const extAll = extIds.length ? await getWorkItems(extIds, undefined, true) : [];
  const category = await getStateCategories(Array.from(new Set([type, childType, ...extAll.map((i) => String(i.fields[F.type]))])));
  const external = extAll.filter(notRemoved(category));
  const extChildIds = childType ? external.filter((e) => e.fields[F.type] === type).flatMap(childIdsOf) : [];
  const extPool = new Map((extChildIds.length ? await getWorkItems(extChildIds, CHILD_FIELDS) : []).map((c) => [c.id, c]));
  const externalChildren = new Map(external.map((e) => [e.id, e.fields[F.type] === type ? childrenOf(e, extPool, category) : []]));
  return { items, children, category, meta: new Map(metas.map((m) => [m.workItemId, m])), milestones, external, externalChildren };
}

// ---------------------------------------------------------------------------------------------
// Dependencies (A7): feature and story links, drawn between the cards that own them
// ---------------------------------------------------------------------------------------------

/** Card owning each id: board items own themselves, children belong to their board item. */
export function ownerMap(items: WorkItem[], children: Map<number, WorkItem[]>): Map<number, number> {
  const out = new Map<number, number>();
  for (const i of items) out.set(i.id, i.id);
  for (const i of items) for (const c of children.get(i.id) ?? []) if (!out.has(c.id)) out.set(c.id, i.id);
  return out;
}

/** Ids at the other end of dependency links of `sources` that no board card owns. */
export function partnerIds(sources: WorkItem[], owner: Map<number, number>, link: DependencyLinkTypes): number[] {
  const out = new Set<number>();
  for (const d of dependenciesOf(sources, link)) {
    if (!owner.has(d.provider)) out.add(d.provider);
    if (!owner.has(d.consumer)) out.add(d.consumer);
  }
  return Array.from(out).sort((a, b) => a - b);
}

export interface DepPair {
  provider: number;
  consumer: number;
}

/** A dependency between two cards (board or external), aggregating the underlying item links. */
export interface CardEdge {
  from: number;
  to: number;
  pairs: DepPair[];
  /** True when the cards themselves are linked (the link can be removed on the board). */
  direct: boolean;
}

/**
 * Card-level dependencies: every provider -> consumer link of `sources` is mapped to the cards
 * owning its ends (`owner`, else the id itself when it is a known external partner). Links
 * inside one card and links to unknown items are dropped.
 */
export function cardEdges(sources: WorkItem[], owner: Map<number, number>, external: Set<number>, link: DependencyLinkTypes): CardEdge[] {
  const byKey = new Map<string, CardEdge>();
  const cardOf = (id: number) => owner.get(id) ?? (external.has(id) ? id : undefined);
  for (const d of dependenciesOf(sources, link)) {
    const from = cardOf(d.provider);
    const to = cardOf(d.consumer);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}>${to}`;
    const edge = byKey.get(key) ?? { from, to, pairs: [], direct: false };
    edge.pairs.push(d);
    if (d.provider === from && d.consumer === to) edge.direct = true;
    byKey.set(key, edge);
  }
  return Array.from(byKey.values());
}

export const CRITICALITY_RANK: Record<Criticality, number> = { critical: 0, atRisk: 1, healthy: 2, resolved: 3 };

/** The most severe criticality (critical > at risk > healthy > resolved); at risk for none. */
export function worstCriticality(list: Criticality[]): Criticality {
  return [...list].sort((a, b) => CRITICALITY_RANK[a] - CRITICALITY_RANK[b])[0] ?? "atRisk";
}

/**
 * Column of an external partner (0 = PI backlog): its calculated sprint (children first in
 * calculated mode), the PI backlog when it is only scheduled to the PI, else undefined.
 */
export function externalColumn(
  item: WorkItem,
  children: WorkItem[],
  pi: Pick<ProgramIncrement, "path">,
  sprintPaths: string[],
  calculated: boolean
): number | undefined {
  const own = item.fields[F.iteration] as string | undefined;
  const sprint = calculated
    ? calculatedSprintIndex(
        own,
        children.map((c) => c.fields[F.iteration]),
        sprintPaths
      )
    : sprintIndex(own, sprintPaths);
  if (sprint >= 0) return sprint + 1;
  return isUnder(own, pi.path) ? 0 : undefined;
}

/** Edge-indicator data for one side of a card: partners that are not drawn, by criticality. */
export interface HiddenPartners {
  side: "providers" | "consumers";
  byCrit: Map<Criticality, number[]>;
}

/** Adds `other` to the indicator of `card` on `side`. */
export function addHidden(map: Map<number, HiddenPartners[]>, card: number, side: HiddenPartners["side"], other: number, crit: Criticality) {
  const list = map.get(card) ?? [];
  let h = list.find((x) => x.side === side);
  if (!h) list.push((h = { side, byCrit: new Map() }));
  const ids = h.byCrit.get(crit) ?? [];
  if (!ids.includes(other)) h.byCrit.set(crit, [...ids, other]);
  map.set(card, list);
}

/** Most severe criticality first. */
export function hiddenCrits(h: HiddenPartners): Criticality[] {
  return Array.from(h.byCrit.keys()).sort((a, b) => CRITICALITY_RANK[a] - CRITICALITY_RANK[b]);
}

/** "Critical: #1, #2\nAt risk: #3" — ids grouped by criticality, most severe first. */
export function hiddenDetail(h: HiddenPartners): string {
  return hiddenCrits(h)
    .map((c) => `${CRITICALITY_LABEL[c]}: ${h.byCrit.get(c)!.map((n) => `#${n}`).join(", ")}`)
    .join("\n");
}
