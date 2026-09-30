import { CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parentIdOf } from "../api/artboard";
import { emptyMeta, metaStore, milestonesStore, newId } from "../api/data";
import { criticalityByDates, CRITICALITY_COLOR, CRITICALITY_LABEL, dependenciesOf } from "../api/dependencies";
import { applyFilter, assigneeName, EMPTY_FILTER, facetOptions, isFilterActive, ItemFilter, withWiqlFilter, wiqlSuffix } from "../api/filters";
import { boardType, LEVEL_COLOR, pathTo, scopeAreas } from "../api/org";
import { scopeQuery } from "../api/queries";
import {
  autoAssignPis,
  clipRange,
  axisTicks,
  DateRange,
  dateToX,
  defaultDuration,
  freeLane,
  inWindow,
  piIdsFor,
  renderWindow,
  roadmapCadences,
  packLanes,
  planFrom,
  rangeDays,
  resizeRange,
  resolveRange,
  shiftRange,
  shortDate,
  timelineBounds,
  todayIso,
  toIsoDateTime,
  xToDate,
  Zoom,
  ZOOM_LABEL,
  ZOOM_PX,
  ZOOMS,
} from "../api/roadmap";
import { Criticality, F, Milestone, ProgramIncrement, WorkItem, WorkItemMeta } from "../api/types";
import { getFieldNames, getProgramIncrements, getStateCategories, getWorkItems, openWorkItem, queryWorkItems, setFields } from "../api/wit";
import { CATEGORY_COLOR, Empty, ErrorBar, Field, Info, Modal, Spinner, storage, typeColor, useAsync, Icon } from "../components/common";
import { useCan, useSafe } from "../components/context";
import { FilterBar } from "../components/FilterBar";

type Layout = "compact" | "extended";

interface Prefs {
  zoom: Zoom;
  layout: Layout;
  crits: Criticality[];
}

const ALL_CRITS: Criticality[] = ["critical", "atRisk", "healthy", "resolved"];
const [readPrefs, writePrefs] = storage<Prefs>("safe-ado-roadmap-prefs", { zoom: "months", layout: "compact", crits: ALL_CRITS });

const LANE_H: Record<Layout, number> = { compact: 40, extended: 76 };
const CARD_H: Record<Layout, number> = { compact: 32, extended: 68 };
/** Pointer travel (px) before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 3;

interface Drag {
  id: number;
  mode: "move" | "start" | "end";
  x0: number;
  y0: number;
  ppd: number;
  laneH: number;
  lanesLocked: boolean;
  orig: DateRange;
  origLane: number;
  range: DateRange;
  lane: number;
  moved: boolean;
}

interface Loaded {
  items: WorkItem[];
  category: (type: string, state: string) => string;
  metas: Map<string, WorkItemMeta>;
  milestones: Milestone[];
  dateFields: boolean;
  /** Parents of the items (for the parent lozenge), by id. */
  parents: Map<number, WorkItem>;
}

interface Hidden {
  side: "providers" | "consumers";
  byCrit: Map<Criticality, number[]>;
}

/**
 * Agile Hive Roadmap: a day-granular timeline of Epics / Capabilities / Features with PI and
 * iteration bands, milestones, draggable/resizable cards in lanes, an unplanned sidebar and
 * date-based dependency criticality.
 */
export function RoadmapView() {
  const { node } = useSafe();
  if (node.level === "team") return <Info>The roadmap is available for portfolios, solutions and ARTs.</Info>;
  return <Roadmap />;
}

const critRank: Record<Criticality, number> = { critical: 0, atRisk: 1, healthy: 2, resolved: 3 };

