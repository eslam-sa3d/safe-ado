import { MouseEvent as ReactMouseEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BoardRow,
  calculatePlacement,
  childIdsOf,
  childTypeOf,
  milestonesBySprint,
  rowForArea,
  sprintIndexForDate,
  todayIso,
} from "../api/artboard";
import { metaStore, milestonesStore } from "../api/data";
import { criticalityByIteration, CRITICALITY_COLOR, CRITICALITY_LABEL, dependenciesOf } from "../api/dependencies";
import { boardRows, boardType, flatten, pathTo, scopeAreas } from "../api/org";
import { scopeQuery } from "../api/queries";
import { Criticality, F, LINK, Milestone, WorkItem, WorkItemMeta } from "../api/types";
import {
  addLink,
  getStateCategories,
  getWorkItems,
  isUnder,
  openNewWorkItem,
  openWorkItem,
  queryWorkItems,
  relationTargetId,
  removeLink,
  setFields,
} from "../api/wit";
import { CATEGORY_COLOR, Empty, ErrorBar, fmtDate, Info, Spinner, storage, typeColor, useAsync, Icon } from "../components/common";
import { useSafe } from "../components/context";

interface Column {
  key: string;
  title: string;
  subtitle?: string;
  path: string;
}

type Row = BoardRow;

interface Edge {
  from: number;
  to: number;
  criticality: Criticality;
}

interface Placement {
  row: string;
  col: number;
}

export type PlacementMode = "calculated" | "feature";

const [loadMode, saveMode] = storage<PlacementMode>("safe-ado-artboard-placement", "calculated");
const CRITICALITIES: Criticality[] = ["healthy", "atRisk", "critical", "resolved"];
const CHILD_FIELDS = [F.id, F.title, F.type, F.state, F.area, F.iteration];

interface BoardData {
  items: WorkItem[];
  category: (type: string, state: string) => string;
  children: Map<number, WorkItem[]>;
  meta: Map<number, WorkItemMeta>;
  milestones: Milestone[];
}

/**
 * ART / Solution Planning Board: rows are teams (or ARTs at solution level), columns are the
 * PI's iterations, cards are Features (or Capabilities). In Agile Hive's default "calculated"
 * mode cards sit where their children are planned; "feature iteration" mode places them by
 * their own iteration and allows drag-and-drop re-planning and dependency editing.
 */
