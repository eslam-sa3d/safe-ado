import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { boardRows, boardType, scopeAreas } from "../api/org";
import { scopeQuery } from "../api/queries";
import { F, LINK, OrgNode, WorkItem } from "../api/types";
import {
  addLink,
  getStateCategories,
  isUnder,
  openNewWorkItem,
  openWorkItem,
  queryWorkItems,
  relationTargetId,
  removeLink,
  setFields,
} from "../api/wit";
import { CATEGORY_COLOR, Empty, ErrorBar, fmtDate, Info, Spinner, typeColor, useAsync } from "../components/common";
import { useSafe } from "../components/context";

interface Column {
  key: string;
  title: string;
  subtitle?: string;
  path: string;
}

interface Row {
  key: string;
  title: string;
  areaPath?: string;
  node?: OrgNode;
}

interface Edge {
  from: number;
  to: number;
  severity: "ok" | "warn" | "conflict";
}

/**
 * SAFe Program Board: rows are teams (or ARTs at solution level), columns are the PI's
 * iterations, cards are Features (or Capabilities). Successor links are dependencies.
 */
export function ProgramBoard() {
  const { config, node, pi } = useSafe();
  const type = boardType(config, node.level);
  const areas = scopeAreas(node);
  const [showDeps, setShowDeps] = useState(true);
  const [linkFrom, setLinkFrom] = useState<number | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const { data, loading, error, reload, setData } = useAsync(async () => {
    if (!pi) return { items: [] as WorkItem[], category: (_t: string, _s: string) => "" };
    const [items, category] = await Promise.all([
      queryWorkItems(scopeQuery([type], areas, pi.path), [], true),
      getStateCategories([type]),
    ]);
    return { items: items.filter((i) => category(i.fields[F.type], i.fields[F.state]) !== "Removed"), category };
  }, [type, areas.join("|"), pi?.path]);

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

  const placement = useMemo(() => {
    const map = new Map<number, { row: string; col: number }>();
    for (const item of items) {
      const area = item.fields[F.area] as string;
      const iter = item.fields[F.iteration] as string;
      // Longest matching area path wins so nested teams land in the right row.
      const row =
        rows
          .filter((r) => r.areaPath && isUnder(area, r.areaPath))
          .sort((a, b) => (b.areaPath!.length ?? 0) - (a.areaPath!.length ?? 0))[0]?.key ?? "unassigned";
      let col = columns.findIndex((c, i) => i > 0 && isUnder(iter, c.path));
      if (col < 0) col = 0;
      map.set(item.id, { row, col });
    }
    return map;
  }, [items, rows, columns]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const item of items) {
      for (const rel of item.relations ?? []) {
        if (rel.rel !== LINK.successor) continue;
        const to = relationTargetId(rel.url);
        if (to === null || !placement.has(to)) continue;
        const a = placement.get(item.id)!.col;
        const b = placement.get(to)!.col;
        // Unscheduled items can't be judged; otherwise the successor must land after its predecessor.
        const severity = a === 0 || b === 0 ? "warn" : b < a ? "conflict" : b === a ? "warn" : "ok";
        out.push({ from: item.id, to, severity });
      }
    }
    return out;
  }, [items, placement]);

  const externalDeps = useCallback(
    (item: WorkItem) =>
      (item.relations ?? []).filter(
        (r) => (r.rel === LINK.successor || r.rel === LINK.predecessor) && !placement.has(relationTargetId(r.url) ?? -1)
      ).length,
    [placement]
  );

  const visibleRows = rows.filter((r) => r.key !== "unassigned" || items.some((i) => placement.get(i.id)?.row === "unassigned"));

  // --- drag & drop ---------------------------------------------------------------------------
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
    if (!window.confirm(`Remove dependency #${edge.from} → #${edge.to}?`)) return;
    try {
      await removeLink(edge.from, edge.to, LINK.successor);
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
  }, [items, placement, showDeps]);

  if (!pi) return null;
  if (loading && !data) return <Spinner label="Loading program board…" />;
  if (!data) return <ErrorBar message={error} />;

  const conflicts = edges.filter((e) => e.severity === "conflict").length;

  return (
    <div className="board-view">
      <div className="toolbar">
        <strong>{type}s</strong>
        <span className="muted">
          {items.length} items · {edges.length} dependencies
          {conflicts > 0 && <span className="danger"> · {conflicts} conflicts</span>}
        </span>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={showDeps} onChange={(e) => setShowDeps(e.target.checked)} /> Show dependencies
        </label>
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
        <button className="btn" onClick={() => reload()}>
          Refresh
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
          {columns.map((c) => (
            <div key={c.key} className={"board-col-header" + (c.key === "backlog" ? " backlog" : "")}>
              <div>{c.title}</div>
              {c.subtitle && <div className="muted small">{c.subtitle}</div>}
            </div>
          ))}
          {visibleRows.map((r) => (
            <RowCells
              key={r.key}
              row={r}
              columns={columns}
              items={items.filter((i) => placement.get(i.id)?.row === r.key)}
              colOf={(id) => placement.get(id)!.col}
              category={data!.category}
              pointsField={config.storyPointsField}
              externalDeps={externalDeps}
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
                {(["ok", "warn", "conflict"] as const).map((s) => (
                  <marker key={s} id={`arrow-${s}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0,0 L10,5 L0,10 z" className={`dep-head ${s}`} />
                  </marker>
                ))}
              </defs>
              {edges.map((e) => {
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
                    className={`dep-line ${e.severity}`}
                    markerEnd={`url(#arrow-${e.severity})`}
                    onClick={() => onEdgeClick(e)}
                  >
                    <title>
                      #{e.from} → #{e.to}
                      {e.severity === "conflict" ? " — successor is planned before its predecessor" : ""}
                      {"\n"}Click to remove
                    </title>
                  </path>
                );
              })}
            </svg>
          )}
        </div>
      </div>
      <div className="legend-bar muted small">
        <span><i className="line ok" /> on track</span>
        <span><i className="line warn" /> same iteration / unscheduled</span>
        <span><i className="line conflict" /> successor planned before predecessor</span>
        <span>Drag cards to re-plan. Changes update Area Path and Iteration Path.</span>
      </div>
    </div>
  );
}

function RowCells(props: {
  row: Row;
  columns: Column[];
  items: WorkItem[];
  colOf: (id: number) => number;
  category: (type: string, state: string) => string;
  pointsField: string;
  externalDeps: (item: WorkItem) => number;
  selected: number | null;
  cardRef: (id: number, el: HTMLElement | null) => void;
  onDrop: (id: number, row: Row, col: Column) => void;
  onCardClick: (id: number) => void;
  onNew: (col: Column) => void;
}) {
  const { row, columns, items } = props;
  const [over, setOver] = useState<string | null>(null);
  return (
    <>
      <div className="board-row-header">
        <div>{row.title}</div>
        <div className="muted small">{items.length} items</div>
      </div>
      {columns.map((col, ci) => (
        <div
          key={col.key}
          role="group"
          aria-label={`${row.title} / ${col.title}`}
          className={"board-cell" + (over === col.key ? " drop-over" : "") + (col.key === "backlog" ? " backlog" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(col.key);
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            const id = Number(e.dataTransfer.getData("text/plain"));
            if (id) props.onDrop(id, row, col);
          }}
        >
          {items
            .filter((i) => props.colOf(i.id) === ci)
            .map((i) => {
              const type = i.fields[F.type];
              const cat = props.category(type, i.fields[F.state]);
              const ext = props.externalDeps(i);
              const pts = i.fields[props.pointsField];
              return (
                <div
                  key={i.id}
                  ref={(el) => props.cardRef(i.id, el)}
                  className={"card" + (props.selected === i.id ? " selected" : "")}
                  style={{ borderLeftColor: typeColor(type) }}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i.id))}
                  onClick={() => props.onCardClick(i.id)}
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
                    {ext > 0 && (
                      <span className="pill ext" title="Dependencies on items outside this board">
                        ↗ {ext}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          {row.key !== "unassigned" && (
            <button className="cell-add" onClick={() => props.onNew(col)} title="New item here">
              +
            </button>
          )}
        </div>
      ))}
    </>
  );
}