function Roadmap() {
  const { config, node, pis, piRoot } = useSafe();
  const can = useCan();
  const readOnly = !can.plan;
  const type = boardType(config, node.level);
  const areas = scopeAreas(node);
  const [prefs, setPrefsState] = useState<Prefs>(readPrefs);
  const [filter, setFilter] = useState<ItemFilter>(EMPTY_FILTER);
  const [sideFilter, setSideFilter] = useState<ItemFilter>(EMPTY_FILTER);
  const [actionError, setActionError] = useState<string>();
  const [milestoneEdit, setMilestoneEdit] = useState<Milestone | null>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 0 });
  const dragRef = useRef<Drag | null>(null);
  const fieldsRef = useRef<Promise<boolean>>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);

  const setPrefs = (p: Partial<Prefs>) => {
    const next = { ...prefs, ...p };
    setPrefsState(next);
    writePrefs(next);
  };
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };

  const { data, loading, error, reload, setData } = useAsync<Loaded>(async () => {
    fieldsRef.current ??= getFieldNames().then(
      (fs) => {
        const names = new Set(fs.map((f) => f.referenceName));
        return names.has(F.startDate) && names.has(F.targetDate);
      },
      () => false
    );
    const [items, category, metas, milestones, dateFields] = await Promise.all([
      queryWorkItems(withWiqlFilter(scopeQuery([type], areas), filter), [], true),
      getStateCategories([type]),
      metaStore.list(),
      milestonesStore.list(),
      fieldsRef.current,
    ]);
    const kept = items.filter((i) => category(i.fields[F.type], i.fields[F.state]) !== "Removed");
    const parentIds = Array.from(new Set(kept.map(parentIdOf).filter((id): id is number => id !== null)));
    // Parent titles are a nicety: the roadmap still works without them.
    const parentItems = parentIds.length ? await getWorkItems(parentIds, [F.id, F.title, F.type]).catch(() => [] as WorkItem[]) : [];
    return {
      items: kept,
      category,
      metas: new Map(metas.map((m) => [m.id, m])),
      milestones,
      dateFields,
      parents: new Map(parentItems.map((p) => [p.id, p])),
    };
  }, [type, areas.join("|"), wiqlSuffix(filter)]);

  // PI bands: the unit's own cadence plus an ancestor's different cadence (Solution Train above an ART).
  const cadences = useMemo(() => roadmapCadences(config, node.id, piRoot), [config, node.id, piRoot]);
  const ancestorPis = useAsync(
    async (): Promise<ProgramIncrement[]> => (cadences.ancestor ? getProgramIncrements(cadences.ancestor.root).catch(() => []) : []),
    [cadences.ancestor?.root]
  ).data;

  const today = todayIso();
  const ppd = ZOOM_PX[prefs.zoom];
  const laneH = LANE_H[prefs.layout];
  const filterActive = isFilterActive(filter);
  const items = useMemo(() => data?.items ?? [], [data]);
  const metas = useMemo(() => data?.metas ?? new Map<string, WorkItemMeta>(), [data]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const rangeOf = useCallback(
    (id: number) => resolveRange(metas.get(String(id)), itemById.get(id)?.fields),
    [metas, itemById]
  );

  const visible = useMemo(() => applyFilter(items, filter), [items, filter]);
  const planned = visible.filter((i) => rangeOf(i.id));
  const unplanned = useMemo(() => {
    const order = new Map(items.map((i, n) => [i.id, n]));
    const rank = (i: WorkItem) => {
      const r = Number(i.fields[F.stackRank]);
      return Number.isFinite(r) && i.fields[F.stackRank] !== undefined ? r : Number.POSITIVE_INFINITY;
    };
    // Agile Hive: finished (Completed) and Removed items are never offered for planning.
    const open = (i: WorkItem) => !["Completed", "Removed"].includes(data!.category(i.fields[F.type], i.fields[F.state]));
    return applyFilter(
      visible.filter((i) => !rangeOf(i.id) && open(i)),
      sideFilter
    ).sort((a, b) => rank(a) - rank(b) || order.get(a.id)! - order.get(b.id)!);
  }, [visible, items, rangeOf, sideFilter, data]);

  const lanes = packLanes(planned.map((i) => ({ id: i.id, range: rangeOf(i.id)!, lane: metas.get(String(i.id))?.lane })));

  const scopeIds = useMemo(() => new Set(pathTo(config.root, node.id).map((n) => n.id)), [config.root, node.id]);
  const milestones = (data?.milestones ?? []).filter((m) => scopeIds.has(m.nodeId)).sort((a, b) => a.date.localeCompare(b.date));

  const bounds = useMemo(
    () =>
      timelineBounds([
        today,
        ...pis.flatMap((p) => [p.start ?? "", p.finish ?? ""]),
        ...items.flatMap((i) => {
          const r = rangeOf(i.id);
          return r ? [r.start, r.end] : [];
        }),
        ...(data?.milestones ?? []).map((m) => m.date),
      ]),
    [today, pis, items, rangeOf, data]
  );
  const totalW = rangeDays(bounds) * ppd;
  const x = (date: string) => dateToX(date, bounds.start, ppd);
  const todayX = x(today);

  // Card geometry, honouring the in-flight drag preview.
  const place = (id: number) => {
    const d = drag?.id === id ? drag : null;
    const range = d ? d.range : rangeOf(id)!;
    const lane = d ? d.lane : lanes.get(id)!;
    return { range, lane, left: x(range.start), width: rangeDays(range) * ppd, top: lane * laneH + (laneH - CARD_H[prefs.layout]) / 2 };
  };
  const placedIds = new Set(planned.map((i) => i.id));
  const onScreen = (id: number) => {
    if (viewport.width <= 0) return true;
    const p = place(id);
    return p.left + p.width >= viewport.left && p.left <= viewport.left + viewport.width;
  };
  const shown = (id: number) => placedIds.has(id) && onScreen(id);
  // Virtualization: only cards, ticks and bands near the viewport are rendered (lanes stay packed over all).
  const win = renderWindow(viewport);
  const rendered = (id: number) => {
    if (drag?.id === id) return true;
    const p = place(id);
    return inWindow(p.left, p.width, win);
  };
  const rangeInWindow = (start: string, end: string) => inWindow(x(start), rangeDays({ start, end }) * ppd, win);
  const laneCount = Math.max(3, ...planned.map((i) => place(i.id).lane + 2));

  // --- dependencies ---------------------------------------------------------------------------
  const visibleIds = new Set(visible.map((i) => i.id));
  const deps = dependenciesOf(items)
    .filter((d) => visibleIds.has(d.provider) || visibleIds.has(d.consumer))
    .map((d) => {
      const provider = itemById.get(d.provider);
      const done = !!provider && data!.category(provider.fields[F.type], provider.fields[F.state]) === "Completed";
      const range = (id: number) => (drag?.id === id ? drag.range : rangeOf(id));
      const crit = criticalityByDates({ end: range(d.provider)?.end }, { start: range(d.consumer)?.start, end: range(d.consumer)?.end }, done);
      return { ...d, crit };
    });
  const critCount = (c: Criticality) => deps.filter((d) => d.crit === c).length;
  const selectedDeps = deps.filter((d) => prefs.crits.includes(d.crit));
  const lines = selectedDeps.filter((d) => shown(d.provider) && shown(d.consumer));
  const hidden = new Map<number, Hidden[]>();
  const addHidden = (card: number, side: Hidden["side"], other: number, crit: Criticality) => {
    const list = hidden.get(card) ?? [];
    let h = list.find((x) => x.side === side);
    if (!h) list.push((h = { side, byCrit: new Map() }));
    h.byCrit.set(crit, [...(h.byCrit.get(crit) ?? []), other]);
    hidden.set(card, list);
  };
  for (const d of selectedDeps) {
    if (shown(d.provider) && !shown(d.consumer)) addHidden(d.provider, "consumers", d.consumer, d.crit);
    if (shown(d.consumer) && !shown(d.provider)) addHidden(d.consumer, "providers", d.provider, d.crit);
  }

  // --- scrolling ------------------------------------------------------------------------------
  const syncViewport = () => {
    const el = scrollRef.current!;
    setViewport({ left: el.scrollLeft, width: el.clientWidth });
  };
  const scrollToToday = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, todayX - el.clientWidth / 2);
    syncViewport();
  };
  const hasData = !!data;
  useLayoutEffect(() => {
    if (hasData) scrollToToday();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasData, ppd]);
  // Re-measure when the scroll area is resized (window resize, sidebar, host layout).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewport({ left: el.scrollLeft, width: el.clientWidth });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [hasData]);

  // --- planning -------------------------------------------------------------------------------
  const plan = async (id: number, range: DateRange, targetLane: number) => {
    const current = data!;
    const occupied = planned.filter((i) => i.id !== id).map((i) => ({ range: rangeOf(i.id)!, lane: lanes.get(i.id)! }));
    const lane = freeLane(targetLane, range, occupied);
    const prev = current.metas.get(String(id)) ?? emptyMeta(id);
    const next: WorkItemMeta = { ...prev, plannedStart: range.start, plannedEnd: range.end, lane };
    if (node.level === "art") {
      next.assignedPiPaths = autoAssignPis(prev.assignedPiPaths ?? [], range, pis, today);
      next.assignedPiIds = piIdsFor(next.assignedPiPaths, pis, prev.assignedPiPaths, prev.assignedPiIds);
    }
    const dates = { [F.startDate]: toIsoDateTime(range.start), [F.targetDate]: toIsoDateTime(range.end) };
    const withMeta = (d: Loaded, m: WorkItemMeta): Loaded => ({ ...d, metas: new Map(d.metas).set(m.id, m) });
    const withFields = (d: Loaded, fields: Record<string, unknown>): Loaded => ({
      ...d,
      items: d.items.map((i) => (i.id === id ? { ...i, fields: { ...i.fields, ...fields } } : i)),
    });
    // Optimistic: the Start/Target Date fields win over the metadata, so preview both.
    setData((d) => d && (current.dateFields ? withFields(withMeta(d, next), dates) : withMeta(d, next)));
    let saved: WorkItemMeta;
    try {
      saved = await metaStore.save(next);
      setData((d) => d && withMeta(d, saved));
    } catch (e: any) {
      setActionError(`Could not plan #${id}: ${e?.message ?? e}`);
      reload(true);
      return;
    }
    if (!current.dateFields) return;
    try {
      const updated = await setFields(id, dates);
      setData((d) => d && withFields(d, updated.fields));
    } catch (e: any) {
      // No partial state: undo the metadata write when the work item rejects the dates.
      try {
        if (prev.__etag === undefined) await metaStore.remove(prev.id);
        else await metaStore.save({ ...prev, __etag: saved.__etag });
      } catch {
        /* the reload below shows whatever the server has */
      }
      setActionError(`Could not plan #${id}: ${e?.message ?? e}. The planned dates were not changed.`);
      reload(true);
    }
  };

  const open = async (id: number) => {
    await openWorkItem(id);
    reload(true);
  };

  const compute = (d: Drag, e: MouseEvent): Drag => {
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    const moved = d.moved || Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD;
    const days = Math.round(dx / d.ppd);
    if (d.mode !== "move") return { ...d, moved, range: resizeRange(d.orig, d.mode, days) };
    const lane = d.lanesLocked ? d.origLane : Math.max(0, d.origLane + Math.round(dy / d.laneH));
    return { ...d, moved, range: shiftRange(d.orig, days), lane };
  };

  const finishRef = useRef<(d: Drag) => void>(() => undefined);
  finishRef.current = (d: Drag) => {
    if (!d.moved) {
      open(d.id);
      return;
    }
    if (readOnly) return;
    if (d.range.start === d.orig.start && d.range.end === d.orig.end && d.lane === d.origLane) return;
    plan(d.id, d.range, d.lane);
  };

  const startDrag = (e: React.MouseEvent, id: number, mode: Drag["mode"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const range = rangeOf(id)!;
    const lane = lanes.get(id)!;
    setDrag({ id, mode, x0: e.clientX, y0: e.clientY, ppd, laneH, lanesLocked: filterActive, orig: range, origLane: lane, range, lane, moved: false });
    // Read-only: a press still opens the item, but nothing moves.
    const step = (ev: MouseEvent) => {
      const next = compute(dragRef.current!, ev);
      return readOnly ? { ...dragRef.current!, moved: next.moved } : next;
    };
    const onMove = (ev: MouseEvent) => setDrag(step(ev));
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const final = step(ev);
      setDrag(null);
      finishRef.current(final);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onCanvasDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData("text/plain"));
    if (readOnly || !id || !itemById.has(id)) return;
    const rect = lanesRef.current!.getBoundingClientRect();
    const start = xToDate(e.clientX - rect.left, bounds.start, ppd);
    const lane = filterActive ? 0 : Math.max(0, Math.floor((e.clientY - rect.top) / laneH));
    plan(id, planFrom(start, defaultDuration(node.level)), lane);
  };

  // --- milestones -----------------------------------------------------------------------------
  const saveMilestone = async (m: Milestone) => {
    try {
      const saved = await milestonesStore.save(m);
      setData((d) => d && { ...d, milestones: [...d.milestones.filter((x) => x.id !== saved.id), saved] });
      setMilestoneEdit(null);
    } catch (e: any) {
      setActionError(`Could not save milestone: ${e?.message ?? e}`);
    }
  };
  const deleteMilestone = async (m: Milestone) => {
    if (!window.confirm(`Delete milestone "${m.title}"?`)) return;
    try {
      await milestonesStore.remove(m.id);
      setData((d) => d && { ...d, milestones: d.milestones.filter((x) => x.id !== m.id) });
      setMilestoneEdit(null);
    } catch (e: any) {
      setActionError(`Could not delete milestone: ${e?.message ?? e}`);
    }
  };

  if (loading && !data) return <Spinner label="Loading roadmap…" />;
  if (!data) return <ErrorBar message={error} />;

  const extended = prefs.layout === "extended";
  const { types, states, assignees, tags } = facetOptions(visible.filter((i) => !rangeOf(i.id)));
  const sideOptions = { types, states, assignees, tags };
  const ticks = axisTicks(win ? clipRange(bounds, xToDate(Math.max(0, win.from), bounds.start, ppd), xToDate(win.to, bounds.start, ppd)) : bounds, prefs.zoom);
  const bands = [
    { key: "own", label: "PIs", aria: "Program increments", pis, owner: cadences.own.owner },
    ...(cadences.ancestor
      ? [{ key: "ancestor", label: `${cadences.ancestor.owner.name} PIs`, aria: `Program increments of ${cadences.ancestor.owner.name}`, pis: ancestorPis ?? [], owner: cadences.ancestor.owner }]
      : []),
  ];
  const sprints = node.level === "art" ? pis.flatMap((p) => p.sprints).filter((s) => s.start && s.finish) : [];
  const lanesHeight = laneCount * laneH;

  return (
    <div className="roadmap">
      <div className="toolbar">
        <strong>Roadmap · {type}s</strong>
        <span className="muted">
          {planned.length} planned · {unplanned.length} unplanned · {deps.length} dependencies
        </span>
        <span className="spacer" />
        <div className="rm-zoom" role="group" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button key={z} className={"btn" + (prefs.zoom === z ? " primary" : "")} aria-pressed={prefs.zoom === z} onClick={() => setPrefs({ zoom: z })}>
              {ZOOM_LABEL[z]}
            </button>
          ))}
        </div>
        <button className="btn" onClick={scrollToToday}>
          Today
        </button>
        <select aria-label="Card layout" value={prefs.layout} onChange={(e) => setPrefs({ layout: e.target.value as Layout })}>
          <option value="compact">Compact</option>
          <option value="extended">Extended</option>
        </select>
        <details className="facet">
          <summary className="btn">Dependencies ({selectedDeps.length})</summary>
          <div className="facet-menu" role="group" aria-label="Dependency criticality">
            {ALL_CRITS.map((c) => (
              <label key={c} className="check">
                <input
                  type="checkbox"
                  checked={prefs.crits.includes(c)}
                  onChange={() => setPrefs({ crits: prefs.crits.includes(c) ? prefs.crits.filter((x) => x !== c) : [...prefs.crits, c] })}
                />{" "}
                <i className="dot" style={{ background: CRITICALITY_COLOR[c] }} /> {CRITICALITY_LABEL[c]} ({critCount(c)})
              </label>
            ))}
          </div>
        </details>
        {!readOnly && (
          <button className="btn" onClick={() => setMilestoneEdit({ id: "", nodeId: node.id, title: "", date: today, description: "" })}>
            <Icon name="Add" /> New milestone
          </button>
        )}
        <button className="btn" onClick={() => reload()}>
          <Icon name="Refresh" /> Refresh
        </button>
      </div>
      <FilterBar value={filter} onChange={setFilter} options={facetOptions(items)} />
      <ErrorBar message={error ?? actionError} onClose={() => setActionError(undefined)} />
      {readOnly && <Info>You have read-only access to this area: planned dates, lanes and milestones can't be changed here.</Info>}
      {filterActive && !readOnly && <Info>Filters are active: cards can be moved and resized in time, but not between lanes.</Info>}
      {items.length === 0 && !loading && (
        <Empty title={`No ${type}s in scope`}>
          <p>
            Items appear here when their Area Path is under <code>{areas.join(", ") || "(no area configured)"}</code>.
          </p>
        </Empty>
      )}

      <div className="rm-body">
        <aside className="rm-sidebar" aria-label="Unplanned items">
          <h3>Unplanned ({unplanned.length})</h3>
          <div className="rm-side-filter">
            <FilterBar value={sideFilter} onChange={setSideFilter} options={sideOptions} showWiql={false} quickFilters={false} />
          </div>
          {unplanned.length === 0 && <div className="muted small">Nothing to plan.</div>}
          <ul>
            {unplanned.map((i) => (
              <li
                key={i.id}
                className="rm-unplanned"
                draggable={!readOnly}
                onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i.id))}
                style={{ borderLeftColor: typeColor(i.fields[F.type]) }}
                title={readOnly ? `${i.fields[F.type]} #${i.id}` : "Drag onto the timeline to plan"}
              >
                <span className="muted">#{i.id}</span> {i.fields[F.title]}
                {!readOnly && (
                  <button className="link" aria-label={`Plan #${i.id} from today`} onClick={() => plan(i.id, planFrom(today, defaultDuration(node.level)), 0)}>
                    Plan
                  </button>
                )}
              </li>
            ))}
          </ul>
        </aside>

        <div className="rm-scroll" ref={scrollRef} onScroll={syncViewport} data-testid="roadmap-scroll">
          <div className="rm-canvas" style={{ width: totalW }}>
            <div className="rm-row rm-axis">
              {ticks.map((t) => (
                <span key={t.date} className="rm-tick" style={{ left: x(t.date) }}>
                  {t.label}
                </span>
              ))}
            </div>
            {bands.map((band) => (
              <div
                key={band.key}
                className={`rm-row rm-pis rm-cadence-${band.owner.level}`}
                role="group"
                aria-label={band.aria}
                data-level={band.owner.level}
                style={{ ["--pi-color" as string]: LEVEL_COLOR[band.owner.level] } as CSSProperties}
              >
                <span className="rm-row-label">{band.label}</span>
                {band.pis
                  .filter((p) => p.start && p.finish && rangeInWindow(p.start.slice(0, 10), p.finish.slice(0, 10)))
                  .map((p) => {
                    const r = { start: p.start!.slice(0, 10), end: p.finish!.slice(0, 10) };
                    const current = r.start <= today && today <= r.end;
                    return (
                      <div
                        key={p.path}
                        className={"rm-pi cadence" + (current ? " current" : "")}
                        style={{ left: x(r.start), width: rangeDays(r) * ppd }}
                        title={`${p.name}: ${shortDate(r.start)} – ${shortDate(r.end)}`}
                      >
                        {p.name}
                      </div>
                    );
                  })}
              </div>
            ))}
            {node.level === "art" && (
              <div className="rm-row rm-iterations" role="group" aria-label="Iterations">
                <span className="rm-row-label">Iterations</span>
                {sprints.filter((s) => rangeInWindow(s.start!.slice(0, 10), s.finish!.slice(0, 10))).map((s) => {
                  const r = { start: s.start!.slice(0, 10), end: s.finish!.slice(0, 10) };
                  return (
                    <div key={s.path} className="rm-sprint" style={{ left: x(r.start), width: rangeDays(r) * ppd }} title={`${s.name}: ${shortDate(r.start)} – ${shortDate(r.end)}`}>
                      {s.name}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="rm-row rm-milestones" role="group" aria-label="Milestones">
              <span className="rm-row-label">Milestones</span>
              {milestones.map((m) => (
                <button
                  key={m.id}
                  className={"rm-milestone" + (m.nodeId !== node.id ? " inherited" : "")}
                  style={{ left: x(m.date) }}
                  aria-label={`Milestone ${m.title}`}
                  aria-disabled={readOnly}
                  title={`${m.title} · ${shortDate(m.date)}${m.description ? `\n${m.description}` : ""}`}
                  onClick={() => !readOnly && setMilestoneEdit(m)}
                >
                  <span className="rm-diamond" aria-hidden="true" />
                  <span className="rm-milestone-label">{m.title}</span>
                </button>
              ))}
            </div>

            <div
              className="rm-lanes"
              ref={lanesRef}
              role="region"
              aria-label="Roadmap timeline"
              style={{ height: lanesHeight, backgroundSize: `100% ${laneH}px` }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onCanvasDrop}
            >
              {milestones.map((m) => (
                <div key={m.id} className="rm-milestone-line" style={{ left: x(m.date) + ppd / 2 }} />
              ))}
              <svg className="rm-deps" width={totalW} height={lanesHeight}>
                <defs>
                  {ALL_CRITS.map((c) => (
                    <marker key={c} id={`rm-arrow-${c}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                      <path d="M0,0 L10,5 L0,10 z" fill={CRITICALITY_COLOR[c]} />
                    </marker>
                  ))}
                </defs>
                {lines.map((d) => {
                  const a = place(d.provider);
                  const b = place(d.consumer);
                  const x1 = a.left + a.width;
                  const y1 = a.top + CARD_H[prefs.layout] / 2;
                  const x2 = b.left;
                  const y2 = b.top + CARD_H[prefs.layout] / 2;
                  const dx = Math.max(30, Math.abs(x2 - x1) / 2);
                  return (
                    <path
                      key={`${d.provider}-${d.consumer}`}
                      data-dep={`${d.provider}-${d.consumer}`}
                      className={`rm-dep ${d.crit}`}
                      d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
                      stroke={CRITICALITY_COLOR[d.crit]}
                      markerEnd={`url(#rm-arrow-${d.crit})`}
                    >
                      <title>{`#${d.provider} → #${d.consumer}: ${CRITICALITY_LABEL[d.crit]}`}</title>
                    </path>
                  );
                })}
              </svg>
              {planned.filter((i) => rendered(i.id)).map((i) => {
                const p = place(i.id);
                const t = i.fields[F.type];
                const cat = data.category(t, i.fields[F.state]);
                const parentId = parentIdOf(i);
                const parent = parentId === null ? undefined : data.parents.get(parentId);
                return (
                  <div
                    key={i.id}
                    className={"rm-card" + (drag?.id === i.id ? " dragging" : "") + (extended ? " extended" : "")}
                    role="button"
                    tabIndex={0}
                    aria-label={`#${i.id} ${i.fields[F.title]}`}
                    title={`${t} #${i.id}: ${i.fields[F.title]}\n${shortDate(p.range.start)} – ${shortDate(p.range.end)}`}
                    data-start={p.range.start}
                    data-end={p.range.end}
                    data-lane={p.lane}
                    style={{ left: p.left, width: p.width, top: p.top, height: CARD_H[prefs.layout], borderLeftColor: typeColor(t) }}
                    onMouseDown={(e) => startDrag(e, i.id, "move")}
                    onKeyDown={(e) => e.key === "Enter" && open(i.id)}
                  >
                    {!readOnly && (
                      <span className="rm-handle start" aria-label={`Resize start of #${i.id}`} onMouseDown={(e) => startDrag(e, i.id, "start")} />
                    )}
                    <div className="rm-card-title">
                      {parent && (
                        <button
                          className="rm-parent"
                          aria-label={`Open parent #${parent.id} ${parent.fields[F.title]}`}
                          title={`${parent.fields[F.type]} #${parent.id}: ${parent.fields[F.title]}`}
                          style={{ borderColor: typeColor(parent.fields[F.type]) }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            void open(parent.id);
                          }}
                        >
                          {parent.fields[F.title]}
                        </button>
                      )}
                      <span className="muted">#{i.id}</span> {i.fields[F.title]}
                    </div>
                    {extended && (
                      <div className="rm-card-meta small">
                        <span className="state">
                          <i className="dot" style={{ background: CATEGORY_COLOR[cat] ?? "#999" }} />
                          {i.fields[F.state]}
                        </span>
                        <span>{assigneeName(i)}</span>
                        <span>
                          {shortDate(p.range.start)} – {shortDate(p.range.end)}
                        </span>
                      </div>
                    )}
                    {(hidden.get(i.id) ?? []).map((h) => {
                      const crits = Array.from(h.byCrit.keys()).sort((a, b) => critRank[a] - critRank[b]);
                      const label = `${h.side === "providers" ? "Hidden providers" : "Hidden consumers"} of #${i.id}`;
                      const detail = crits.map((c) => `${CRITICALITY_LABEL[c]}: ${h.byCrit.get(c)!.map((n) => `#${n}`).join(", ")}`).join("\n");
                      return (
                        <span
                          key={h.side}
                          className={`rm-edge ${h.side === "providers" ? "left" : "right"}`}
                          style={{ background: CRITICALITY_COLOR[crits[0]] }}
                          aria-label={label}
                          title={`${label}\n${detail}`}
                        />
                      );
                    })}
                    {!readOnly && (
                      <span className="rm-handle end" aria-label={`Resize end of #${i.id}`} onMouseDown={(e) => startDrag(e, i.id, "end")} />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="rm-today" style={{ left: todayX + ppd / 2 }} aria-label="Today line" title={`Today · ${shortDate(today)}`} />
          </div>
        </div>
      </div>
      <div className="legend-bar muted small">
        {ALL_CRITS.map((c) => (
          <span key={c}>
            <i className="line" style={{ borderColor: CRITICALITY_COLOR[c] }} /> {CRITICALITY_LABEL[c]}
          </span>
        ))}
        <span>
          {readOnly
            ? "Read-only: click a card to open it."
            : "Drag cards to re-plan, drag their edges to resize; drag unplanned items onto the timeline."}
        </span>
      </div>

      {milestoneEdit && (
        <MilestoneDialog milestone={milestoneEdit} onClose={() => setMilestoneEdit(null)} onSave={saveMilestone} onDelete={deleteMilestone} />
      )}
    </div>
  );
}

function MilestoneDialog({
  milestone,
  onClose,
  onSave,
  onDelete,
}: {
  milestone: Milestone;
  onClose: () => void;
  onSave: (m: Milestone) => void;
  onDelete: (m: Milestone) => void;
}) {
  const isNew = !milestone.id;
  const [title, setTitle] = useState(milestone.title);
  const [date, setDate] = useState(milestone.date);
  const [description, setDescription] = useState(milestone.description ?? "");
  const valid = title.trim() !== "" && /^\d{4}-\d{2}-\d{2}$/.test(date);
  return (
    <Modal
      title={isNew ? "New milestone" : "Edit milestone"}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <button className="btn danger" onClick={() => onDelete(milestone)}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!valid}
            onClick={() => onSave({ ...milestone, id: milestone.id || newId(), title: title.trim(), date, description: description.trim() })}
          >
            Save
          </button>
        </>
      }
    >
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Date">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </Modal>
  );
}
