import { Fragment, MouseEvent as ReactMouseEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addHidden,
  ArtBoardData,
  BoardRow,
  calculatePlacement,
  CardEdge,
  cardEdges,
  childTypeOf,
  externalColumn,
  hiddenCrits,
  hiddenDetail,
  HiddenPartners,
  loadArtBoard,
  milestonesBySprint,
  ownerMap,
  rowForArea,
  sprintIndexForDate,
  todayIso,
  worstCriticality,
} from "../api/artboard";
import {
  criticalityByIteration,
  CRITICALITY_COLOR,
  CRITICALITY_LABEL,
  dependencyLinkTypes,
  sprintIndex,
} from "../api/dependencies";
import { applyFilter, EMPTY_FILTER, ExtraFacet, facetOptions, ItemFilter, wiqlSuffix } from "../api/filters";
import { boardRows, boardType, flatten, pathTo, scopeAreas } from "../api/org";
import { groupByArea } from "../api/teamboard";
import { Criticality, F, WorkItem } from "../api/types";
import { addLink, isUnder, openNewWorkItem, openWorkItem, relationTargetId, removeLink, setFields } from "../api/wit";
import { CATEGORY_COLOR, Empty, ErrorBar, fmtDate, Icon, Info, lastSegment, Spinner, storage, typeColor, useAsync } from "../components/common";
import { useCan, useSafe } from "../components/context";
import { FilterBar } from "../components/FilterBar";

interface Column {
  key: string;
  title: string;
  subtitle?: string;
  path: string;
}

type Row = BoardRow;

interface Edge extends CardEdge {
  criticality: Criticality;
}

interface Placement {
  row: string;
  col: number;
}

export type PlacementMode = "calculated" | "feature";

const [loadMode, saveMode] = storage<PlacementMode>("safe-ado-artboard-placement", "calculated");
const extKey = (area: string) => `ext:${area}`;
const CRITICALITIES: Criticality[] =["healthy", "atRisk", "critical", "resolved"];
const EMPTY_DATA: ArtBoardData = {
  items: [],
  category: () => "",
  children: new Map(),
  meta: new Map(),
  milestones: [],
  external: [],
  externalChildren: new Map(),
};

/**
 * ART / Solution Planning Board: rows are teams (or ARTs at solution level), columns are the
 * PI's iterations, cards are Features (or Capabilities). In Agile Hive's default "calculated"
 * mode cards sit where their children are planned; "feature iteration" mode places them by
 * their own iteration and allows drag-and-drop re-planning and dependency editing.
 * Dependencies include story-level links (drawn between the cards owning the stories); partners
 * outside the board sit in EXTERNAL rows, and partners that are not drawn show as edge indicators.
 */
