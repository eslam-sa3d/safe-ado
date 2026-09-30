import { FormEvent, Fragment, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { capacitySettings, CAPACITY_SOURCE_LABEL, effectiveCapacity, EffectiveCapacity, loadDerivedCapacity } from "../api/capacity";
import { capacityId, capacityStore, emptyMeta, findCapacity, metaStore } from "../api/data";
import { CRITICALITY_COLOR, CRITICALITY_LABEL, dependencyLinkTypes, DependencyLinkTypes, sprintIndex } from "../api/dependencies";
import { applyFilter, EMPTY_FILTER, ExtraFacet, facetOptions, isFilterActive, ItemFilter, wiqlSuffix, withWiqlFilter } from "../api/filters";
import { findNode, parentOf, scopeAreas } from "../api/org";
import { baseFields, scopeQuery } from "../api/queries";
import { DEFAULT_RROE_FIELD } from "../api/rules";
import {
  assignedPiNames,
  assignMeta,
  assignPiMeta,
  backlogMarkers,
  BoardDependency,
  boardDependencies,
  boardFacets,
  buildLanes,
  changeParent,
  childIds,
  CRITICALITY_RANK,
  decodeDrag,
  DragPayload,
  EdgeHint,
  edgeHints,
  encodeDrag,
  externalIds,
  externalPlacement,
  groupByArea,
  INDEPENDENT,
  isOpen,
  iterationStatus,
  IterationStatus,
  Lane,
  moveChanges,
  openStatesClause,
  ownParentId,
  parentMap,
  piOf,
  Placement,
  rolledOverItems,
  searchItems,
  SortKey,
  sortItems,
  sprintLoads,
  storyLevelTypes,
  storyPoints,
  todayIso,
  unassignMeta,
  unplannedStories,
  wsjf,
  metaHasPi,
} from "../api/teamboard";
import {
  Criticality,
  F,
  IterationCapacity,
  LINK,
  OrgNode,
  ProgramIncrement,
  SafeConfig,
  Sprint,
  WorkItem,
  WorkItemMeta,
} from "../api/types";
import {
  addLink,
  createWorkItem,
  getFieldNames,
  getRevisions,
  getStateCategories,
  getWorkItems,
  getWorkItemTypes,
  openWorkItem,
  queryIds,
  queryWorkItems,
  setFields,
} from "../api/wit";
import { CapacityBadge, CapacitySetupLink } from "../components/CapacityBadge";
import { FilterBar } from "../components/FilterBar";
import { CATEGORY_COLOR, ErrorBar, fmtDate, Icon, Info, lastSegment, RefreshContext, Spinner, storage, typeColor, useAsync } from "../components/common";
import { useCan, useSafe } from "../components/context";

/**
 * Team Planning Board (Agile Hive's "breakout board"). Columns are the PI's iterations with
 * load / capacity, rows are the team's Feature swimlanes plus "Independent", followed by
 * read-only sibling teams of the ART and an EXTERNAL block for dependencies outside the board.
 * An "Unplanned" sidebar offers the team backlog and the ART's features for drag & drop.
 *
 * "Remove from board" moves a story back to `config.piRootIteration` — the iteration above all
 * PIs — so it leaves every PI and reappears in the team's Unplanned list.
 *
 * Completed sprints show translucent "Rolled over" shadow cards for items that were in them and
 * moved on to a later sprint (from the revision history). Cards whose dependency partner is not
 * drawn get a coloured edge marker (left = providers, right = consumers).
 */
export function TeamBoard() {
  const { node, pi } = useSafe();
  if (!pi) return null;
  if (node.level !== "team") {
    return <Info>The Team Planning Board is available for teams. Select a team in the tree.</Info>;
  }
  return <TeamPlanningBoard key={`${node.id}|${pi.path}`} team={node} pi={pi} />;
}

type Category = (type: string, state: string) => string;
type Layout = "compact" | "extended";
type Hint = "valid" | "invalid" | undefined;
/** What is being dragged (the type decides which lanes accept a feature). */
type DragInfo = DragPayload & { type?: string };

interface BlockData {
  stories: WorkItem[];
  features: WorkItem[];
  parents: Map<number, number>;
  external: WorkItem[];
  /** Placement of external items (own sprint, children's sprint or target date). */
  placement: Map<number, Placement>;
}

interface Ctx {
  config: SafeConfig;
  pi: ProgramIncrement;
  pis: ProgramIncrement[];
  types: string[];
  category: Category;
  metas: Map<number, WorkItemMeta>;
  artAreas: string[];
  link: DependencyLinkTypes;
}

interface SiblingSummary {
  critical?: number;
  error?: string;
  denied?: boolean;
}

interface Shadow {
  item: WorkItem;
  sprintIndex: number;
}

const ALL_CRITICALITIES: Criticality[] = ["healthy", "atRisk", "critical", "resolved"];
const [loadLayout, saveLayout] = storage<Layout>("safe-ado-teamboard-layout", "compact");
const DAY = 86_400_000;
const isDenied = (e: any) => e?.status === 401 || e?.status === 403;
const notRemoved = (category: Category) => (i: WorkItem) => category(i.fields[F.type], i.fields[F.state]) !== "Removed";

interface LaneOption {
  key: string;
  title: string;
}

const laneOption = (l: Lane): LaneOption => ({ key: l.key, title: l.feature ? `#${l.feature.id} ${l.title}` : l.title });

/** Lane options of several blocks, first occurrence of each key wins. */
function unionLanes(lists: LaneOption[][]): LaneOption[] {
  const out = new Map<string, LaneOption>();
  lists.flat().forEach((o) => out.has(o.key) || out.set(o.key, o));
  return Array.from(out.values());
}

/**
 * Loads `fn` whenever `key` changes (not on re-renders or unrelated reloads); keeps the previous
 * data until the new one arrives. An undefined key means "not ready yet".
 */
function useKeyed<T>(key: string | undefined, fn: () => Promise<T>): { data?: T; error?: string } {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    if (key === undefined) return;
    let live = true;
    fn()
      .then((data) => live && setState({ data }))
      .catch((e) => live && setState((s) => ({ data: s.data, error: e?.message ?? String(e) })));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** Loads one team's stories in the PI, their Feature parents, assigned features and external dependency ends. */
async function loadBlock(ctx: Ctx, team: OrgNode, filter: ItemFilter): Promise<BlockData> {
  const { config, pi, types, category, metas } = ctx;
  const stories = (await queryWorkItems(withWiqlFilter(scopeQuery(types, scopeAreas(team), pi.path), filter), [], true)).filter(
    notRemoved(category)
  );

  const featureIds = new Set<number>();
  stories.forEach((s) => {
    const p = ownParentId(s);
    if (p !== null) featureIds.add(p);
  });
  metas.forEach((m) => {
    if (m.assignedNodeIds.includes(team.id) && metaHasPi(m, pi)) featureIds.add(m.workItemId);
  });
  // Features planned in the PI on the ART, so parents known only through their Child link resolve too.
  (await queryIds(scopeQuery([config.types.feature], ctx.artAreas, pi.path))).forEach((id) => featureIds.add(id));
  const features = featureIds.size
    ? (await getWorkItems(Array.from(featureIds), undefined, true)).filter(
        (f) => f.fields[F.type] === config.types.feature && category(f.fields[F.type], f.fields[F.state]) !== "Removed"
      )
    : [];

  // External dependency ends, with relations so features / epics can be placed by their children.
  const extIds = externalIds(stories, ctx.link);
  const external = extIds.length ? await getWorkItems(extIds, undefined, true) : [];
  const storyLevel = new Set(types);
  const kids = new Map(external.filter((e) => !storyLevel.has(e.fields[F.type])).map((e) => [e.id, childIds(e)]));
  const allKids = Array.from(new Set(Array.from(kids.values()).flat()));
  const childItems = allKids.length ? await getWorkItems(allKids, [F.id, F.iteration]) : [];
  const childIteration = new Map(childItems.map((c) => [c.id, c.fields[F.iteration] as string | undefined]));
  const placement = new Map(
    external.map((e) => [e.id, externalPlacement(e, pi.sprints, (kids.get(e.id) ?? []).map((k) => childIteration.get(k)))])
  );
  return { stories, features, parents: parentMap(stories, features), external, placement };
}

function blockDependencies(block: BlockData, ctx: Ctx): BoardDependency[] {
  const lookup = new Map([...block.external, ...block.stories].map((i) => [i.id, i]));
  const sprintPaths = ctx.pi.sprints.map((s) => s.path);
  return boardDependencies(block.stories, lookup, sprintPaths, ctx.category, ctx.link, (id) => block.placement.get(id)?.index);
}

/**
 * Light query per sibling team (its stories in the PI with relations) to show the number of
 * unresolved critical dependencies without expanding the block. 401/403 marks "no access".
 */
async function loadSiblingSummaries(ctx: Ctx, siblings: OrgNode[], own: BlockData, filter: ItemFilter): Promise<Map<string, SiblingSummary>> {
  const sprintPaths = ctx.pi.sprints.map((s) => s.path);
  const results = await Promise.allSettled(
    siblings.map((s) => queryWorkItems(withWiqlFilter(scopeQuery(ctx.types, scopeAreas(s), ctx.pi.path), filter), [], true))
  );
  const lists = results.map((r) => (r.status === "fulfilled" ? r.value.filter(notRemoved(ctx.category)) : undefined));
  const lookup = new Map<number, WorkItem>([...own.external, ...own.stories].map((i) => [i.id, i]));
  lists.forEach((l) => l?.forEach((i) => lookup.set(i.id, i)));
  const missing = Array.from(new Set(lists.flatMap((l) => (l ? externalIds(l, ctx.link) : [])))).filter((id) => !lookup.has(id));
  // Ends we can't read are rated "at risk", never critical.
  const extra = missing.length ? await getWorkItems(missing, [F.id, F.type, F.state, F.iteration]).catch(() => [] as WorkItem[]) : [];
  extra.forEach((i) => lookup.set(i.id, i));
  const out = new Map<string, SiblingSummary>();
  siblings.forEach((s, i) => {
    const r = results[i];
    if (r.status === "rejected") {
      out.set(s.id, { error: String(r.reason?.message ?? r.reason), denied: isDenied(r.reason) });
      return;
    }
    const deps = boardDependencies(lists[i]!, lookup, sprintPaths, ctx.category, ctx.link);
    out.set(s.id, { critical: deps.filter((d) => d.criticality === "critical").length });
  });
  return out;
}

/** Items that were in a completed sprint of the team and have since moved to a later sprint. */
async function loadRolledOver(ctx: Ctx, team: OrgNode, past: boolean[]): Promise<Shadow[]> {
  if (!team.areaPath || !past.some(Boolean)) return [];
  const sprintPaths = ctx.pi.sprints.map((s) => s.path);
  const since = ctx.pi.start ? new Date(Date.parse(ctx.pi.start) - 90 * DAY).toISOString() : undefined;
  const revisions = await getRevisions(ctx.types, [F.iteration, F.area], since);
  const candidates = Array.from(
    new Set(
      revisions
        .filter((r) => {
          const i = sprintIndex(r.fields[F.iteration], sprintPaths);
          return i >= 0 && past[i];
        })
        .map((r) => r.id)
    )
  );
  if (!candidates.length) return [];
  const current = new Map((await getWorkItems(candidates, baseFields(ctx.config))).filter(notRemoved(ctx.category)).map((i) => [i.id, i]));
  const piIndex = ctx.pis.findIndex((p) => p.path === ctx.pi.path);
  const laterOutside = (iteration: string | undefined) => {
    const other = piOf(iteration, ctx.pis);
    return !!other && piIndex >= 0 && ctx.pis.indexOf(other) > piIndex;
  };
  return rolledOverItems(revisions, current, sprintPaths, past, team.areaPath, laterOutside).map((r) => ({
    item: current.get(r.id)!,
    sprintIndex: r.sprintIndex,
  }));
}

function TeamPlanningBoard({ team, pi }: { team: OrgNode; pi: ProgramIncrement }) {
  const { config, pis, piRoot } = useSafe();
  const can = useCan();
  const readOnly = !can.plan;
  const art = parentOf(config.root, team.id);
  const siblings = (art?.children ?? []).filter((c) => c.id !== team.id && c.level === "team");
  const artAreas = art ? scopeAreas(art) : scopeAreas(team);
  const sprintPaths = pi.sprints.map((s) => s.path);
  const today = todayIso();
  const status = pi.sprints.map((s) => iterationStatus(s, today));
  const past = status.map((s) => s === "past");

  const [filter, setFilter] = useState<ItemFilter>(EMPTY_FILTER);
  const [laneFilter, setLaneFilter] = useState<string[]>([]);
  const [crit, setCrit] = useState<Criticality[]>(ALL_CRITICALITIES);
  const [showDeps, setShowDeps] = useState(true);
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const [collapse, setCollapse] = useState<{ all: boolean; over: Record<string, boolean> }>({ all: false, over: {} });
  const [actionError, setActionError] = useState<string>();
  /** Bumped by actual board changes (drop, create, remove); keys the cached side data. */
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState<{ lane: string; sprint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<DragInfo | null>(null);
  const [siblingLanes, setSiblingLanes] = useState<Record<string, LaneOption[]>>({});
  const tick = useContext(RefreshContext);
  const wiqlKey = wiqlSuffix(filter);

  const { data, loading, error, reload, setData } = useAsync(async () => {
    const types = storyLevelTypes(config.types.story, (await getWorkItemTypes()).map((t) => t.name));
    const [metaDocs, caps, category, derived] = await Promise.all([
      metaStore.list(),
      capacityStore.list(),
      getStateCategories([...types, config.types.feature]),
      // Azure DevOps team capacity; no requests when the project uses manual capacity.
      loadDerivedCapacity(config, [team], pi.sprints),
    ]);
    const metas = new Map(metaDocs.map((m) => [m.workItemId, m]));
    const ctx: Ctx = { config, pi, pis, types, category, metas, artAreas, link: dependencyLinkTypes(config) };
    const block = await loadBlock(ctx, team, filter);
    // Load counts every story of the team in the sprint, whatever the (server-side) filter shows.
    const all = wiqlKey
      ? (await queryWorkItems(scopeQuery(types, scopeAreas(team), pi.path), [F.id, F.type, F.state, F.iteration, config.storyPointsField])).filter(
          notRemoved(category)
        )
      : block.stories;
    return { ctx, block, caps, derived, all, key: `${tick}|${version}|${wiqlKey}` };
  }, [team.id, pi.path, wiqlKey, version]);

  const block = data?.block;
  const ctx = data?.ctx;

  // Sibling critical counts and rolled-over shadows are cached until the global refresh or a
  // board change; reloading the main block alone (e.g. after a work item dialog) keeps them.
  const summaries = useKeyed(data?.key, async () =>
    block && ctx && siblings.length ? loadSiblingSummaries(ctx, siblings, block, filter) : new Map<string, SiblingSummary>()
  );
  const rolled = useKeyed(data ? `${tick}|${version}` : undefined, async () => (ctx ? loadRolledOver(ctx, team, past) : []));
  const onSiblingLanes = useCallback(
    (id: string, list: LaneOption[]) => setSiblingLanes((s) => (JSON.stringify(s[id]) === JSON.stringify(list) ? s : { ...s, [id]: list })),
    []
  );

  const setLayout = (l: Layout) => {
    setLayoutState(l);
    saveLayout(l);
  };
  const isCollapsed = (key: string) => collapse.over[key] ?? collapse.all;
  const toggleLane = (key: string) => setCollapse((c) => ({ ...c, over: { ...c.over, [key]: !(c.over[key] ?? c.all) } }));

  const lanes = useMemo(
    () => (block && ctx ? buildLanes(block.stories, block.features, block.parents, ctx.metas, team.id, pi) : []),
    [block, ctx, team.id, pi.path]
  );
  const loads = useMemo(() => (data ? sprintLoads(data.all, sprintPaths, config.storyPointsField) : []), [data, sprintPaths.join("|")]);
  const deps: BoardDependency[] = useMemo(() => (block && ctx ? blockDependencies(block, ctx) : []), [block, ctx]);
  const facets: ExtraFacet[] = useMemo(
    () => (block && ctx ? boardFacets(block.stories, block.features, block.parents, ctx.metas, pis) : []),
    [block, ctx, pis]
  );

  // --- dependency lines ------------------------------------------------------------------------
  const gridRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<number, HTMLElement>());
  const [rects, setRects] = useState<Map<number, DOMRect>>(new Map());
  const cardRef = useCallback((id: number, el: HTMLElement | null) => (el ? cardRefs.current.set(id, el) : cardRefs.current.delete(id)), []);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const origin = grid.getBoundingClientRect();
      const next = new Map<number, DOMRect>();
      cardRefs.current.forEach((el, id) => {
        const r = el.getBoundingClientRect();
        next.set(id, new DOMRect(r.left - origin.left, r.top - origin.top, r.width, r.height));
      });
      setRects(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(grid);
    return () => ro.disconnect();
  }, [data, filter, laneFilter, collapse, layout, showDeps]);

  // --- actions -----------------------------------------------------------------------------------
  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (e: any) {
      setActionError(`${label}: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
      // A board change reloads the board, the backlog, sibling counts, expanded siblings and shadows.
      setVersion((v) => v + 1);
    }
  };

  const saveMeta = (id: number, change: (m: WorkItemMeta) => WorkItemMeta) =>
    metaStore.save(change(data!.ctx.metas.get(id) ?? emptyMeta(id)));

  /** The item's Feature parent: the lane it is shown in, or (off the board) its own parent when that is a Feature. */
  const featureParentOf = async (item: WorkItem): Promise<number | null> => {
    const lanesParent = data!.block.parents.get(item.id);
    if (lanesParent !== undefined) return lanesParent;
    const own = ownParentId(item);
    if (own === null || data!.block.stories.some((s) => s.id === item.id)) return null;
    const known = data!.block.features.find((f) => f.id === own) ?? (await getWorkItems([own], [F.id, F.type]))[0];
    return known?.fields[F.type] === config.types.feature ? own : null;
  };

  const onDrop = (raw: string, lane: Lane | null, sprint: Sprint | null) => {
    setDragging(null);
    const payload = decodeDrag(raw);
    if (!payload || !data || readOnly) return;
    if (payload.kind === "feature") {
      if (lanes.some((l) => l.feature?.id === payload.id && l.assigned)) return;
      void run(`Could not add swimlane for #${payload.id}`, () => saveMeta(payload.id, (m) => assignMeta(m, team.id, pi)));
      return;
    }
    if (!lane || !sprint) return;
    const id = payload.id;
    void run(`Could not move #${id}`, async () => {
      const [item] = await getWorkItems([id], undefined, true);
      if (!item) throw new Error("the work item no longer exists");
      const changes = moveChanges(item, sprint.path, team.areaPath);
      // Only the Feature parent (the swimlane) is managed here: staying in the lane never touches
      // links, Independent removes only a Feature parent, and a Feature lane replaces any parent.
      const featureParent = await featureParentOf(item);
      const target = lane.feature?.id ?? null;
      if (target === featureParent) await changeParent(item, null, null, changes);
      else if (target === null) await changeParent(item, featureParent, null, changes);
      else await changeParent(item, ownParentId(item) ?? featureParent, target, changes);
    });
  };

  const removeLane = (lane: Lane) =>
    run(`Could not remove swimlane "${lane.title}"`, () => saveMeta(lane.feature!.id, (m) => unassignMeta(m, team.id, pi)));

  const removeFromBoard = (item: WorkItem) =>
    // Back to the unit's cadence root (its own PI root, an ancestor's, or the project's).
    run(`Could not remove #${item.id} from the board`, () => setFields(item.id, { [F.iteration]: piRoot ?? config.piRootIteration }));

  /** Opens the work item dialog; once it closes only the main block reloads (side data stays cached). */
  const open = async (id: number) => {
    try {
      await openWorkItem(id);
    } catch (e: any) {
      setActionError(`Could not open #${id}: ${e?.message ?? e}`);
      return;
    }
    reload(true);
  };

  const create = (lane: Lane, sprint: Sprint, values: { title: string; type: string; points: string }) =>
    run("Could not create the work item", async () => {
      const fields: Record<string, unknown> = {
        [F.title]: values.title,
        [F.area]: team.areaPath ?? artAreas[0],
        [F.iteration]: sprint.path,
      };
      if (values.points.trim() !== "") fields[config.storyPointsField] = Number(values.points);
      const created = await createWorkItem(values.type, fields);
      setCreating(null);
      if (lane.feature) await addLink(created.id, lane.feature.id, LINK.parent);
      // The item is planned in this PI: record it as an Assigned PI like Agile Hive does.
      await metaStore.save(assignPiMeta(emptyMeta(created.id), pi));
    });

  const saveCapacity = async (sprint: Sprint, capacity: number | null) => {
    const existing = findCapacity(data!.caps, team.id, sprint);
    if (capacity === null) {
      // Hybrid mode: clearing the override falls back to the derived value.
      if (!existing) return;
      try {
        await capacityStore.remove(existing.id);
        setData((d) => (d ? { ...d, caps: d.caps.filter((c) => c.id !== existing.id) } : d));
      } catch (e: any) {
        setActionError(`Could not clear the capacity override: ${e?.message ?? e}`);
      }
      return;
    }
    const doc: IterationCapacity = {
      ...(existing ?? { id: capacityId(team.id, sprint.identifier), nodeId: team.id, iterationPath: sprint.path }),
      iterationPath: sprint.path,
      iterationId: sprint.identifier,
      capacity,
    };
    try {
      const saved = await capacityStore.save(doc);
      setData((d) => (d ? { ...d, caps: [...d.caps.filter((c) => c.id !== saved.id), saved] } : d));
    } catch (e: any) {
      setActionError(`Could not save capacity: ${e?.message ?? e}`);
    }
  };

  if (loading && !data) return <Spinner label="Loading team planning board…" />;
  if (!data || !block || !ctx) return <ErrorBar message={error} />;

  const visibleStories = new Set(applyFilter(block.stories, filter, facets).map((s) => s.id));
  // The swimlane filter applies across all blocks, so it lists the (expanded) siblings' features too.
  const laneOptions = unionLanes([lanes.filter((l) => l.feature).map(laneOption), ...Object.values(siblingLanes), [laneOption(lanes[lanes.length - 1])]]);
  const laneVisible = (l: Lane) => laneFilter.length === 0 || laneFilter.includes(l.key);
  const filtering = isFilterActive(filter);
  const featureTitle = (id: number | undefined) => block.features.find((f) => f.id === id)?.fields[F.title] as string | undefined;
  const shownDeps = deps.filter((d) => crit.includes(d.criticality));
  const critical = deps.filter((d) => d.criticality === "critical").length;
  const cols = `220px repeat(${pi.sprints.length}, minmax(200px, 1fr))`;
  const plannedCount = block.stories.length;
  const onBoard = new Set(block.stories.map((s) => s.id));
  const hints = showDeps ? edgeHints(shownDeps, (id) => rects.has(id)) : new Map<number, EdgeHint[]>();
  const shadows = rolled.data ?? [];
  const capSource = capacitySettings(config).source;
  const laneOfShadow = (s: Shadow) => {
    const parent = block.parents.get(s.item.id);
    const lane = lanes.find((l) => l.feature?.id === parent);
    return lane ? lane.key : INDEPENDENT;
  };

  const cellHint = (lane: Lane, locked: boolean): Hint => {
    if (!dragging) return undefined;
    if (locked) return "invalid";
    if (dragging.kind === "story") return "valid";
    return lane.feature && lane.feature.fields[F.type] === (dragging.type ?? config.types.feature) ? "valid" : "invalid";
  };
  const dropZoneHint: Hint = dragging ? (dragging.kind === "feature" ? "valid" : "invalid") : undefined;

  const cardProps = {
    category: ctx.category,
    pointsField: config.storyPointsField,
    layout,
    onOpen: open,
  };

  return (
    <div className="tb-layout">
      <div className="tb-main">
        <div className="toolbar">
          <strong>{team.name}</strong>
          <span className="muted">
            {plannedCount} stories · {deps.length} dependencies
            {critical > 0 && <span className="danger"> · {critical} critical</span>}
          </span>
          <span className="spacer" />
          <div className="tb-toggle" role="group" aria-label="Card layout">
            {(["compact", "extended"] as Layout[]).map((l) => (
              <button key={l} className={"btn" + (layout === l ? " primary" : "")} aria-pressed={layout === l} onClick={() => setLayout(l)}>
                {l === "compact" ? "Compact" : "Extended"}
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => setCollapse({ all: false, over: {} })}>
            Expand all
          </button>
          <button className="btn" onClick={() => setCollapse({ all: true, over: {} })}>
            Collapse all
          </button>
          <details className="facet">
            <summary className={"btn" + (laneFilter.length ? " primary" : "")}>
              Swimlanes{laneFilter.length ? ` (${laneFilter.length})` : ""}
            </summary>
            <div className="facet-menu" role="group" aria-label="Swimlane filter">
              {laneOptions.map((o) => (
                <label key={o.key} className="check">
                  <input
                    type="checkbox"
                    checked={laneFilter.includes(o.key)}
                    onChange={() => setLaneFilter((f) => (f.includes(o.key) ? f.filter((k) => k !== o.key) : [...f, o.key]))}
                  />{" "}
                  {o.title}
                </label>
              ))}
            </div>
          </details>
          <button className="btn" onClick={() => reload()} disabled={busy}>
            <Icon name="Refresh" /> Refresh
          </button>
        </div>
        <FilterBar value={filter} onChange={setFilter} options={facetOptions(block.stories)} extraFacets={facets} />
        <div className="toolbar tb-deps" role="group" aria-label="Dependency criticality">
          <label className="check">
            <input type="checkbox" checked={showDeps} onChange={(e) => setShowDeps(e.target.checked)} /> Show dependencies
          </label>
          {ALL_CRITICALITIES.map((c) => (
            <label key={c} className="check">
              <input
                type="checkbox"
                checked={crit.includes(c)}
                onChange={() => setCrit((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]))}
              />
              <i className="line" style={{ borderColor: CRITICALITY_COLOR[c] }} /> {CRITICALITY_LABEL[c]}
            </label>
          ))}
        </div>
        <ErrorBar message={error ?? actionError} onClose={() => setActionError(undefined)} />
        {rolled.error && <ErrorBar message={`Could not load rolled-over items: ${rolled.error}`} />}
        {readOnly && (
          <div className="tb-readonly">
            <Info>Read-only: you don't have permission to plan in this area.</Info>
          </div>
        )}
        {!team.areaPath && <Info>{team.name} has no area path. Set one in Setup to plan its stories.</Info>}
        {plannedCount === 0 && !loading && (
          <Info>
            No stories of {team.name} are planned in {pi.name} yet.
            {!readOnly && " Drag stories from the Unplanned sidebar or create them in a cell."}
          </Info>
        )}

        <div className="board-scroll">
          <div
            className={"board-grid tb-grid" + (dragging ? " tb-dragging" : "")}
            ref={gridRef}
            style={{ gridTemplateColumns: cols }}
          >
            <div className="board-corner" />
            {pi.sprints.map((s, i) => (
              <SprintHeader
                key={s.path}
                sprint={s}
                status={status[i]}
                readOnly={readOnly}
                load={loads[i]}
                capacity={effectiveCapacity(config, data.caps, data.derived, team.id, s)}
                onSave={(c) => saveCapacity(s, c)}
                onError={setActionError}
              />
            ))}

            <div className="tb-block-header current">
              <span className="tb-block-title">{team.name}</span>
              {!readOnly && (
                <div
                  className={"tb-feature-drop" + (dropZoneHint ? ` drop-${dropZoneHint}` : "")}
                  role="group"
                  aria-label="Add swimlane"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    onDrop(e.dataTransfer.getData("text/plain"), null, null);
                  }}
                >
                  Drop a feature from the ART tab here to add a swimlane
                </div>
              )}
            </div>
            {lanes.filter((l) => laneVisible(l) && !(filtering && l.feature && !l.stories.some((s) => visibleStories.has(s.id)))).map((lane) => {
              const key = `${team.id}|${lane.key}`;
              const collapsed = isCollapsed(key);
              const stories = lane.stories.filter((s) => visibleStories.has(s.id));
              return (
                <LaneRow
                  key={key}
                  lane={lane}
                  count={stories.length}
                  collapsed={collapsed}
                  onToggle={() => toggleLane(key)}
                  onRemove={!readOnly && lane.assigned && lane.stories.length === 0 ? () => removeLane(lane) : undefined}
                >
                  {pi.sprints.map((s, si) => {
                    const isPast = past[si];
                    const locked = isPast || readOnly;
                    const here = stories.filter((st) => sprintIndex(st.fields[F.iteration], sprintPaths) === si);
                    const ghosts = isPast ? shadows.filter((sh) => sh.sprintIndex === si && laneOfShadow(sh) === lane.key) : [];
                    const isCreating = creating?.lane === lane.key && creating.sprint === s.path;
                    return (
                      <DropCell
                        key={s.path}
                        label={`${lane.title} / ${s.name}`}
                        past={isPast}
                        disabled={locked}
                        hint={cellHint(lane, locked)}
                        onDrop={(raw) => onDrop(raw, lane, s)}
                      >
                        {here.map((st) => {
                          const parentId = block.parents.get(st.id);
                          return (
                            <Card
                              key={st.id}
                              item={st}
                              {...cardProps}
                              parentId={parentId}
                              parentTitle={featureTitle(parentId)}
                              draggable={!locked}
                              cardRef={cardRef}
                              edges={hints.get(st.id)}
                              onDragStart={() => setDragging({ kind: "story", id: st.id })}
                              onDragEnd={() => setDragging(null)}
                              onRemove={locked ? undefined : () => removeFromBoard(st)}
                            />
                          );
                        })}
                        {ghosts.map((sh) => (
                          <Card
                            key={`shadow-${sh.item.id}`}
                            item={sh.item}
                            {...cardProps}
                            shadow
                          />
                        ))}
                        {!locked && !isCreating && (
                          <button
                            className="cell-add"
                            aria-label={`Create in ${lane.title} / ${s.name}`}
                            title="Create a story here"
                            onClick={() => setCreating({ lane: lane.key, sprint: s.path })}
                          >
                            +
                          </button>
                        )}
                        {isCreating && !locked && (
                          <CreateForm
                            types={ctx.types}
                            defaultType={config.types.story}
                            onCancel={() => setCreating(null)}
                            onCreate={(v) => create(lane, s, v)}
                          />
                        )}
                      </DropCell>
                    );
                  })}
                </LaneRow>
              );
            })}

            {siblings.map((sib) => (
              <SiblingBlock
                key={sib.id}
                team={sib}
                ctx={ctx}
                reloadKey={data.key}
                filter={filter}
                summary={summaries.data?.get(sib.id)}
                onLanes={onSiblingLanes}
                laneVisible={laneVisible}
                isCollapsed={isCollapsed}
                onToggleLane={toggleLane}
                cardProps={cardProps}
              />
            ))}

            {block.external.length > 0 && (
              <ExternalBlock
                items={block.external}
                placement={block.placement}
                pi={pi}
                category={ctx.category}
                layout={layout}
                cardRef={cardRef}
                hints={hints}
                onOpen={open}
                exclude={onBoard}
              />
            )}

            {showDeps && (
              <svg className="dep-layer" aria-hidden="true">
                <defs>
                  {ALL_CRITICALITIES.map((c) => (
                    <marker key={c} id={`tb-arrow-${c}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                      <path d="M0,0 L10,5 L0,10 z" fill={CRITICALITY_COLOR[c]} />
                    </marker>
                  ))}
                </defs>
                {shownDeps.map((d) => {
                  const a = rects.get(d.provider);
                  const b = rects.get(d.consumer);
                  if (!a || !b) return null;
                  const forward = b.x >= a.x;
                  const x1 = forward ? a.right : a.left;
                  const x2 = forward ? b.left : b.right;
                  const y1 = a.y + a.height / 2;
                  const y2 = b.y + b.height / 2;
                  const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
                  return (
                    <path
                      key={`${d.provider}-${d.consumer}`}
                      d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
                      className={`dep-line tb-dep ${d.criticality}`}
                      style={{ stroke: CRITICALITY_COLOR[d.criticality] }}
                      markerEnd={`url(#tb-arrow-${d.criticality})`}
                    >
                      <title>
                        #{d.provider} → #{d.consumer}: {CRITICALITY_LABEL[d.criticality]}
                      </title>
                    </path>
                  );
                })}
              </svg>
            )}
          </div>
        </div>
        <div className="legend-bar muted small">
          <span>
            Load / Capacity in story points ({CAPACITY_SOURCE_LABEL[capSource].toLowerCase()}).
            {!readOnly && capSource === "manual" && " Click a capacity to edit it."}
            {!readOnly && capSource === "hybrid" && " Click a capacity to override it; clear the value to use the derived one."}
          </span>
          {!readOnly && <span>Drag stories to plan them; the swimlane sets the parent Feature.</span>}
          <span>Edge dots mark dependencies to items not shown (left = providers, right = consumers).</span>
        </div>
      </div>
      <UnplannedSidebar
        team={team}
        ctx={ctx}
        token={version}
        canPlan={!readOnly}
        onOpen={open}
        onDragStart={setDragging}
        onDragEnd={() => setDragging(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Header, lanes and cells
// ---------------------------------------------------------------------------------------------

function SprintHeader(props: {
  sprint: Sprint;
  status: IterationStatus;
  readOnly: boolean;
  load: number;
  capacity: EffectiveCapacity;
  /** null clears a (hybrid) override. */
  onSave: (capacity: number | null) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { sprint, status, load } = props;
  const eff = props.capacity;
  const capacity = eff.value;
  // Derived capacity comes from Azure DevOps and is edited there; hybrid edits the override.
  const editable = eff.source !== "derived";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const done = useRef(false);
  const over = capacity !== undefined && load > capacity;

  const commit = () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const value = Number(draft);
    if (draft.trim() === "" && eff.source === "hybrid") {
      if (eff.manual !== undefined) void props.onSave(null);
      return;
    }
    if (draft.trim() === "" || !Number.isFinite(value) || value < 0) {
      props.onError(`Capacity must be a non-negative number`);
      return;
    }
    if (value !== (eff.source === "hybrid" ? eff.manual : capacity)) void props.onSave(value);
  };

  const loadText = (
    <>
      <span className={"tb-load" + (over ? " overload" : "")}>{load}</span> / {capacity ?? "–"}
    </>
  );
  const badge = eff.source !== "manual" && <CapacityBadge origin={eff.origin} explanation={eff.explanation} />;

  return (
    <div className={"board-col-header tb-col-header " + status}>
      <div className="tb-col-title">
        {sprint.name}
        {status === "current" && <span className="tb-today">Today</span>}
      </div>
      {sprint.start && (
        <div className="muted small">
          {fmtDate(sprint.start)} – {fmtDate(sprint.finish)}
        </div>
      )}
      <div className="small tb-capacity-row">
        {status === "past" || props.readOnly || !editable ? (
          <span
            className="tb-capacity locked"
            title={
              status === "past"
                ? "Iteration completed — capacity is locked"
                : !editable
                ? "Load / Capacity (story points) — derived from Azure DevOps team capacity"
                : "Load / Capacity (story points) — read-only"
            }
          >
            {loadText}
          </span>
        ) : editing ? (
          <input
            className="tb-capacity-input"
            type="number"
            min={0}
            autoFocus
            aria-label={`Capacity for ${sprint.name}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                done.current = true;
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            className="link tb-capacity"
            aria-label={`Load ${load} of capacity ${capacity ?? "not set"} for ${sprint.name}`}
            title={eff.source === "hybrid" ? "Load / Capacity (story points) — click to override the capacity" : "Load / Capacity (story points) — click to edit capacity"}
            onClick={() => {
              done.current = false;
              const start = eff.source === "hybrid" ? eff.manual : capacity;
              setDraft(start === undefined ? "" : String(start));
              setEditing(true);
            }}
          >
            {loadText}
          </button>
        )}
        {badge}
        <CapacitySetupLink capacity={eff} />
      </div>
    </div>
  );
}

function LaneRow(props: {
  lane: Lane;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const { lane, collapsed } = props;
  return (
    <>
      <div className={"board-row-header tb-lane-header" + (collapsed ? " collapsed" : "")} style={collapsed ? { gridColumn: "1 / -1" } : undefined}>
        <button
          className="twisty"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${lane.title}`}
          onClick={props.onToggle}
        >
          <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="small" />
        </button>
        <span className="tb-lane-title" title={lane.feature ? `${lane.feature.fields[F.type]} #${lane.feature.id}` : undefined}>
          {lane.feature && <i className="type-bar" style={{ background: typeColor(lane.feature.fields[F.type]) }} />}
          {lane.title}
        </span>
        <span className="muted small">{props.count}</span>
        {props.onRemove && (
          <button className="link danger" aria-label={`Remove swimlane ${lane.title}`} title="Remove this empty swimlane" onClick={props.onRemove}>
            <Icon name="Cancel" className="small" />
          </button>
        )}
      </div>
      {!collapsed && props.children}
    </>
  );
}

function DropCell(props: { label: string; past: boolean; disabled: boolean; hint: Hint; onDrop: (raw: string) => void; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const hint = props.hint ? ` drop-${props.hint}` : "";
  if (props.disabled) return <div className={"board-cell tb-cell" + (props.past ? " past" : " locked") + hint}>{props.children}</div>;
  return (
    <div
      role="group"
      aria-label={props.label}
      className={"board-cell tb-cell" + (over ? " drop-over" : "") + hint}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        props.onDrop(e.dataTransfer.getData("text/plain"));
      }}
    >
      {props.children}
    </div>
  );
}

function CreateForm(props: {
  types: string[];
  defaultType: string;
  onCancel: () => void;
  onCreate: (v: { title: string; type: string; points: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState(props.types.includes(props.defaultType) ? props.defaultType : props.types[0]);
  const [points, setPoints] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) props.onCreate({ title: title.trim(), type, points });
  };
  return (
    <form className="tb-create" role="dialog" aria-label="Create work item" onSubmit={submit}>
      <input aria-label="Title" placeholder="Title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="tb-create-row">
        <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>
          {props.types.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <input aria-label="Story points" type="number" min={0} placeholder="SP" value={points} onChange={(e) => setPoints(e.target.value)} />
      </div>
      <div className="tb-create-row">
        <button className="btn primary" type="submit" disabled={!title.trim()}>
          Create
        </button>
        <button className="btn" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Coloured dots on a card's edges for dependency partners that are not drawn. */
function EdgeMarkers({ id, edges }: { id: number; edges: EdgeHint[] }) {
  return (
    <>
      {edges.map((h) => {
        const crits = Array.from(h.byCrit.keys()).sort((a, b) => CRITICALITY_RANK[a] - CRITICALITY_RANK[b]);
        const label = `${h.side === "providers" ? "Hidden providers" : "Hidden consumers"} of #${id}`;
        const detail = crits.map((c) => `${CRITICALITY_LABEL[c]}: ${h.byCrit.get(c)!.map((n) => `#${n}`).join(", ")}`).join("\n");
        return (
          <span
            key={h.side}
            className={`tb-edge ${h.side === "providers" ? "left" : "right"}`}
            style={{ background: CRITICALITY_COLOR[crits[0]] }}
            aria-label={label}
            title={`${label}\n${detail}`}
          />
        );
      })}
    </>
  );
}

function Card(props: {
  item: WorkItem;
  category: Category;
  pointsField: string;
  layout: Layout;
  parentId?: number;
  parentTitle?: string;
  draggable?: boolean;
  cardRef?: (id: number, el: HTMLElement | null) => void;
  onOpen: (id: number) => void;
  onRemove?: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  edges?: EdgeHint[];
  /** Read-only copy in a completed sprint of an item that rolled over to a later sprint. */
  shadow?: boolean;
  /** Target / due date that placed an external item. */
  date?: string;
}) {
  const { item, layout } = props;
  const [menu, setMenu] = useState(false);
  const type = item.fields[F.type];
  const cat = props.category(type, item.fields[F.state]);
  const pts = item.fields[props.pointsField];
  const tags = String(item.fields[F.tags] ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
  const title = `${type} #${item.id}: ${item.fields[F.title]}` + (props.shadow ? ` — rolled over, now in ${lastSegment(item.fields[F.iteration])}` : "");
  return (
    <div
      ref={props.cardRef ? (el) => props.cardRef!(item.id, el) : undefined}
      className={"card tb-card " + layout + (props.shadow ? " tb-shadow" : "")}
      style={{ borderLeftColor: typeColor(type) }}
      draggable={!!props.draggable}
      onDragStart={
        props.draggable
          ? (e) => {
              e.dataTransfer.setData("text/plain", encodeDrag({ kind: "story", id: item.id }));
              props.onDragStart?.();
            }
          : undefined
      }
      onDragEnd={props.draggable ? props.onDragEnd : undefined}
      onClick={() => props.onOpen(item.id)}
      title={title}
    >
      <div className="card-title">{item.fields[F.title]}</div>
      <div className="card-meta">
        <span className="muted">#{item.id}</span>
        <span className="state">
          <i className="dot" style={{ background: CATEGORY_COLOR[cat] ?? "#999" }} />
          {item.fields[F.state]}
        </span>
        {pts !== undefined && pts !== null && pts !== "" ? <span className="pill">{pts} pts</span> : null}
        {props.shadow && <span className="pill tb-rolled">Rolled over</span>}
        {props.date && (
          <span className="pill tb-date" title="Target date">
            {fmtDate(props.date)}
          </span>
        )}
        {props.parentTitle && (
          <button
            type="button"
            className="pill tb-parent"
            title="Parent feature"
            onClick={(e) => {
              e.stopPropagation();
              props.onOpen(props.parentId!);
            }}
          >
            {props.parentTitle}
          </button>
        )}
      </div>
      {layout === "extended" && (
        <div className="card-meta tb-extended">
          <span>{item.fields[F.assignedTo]?.displayName ?? "Unassigned"}</span>
          {tags.map((t) => (
            <span key={t} className="pill tb-tag">
              {t}
            </span>
          ))}
        </div>
      )}
      {props.edges && <EdgeMarkers id={item.id} edges={props.edges} />}
      {props.onRemove && (
        <div className="tb-menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button className="link tb-menu-btn" aria-label={`Actions for #${item.id}`} aria-expanded={menu} onClick={() => setMenu(!menu)}>
            …
          </button>
          {menu && (
            <div className="tb-menu" role="menu">
              <button
                role="menuitem"
                className="link"
                onClick={() => {
                  setMenu(false);
                  props.onRemove!();
                }}
              >
                Remove from board
              </button>
              <button
                role="menuitem"
                className="link"
                onClick={() => {
                  setMenu(false);
                  props.onOpen(item.id);
                }}
              >
                Open
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Sibling teams (read-only; critical count from a light query, lanes loaded on expand)
// ---------------------------------------------------------------------------------------------

function SiblingBlock(props: {
  team: OrgNode;
  ctx: Ctx;
  /** Changes on the global refresh, a board change or a new server-side filter (not on a card open). */
  reloadKey: string;
  filter: ItemFilter;
  summary?: SiblingSummary;
  onLanes: (teamId: string, lanes: LaneOption[]) => void;
  laneVisible: (l: Lane) => boolean;
  isCollapsed: (key: string) => boolean;
  onToggleLane: (key: string) => void;
  cardProps: { category: Category; pointsField: string; layout: Layout; onOpen: (id: number) => void };
}) {
  const { team, ctx, filter, summary, onLanes } = props;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<BlockData>();
  const [error, setError] = useState<{ message: string; denied: boolean }>();
  const [loading, setLoading] = useState(false);

  // The team's feature lanes join the swimlane filter once loaded.
  useEffect(() => {
    if (data) onLanes(team.id, buildLanes(data.stories, data.features, data.parents, ctx.metas, team.id, ctx.pi).filter((l) => l.feature && l.stories.length).map(laneOption));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Reloads when expanded and whenever the board data key changes, e.g. after a drop.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(undefined);
    loadBlock(ctx, team, filter)
      .then((d) => live && setData(d))
      .catch((e) => live && setError({ message: `Could not load ${team.name}: ${e?.message ?? e}`, denied: isDenied(e) }))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, props.reloadKey]);

  const sprintPaths = ctx.pi.sprints.map((s) => s.path);
  const loadedCount = useMemo(
    () => (data ? blockDependencies(data, ctx).filter((d) => d.criticality === "critical").length : undefined),
    [data]
  );
  const criticalCount = loadedCount ?? summary?.critical;
  const denied = summary?.denied || error?.denied;
  const facets = useMemo(
    () => (data ? boardFacets(data.stories, data.features, data.parents, ctx.metas, ctx.pis) : []),
    [data]
  );

  const visible = new Set(applyFilter(data?.stories ?? [], filter, facets).map((s) => s.id));
  const lanes = data
    ? buildLanes(data.stories, data.features, data.parents, ctx.metas, team.id, ctx.pi)
        .filter(props.laneVisible)
        .map((l) => ({ lane: l, stories: l.stories.filter((s) => visible.has(s.id)) }))
        .filter((l) => l.stories.length > 0)
    : [];
  const featureTitle = (id: number | undefined) => data?.features.find((f) => f.id === id)?.fields[F.title] as string | undefined;

  return (
    <>
      <div className="tb-block-header sibling">
        <button className="twisty" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} team ${team.name}`} onClick={() => setOpen(!open)}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="small" />
        </button>
        <span className="tb-block-title">{team.name}</span>
        <span className="muted small">read-only</span>
        {criticalCount !== undefined && (
          <span className={"pill" + (criticalCount ? " tb-critical" : "")} title="Unresolved critical dependencies">
            {criticalCount} critical
          </span>
        )}
        {denied && <span className="tb-no-access small">You don't have access to {team.name}</span>}
        {!denied && summary?.error && criticalCount === undefined && (
          <span className="pill" title={summary.error}>
            critical count unavailable
          </span>
        )}
      </div>
      {open && loading && !data && (
        <div className="tb-span">
          <Spinner label={`Loading ${team.name}…`} />
        </div>
      )}
      {open && error && !error.denied && (
        <div className="tb-span">
          <ErrorBar message={error.message} />
        </div>
      )}
      {open && !loading && data && lanes.length === 0 && (
        <div className="tb-span muted small tb-empty">No stories of {team.name} in {ctx.pi.name}.</div>
      )}
      {open &&
        data &&
        !error &&
        lanes.map(({ lane, stories }) => {
          const key = `${team.id}|${lane.key}`;
          return (
            <LaneRow key={key} lane={lane} count={stories.length} collapsed={props.isCollapsed(key)} onToggle={() => props.onToggleLane(key)}>
              {ctx.pi.sprints.map((s, si) => (
                <div key={s.path} className="board-cell tb-cell readonly">
                  {stories
                    .filter((st) => sprintIndex(st.fields[F.iteration], sprintPaths) === si)
                    .map((st) => {
                      const parentId = data.parents.get(st.id);
                      return <Card key={st.id} item={st} {...props.cardProps} parentId={parentId} parentTitle={featureTitle(parentId)} />;
                    })}
                </div>
              ))}
            </LaneRow>
          );
        })}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// EXTERNAL lanes: dependency partners that are not on this team's board
// ---------------------------------------------------------------------------------------------

function ExternalBlock(props: {
  items: WorkItem[];
  placement: Map<number, Placement>;
  pi: ProgramIncrement;
  category: Category;
  layout: Layout;
  cardRef: (id: number, el: HTMLElement | null) => void;
  hints: Map<number, EdgeHint[]>;
  onOpen: (id: number) => void;
  exclude: Set<number>;
}) {
  const groups = groupByArea(props.items.filter((i) => !props.exclude.has(i.id)));
  const indexOf = (i: WorkItem) => props.placement.get(i.id)?.index ?? -1;
  const card = (i: WorkItem) => (
    <Card
      key={i.id}
      item={i}
      category={props.category}
      pointsField=""
      layout={props.layout}
      cardRef={props.cardRef}
      edges={props.hints.get(i.id)}
      date={props.placement.get(i.id)?.date}
      onOpen={props.onOpen}
    />
  );
  return (
    <>
      <div className="tb-block-header external">
        <span className="tb-block-title">EXTERNAL</span>
        <span className="muted small">Dependencies to items outside this board</span>
      </div>
      {groups.map((g) => {
        const outside = g.items.filter((i) => indexOf(i) < 0);
        return (
          <Fragment key={g.area}>
            <div className="board-row-header tb-lane-header external">
              <span className="tb-lane-title" title={g.area}>
                {lastSegment(g.area) || "(no area)"}
              </span>
              {outside.length > 0 && (
                <div className="tb-outside">
                  <span className="muted small">Outside {props.pi.name}</span>
                  {outside.map(card)}
                </div>
              )}
            </div>
            {props.pi.sprints.map((s, si) => (
              <div key={s.path} className="board-cell tb-cell readonly">
                {g.items.filter((i) => indexOf(i) === si).map(card)}
              </div>
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Unplanned sidebar (Team / ART tabs)
// ---------------------------------------------------------------------------------------------

type Tab = "team" | "art";

interface SidebarProps {
  team: OrgNode;
  ctx: Ctx;
  token: number;
  canPlan: boolean;
  onOpen: (id: number) => void;
  onDragStart: (info: DragInfo) => void;
  onDragEnd: () => void;
}

function UnplannedSidebar(props: SidebarProps) {
  const [tab, setTab] = useState<Tab>("team");
  return (
    <aside className="tb-sidebar" aria-label="Unplanned">
      <div className="tb-sidebar-title">Unplanned</div>
      <div className="tb-tabs" role="tablist">
        {(["team", "art"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={"tab" + (tab === t ? " active" : "")} onClick={() => setTab(t)}>
            {t === "team" ? "Team" : "ART"}
          </button>
        ))}
      </div>
      <BacklogList key={tab} tab={tab} {...props} />
    </aside>
  );
}

type FacetOptions = Parameters<typeof FilterBar>[0]["options"];

function BacklogList(props: SidebarProps & { tab: Tab }) {
  const { tab, team, ctx } = props;
  const { config, pi, types, category } = ctx;
  const [filter, setFilter] = useState<ItemFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<SortKey>("rank");
  const sprintPaths = pi.sprints.map((s) => s.path);
  const nodeName = (id: string) => findNode(config.root, id)?.name;

  // Active quick filters may carry WIQL clauses: those apply server-side, like on the board.
  const quick: ItemFilter = { ...EMPTY_FILTER, quick: filter.quick };
  const quickKey = wiqlSuffix(quick);

  const { data, loading, error } = useAsync(async () => {
    if (tab === "team") {
      // Completed / Removed stories are excluded by the server, not downloaded and dropped.
      const open = { ...quick, wiql: await openStatesClause(types) };
      const items = await queryWorkItems(withWiqlFilter(scopeQuery(types, scopeAreas(team)), open), baseFields(config).concat(F.priority));
      return unplannedStories(items, sprintPaths, category);
    }
    // Only request optional fields the process has (unknown fields fail the whole batch).
    const known = new Set((await getFieldNames()).map((f) => f.referenceName));
    const optional = [F.priority, F.stackRank, F.businessValue, F.timeCriticality, F.effort, config.rroeField ?? DEFAULT_RROE_FIELD];
    const items = await queryWorkItems(withWiqlFilter(scopeQuery([config.types.feature], ctx.artAreas), quick), [
      ...baseFields(config),
      ...optional.filter((f) => known.has(f)),
    ]);
    return items.filter((i) => isOpen(i, category));
  }, [tab, props.token, quickKey]);

  const items = data ?? [];
  const opts = facetOptions(items);
  const facetOpts = opts as unknown as FacetOptions;
  const shown = sortItems(searchItems(applyFilter(items, { ...filter, text: "" }), filter.text), sort, config.storyPointsField, config.rroeField);
  const kind = tab === "team" ? "story" : "feature";

  return (
    <div className="tb-backlog" role="tabpanel" aria-label={tab === "team" ? "Team backlog" : "ART backlog"}>
      <div className="tb-sidebar-filter">
        <FilterBar value={filter} onChange={setFilter} options={facetOpts} showWiql={false} />
      </div>
      <select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
        <option value="rank">Backlog order</option>
        <option value="priority">Priority</option>
        <option value="points">Story Points</option>
        <option value="id">ID</option>
        {tab === "art" && <option value="wsjf">WSJF</option>}
      </select>
      {loading && !data && <Spinner label="Loading backlog…" />}
      <ErrorBar message={error} />
      {data && shown.length === 0 && <div className="muted small tb-empty">{isFilterActive(filter) ? "No matches" : "Nothing unplanned"}</div>}
      {shown.map((i) => {
        const pts = storyPoints(i, config.storyPointsField);
        const w = wsjf(i, config.rroeField);
        const meta = ctx.metas.get(i.id);
        const markers = backlogMarkers(i, { pis: ctx.pis, pi, meta, teamId: team.id, nodeName, story: tab === "team" });
        const piNames = tab === "art" ? assignedPiNames(meta, ctx.pis) : [];
        return (
          <div
            key={i.id}
            className="card tb-backlog-card"
            style={{ borderLeftColor: typeColor(i.fields[F.type]) }}
            draggable={props.canPlan}
            onDragStart={
              props.canPlan
                ? (e) => {
                    e.dataTransfer.setData("text/plain", encodeDrag({ kind, id: i.id }));
                    props.onDragStart({ kind, id: i.id, type: i.fields[F.type] });
                  }
                : undefined
            }
            onDragEnd={props.canPlan ? props.onDragEnd : undefined}
            onClick={() => props.onOpen(i.id)}
            title={`${i.fields[F.type]} #${i.id}: ${i.fields[F.title]}`}
          >
            <div className="card-title">{i.fields[F.title]}</div>
            <div className="card-meta">
              <span className="muted">#{i.id}</span>
              <span className="state">
                <i className="dot" style={{ background: CATEGORY_COLOR[category(i.fields[F.type], i.fields[F.state])] ?? "#999" }} />
                {i.fields[F.state]}
              </span>
              {pts > 0 && <span className="pill">{pts} pts</span>}
              {i.fields[F.priority] !== undefined && <span className="pill">P{i.fields[F.priority]}</span>}
              {tab === "art" && w !== undefined && <span className="pill">WSJF {w}</span>}
            </div>
            {(markers.length > 0 || piNames.length > 0) && (
              <div className="card-meta tb-markers">
                {markers.map((m) => (
                  <span key={m.kind} className={"tb-marker " + m.kind}>
                    {m.label}
                  </span>
                ))}
                {piNames.length > 0 && (
                  <span className="tb-marker pis" title="Assigned PIs">
                    PIs: {piNames.join(", ")}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
