import { capacityStore, metaStore, milestonesStore, objectivesStore, risksStore } from "../../api/data";
import { dependenciesOf } from "../../api/dependencies";
import { scopeAreas } from "../../api/org";
import { scopeQuery, typeChain } from "../../api/queries";
import { dependencyRows, DepRow, DepSource, inIteration, isLive, normalize, placements, RItem } from "../../api/reports";
import { F, IterationCapacity, LINK, Milestone, OrgNode, PiObjective, ProgramIncrement, Risk, SafeConfig, WorkItem, WorkItemMeta } from "../../api/types";
import { getStateCategories, getWorkItems, isUnder, queryWorkItems, relationTargetId } from "../../api/wit";

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
}

export async function loadReportData(config: SafeConfig, node: OrgNode, pi: ProgramIncrement | undefined): Promise<ReportData> {
  const areas = scopeAreas(node);
  const chain = typeChain(config);
  const { epic, capability, feature, story } = config.types;

  const [categoryOf, objectives, risks, milestones, capacity, meta] = await Promise.all([
    getStateCategories(chain),
    objectivesStore.list(),
    risksStore.list(),
    milestonesStore.list(),
    capacityStore.list(),
    metaStore.list(),
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
  if (node.level === "portfolio") {
    const epics = await queryWorkItems(scopeQuery([epic], areas), [], true);
    add(epics);
    anchors = epics.map((e) => e.id);
    // Walk down to the stories for the Epic Overview roll-up.
    for (let depth = 0; depth < chain.length - 1; depth++) {
      if (!(await fetchMissing(ids(LINK.child)))) break;
    }
  } else if (pi) {
    const [stories, planning] = await Promise.all([
      queryWorkItems(scopeQuery([story], areas, config.piRootIteration), [], true),
      queryWorkItems(scopeQuery([feature, capability].filter(Boolean), areas, pi.path), [], true),
    ]);
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
    dependenciesOf(Array.from(raw.values()))
      .filter((d) => anchorSet.has(d.provider) || anchorSet.has(d.consumer))
      .flatMap((d) => [d.provider, d.consumer])
  );

  const items = new Map(Array.from(raw.values()).map((w) => [w.id, normalize(w, categoryOf, config.storyPointsField)]));
  // Links are two-way in Azure DevOps, but a child fetched without its reverse link still has a known parent.
  for (const parent of items.values()) {
    for (const id of parent.childIds) {
      const child = items.get(id);
      if (child && child.parentId === undefined) child.parentId = parent.id;
    }
  }
  const inScope = (i: RItem) => areas.some((a) => isUnder(i.area, a));
  const stories = Array.from(items.values()).filter((i) => i.type === story && isLive(i) && inScope(i));
  return {
    items,
    raw: Array.from(raw.values()),
    stories,
    piStories: pi && node.level !== "portfolio" ? stories.filter((s) => inIteration(s, pi.path)) : [],
    anchorIds: anchorSet,
    inScope,
    objectives,
    risks,
    milestones,
    capacity,
    meta: new Map(meta.map((m) => [m.workItemId, m])),
  };
}

/** Dependency rows for the report: PI items (or portfolio items) against the selected source. */
export function reportDependencies(data: ReportData, pis: ProgramIncrement[], source: DepSource): DepRow[] {
  const all = Array.from(data.items.values());
  const placement = placements(all, pis.flatMap((p) => p.sprints.map((s) => s.path)));
  return dependencyRows(dependenciesOf(data.raw), { items: data.items, anchorIds: data.anchorIds, inScope: data.inScope, placement, meta: data.meta }, source);
}