export function ProgramBoard() {
  const { config, node, pi } = useSafe();
  const can = useCan();
  const type = boardType(config, node.level);
  const childType = childTypeOf(config, type);
  const areas = scopeAreas(node);
  const link = dependencyLinkTypes(config);
  const [mode, setModeState] = useState<PlacementMode>(loadMode);
  const [showDeps, setShowDeps] = useState(true);
  const [shown, setShown] = useState<Record<Criticality, boolean>>({ healthy: true, atRisk: true, critical: true, resolved: true });
  const [linkFrom, setLinkFrom] = useState<number | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string>();
  const [filter, setFilter] = useState<ItemFilter>(EMPTY_FILTER);
  const editable = mode === "feature" && can.plan;
  const calculatedMode = mode === "calculated";

  const setMode = (m: PlacementMode) => {
    setModeState(m);
    saveMode(m);
    setLinkMode(false);
    setLinkFrom(null);
  };

  const { data, loading, error, reload, setData } = useAsync(
    async (): Promise<ArtBoardData> => (pi ? loadArtBoard({ type, childType, areas, pi, filter, link }) : EMPTY_DATA),
    [type, childType, areas.join("|"), pi?.path, pi?.identifier, wiqlSuffix(filter), link.forward, link.reverse]
  );

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

  const d = data ?? EMPTY_DATA;
  const items = d.items;
  const sprintPaths = useMemo(() => (pi?.sprints ?? []).map((s) => s.path), [pi]);
  const nodeName = useMemo(() => new Map(flatten(config.root).map((n) => [n.id, n.name])), [config]);

  const calculated = useMemo(() => {
    const map = new Map<number, ReturnType<typeof calculatePlacement>>();
    for (const item of d.items) {
      map.set(item.id, calculatePlacement(item, d.children.get(item.id) ?? [], rows, sprintPaths, d.meta.get(item.id)?.owningNodeId));
    }
    return map;
  }, [d, rows, sprintPaths]);

  const placement = useMemo(() => {
    const map = new Map<number, Placement>();
    for (const item of items) {
      if (calculatedMode) {
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
  }, [items, rows, columns, calculatedMode, calculated]);

  // --- filter (A6) --------------------------------------------------------------------------
  const owningName = (i: WorkItem) => {
    const owner = d.meta.get(i.id)?.owningNodeId;
    return owner ? nodeName.get(owner) ?? owner : "None";
  };
  const involvedNames = (i: WorkItem) => (calculated.get(i.id)?.involved ?? []).map((k) => rows.find((r) => r.key === k)!.title);
  const uniq = (xs: string[]) => Array.from(new Set(xs)).sort((a, b) => a.localeCompare(b));
  const extraFacets: ExtraFacet[] = [
    { key: "owningTeam", label: "Owning team", options: uniq(items.map(owningName)), values: (i) => [owningName(i)] },
    { key: "involvedTeams", label: "Involved teams", options: uniq(items.flatMap(involvedNames)), values: involvedNames },
  ];
  const visibleItems = applyFilter(items, filter, extraFacets);
  const visibleIds = new Set(visibleItems.map((i) => i.id));

  // --- dependencies (A7) ---------------------------------------------------------------------
  const deps = useMemo(() => {
    const owner = ownerMap(d.items, d.children);
    const lookup = new Map<number, WorkItem>();
    for (const i of [...d.external, ...Array.from(d.children.values()).flat(), ...d.items]) lookup.set(i.id, i);
    const extCol = new Map<number, number>();
    for (const e of d.external) {
      const col = pi ? externalColumn(e, d.externalChildren.get(e.id) ?? [], pi, sprintPaths, calculatedMode) : undefined;
      if (col !== undefined) extCol.set(e.id, col);
    }
    const sprintOf = (id: number) => {
      const o = owner.get(id);
      if (o === id) return placement.get(id)!.col - 1;
      if (o !== undefined) return sprintIndex(lookup.get(id)!.fields[F.iteration], sprintPaths);
      return (extCol.get(id) ?? 0) - 1;
    };
    const done = (id: number) => {
      const i = lookup.get(id)!;
      return d.category(i.fields[F.type], i.fields[F.state]) === "Completed";
    };
    const sources = [...d.items, ...Array.from(d.children.values()).flat()];
    const external = new Set(d.external.map((e) => e.id));
    const edges: Edge[] = cardEdges(sources, owner, external, link).map((e) => ({
      ...e,
      criticality: worstCriticality(e.pairs.map((p) => criticalityByIteration(sprintOf(p.provider), sprintOf(p.consumer), done(p.provider)))),
    }));
    return { edges, extCol, lookup };
  }, [d, placement, sprintPaths, calculatedMode, pi, link]);
  const { edges, extCol, lookup } = deps;

  const externalShown = d.external.filter((e) => extCol.has(e.id));
  const externalGroups = groupByArea(externalShown);
  const externalIds = new Set(d.external.map((e) => e.id));

  const extArea = new Map(externalShown.map((e) => [e.id, extKey(String(e.fields[F.area] ?? ""))]));
  const drawn = (id: number) => {
    if (extArea.has(id)) return !collapsed.has(extArea.get(id)!);
    const p = placement.get(id);
    return !!p && visibleIds.has(id) && !collapsed.has(p.row);
  };
  const selectedEdges = edges.filter((e) => shown[e.criticality]);
  const visibleEdges = selectedEdges.filter((e) => drawn(e.from) && drawn(e.to));
  const hidden = new Map<number, HiddenPartners[]>();
  if (showDeps) {
    for (const e of selectedEdges) {
      if (drawn(e.from) && !drawn(e.to)) addHidden(hidden, e.from, "consumers", e.to, e.criticality);
      if (drawn(e.to) && !drawn(e.from)) addHidden(hidden, e.to, "providers", e.from, e.criticality);
    }
  }

  const externalDeps = (item: WorkItem) => new Set(edges.flatMap((e) => (e.from === item.id && externalIds.has(e.to) ? [e.to] : e.to === item.id && externalIds.has(e.from) ? [e.from] : []))).size;

  const criticalByRow = (rowKey: string) =>
    edges.filter((e) => e.criticality === "critical" && (placement.get(e.from)?.row === rowKey || placement.get(e.to)?.row === rowKey)).length;

  const visibleRows = rows.filter((r) => r.key !== "unassigned" || items.some((i) => placement.get(i.id)?.row === "unassigned"));

  const milestones = useMemo(
    () => milestonesBySprint(d.milestones, pathTo(config.root, node.id).map((n) => n.id), pi?.sprints ?? []),
    [d, config, node, pi]
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
    if (!item || !editable) return;
    const changes: Record<string, string> = {};
    if (row.areaPath && placement.get(id)?.row !== row.key) changes[F.area] = row.areaPath;
    if (item.fields[F.iteration] !== col.path) changes[F.iteration] = col.path;
    if (!Object.keys(changes).length) return;
    // Optimistic move, then refresh from the server.
    setData({ ...d, items: items.map((i) => (i.id === id ? { ...i, fields: { ...i.fields, ...changes } } : i)) });
    try {
      await setFields(id, changes);
    } catch (e: any) {
      setActionError(`Could not move #${id}: ${e.message}`);
    }
    reload(true);
  };

  const onCardClick = async (id: number) => {
    if (!linkMode || !editable) {
      await openWorkItem(id);
      reload(true);
      return;
    }
    if (linkFrom === null) {
      setLinkFrom(id);
    } else if (linkFrom !== id) {
      try {
        await addLink(linkFrom, id, link.forward, "Program board dependency");
        setLinkFrom(null);
        reload(true);
      } catch (e: any) {
        setActionError(`Could not add dependency: ${e.message}`);
      }
    }
  };

  const onEdgeClick = async (edge: Edge) => {
    if (!editable || !edge.direct || !window.confirm(`Remove dependency #${edge.from} → #${edge.to}?`)) return;
    const provider = lookup.get(edge.from)!;
    const onProvider = (provider.relations ?? []).some((r) => r.rel === link.forward && relationTargetId(r.url) === edge.to);
    try {
      // The link may be stored on either side; Azure DevOps removes the reverse end automatically.
      if (onProvider) await removeLink(edge.from, edge.to, link.forward);
      else await removeLink(edge.to, edge.from, link.reverse);
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
  }, [data, placement, showDeps, collapsed, filter]);

  if (!pi) return null;
  if (loading && !data) return <Spinner label="Loading program board…" />;
  if (!data) return <ErrorBar message={error} />;

  const counts = Object.fromEntries(CRITICALITIES.map((c) => [c, edges.filter((e) => e.criticality === c).length])) as Record<
    Criticality,
    number
  >;
  const cardRef = (id: number, el: HTMLElement | null) => (el ? cardRefs.current.set(id, el) : cardRefs.current.delete(id));

  return (
    <div className="board-view">
      <div className="toolbar">
        <strong>{type}s</strong>
        <span className="muted">
          {visibleItems.length} items · {edges.length} dependencies
          {counts.critical > 0 && <span className="danger"> · {counts.critical} critical</span>}
        </span>
        <span className="spacer" />
        <span className="segmented" role="group" aria-label="Placement">
          <span className="muted small">Placement:</span>
          <button className={"btn" + (calculatedMode ? " primary" : "")} aria-pressed={calculatedMode} onClick={() => setMode("calculated")}>
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
        <button className="btn" onClick={() => setCollapsed(new Set([...visibleRows.map((r) => r.key), ...externalGroups.map((g) => extKey(g.area))]))}>
          Collapse all
        </button>
        <button className="btn" onClick={() => setCollapsed(new Set())}>
          Expand all
        </button>
        <button className="btn" onClick={() => reload()}>
          <Icon name="Refresh" /> Refresh
        </button>
      </div>
      <FilterBar value={filter} onChange={setFilter} options={facetOptions(items)} extraFacets={extraFacets} />
      <ErrorBar message={error ?? actionError} onClose={() => setActionError(undefined)} />
      {mode === "feature" && !can.plan && (
        <Info>You have read-only access to this area: re-planning by drag and drop, dependency editing and new items are disabled.</Info>
      )}
      {!node.children.length && node.level !== "team" && (
        <Info>This {node.level === "art" ? "ART has no teams" : "node has no children"} yet. Add them in Setup to get one row per team.</Info>
      )}
      {items.length === 0 && !loading && (
        <Empty title={`No ${type}s in ${pi.name}`}>
          <p>
            Items appear here when their Area Path is under <code>{areas.join(", ") || "(no area configured)"}</code> and their Iteration
            Path is under <code>{pi.path}</code>, their children are planned in it, or they are assigned to it.
          </p>
        </Empty>
      )}

      <div className="board-scroll">
        <div
          className="board-grid"
          ref={gridRef}
          style={{ gridTemplateColumns: `180px repeat(${columns.length}, minmax(170px, 1fr))`, minWidth: 180 + columns.length * 170 }}
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
              items={visibleItems.filter((i) => placement.get(i.id)?.row === r.key)}
              colOf={(id) => placement.get(id)!.col}
              category={d.category}
              pointsField={config.storyPointsField}
              externalDeps={externalDeps}
              hidden={hidden}
              critical={criticalByRow(r.key)}
              collapsed={collapsed.has(r.key)}
              onToggle={() => toggleRow(r.key)}
              editable={editable}
              info={(id) => {
                const c = calculated.get(id)!;
                const owner = d.meta.get(id)?.owningNodeId;
                return {
                  involved: c.involved.map((k) => rows.find((x) => x.key === k)!.title),
                  unplanned: c.unplanned,
                  owner: owner ? nodeName.get(owner) ?? owner : undefined,
                  hasChildren: (d.children.get(id) ?? []).length > 0,
                };
              }}
              selected={linkFrom}
              cardRef={cardRef}
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
          {externalGroups.length > 0 && (
            <>
              <div className="ab-external-header" style={{ gridColumn: "1 / -1" }}>
                <span className="ab-external-title">EXTERNAL</span>
                <span className="muted small">Dependency partners outside this board, in their calculated iteration</span>
              </div>
              {externalGroups.map((g) => {
                const name = lastSegment(g.area) || "(no area)";
                const key = extKey(g.area);
                const isCollapsed = collapsed.has(key);
                return (
                  <Fragment key={g.area}>
                    <div className={"board-row-header ab-external-row" + (isCollapsed ? " collapsed" : "")}>
                      <div className="ab-row-title" title={g.area}>
                        <button
                          className="link row-toggle"
                          aria-expanded={!isCollapsed}
                          aria-label={`${isCollapsed ? "Expand" : "Collapse"} external ${name}`}
                          onClick={() => toggleRow(key)}
                        >
                          <Icon name={isCollapsed ? "ChevronRight" : "ChevronDown"} className="small" />
                        </button>
                        <span>{name}</span>
                      </div>
                      <div className="muted small">{g.items.length} {g.items.length === 1 ? "item" : "items"}</div>
                    </div>
                    {columns.map((col, ci) => {
                      const cellItems = g.items.filter((i) => extCol.get(i.id) === ci);
                      return (
                        <div key={col.key} role="group" aria-label={`External ${name} / ${col.title}`} className="board-cell ab-external-cell">
                          {isCollapsed
                            ? cellItems.length > 0 && <span className="muted small">{cellItems.length} {cellItems.length === 1 ? "item" : "items"}</span>
                            : cellItems.map((i) => (
                                <ExternalCard
                                  key={i.id}
                                  item={i}
                                  category={d.category}
                                  hidden={hidden.get(i.id) ?? []}
                                  cardRef={(el) => cardRef(i.id, el)}
                                  onOpen={() => openWorkItem(i.id).then(() => reload(true))}
                                />
                              ))}
                        </div>
                      );
                    })}
                  </Fragment>
                );
              })}
            </>
          )}
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
                const removable = editable && e.direct;
                const via = e.pairs.filter((p) => p.provider !== e.from || p.consumer !== e.to);
                return (
                  <path
                    key={`${e.from}-${e.to}`}
                    data-dep={`${e.from}-${e.to}`}
                    d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
                    className={`dep-line ${e.criticality}${removable ? "" : " readonly"}${externalIds.has(e.from) || externalIds.has(e.to) ? " external" : ""}`}
                    style={{ stroke: CRITICALITY_COLOR[e.criticality] }}
                    markerEnd={`url(#arrow-${e.criticality})`}
                    onClick={() => onEdgeClick(e)}
                  >
                    <title>
                      {`#${e.from} → #${e.to} (${CRITICALITY_LABEL[e.criticality]})` +
                        (e.criticality === "critical" ? " — consumer is planned before its provider" : "") +
                        (via.length ? `\nvia ${via.map((p) => `#${p.provider} → #${p.consumer}`).join(", ")}` : "") +
                        (removable ? "\nClick to remove" : "")}
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
            : calculatedMode
              ? "Cards are placed in the sprint of their last planned child and the team planning it."
              : "Cards are placed by their own Area Path and Iteration Path."}
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
  hidden: Map<number, HiddenPartners[]>;
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
        <div className="muted small">{items.length} {items.length === 1 ? "item" : "items"}</div>
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
              ? cellItems.length > 0 && <span className="muted small">{cellItems.length} {cellItems.length === 1 ? "item" : "items"}</span>
              : cellItems.map((i) => (
                  <BoardCard
                    key={i.id}
                    item={i}
                    category={props.category}
                    pointsField={props.pointsField}
                    ext={props.externalDeps(i)}
                    hidden={props.hidden.get(i.id) ?? []}
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

/** Edge indicators: partners of this card that are not drawn (collapsed, filtered, outside the PI). */
function EdgeIndicators({ id, hidden }: { id: number; hidden: HiddenPartners[] }) {
  return (
    <>
      {hidden.map((h) => {
        const label = `${h.side === "providers" ? "Hidden providers" : "Hidden consumers"} of #${id}`;
        return (
          <span
            key={h.side}
            className={`ab-edge ${h.side === "providers" ? "left" : "right"}`}
            style={{ background: CRITICALITY_COLOR[hiddenCrits(h)[0]] }}
            aria-label={label}
            title={`${label}\n${hiddenDetail(h)}`}
          />
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
  hidden: HiddenPartners[];
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
      <EdgeIndicators id={i.id} hidden={props.hidden} />
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
        {info.owner && (
          <span className="pill owner" title="Owning team">
            <Icon name="TeamFavorite" className="small" /> {info.owner}
          </span>
        )}
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

/** Read-only card of a dependency partner outside the board. */
function ExternalCard(props: {
  item: WorkItem;
  category: (type: string, state: string) => string;
  hidden: HiddenPartners[];
  cardRef: (el: HTMLElement | null) => void;
  onOpen: () => void;
}) {
  const { item: i } = props;
  const type = i.fields[F.type];
  const cat = props.category(type, i.fields[F.state]);
  return (
    <div
      ref={props.cardRef}
      className="card ab-external-card"
      style={{ borderLeftColor: typeColor(type) }}
      onClick={props.onOpen}
      title={`${type} #${i.id}: ${i.fields[F.title]}`}
    >
      <EdgeIndicators id={i.id} hidden={props.hidden} />
      <div className="card-title">{i.fields[F.title]}</div>
      <div className="card-meta">
        <span className="muted">#{i.id}</span>
        <span className="muted">{type}</span>
        <span className="state">
          <i className="dot" style={{ background: CATEGORY_COLOR[cat] ?? "#999" }} />
          {i.fields[F.state]}
        </span>
      </div>
    </div>
  );
}