export function ProgramBoard() {
  const { config, node, pi } = useSafe();
  const type = boardType(config, node.level);
  const childType = childTypeOf(config, type);
  const areas = scopeAreas(node);
  const [mode, setModeState] = useState<PlacementMode>(loadMode);
  const [showDeps, setShowDeps] = useState(true);
  const [shown, setShown] = useState<Record<Criticality, boolean>>({ healthy: true, atRisk: true, critical: true, resolved: true });
  const [linkFrom, setLinkFrom] = useState<number | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string>();
  const editable = mode === "feature";

  const setMode = (m: PlacementMode) => {
    setModeState(m);
    saveMode(m);
    setLinkMode(false);
    setLinkFrom(null);
  };

  const { data, loading, error, reload, setData } = useAsync(async (): Promise<BoardData> => {
    const empty: BoardData = { items: [], category: () => "", children: new Map(), meta: new Map(), milestones: [] };
    if (!pi) return empty;
    const [all, category] = await Promise.all([
      queryWorkItems(scopeQuery([type], areas, pi.path), [], true),
      getStateCategories([type, childType]),
    ]);
    const items = all.filter((i) => category(i.fields[F.type], i.fields[F.state]) !== "Removed");
    const childIds = childType ? items.flatMap(childIdsOf) : [];
    const [childItems, metas, milestones] = await Promise.all([
      childIds.length ? getWorkItems(childIds, CHILD_FIELDS) : Promise.resolve([] as WorkItem[]),
      // Planning metadata is optional: the board still works without it.
      metaStore.list().catch(() => [] as WorkItemMeta[]),
      milestonesStore.list().catch(() => [] as Milestone[]),
    ]);
    const byId = new Map(childItems.map((c) => [c.id, c]));
    const children = new Map(
      items.map((i) => [
        i.id,
        childIdsOf(i)
          .map((id) => byId.get(id))
          .filter(
            (c): c is WorkItem =>
              !!c && c.fields[F.type] === childType && category(c.fields[F.type], c.fields[F.state]) !== "Removed"
          ),
      ])
    );
    return { items, category, children, meta: new Map(metas.map((m) => [m.workItemId, m])), milestones };
  }, [type, childType, areas.join("|"), pi?.path]);

  const columns: Column[] = useMemo(() => {
    if (!pi) return [];
    return [
      { key: "backlog", title: "PI Backlog", subtitle: "Not yet scheduled", path: pi.path },
      ...pi.sprints.map((s) => ({
        key: s.path,
        title: s.name,
        subtitle: s.start ? `${fmtDate(s.start)} – ${fmtDate(s.finish)}` : undefined,
        path: s.path,
      })),
    ];
  }, [pi]);

  const rows: Row[] = useMemo(() => {
    const base = boardRows(node).map((n) => ({ key: n.id, title: n.name, areaPath: n.areaPath, node: n }));
    return [...base, { key: "unassigned", title: "Unassigned", areaPath: undefined }];
  }, [node]);

  const items = data?.items ?? [];
  const sprintPaths = useMemo(() => (pi?.sprints ?? []).map((s) => s.path), [pi]);
  const nodeName = useMemo(() => new Map(flatten(config.root).map((n) => [n.id, n.name])), [config]);

  const calculated = useMemo(() => {
    const map = new Map<number, ReturnType<typeof calculatePlacement>>();
    for (const item of items) {
      map.set(item.id, calculatePlacement(item, data?.children.get(item.id) ?? [], rows, sprintPaths, data?.meta.get(item.id)?.owningNodeId));
    }
    return map;
  }, [items, data, rows, sprintPaths]);

  const placement = useMemo(() => {
    const map = new Map<number, Placement>();
    for (const item of items) {
      if (mode === "calculated") {
        const c = calculated.get(item.id)!;
        map.set(item.id, { row: c.row ?? "unassigned", col: c.sprint + 1 });
        continue;
      }
      const iter = item.fields[F.iteration] as string;
      const row = rowForArea(item.fields[F.area], rows) ?? "unassigned";
      let col = columns.findIndex((c, i) => i > 0 && isUnder(iter, c.path));
      if (col < 0) col = 0;
      map.set(item.id, { row, col });
    }
    return map;
  }, [items, rows, columns, mode, calculated]);

  const edges: Edge[] = useMemo(() => {
    const done = new Map(items.map((i) => [i.id, data!.category(i.fields[F.type], i.fields[F.state]) === "Completed"]));
    return dependenciesOf(items)
      .filter((d) => placement.has(d.provider) && placement.has(d.consumer))
      .map((d) => ({
        from: d.provider,
        to: d.consumer,
        criticality: criticalityByIteration(placement.get(d.provider)!.col - 1, placement.get(d.consumer)!.col - 1, done.get(d.provider)),
      }));
  }, [items, placement, data]);

  const visibleEdges = edges.filter((e) => shown[e.criticality]);

  const externalDeps = (item: WorkItem) =>
    (item.relations ?? []).filter(
      (r) => (r.rel === LINK.successor || r.rel === LINK.predecessor) && !placement.has(relationTargetId(r.url) ?? -1)
    ).length;

  const criticalByRow = (rowKey: string) =>
    edges.filter((e) => e.criticality === "critical" && (placement.get(e.from)!.row === rowKey || placement.get(e.to)!.row === rowKey))
      .length;

  const visibleRows = rows.filter((r) => r.key !== "unassigned" || items.some((i) => placement.get(i.id)?.row === "unassigned"));

  const milestones = useMemo(
    () => milestonesBySprint(data?.milestones ?? [], pathTo(config.root, node.id).map((n) => n.id), pi?.sprints ?? []),
    [data, config, node, pi]
  );
  const currentSprint = sprintIndexForDate(todayIso(), pi?.sprints ?? []);

  const toggleRow = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // --- drag & drop (feature iteration mode) ---------------------------------------------------
  const onDrop = async (id: number, row: Row, col: Column) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    const changes: Record<string, string> = {};
    if (row.areaPath && placement.get(id)?.row !== row.key) changes[F.area] = row.areaPath;
    if (item.fields[F.iteration] !== col.path) changes[F.iteration] = col.path;
    if (!Object.keys(changes).length) return;
    // Optimistic move, then refresh from the server.
    setData({ ...data!, items: items.map((i) => (i.id === id ? { ...i, fields: { ...i.fields, ...changes } } : i)) });
    try {
      await setFields(id, changes);
    } catch (e: any) {
      setActionError(`Could not move #${id}: ${e.message}`);
    }
    reload(true);
  };

  const onCardClick = async (id: number) => {
    if (!linkMode) {
      await openWorkItem(id);
      reload(true);
      return;
    }
    if (linkFrom === null) {
      setLinkFrom(id);
    } else if (linkFrom !== id) {
      try {
        await addLink(linkFrom, id, LINK.successor, "Program board dependency");
        setLinkFrom(null);
        reload(true);
      } catch (e: any) {
        setActionError(`Could not add dependency: ${e.message}`);
      }
    }
  };

  const onEdgeClick = async (edge: Edge) => {
    if (!editable || !window.confirm(`Remove dependency #${edge.from} → #${edge.to}?`)) return;
    const provider = items.find((i) => i.id === edge.from)!;
    const onProvider = (provider.relations ?? []).some((r) => r.rel === LINK.successor && relationTargetId(r.url) === edge.to);
    try {
      // The link may be stored on either side; Azure DevOps removes the reverse end automatically.
      if (onProvider) await removeLink(edge.from, edge.to, LINK.successor);
      else await removeLink(edge.to, edge.from, LINK.predecessor);
      reload(true);
    } catch (e: any) {
      setActionError(`Could not remove dependency: ${e.message}`);
    }
  };

  // --- dependency lines ------------------------------------------------------------------------
  const gridRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<number, HTMLElement>());
  const [rects, setRects] = useState<Map<number, DOMRect>>(new Map());

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
  }, [items, placement, showDeps, collapsed]);

  if (!pi) return null;
  if (loading && !data) return <Spinner label="Loading program board…" />;
  if (!data) return <ErrorBar message={error} />;

  const counts = Object.fromEntries(CRITICALITIES.map((c) => [c, edges.filter((e) => e.criticality === c).length])) as Record<
    Criticality,
    number
  >;

  return (
    <div className="board-view">
      <div className="toolbar">
        <strong>{type}s</strong>
        <span className="muted">
          {items.length} items · {edges.length} dependencies
          {counts.critical > 0 && <span className="danger"> · {counts.critical} critical</span>}
        </span>
        <span className="spacer" />
        <span className="segmented" role="group" aria-label="Placement">
          <span className="muted small">Placement:</span>
          <button className={"btn" + (mode === "calculated" ? " primary" : "")} aria-pressed={mode === "calculated"} onClick={() => setMode("calculated")}>
            Calculated from team plans
          </button>
          <button className={"btn" + (mode === "feature" ? " primary" : "")} aria-pressed={mode === "feature"} onClick={() => setMode("feature")}>
            Feature iteration
          </button>
        </span>
        <label className="check">
          <input type="checkbox" checked={showDeps} onChange={(e) => setShowDeps(e.target.checked)} /> Show dependencies
        </label>
        {editable && (
          <button
            className={"btn" + (linkMode ? " primary" : "")}
            onClick={() => {
              setLinkMode(!linkMode);
              setLinkFrom(null);
            }}
            title="Click a predecessor card, then its successor"
          >
            {linkMode ? (linkFrom ? `Select successor of #${linkFrom}…` : "Select predecessor…") : "Add dependency"}
          </button>
        )}
        <button className="btn" onClick={() => setCollapsed(new Set(visibleRows.map((r) => r.key)))}>
          Collapse all
        </button>
        <button className="btn" onClick={() => setCollapsed(new Set())}>
          Expand all
        </button>
        <button className="btn" onClick={() => reload()}>
          <Icon name="Refresh" /> Refresh
        </button>
      </div>
      <ErrorBar message={error ?? actionError} onClose={() => setActionError(undefined)} />
      {!node.children.length && node.level !== "team" && (
        <Info>This {node.level === "art" ? "ART has no teams" : "node has no children"} yet. Add them in Setup to get one row per team.</Info>
      )}
      {items.length === 0 && !loading && (
        <Empty title={`No ${type}s in ${pi.name}`}>
          <p>
            Items appear here when their Iteration Path is under <code>{pi.path}</code> and their Area Path is under{" "}
            <code>{areas.join(", ") || "(no area configured)"}</code>.
          </p>
        </Empty>
      )}

      <div className="board-scroll">
        <div
          className="board-grid"
          ref={gridRef}
          style={{ gridTemplateColumns: `180px repeat(${columns.length}, minmax(190px, 1fr))` }}
        >
          <div className="board-corner" />
          {columns.map((c, ci) => (
            <div
              key={c.key}
              className={"board-col-header" + (c.key === "backlog" ? " backlog" : "") + (ci - 1 === currentSprint && ci > 0 ? " current" : "")}
            >
              <div>{c.title}</div>
              {c.subtitle && <div className="muted small">{c.subtitle}</div>}
              {ci > 0 && ci - 1 === currentSprint && <span className="today-badge">Today</span>}
              {(milestones.get(ci - 1) ?? []).map((m) => (
                <div key={m.id} className="milestone-chip" title={`${m.title} — ${fmtDate(m.date)}${m.description ? `\n${m.description}` : ""}`}>
                  <Icon name="DiamondSolid" className="small" /> {m.title}
                </div>
              ))}
            </div>
          ))}
          {visibleRows.map((r) => (
            <RowCells
              key={r.key}
              row={r}
              columns={columns}
              items={items.filter((i) => placement.get(i.id)?.row === r.key)}
              colOf={(id) => placement.get(id)!.col}
              category={data.category}
              pointsField={config.storyPointsField}
              externalDeps={externalDeps}
              critical={criticalByRow(r.key)}
              collapsed={collapsed.has(r.key)}
              onToggle={() => toggleRow(r.key)}
              editable={editable}
              info={(id) => {
                const c = calculated.get(id)!;
                const owner = data.meta.get(id)?.owningNodeId;
                return {
                  involved: c.involved.map((k) => rows.find((x) => x.key === k)!.title),
                  unplanned: c.unplanned,
                  owner: owner ? nodeName.get(owner) ?? owner : undefined,
                  hasChildren: (data.children.get(id) ?? []).length > 0,
                };
              }}
              selected={linkFrom}
              cardRef={(id, el) => (el ? cardRefs.current.set(id, el) : cardRefs.current.delete(id))}
              onDrop={onDrop}
              onCardClick={onCardClick}
              onNew={(col) =>
                openNewWorkItem(type, {
                  [F.area]: r.areaPath ?? areas[0],
                  [F.iteration]: col.path,
                }).then(() => reload(true))
              }
            />
          ))}
          {showDeps && (
            <svg className="dep-layer">
              <defs>
                {CRITICALITIES.map((s) => (
                  <marker key={s} id={`arrow-${s}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0,0 L10,5 L0,10 z" className={`dep-head ${s}`} style={{ fill: CRITICALITY_COLOR[s] }} />
                  </marker>
                ))}
              </defs>
              {visibleEdges.map((e) => {
                const a = rects.get(e.from);
                const b = rects.get(e.to);
                if (!a || !b) return null;
                const forward = b.x >= a.x;
                const x1 = forward ? a.right : a.left;
                const x2 = forward ? b.left : b.right;
                const y1 = a.y + a.height / 2;
                const y2 = b.y + b.height / 2;
                const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
                return (
                  <path
                    key={`${e.from}-${e.to}`}
                    d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
                    className={`dep-line ${e.criticality}${editable ? "" : " readonly"}`}
                    style={{ stroke: CRITICALITY_COLOR[e.criticality] }}
                    markerEnd={`url(#arrow-${e.criticality})`}
                    onClick={() => onEdgeClick(e)}
                  >
                    <title>
                      #{e.from} → #{e.to} ({CRITICALITY_LABEL[e.criticality]})
                      {e.criticality === "critical" ? " — consumer is planned before its provider" : ""}
                      {editable ? "\nClick to remove" : ""}
                    </title>
                  </path>
                );
              })}
            </svg>
          )}
        </div>
      </div>
      <div className="legend-bar muted small">
        {CRITICALITIES.map((c) => (
          <label key={c} className="check">
            <input
              type="checkbox"
              checked={shown[c]}
              aria-label={`Show ${CRITICALITY_LABEL[c].toLowerCase()} dependencies`}
              onChange={(e) => setShown({ ...shown, [c]: e.target.checked })}
            />
            <i className={`line ${c}`} style={{ borderColor: CRITICALITY_COLOR[c] }} /> {CRITICALITY_LABEL[c]} ({counts[c]})
          </label>
        ))}
        <span>
          {editable
            ? "Drag cards to re-plan. Changes update Area Path and Iteration Path."
            : "Cards are placed in the sprint of their last planned child and the team planning it."}
        </span>
      </div>
    </div>
  );
}

