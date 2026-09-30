import { CapacityTotal, DerivedMap, effectiveCapacity, loadDerivedCapacity, totalCapacity } from "../../api/capacity";
import { capacityStore, metaStore, milestonesStore, objectivesStore, risksStore, snapshotsStore } from "../../api/data";
import { dependenciesOf, DependencyLinkTypes, dependencyLinkTypes } from "../../api/dependencies";
import { flatten, scopeAreas, effectivePiRoot } from "../../api/org";
import { scopeQuery, typeChain } from "../../api/queries";
import {
  Burnup,
  burnup,
  burnupFromHistory,
  buildSnapshot,
  dependencyRows,
  DepRow,
  DepSource,
  firstActiveDates,
  historicDailyRate,
  historyFields,
  inIteration,
  inSnapshotWindow,
  KindTypes,
  isLive,
  normalize,
  PiSnapshot,
  piStatus,
  placements,
  RItem,
  snapshotId,
} from "../../api/reports";
import { F, IterationCapacity, LINK, Milestone, OrgNode, PiObjective, ProgramIncrement, Risk, SafeConfig, WorkItem, WorkItemMeta } from "../../api/types";
import { getRevisions, getStateCategories, getWorkItems, getWorkItemTypes, isUnder, queryWorkItems, relationTargetId, RevisionList } from "../../api/wit";

/** The process's defect type, counted as "Defect" work in the flow distribution. */
export const BUG_TYPE = "Bug";

/** Everything the Reports widgets read, loaded once per node / PI. */
export interface ReportData {
  /** Every fetched work item (scope, ancestors, descendants, dependency partners). */
  items: Map<number, RItem>;
  /** Raw items with relations, for the dependency engine. */
  raw: WorkItem[];
  /** Live team stories in scope across all PIs (empty at Portfolio level). */
  stories: RItem[];
  /** Live team stories in scope planned in the selected PI. */
  piStories: RItem[];
  /** Items a dependency must touch to appear in the report (PI items, or portfolio items). */
  anchorIds: Set<number>;
  inScope: (item: RItem) => boolean;
  objectives: PiObjective[];
  risks: Risk[];
  milestones: Milestone[];
  capacity: IterationCapacity[];
  /** Capacity derived from Azure DevOps per `${teamNodeId}|${iterationId}` (empty in manual mode). */
  derived: DerivedMap;
  meta: Map<number, WorkItemMeta>;
  /** Dependency link types configured in Setup. */
  link: DependencyLinkTypes;
  /** Burnup of the selected PI: from revision history, or from the current state as fallback. */
  burnup: Burnup | null;
  /** Why the history could not be read (the burnup then uses the current state). */
  historyError?: string;
  /** The history hit the page limit (newest revisions missing): the burnup uses the current state. */
  historyTruncated?: boolean;
  /** First in-progress date per item from revision history (flow time fallback). */
  firstActive: Map<number, string>;
  /** Numbers recorded when the selected (completed) PI ended. */
  snapshot?: PiSnapshot;
  /** The selected PI ended more than SNAPSHOT_WINDOW_DAYS ago and has no snapshot. */
  snapshotMissing?: boolean;
  /**
   * A snapshot of the completed PI built from the current numbers, for "Record snapshot now";
   * only when there is none yet and the burnup comes from complete history.
   */
  freshSnapshot?: PiSnapshot;
  /** Types that decide the flow distribution (enabler, and Bug when the process has it). */
  kinds: KindTypes;
}

export interface LoadOptions {
  /** Today as a day number (see reports.toDay). */
  today: number;
  /** Whether a missing PI snapshot may be written (the user can plan). */
  persist?: boolean;
  /** The unit's cadence, for the forecast's historic velocity. */
  pis?: ProgramIncrement[];
}

const teamsOf = (node: OrgNode) => flatten(node).filter((n) => n.level === "team");

/** Effective capacity of the unit's teams over the PI's iterations (see api/capacity.ts). */
export function piCapacity(
  config: Pick<SafeConfig, "capacity">,
  docs: IterationCapacity[],
  derived: DerivedMap,
  node: OrgNode,
  pi: ProgramIncrement
): CapacityTotal {
  return totalCapacity(teamsOf(node).flatMap((t) => pi.sprints.map((s) => effectiveCapacity(config, docs, derived, t.id, s))));
}

