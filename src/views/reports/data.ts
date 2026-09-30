import { capacityStore, metaStore, milestonesStore, objectivesStore, risksStore, snapshotsStore } from "../../api/data";
import { dependenciesOf, DependencyLinkTypes, dependencyLinkTypes } from "../../api/dependencies";
import { flatten, scopeAreas } from "../../api/org";
import { scopeQuery, typeChain } from "../../api/queries";
import {
  Burnup,
  burnup,
  burnupFromHistory,
  buildSnapshot,
  capacityTotal,
  dependencyRows,
  DepRow,
  DepSource,
  firstActiveDates,
  historyFields,
  inIteration,
  isLive,
  normalize,
  PiSnapshot,
  piStatus,
  placements,
  RItem,
  snapshotId,
} from "../../api/reports";
import { F, IterationCapacity, LINK, Milestone, OrgNode, PiObjective, ProgramIncrement, Risk, SafeConfig, WorkItem, WorkItemMeta } from "../../api/types";
import { getRevisions, getStateCategories, getWorkItems, isUnder, queryWorkItems, relationTargetId, Revision } from "../../api/wit";

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
  meta: Map<number, WorkItemMeta>;
  /** Dependency link types configured in Setup. */
  link: DependencyLinkTypes;
  /** Burnup of the selected PI: from revision history, or from the current state as fallback. */
  burnup: Burnup | null;
  /** Why the history could not be read (the burnup then uses the current state). */
  historyError?: string;
  /** First in-progress date per item from revision history (flow time fallback). */
  firstActive: Map<number, string>;
  /** Numbers recorded when the selected (completed) PI ended. */
  snapshot?: PiSnapshot;
}

export interface LoadOptions {
  /** Today as a day number (see reports.toDay). */
  today: number;
  /** Whether a missing PI snapshot may be written (the user can plan). */
  persist?: boolean;
}

/** Capacity of the unit's teams over the PI's iterations. */
export function piCapacity(docs: IterationCapacity[], node: OrgNode, pi: ProgramIncrement): number {
  const teams = new Set(flatten(node).filter((n) => n.level === "team").map((n) => n.id));
  return capacityTotal(docs, teams, pi.sprints.map((s) => s.path));
}

export async function loadReportData(config: SafeConfig, node: OrgNode, pi: ProgramIncrement | undefined, opts: LoadOptions): Promise<ReportData> {
  const areas = scopeAreas(node);
  const chain = typeChain(config);
  const link = dependencyLinkTypes(config);
  const { epic, capability, feature, story, enabler } = config.types;
  const piLevel = !!pi && node.level !== "portfolio";
  const completed = piLevel && piStatus(pi!, opts.today) === "completed";

  const [categoryOf, objectives, risks, milestones, capacity, meta, stored] = await Promise.all([
    getStateCategories(chain),
    objectivesStore.list(),
    risksStore.list(),
    milestonesStore.list(),
    capacityStore.list(),
    metaStore.list(),
    completed ? snapshotsStore.get(snapshotId(node.id, pi!)) : Promise.resolve(undefined),
  ]);

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
  let revisions: Revision[] | null = null;
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
    const flowTypes = [story, feature, capability, enabler].filter((t): t is string => !!t);
    const [stories, planning, history] = await Promise.all([
      queryWorkItems(scopeQuery([story], areas, config.piRootIteration), [], true),
      queryWorkItems(scopeQuery([feature, capability, enabler].filter((t): t is string => !!t), areas, pi.path), [], true),
      // History for the burnup and flow time; the report still works without it.
      getRevisions(flowTypes, historyFields(config.storyPointsField)).catch((e) => {
        historyError = e?.message ?? String(e);
        return null;
      }),
    ]);
    revisions = history;
    add(stories);
    add(planning);
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

  const chart = !piLevel
    ? null
    : revisions
    ? burnupFromHistory(pi!, revisions, { storyType: story, spField: config.storyPointsField, areas, categoryOf }, opts.today)
    : burnup(pi!, piStories, opts.today);

  let snapshot = stored;
  if (completed && !snapshot) {
    const fresh = buildSnapshot({
      nodeId: node.id,
      team: node.level === "team",
      pi: pi!,
      stories,
      piStories,
      capacity: piCapacity(capacity, node, pi!),
      burnup: chart,
      today: opts.today,
    });
    // Recording is best effort: a failed write only means the next visit tries again.
    if (opts.persist) snapshot = await snapshotsStore.save(fresh).catch(() => undefined);
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
    meta: new Map(meta.map((m) => [m.workItemId, m])),
    link,
    burnup: chart,
    historyError,
    firstActive: revisions ? firstActiveDates(revisions, categoryOf) : new Map(),
    snapshot,
  };
}

/** Dependency rows for the report: PI items (or portfolio items) against the selected source. */
export function reportDependencies(data: ReportData, pis: ProgramIncrement[], source: DepSource): DepRow[] {
  const all = Array.from(data.items.values());
  const placement = placements(all, pis.flatMap((p) => p.sprints.map((s) => s.path)));
  return dependencyRows(dependenciesOf(data.raw, data.link), { items: data.items, anchorIds: data.anchorIds, inScope: data.inScope, placement, meta: data.meta }, source);
}