interface CardInfo {
  involved: string[];
  unplanned: WorkItem[];
  owner?: string;
  hasChildren: boolean;
}

function RowCells(props: {
  row: Row;
  columns: Column[];
  items: WorkItem[];
  colOf: (id: number) => number;
  category: (type: string, state: string) => string;
  pointsField: string;
  externalDeps: (item: WorkItem) => number;
  critical: number;
  collapsed: boolean;
  onToggle: () => void;
  editable: boolean;
  info: (id: number) => CardInfo;
  selected: number | null;
  cardRef: (id: number, el: HTMLElement | null) => void;
  onDrop: (id: number, row: Row, col: Column) => void;
  onCardClick: (id: number) => void;
  onNew: (col: Column) => void;
}) {
  const { row, columns, items, editable, collapsed } = props;
  const [over, setOver] = useState<string | null>(null);
  return (
    <>
      <div className={"board-row-header" + (collapsed ? " collapsed" : "")}>
        <div className="row-title">
          <button
            className="link row-toggle"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${row.title}`}
            onClick={props.onToggle}
          >
            <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="small" />
          </button>
          <span>{row.title}</span>
        </div>
        <div className="muted small">{items.length} items</div>
        <div className={"small" + (props.critical > 0 ? " danger" : " muted")} title="Unresolved critical dependencies involving this row">
          {props.critical} critical
        </div>
      </div>
      {columns.map((col, ci) => {
        const cellItems = items.filter((i) => props.colOf(i.id) === ci);
        return (
          <div
            key={col.key}
            role="group"
            aria-label={`${row.title} / ${col.title}`}
            className={
              "board-cell" + (over === col.key ? " drop-over" : "") + (col.key === "backlog" ? " backlog" : "") + (collapsed ? " collapsed" : "")
            }
            onDragOver={(e) => {
              if (!editable) return;
              e.preventDefault();
              setOver(col.key);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = Number(e.dataTransfer.getData("text/plain"));
              if (editable && id) props.onDrop(id, row, col);
            }}
          >
            {collapsed
              ? cellItems.length > 0 && <span className="muted small">{cellItems.length} items</span>
              : cellItems.map((i) => (
                  <BoardCard
                    key={i.id}
                    item={i}
                    category={props.category}
                    pointsField={props.pointsField}
                    ext={props.externalDeps(i)}
                    info={props.info(i.id)}
                    editable={editable}
                    selected={props.selected === i.id}
                    cardRef={(el) => props.cardRef(i.id, el)}
                    onClick={() => props.onCardClick(i.id)}
                  />
                ))}
            {editable && !collapsed && row.key !== "unassigned" && (
              <button className="cell-add" onClick={() => props.onNew(col)} title="New item here">
                +
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

function BoardCard(props: {
  item: WorkItem;
  category: (type: string, state: string) => string;
  pointsField: string;
  ext: number;
  info: CardInfo;
  editable: boolean;
  selected: boolean;
  cardRef: (el: HTMLElement | null) => void;
  onClick: () => void;
}) {
  const { item: i, info } = props;
  const [open, setOpen] = useState<"teams" | "unplanned" | null>(null);
  const type = i.fields[F.type];
  const cat = props.category(type, i.fields[F.state]);
  const pts = i.fields[props.pointsField];
  const target = i.fields[F.targetDate] as string | undefined;
  const toggle = (e: ReactMouseEvent, what: "teams" | "unplanned") => {
    e.stopPropagation();
    setOpen(open === what ? null : what);
  };
  return (
    <div
      ref={props.cardRef}
      className={"card" + (props.selected ? " selected" : "")}
      style={{ borderLeftColor: typeColor(type) }}
      draggable={props.editable}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i.id))}
      onClick={props.onClick}
      title={`${type} #${i.id}: ${i.fields[F.title]}`}
    >
      <div className="card-title">{i.fields[F.title]}</div>
      <div className="card-meta">
        <span className="muted">#{i.id}</span>
        <span className="state">
          <i className="dot" style={{ background: CATEGORY_COLOR[cat] ?? "#999" }} />
          {i.fields[F.state]}
        </span>
        {pts ? <span className="pill">{pts} pts</span> : null}
        {props.ext > 0 && (
          <span className="pill ext" title="Dependencies on items outside this board">
            <Icon name="Link" className="small" /> {props.ext}
          </span>
        )}
        {target && <span className="pill due">Due {fmtDate(target)}</span>}
        {info.owner && <span className="pill owner" title="Owning team"><Icon name="TeamFavorite" className="small" /> {info.owner}</span>}
        {info.hasChildren && (
          <button className="pill link involved" aria-label={`Involved teams: ${info.involved.length}`} onClick={(e) => toggle(e, "teams")}>
            <Icon name="People" className="small" /> {info.involved.length}
          </button>
        )}
        {info.unplanned.length > 0 && (
          <button
            className="pill link warn-icon"
            aria-label={`${info.unplanned.length} children not planned in this PI`}
            onClick={(e) => toggle(e, "unplanned")}
          >
            <Icon name="Warning" className="small" /> {info.unplanned.length}
          </button>
        )}
      </div>
      {open === "teams" && (
        <div className="card-popover" onClick={(e) => e.stopPropagation()}>
          <div className="small muted">Involved teams</div>
          {info.involved.length ? (
            <ul aria-label="Involved teams">
              {info.involved.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : (
            <div className="small">No children in this board's teams.</div>
          )}
        </div>
      )}
      {open === "unplanned" && (
        <div className="card-popover" onClick={(e) => e.stopPropagation()}>
          <div className="small muted">Not planned in this PI's iterations</div>
          <ul aria-label="Unplanned children">
            {info.unplanned.map((c) => (
              <li key={c.id}>
                #{c.id} {c.fields[F.title]} <span className="muted">({c.fields[F.iteration] || "no iteration"})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