export async function loadReportData(config: SafeConfig, node: OrgNode, pi: ProgramIncrement | undefined, opts: LoadOptions): Promise<ReportData> {
  const areas = scopeAreas(node);
  const chain = typeChain(config);
  const link = dependencyLinkTypes(config);
  const { epic, capability, feature, story, enabler } = config.types;
  const piLevel = !!pi && node.level !== "portfolio";
  const completed = piLevel && piStatus(pi!, opts.today) === "completed";

  const [chainCategory, objectives, risks, milestones, capacity, meta, stored, bugType, derived] = await Promise.all([
    getStateCategories(enabler ? [...chain, enabler] : chain),
    objectivesStore.list(),
    risksStore.list(),
    milestonesStore.list(),
    capacityStore.list(),
    metaStore.list(),
    completed ? snapshotsStore.get(snapshotId(node.id, pi!)) : Promise.resolve(undefined),
    // Team flow metrics count bugs as defects when the process has the type.
    piLevel && node.level === "team"
      ? getWorkItemTypes()
          .then((ts) => (ts.some((t) => t.name === BUG_TYPE) ? BUG_TYPE : undefined))
          .catch(() => undefined)
      : Promise.resolve(undefined),
    // Azure DevOps team capacity (no requests in manual mode).
    piLevel ? loadDerivedCapacity(config, teamsOf(node), pi!.sprints) : Promise.resolve<DerivedMap>(new Map()),
  ]);
  const bugCategory = bugType ? await getStateCategories([bugType]).catch(() => undefined) : undefined;
  const categoryOf = (type: string, state: string) => (bugCategory && type === bugType ? bugCategory(type, state) : chainCategory(type, state));
  // A snapshot with a history-based burnup needs no history: skip the (large) revisions read.
  const trusted = !!stored && stored.burnup?.source === "history";

  const raw = new Map<number, WorkItem>();
  const add = (list: WorkItem[]) => list.forEach((w) => raw.set(w.id, w));
  // Ids already requested; deleted or inaccessible items are simply omitted by the batch API.
  const tried = new Set<number>();
  const fetchMissing = async (ids: number[]) => {
    const missing = Array.from(new Set(ids)).filter((id) => !raw.has(id) && !tried.has(id));
    missing.forEach((id) => tried.add(id));
    if (missing.length) add(await getWorkItems(missing, undefined, true));
    return missing.length > 0;
  };
  const ids = (rel: string) =>
    Array.from(raw.values())
      .flatMap((w) => (w.relations ?? []).filter((r) => r.rel === rel).map((r) => relationTargetId(r.url)))
      .filter((id): id is number => id !== null);

  let anchors: number[] = [];
  let revisions: RevisionList | null = null;
  let historyError: string | undefined;
  if (node.level === "portfolio") {
    const epics = await queryWorkItems(scopeQuery([epic], areas), [], true);
    add(epics);
    anchors = epics.map((e) => e.id);
    // Walk down to the stories for the Epic Overview roll-up.
    for (let depth = 0; depth < chain.length - 1; depth++) {
      if (!(await fetchMissing(ids(LINK.child)))) break;
    }
  } else if (pi) {
    const flowTypes = [story, feature, capability, enabler, bugType].filter((t): t is string => !!t);
    const [stories, planning, bugs, history] = await Promise.all([
      // Stories of the unit's own cadence (its PI root, an ancestor's, or the project's).
      queryWorkItems(scopeQuery([story], areas, effectivePiRoot(config, node.id)), [], true),
      queryWorkItems(scopeQuery([feature, capability, enabler].filter((t): t is string => !!t), areas, pi.path), [], true),
      bugType ? queryWorkItems(scopeQuery([bugType], areas, pi.path), [], true) : Promise.resolve([]),
      // History for the burnup and flow time; the report still works without it.
      trusted
        ? Promise.resolve(null)
        : getRevisions(flowTypes, historyFields(config.storyPointsField)).catch((e) => {
            historyError = e?.message ?? String(e);
            return null;
          }),
    ]);
    revisions = history;
    add(stories);
    add(planning);
    add(bugs);
    anchors = [...planning, ...stories.filter((w) => isUnder(w.fields[F.iteration], pi.path))].map((w) => w.id);
    // Walk up to the parents for the PI Overview and the Iteration Overview grouping.
    for (let depth = 0; depth < chain.length - 1; depth++) {
      if (!(await fetchMissing(ids(LINK.parent)))) break;
    }
  }
  // Dependency partners outside the loaded set (external dependencies).
  const anchorSet = new Set(anchors);
  await fetchMissing(
    dependenciesOf(Array.from(raw.values()), link)
      .filter((d) => anchorSet.has(d.provider) || anchorSet.has(d.consumer))
      .flatMap((d) => [d.provider, d.consumer])
  );

  const items = new Map(Array.from(raw.values()).map((w) => [w.id, normalize(w, categoryOf, config.storyPointsField, config.rroeField)]));
  // Links are two-way in Azure DevOps, but a child fetched without its reverse link still has a known parent.
  for (const parent of items.values()) {
    for (const id of parent.childIds) {
      const child = items.get(id);
      if (child && child.parentId === undefined) child.parentId = parent.id;
    }
  }
  const inScope = (i: RItem) => areas.some((a) => isUnder(i.area, a));
  const stories = Array.from(items.values()).filter((i) => i.type === story && isLive(i) && inScope(i));
  const piStories = piLevel ? stories.filter((s) => inIteration(s, pi!.path)) : [];

  const historyTruncated = !!revisions?.truncated;
  const rate = piLevel ? historicDailyRate(pi!, opts.pis ?? [], stories, opts.today) : null;
  const chart = !piLevel
    ? null
    : revisions && !historyTruncated
    ? burnupFromHistory(pi!, revisions, { storyType: story, spField: config.storyPointsField, areas, categoryOf }, opts.today, rate)
    : burnup(pi!, piStories, opts.today, rate);

  let snapshot = stored;
  let freshSnapshot: PiSnapshot | undefined;
  // Only complete history makes a snapshot: never record a truncated or current-state burnup.
  if (completed && !snapshot && chart?.source === "history") {
    freshSnapshot = buildSnapshot({
      nodeId: node.id,
      team: node.level === "team",
      pi: pi!,
      stories,
      piStories,
      capacity: piCapacity(config, capacity, derived, node, pi!).value,
      burnup: chart,
      today: opts.today,
    });
    // Recorded automatically only shortly after the PI ended, so the numbers are close to
    // those at PI end. Best effort: a failed write only means the next visit tries again.
    if (opts.persist && inSnapshotWindow(pi!, opts.today)) snapshot = await snapshotsStore.save(freshSnapshot).catch(() => undefined);
    if (snapshot) freshSnapshot = undefined;
  }

  return {
    items,
    raw: Array.from(raw.values()),
    stories,
    piStories,
    anchorIds: anchorSet,
    inScope,
    objectives,
    risks,
    milestones,
    capacity,
    derived,
    meta: new Map(meta.map((m) => [m.workItemId, m])),
    link,
    burnup: chart,
    historyError,
    historyTruncated,
    firstActive: revisions ? firstActiveDates(revisions, categoryOf) : new Map(),
    snapshot,
    snapshotMissing: completed && !snapshot && !inSnapshotWindow(pi!, opts.today),
    freshSnapshot,
    kinds: { enabler, bug: bugType },
  };
}

/** Dependency rows for the report: PI items (or portfolio items) against the selected source. */
export function reportDependencies(data: ReportData, pis: ProgramIncrement[], source: DepSource): DepRow[] {
  const all = Array.from(data.items.values());
  const placement = placements(all, pis.flatMap((p) => p.sprints.map((s) => s.path)));
  return dependencyRows(dependenciesOf(data.raw, data.link), { items: data.items, anchorIds: data.anchorIds, inScope: data.inScope, placement, meta: data.meta }, source);
}
