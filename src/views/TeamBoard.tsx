import { FormEvent, Fragment, ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { capacityId, capacityStore, emptyMeta, metaStore } from "../api/data";
import { CRITICALITY_COLOR, CRITICALITY_LABEL, sprintIndex } from "../api/dependencies";
import { applyFilter, EMPTY_FILTER, facetOptions, ItemFilter, withWiqlFilter } from "../api/filters";
import { parentOf, scopeAreas } from "../api/org";
import { baseFields, scopeQuery } from "../api/queries";
import {
  assignMeta,
  BoardDependency,
  boardDependencies,
  buildLanes,
  decodeDrag,
  encodeDrag,
  externalIds,
  groupByArea,
  isOpen,
  iterationStatus,
  IterationStatus,
  Lane,
  moveChanges,
  ownParentId,
  parentMap,
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
  getStateCategories,
  getWorkItems,
  getWorkItemTypes,
  openWorkItem,
  queryIds,
  queryWorkItems,
  removeLink,
  setFields,
} from "../api/wit";
import { FilterBar } from "../components/FilterBar";
import { CATEGORY_COLOR, ErrorBar, fmtDate, Info, lastSegment, Spinner, storage, typeColor, useAsync, Icon } from "../components/common";
import { useSafe } from "../components/context";

/**
 * Team Planning Board (Agile Hive's "breakout board"). Columns are the PI's iterations with
 * load / capacity, rows are the team's Feature swimlanes plus "Independent", followed by
 * read-only sibling teams of the ART and an EXTERNAL block for dependencies outside the board.
 * An "Unplanned" sidebar offers the team backlog and the ART's features for drag & drop.
 *
 * "Remove from board" moves a story back to `config.piRootIteration` — the iteration above all
 * PIs — so it leaves every PI and reappears in the team's Unplanned list.
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

interface BlockData {
  stories: WorkItem[];
  features: WorkItem[];
  parents: Map<number, number>;
  external: WorkItem[];
}

interface Ctx {
  config: SafeConfig;
  pi: ProgramIncrement;
  types: string[];
  category: Category;
  metas: Map<number, WorkItemMeta>;
  artAreas: string[];
}

const ALL_CRITICALITIES: Criticality[] = ["healthy", "atRisk", "critical", "resolved"];
const [loadLayout, saveLayout] = storage<Layout>("safe-ado-teamboard-layout", "compact");

/** Loads one team's stories in the PI, their Feature parents, assigned features and external dependency ends. */
async function loadBlock(ctx: Ctx, team: OrgNode, filter: ItemFilter): Promise<BlockData> {
  const { config, pi, types, category, metas } = ctx;
  const stories = (
    await queryWorkItems(withWiqlFilter(scopeQuery(types, scopeAreas(team), pi.path), filter), [], true)
  ).filter((s) => category(s.fields[F.type], s.fields[F.state]) !== "Removed");

  const featureIds = new Set<number>();
  stories.forEach((s) => {
    const p = ownParentId(s);
    if (p !== null) featureIds.add(p);
  });
  metas.forEach((m) => {
    if (m.assignedNodeIds.includes(team.id) && m.assignedPiPaths.includes(pi.path)) featureIds.add(m.workItemId);
  });
  // Features planned in the PI on the ART, so parents known only through their Child link resolve too.
  (await queryIds(scopeQuery([config.types.feature], ctx.artAreas, pi.path))).forEach((id) => featureIds.add(id));
  const features = featureIds.size
    ? (await getWorkItems(Array.from(featureIds), undefined, true)).filter(
        (f) => f.fields[F.type] === config.types.feature && category(f.fields[F.type], f.fields[F.state]) !== "Removed"
      )
    : [];

  const extIds = externalIds(stories);
  const external = extIds.length ? await getWorkItems(extIds, baseFields(config)) : [];
  return { stories, features, parents: parentMap(stories, features), external };
}

function TeamPlanningBoard({ team, pi }: { team: OrgNode; pi: ProgramIncrement }) {
  const { config } = useSafe();
  const art = parentOf(config.root, team.id);
  const siblings = (art?.children ?? []).filter((c) => c.id !== team.id && c.level === "team");
  const artAreas = art ? scopeAreas(art) : scopeAreas(team);
  const sprintPaths = pi.sprints.map((s) => s.path);
  const today = todayIso();
  const status = pi.sprints.map((s) => iterationStatus(s, today));

  const [filter, setFilter] = useState<ItemFilter>(EMPTY_FILTER);
  const [laneFilter, setLaneFilter] = useState<string[]>([]);
  const [crit, setCrit] = useState<Criticality[]>(ALL_CRITICALITIES);
  const [showDeps, setShowDeps] = useState(true);
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const [collapse, setCollapse] = useState<{ all: boolean; over: Record<string, boolean> }>({ all: false, over: {} });
  const [actionError, setActionError] = useState<string>();
  const [backlogToken, setBacklogToken] = useState(0);
  const [creating, setCreating] = useState<{ lane: string; sprint: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, reload, setData } = useAsync(async () => {
    const types = storyLevelTypes(config.types.story, (await getWorkItemTypes()).map((t) => t.name));
    const [metaDocs, caps, category] = await Promise.all([
      metaStore.list(),
      capacityStore.list(),
      getStateCategories([...types, config.types.feature]),
    ]);
    const metas = new Map(metaDocs.map((m) => [m.workItemId, m]));
    const ctx: Ctx = { config, pi, types, category, metas, artAreas };
    const block = await loadBlock(ctx, team, filter);
    return { ctx, block, caps: new Map(caps.map((c) => [c.id, c])) };
  }, [team.id, pi.path, filter.wiql]);

  const setLayout = (l: Layout) => {
    setLayoutState(l);
    saveLayout(l);
  };
  const isCollapsed = (key: string) => collapse.over[key] ?? collapse.all;
  const toggleLane = (key: string) => setCollapse((c) => ({ ...c, over: { ...c.over, [key]: !(c.over[key] ?? c.all) } }));

  const block = data?.block;
  const ctx = data?.ctx;
  const lanes = useMemo(
    () => (block && ctx ? buildLanes(block.stories, block.features, block.parents, ctx.metas, team.id, pi.path) : []),
    [block, ctx, team.id, pi.path]
  );
  const loads = useMemo(() => (block ? sprintLoads(block.stories, sprintPaths, config.storyPointsField) : []), [block, sprintPaths.join("|")]);

  const deps: BoardDependency[] = useMemo(() => {
    if (!block || !ctx) return [];
    const lookup = new Map([...block.external, ...block.stories].map((i) => [i.id, i]));
    return boardDependencies(block.stories, lookup, sprintPaths, ctx.category);
  }, [block, ctx]);

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
      reload(true);
      setBacklogToken((t) => t + 1);
    }
  };

  const saveMeta = (id: number, change: (m: WorkItemMeta) => WorkItemMeta) =>
    metaStore.save(change(data!.ctx.metas.get(id) ?? emptyMeta(id)));

  const onDrop = (raw: string, lane: Lane | null, sprint: Sprint | null) => {
    const payload = decodeDrag(raw);
    if (!payload || !data) return;
    if (payload.kind === "feature") {
      if (lanes.some((l) => l.feature?.id === payload.id && l.assigned)) return;
      void run(`Could not add swimlane for #${payload.id}`, () =>
        saveMeta(payload.id, (m) => assignMeta(m, team.id, pi.path))
      );
      return;
    }
    if (!lane || !sprint) return;
    const id = payload.id;
    void run(`Could not move #${id}`, async () => {
      const [item] = await getWorkItems([id], undefined, true);
      if (!item) throw new Error("the work item no longer exists");
      const changes = moveChanges(item, sprint.path, team.areaPath);
      const current = data.block.parents.get(id) ?? ownParentId(item);
      const target = lane.feature?.id ?? null;
      if (Object.keys(changes).length) await setFields(id, changes);
      if (current === target) return;
      if (current !== null) {
        // Remove the link from whichever side holds it.
        if (ownParentId(item) === current) await removeLink(id, current, LINK.parent);
        else await removeLink(current, id, LINK.child);
      }
      if (target !== null) await addLink(id, target, LINK.parent);
    });
  };

  const removeLane = (lane: Lane) =>
    run(`Could not remove swimlane "${lane.title}"`, () => saveMeta(lane.feature!.id, (m) => unassignMeta(m, team.id, pi.path)));

  const removeFromBoard = (item: WorkItem) =>
    run(`Could not remove #${item.id} from the board`, () => setFields(item.id, { [F.iteration]: config.piRootIteration }));

  const open = (id: number) => run(`Could not open #${id}`, () => openWorkItem(id));

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
    });

  const saveCapacity = async (sprint: Sprint, capacity: number) => {
    const id = capacityId(team.id, sprint.path);
    const existing = data!.caps.get(id);
    const doc: IterationCapacity = { ...(existing ?? { id, nodeId: team.id, iterationPath: sprint.path }), capacity };
    try {
      const saved = await capacityStore.save(doc);
      setData((d) => (d ? { ...d, caps: new Map(d.caps).set(id, saved) } : d));
    } catch (e: any) {
      setActionError(`Could not save capacity: ${e?.message ?? e}`);
    }
  };

  if (loading && !data) return <Spinner label="Loading team planning board…" />;
  if (!data || !block || !ctx) return <ErrorBar message={error} />;

  const visibleStories = new Set(applyFilter(block.stories, filter).map((s) => s.id));
  const laneOptions = lanes.map((l) => ({ key: l.key, title: l.feature ? `#${l.feature.id} ${l.title}` : l.title }));
  const laneVisible = (l: Lane) => laneFilter.length === 0 || laneFilter.includes(l.key);
  const featureTitle = (id: number | undefined) => block.features.find((f) => f.id === id)?.fields[F.title] as string | undefined;
  const shownDeps = deps.filter((d) => crit.includes(d.criticality));
  const critical = deps.filter((d) => d.criticality === "critical").length;
  const cols = `220px repeat(${pi.sprints.length}, minmax(200px, 1fr))`;
  const plannedCount = block.stories.length;
  const onBoard = new Set(block.stories.map((s) => s.id));

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
                    onChange={() =>
                      setLaneFilter((f) => (f.includes(o.key) ? f.filter((k) => k !== o.key) : [...f, o.key]))
                    }
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
        <FilterBar value={filter} onChange={setFilter} options={facetOptions(block.stories)} />
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
        {!team.areaPath && <Info>{team.name} has no area path. Set one in Setup to plan its stories.</Info>}
        {plannedCount === 0 && !loading && (
          <Info>
            No stories of {team.name} are planned in {pi.name} yet. Drag stories from the Unplanned sidebar or create
            them in a cell.
          </Info>
        )}

        <div className="board-scroll">
          <div className="board-grid tb-grid" ref={gridRef} style={{ gridTemplateColumns: cols }}>
            <div className="board-corner" />
            {pi.sprints.map((s, i) => (
              <SprintHeader
                key={s.path}
                sprint={s}
                status={status[i]}
                load={loads[i]}
                capacity={data.caps.get(capacityId(team.id, s.path))?.capacity}
                onSave={(c) => saveCapacity(s, c)}
                onError={setActionError}
              />
            ))}

            <div className="tb-block-header current">
              <span className="tb-block-title">{team.name}</span>
              <div
                className="tb-feature-drop"
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
            </div>
            {lanes.filter(laneVisible).map((lane) => {
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
                  onRemove={lane.assigned && lane.stories.length === 0 ? () => removeLane(lane) : undefined}
                >
                  {pi.sprints.map((s, si) => {
                    const past = status[si] === "past";
                    const here = stories.filter((st) => sprintIndex(st.fields[F.iteration], sprintPaths) === si);
                    const isCreating = creating?.lane === lane.key && creating.sprint === s.path;
                    return (
                      <DropCell
                        key={s.path}
                        label={`${lane.title} / ${s.name}`}
                        disabled={past}
                        onDrop={(raw) => onDrop(raw, lane, s)}
                      >
                        {here.map((st) => (
                          <Card
                            key={st.id}
                            item={st}
                            {...cardProps}
                            parentTitle={featureTitle(block.parents.get(st.id))}
                            draggable={!past}
                            cardRef={cardRef}
                            onRemove={past ? undefined : () => removeFromBoard(st)}
                          />
                        ))}
                        {!past && !isCreating && (
                          <button
                            className="cell-add"
                            aria-label={`Create in ${lane.title} / ${s.name}`}
                            title="Create a story here"
                            onClick={() => setCreating({ lane: lane.key, sprint: s.path })}
                          >
                            +
                          </button>
                        )}
                        {isCreating && (
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
                filter={filter}
                laneVisible={laneVisible}
                isCollapsed={isCollapsed}
                onToggleLane={toggleLane}
                cardProps={cardProps}
              />
            ))}

            {block.external.length > 0 && (
              <ExternalBlock
                items={block.external}
                pi={pi}
                category={ctx.category}
                layout={layout}
                cardRef={cardRef}
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
          <span>Load / Capacity in story points. Click a capacity to edit it.</span>
          <span>Drag stories to plan them; the swimlane sets the parent Feature.</span>
        </div>
      </div>
      <UnplannedSidebar
        team={team}
        ctx={ctx}
        token={backlogToken}
        onOpen={open}
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
  load: number;
  capacity: number | undefined;
  onSave: (capacity: number) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { sprint, status, load, capacity } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const done = useRef(false);
  const over = capacity !== undefined && load > capacity;

  const commit = () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const value = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(value) || value < 0) {
      props.onError(`Capacity must be a non-negative number`);
      return;
    }
    if (value !== capacity) void props.onSave(value);
  };

  const loadText = (
    <>
      <span className={"tb-load" + (over ? " overload" : "")}>{load}</span> / {capacity ?? "–"}
    </>
  );

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
        {status === "past" ? (
          <span className="tb-capacity locked" title="Iteration completed — capacity is locked">
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
            title="Load / Capacity (story points) — click to edit capacity"
            onClick={() => {
              done.current = false;
              setDraft(capacity === undefined ? "" : String(capacity));
              setEditing(true);
            }}
          >
            {loadText}
          </button>
        )}
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

function DropCell(props: { label: string; disabled: boolean; onDrop: (raw: string) => void; children: ReactNode }) {
  const [over, setOver] = useState(false);
  if (props.disabled) return <div className="board-cell tb-cell past">{props.children}</div>;
  return (
    <div
      role="group"
      aria-label={props.label}
      className={"board-cell tb-cell" + (over ? " drop-over" : "")}
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

function Card(props: {
  item: WorkItem;
  category: Category;
  pointsField: string;
  layout: Layout;
  parentTitle?: string;
  draggable?: boolean;
  cardRef?: (id: number, el: HTMLElement | null) => void;
  onOpen: (id: number) => void;
  onRemove?: () => void;
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
  return (
    <div
      ref={props.cardRef ? (el) => props.cardRef!(item.id, el) : undefined}
      className={"card tb-card " + layout}
      style={{ borderLeftColor: typeColor(type) }}
      draggable={!!props.draggable}
      onDragStart={props.draggable ? (e) => e.dataTransfer.setData("text/plain", encodeDrag({ kind: "story", id: item.id })) : undefined}
      onClick={() => props.onOpen(item.id)}
      title={`${type} #${item.id}: ${item.fields[F.title]}`}
    >
      <div className="card-title">{item.fields[F.title]}</div>
      <div className="card-meta">
        <span className="muted">#{item.id}</span>
        <span className="state">
          <i className="dot" style={{ background: CATEGORY_COLOR[cat] ?? "#999" }} />
          {item.fields[F.state]}
        </span>
        {pts !== undefined && pts !== null && pts !== "" ? <span className="pill">{pts} pts</span> : null}
        {props.parentTitle && (
          <span className="pill tb-parent" title="Parent feature">
            {props.parentTitle}
          </span>
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
// Sibling teams (read-only, lazily loaded)
// ---------------------------------------------------------------------------------------------

function SiblingBlock(props: {
  team: OrgNode;
  ctx: Ctx;
  filter: ItemFilter;
  laneVisible: (l: Lane) => boolean;
  isCollapsed: (key: string) => boolean;
  onToggleLane: (key: string) => void;
  cardProps: { category: Category; pointsField: string; layout: Layout; onOpen: (id: number) => void };
}) {
  const { team, ctx, filter } = props;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<BlockData>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(undefined);
    loadBlock(ctx, team, filter)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(`Could not load ${team.name}: ${e?.message ?? e}`))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ctx, filter.wiql]);

  const sprintPaths = ctx.pi.sprints.map((s) => s.path);
  const criticalCount = useMemo(() => {
    if (!data) return undefined;
    const lookup = new Map([...data.external, ...data.stories].map((i) => [i.id, i]));
    return boardDependencies(data.stories, lookup, sprintPaths, ctx.category).filter((d) => d.criticality === "critical").length;
  }, [data]);

  const visible = new Set(applyFilter(data?.stories ?? [], filter).map((s) => s.id));
  const lanes = data
    ? buildLanes(data.stories, data.features, data.parents, ctx.metas, team.id, ctx.pi.path)
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
      </div>
      {open && loading && (
        <div className="tb-span">
          <Spinner label={`Loading ${team.name}…`} />
        </div>
      )}
      {open && error && (
        <div className="tb-span">
          <ErrorBar message={error} />
        </div>
      )}
      {open && !loading && data && lanes.length === 0 && (
        <div className="tb-span muted small tb-empty">No stories of {team.name} in {ctx.pi.name}.</div>
      )}
      {open &&
        !loading &&
        lanes.map(({ lane, stories }) => {
          const key = `${team.id}|${lane.key}`;
          return (
            <LaneRow key={key} lane={lane} count={stories.length} collapsed={props.isCollapsed(key)} onToggle={() => props.onToggleLane(key)}>
              {ctx.pi.sprints.map((s, si) => (
                <div key={s.path} className="board-cell tb-cell readonly">
                  {stories
                    .filter((st) => sprintIndex(st.fields[F.iteration], sprintPaths) === si)
                    .map((st) => (
                      <Card key={st.id} item={st} {...props.cardProps} parentTitle={featureTitle(data!.parents.get(st.id))} />
                    ))}
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
  pi: ProgramIncrement;
  category: Category;
  layout: Layout;
  cardRef: (id: number, el: HTMLElement | null) => void;
  onOpen: (id: number) => void;
  exclude: Set<number>;
}) {
  const sprintPaths = props.pi.sprints.map((s) => s.path);
  const groups = groupByArea(props.items.filter((i) => !props.exclude.has(i.id)));
  const card = (i: WorkItem) => (
    <Card key={i.id} item={i} category={props.category} pointsField="" layout={props.layout} cardRef={props.cardRef} onOpen={props.onOpen} />
  );
  return (
    <>
      <div className="tb-block-header external">
        <span className="tb-block-title">EXTERNAL</span>
        <span className="muted small">Dependencies to items outside this board</span>
      </div>
      {groups.map((g) => {
        const outside = g.items.filter((i) => sprintIndex(i.fields[F.iteration], sprintPaths) < 0);
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
                {g.items.filter((i) => sprintIndex(i.fields[F.iteration], sprintPaths) === si).map(card)}
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

function UnplannedSidebar(props: { team: OrgNode; ctx: Ctx; token: number; onOpen: (id: number) => void }) {
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

function BacklogList(props: { tab: Tab; team: OrgNode; ctx: Ctx; token: number; onOpen: (id: number) => void }) {
  const { tab, team, ctx } = props;
  const { config, pi, types, category } = ctx;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("rank");
  const sprintPaths = pi.sprints.map((s) => s.path);

  const { data, loading, error } = useAsync(async () => {
    if (tab === "team") {
      const items = await queryWorkItems(scopeQuery(types, scopeAreas(team)), baseFields(config).concat(F.priority));
      return unplannedStories(items, sprintPaths, category);
    }
    const items = await queryWorkItems(scopeQuery([config.types.feature], ctx.artAreas), [
      ...baseFields(config),
      F.priority,
      F.businessValue,
      F.timeCriticality,
      F.effort,
      F.stackRank,
    ]);
    return items.filter((i) => isOpen(i, category));
  }, [tab, props.token]);

  const shown = sortItems(searchItems(data ?? [], query), sort, config.storyPointsField);
  const kind = tab === "team" ? "story" : "feature";

  return (
    <div className="tb-backlog" role="tabpanel" aria-label={tab === "team" ? "Team backlog" : "ART backlog"}>
      <input className="tb-search" aria-label="Search unplanned" placeholder="Search title or ID" value={query} onChange={(e) => setQuery(e.target.value)} />
      <select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
        <option value="rank">Backlog order</option>
        <option value="priority">Priority</option>
        <option value="points">Story Points</option>
        <option value="id">ID</option>
        {tab === "art" && <option value="wsjf">WSJF</option>}
      </select>
      {loading && !data && <Spinner label="Loading backlog…" />}
      <ErrorBar message={error} />
      {data && shown.length === 0 && <div className="muted small tb-empty">{query ? "No matches" : "Nothing unplanned"}</div>}
      {shown.map((i) => {
        const pts = storyPoints(i, config.storyPointsField);
        const w = wsjf(i);
        return (
          <div
            key={i.id}
            className="card tb-backlog-card"
            style={{ borderLeftColor: typeColor(i.fields[F.type]) }}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", encodeDrag({ kind, id: i.id }))}
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
          </div>
        );
      })}
    </div>
  );
}
