import { ReactNode, useEffect, useMemo, useState } from "react";
import { emptyMeta, metaStore } from "../api/data";
import { EMPTY_FILTER, facetOptions, ItemFilter, matchesFilter, withWiqlFilter } from "../api/filters";
import { boardType, scopeAreas } from "../api/org";
import { scopeQuery, typeChain } from "../api/queries";
import { F, LINK, OrgNode, ProgramIncrement, WorkItem, WorkItemMeta } from "../api/types";
import {
  addLink,
  getStateCategories,
  getWorkItems,
  isUnder,
  openWorkItem,
  queryWorkItems,
  relationTargetId,
  removeLink,
  setFields,
} from "../api/wit";
import { CATEGORY_COLOR, Empty, ErrorBar, lastSegment, Spinner, typeColor, useAsync } from "../components/common";
import { useSafe } from "../components/context";
import { FilterBar } from "../components/FilterBar";

/** A work item row plus the SAFe data derived for it. */
export interface Row {
  item: WorkItem;
  category: string;
  parentId: number | null;
  /** Whether the parent link is stored on this item (Hierarchy-Reverse) or only seen from the parent. */
  parentOnItem: boolean;
  childAreas: string[];
  meta?: WorkItemMeta;
}

interface ListData {
  rows: Row[];
}

type ColumnKey =
  | "id"
  | "type"
  | "title"
  | "state"
  | "priority"
  | "assignee"
  | "parent"
  | "iteration"
  | "area"
  | "teams"
  | "owner"
  | "pis"
  | "piInvolvement";

interface Column {
  key: ColumnKey;
  label: string;
  numeric?: boolean;
}

const BASE_COLUMNS: Column[] = [
  { key: "id", label: "ID", numeric: true },
  { key: "type", label: "Type" },
  { key: "title", label: "Title" },
  { key: "state", label: "State" },
  { key: "priority", label: "Priority", numeric: true },
  { key: "assignee", label: "Assigned To" },
  { key: "parent", label: "Parent", numeric: true },
  { key: "iteration", label: "Iteration" },
  { key: "area", label: "Area" },
];

const PROGRAM_COLUMNS: Column[] = [
  { key: "teams", label: "Teams involved" },
  { key: "owner", label: "Owning team" },
  { key: "pis", label: "Assigned PIs" },
];

const TEAM_COLUMNS: Column[] = [{ key: "piInvolvement", label: "PI involvement" }];

export function columnsFor(level: OrgNode["level"]): Column[] {
  if (level === "art" || level === "solution") return [...BASE_COLUMNS, ...PROGRAM_COLUMNS];
  if (level === "team") return [...BASE_COLUMNS, ...TEAM_COLUMNS];
  return BASE_COLUMNS;
}

interface Assignee {
  displayName: string;
  uniqueName?: string;
}

function assigneeOf(item: WorkItem): Assignee | undefined {
  const v = item.fields[F.assignedTo];
  if (!v) return undefined;
  if (typeof v === "string") return { displayName: v, uniqueName: v };
  return { displayName: v.displayName ?? v.uniqueName ?? "", uniqueName: v.uniqueName };
}

/** Child nodes (units) of `node` whose area contains any child work item of the row. */
export function teamsInvolved(node: OrgNode, row: Row): OrgNode[] {
  return node.children.filter((c) => {
    const areas = scopeAreas(c);
    return row.childAreas.some((a) => areas.some((s) => isUnder(a, s)));
  });
}

export function piOf(iteration: string | undefined, pis: ProgramIncrement[]): ProgramIncrement | undefined {
  return pis.find((p) => isUnder(iteration, p.path));
}

function piName(path: string, pis: ProgramIncrement[]): string {
  return pis.find((p) => p.path === path)?.name ?? lastSegment(path);
}

/** Loads the unit's items, their parents, child areas and SAFe metadata. */
async function loadRows(types: string[], areas: string[], wiql: string, needChildren: boolean): Promise<ListData> {
  const query = withWiqlFilter(scopeQuery(types, areas, undefined, F.id), { ...EMPTY_FILTER, wiql });
  const [items, categoryOf, metas] = await Promise.all([
    queryWorkItems(query, [], true),
    getStateCategories(types),
    metaStore.list(),
  ]);
  const live = items.filter((i) => categoryOf(i.fields[F.type], i.fields[F.state]) !== "Removed");
  const metaById = new Map(metas.map((m) => [m.workItemId, m]));

  // Parent from the item's own reverse link; fall back to a forward link on a loaded parent.
  const parentFromForward = new Map<number, number>();
  const childIds = new Map<number, number[]>();
  for (const item of items) {
    const kids: number[] = [];
    for (const r of item.relations ?? []) {
      const target = relationTargetId(r.url);
      if (target === null) continue;
      if (r.rel === LINK.child) {
        kids.push(target);
        parentFromForward.set(target, item.id);
      }
    }
    childIds.set(item.id, kids);
  }

  const areaById = new Map<number, string>();
  const allKids = Array.from(new Set(Array.from(childIds.values()).flat()));
  if (needChildren && allKids.length) {
    const kids = await getWorkItems(allKids, [F.id, F.area]);
    kids.forEach((k) => areaById.set(k.id, k.fields[F.area]));
  }

  const rows = live.map((item): Row => {
    const reverse = (item.relations ?? []).find((r) => r.rel === LINK.parent);
    const onItem = reverse ? relationTargetId(reverse.url) : null;
    const parentId = onItem ?? parentFromForward.get(item.id) ?? null;
    return {
      item,
      category: categoryOf(item.fields[F.type], item.fields[F.state]),
      parentId,
      parentOnItem: onItem !== null,
      childAreas: (childIds.get(item.id) ?? []).map((id) => areaById.get(id)).filter((a): a is string => !!a),
      meta: metaById.get(item.id),
    };
  });
  return { rows };
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: (string | number)[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** Agile Hive's Work Item List: every item of the unit, sortable, filterable and editable inline. */
export function WorkItemList() {
  const { config, node, pis } = useSafe();
  const chain = typeChain(config);
  const isTeam = node.level === "team";
  const [showAll, setShowAll] = useState(false);
  const types = isTeam || showAll ? chain : [boardType(config, node.level)];
  const areas = scopeAreas(node);
  const columns = columnsFor(node.level);
  const needChildren = node.level === "art" || node.level === "solution";

  const [filter, setFilter] = useState<ItemFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<{ key: ColumnKey; dir: 1 | -1 }>({ key: "id", dir: 1 });
  const [error, setError] = useState<string>();

  const { data, loading, error: loadError, setData } = useAsync(
    () => loadRows(types, areas, filter.wiql, needChildren),
    [types.join("|"), areas.join("|"), filter.wiql, needChildren]
  );

  const rows = data?.rows ?? [];
  const options = useMemo(() => facetOptions(rows.map((r) => r.item)), [rows]);
  const assignees = useMemo(() => {
    const byName = new Map<string, Assignee>();
    rows.forEach((r) => {
      const a = assigneeOf(r.item);
      if (a && a.displayName && !byName.has(a.displayName)) byName.set(a.displayName, a);
    });
    return Array.from(byName.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [rows]);

  const nodeName = (id?: string) => (id ? node.children.find((c) => c.id === id)?.name ?? "" : "");

  const cellText = (row: Row, key: ColumnKey): string | number => {
    const f = row.item.fields;
    switch (key) {
      case "id":
        return row.item.id;
      case "type":
        return f[F.type] ?? "";
      case "title":
        return f[F.title] ?? "";
      case "state":
        return f[F.state] ?? "";
      case "priority":
        return f[F.priority] ?? "";
      case "assignee":
        return assigneeOf(row.item)?.displayName ?? "Unassigned";
      case "parent":
        return row.parentId ?? "";
      case "iteration":
        return f[F.iteration] ?? "";
      case "area":
        return f[F.area] ?? "";
      case "teams":
        return teamsInvolved(node, row)
          .map((n) => n.name)
          .join(", ");
      case "owner":
        return nodeName(row.meta?.owningNodeId);
      case "pis":
        return (row.meta?.assignedPiPaths ?? []).map((p) => piName(p, pis)).join(", ");
      case "piInvolvement":
        return piOf(f[F.iteration], pis)?.name ?? "";
    }
  };

  const visible = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key)!;
    const filtered = rows.filter((r) => matchesFilter(r.item, filter));
    return [...filtered].sort((a, b) => {
      const x = cellText(a, sort.key);
      const y = cellText(b, sort.key);
      let cmp: number;
      if (col.numeric) {
        // Blank values sort last in ascending order.
        const nx = x === "" ? Infinity : Number(x);
        const ny = y === "" ? Infinity : Number(y);
        cmp = nx === ny ? 0 : nx < ny ? -1 : 1;
      } else cmp = String(x).localeCompare(String(y));
      return (cmp || a.item.id - b.item.id) * sort.dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filter, sort, pis, node]);

  const updateRow = (id: number, fn: (r: Row) => Row) =>
    setData((d) => (d ? { rows: d.rows.map((r) => (r.item.id === id ? fn(r) : r)) } : d));

  /** Applies `local` immediately, runs `save`, and restores the previous row on failure. */
  const optimistic = async (row: Row, local: (r: Row) => Row, save: () => Promise<unknown>, what: string) => {
    const before = row;
    setError(undefined);
    updateRow(row.item.id, local);
    try {
      await save();
    } catch (e: any) {
      updateRow(row.item.id, () => before);
      setError(`Could not update ${what} of #${row.item.id}: ${e?.message ?? e}`);
    }
  };

  const withField = (row: Row, field: string, value: unknown): Row => ({
    ...row,
    item: { ...row.item, fields: { ...row.item.fields, [field]: value } },
  });

  const saveTitle = (row: Row, title: string) => {
    const t = title.trim();
    if (!t) {
      setError("Title cannot be empty.");
      return;
    }
    if (t === row.item.fields[F.title]) return;
    return optimistic(row, (r) => withField(r, F.title, t), () => setFields(row.item.id, { [F.title]: t }), "the title");
  };

  const savePriority = (row: Row, value: number) =>
    optimistic(row, (r) => withField(r, F.priority, value), () => setFields(row.item.id, { [F.priority]: value }), "the priority");

  const saveAssignee = (row: Row, displayName: string) => {
    const a = assignees.find((x) => x.displayName === displayName);
    const value = a ? a.uniqueName ?? a.displayName : "";
    return optimistic(
      row,
      (r) => withField(r, F.assignedTo, a ? { ...a } : undefined),
      () => setFields(row.item.id, { [F.assignedTo]: value }),
      "the assignee"
    );
  };

  const saveParent = (row: Row, text: string) => {
    const raw = text.trim().replace(/^#/, "");
    const next = raw === "" ? null : Number(raw);
    if (next !== null && (!Number.isInteger(next) || next <= 0)) {
      setError(`"${text}" is not a work item ID.`);
      return;
    }
    if (next === row.item.id) {
      setError("A work item cannot be its own parent.");
      return;
    }
    if (next === row.parentId) return;
    const old = row.parentId;
    return optimistic(
      row,
      (r) => ({ ...r, parentId: next, parentOnItem: next !== null }),
      async () => {
        if (old !== null) {
          if (row.parentOnItem) await removeLink(row.item.id, old, LINK.parent);
          else await removeLink(old, row.item.id, LINK.child);
        }
        if (next !== null) await addLink(row.item.id, next, LINK.parent);
      },
      "the parent"
    );
  };

  const saveOwner = (row: Row, owningNodeId: string) => {
    const base = row.meta ?? emptyMeta(row.item.id);
    const next: WorkItemMeta = { ...base, owningNodeId: owningNodeId || undefined };
    return optimistic(
      row,
      (r) => ({ ...r, meta: next }),
      async () => {
        const saved = await metaStore.save(next);
        updateRow(row.item.id, (r) => ({ ...r, meta: saved }));
      },
      "the owning team"
    );
  };

  const exportCsv = () => {
    const csv = toCsv(
      columns.map((c) => c.label),
      visible.map((r) => columns.map((c) => cellText(r, c.key)))
    );
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${node.name} work items.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const onSort = (key: ColumnKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const renderCell = (row: Row, key: ColumnKey): ReactNode => {
    const f = row.item.fields;
    const id = row.item.id;
    switch (key) {
      case "id":
        return (
          <button className="link" onClick={() => openWorkItem(id)}>
            #{id}
          </button>
        );
      case "type":
        return (
          <span className="tree-cell">
            <i className="type-bar" style={{ background: typeColor(f[F.type]) }} />
            {f[F.type]}
          </span>
        );
      case "title":
        return <TitleCell key={`${id}-${f[F.title]}`} id={id} value={f[F.title] ?? ""} onSave={(t) => saveTitle(row, t)} />;
      case "state":
        return (
          <span className="state">
            <i className="dot" style={{ background: CATEGORY_COLOR[row.category] ?? "#888" }} />
            {f[F.state]}
          </span>
        );
      case "priority":
        return (
          <select
            className="cell-input"
            aria-label={`Priority of #${id}`}
            value={f[F.priority] ?? ""}
            onChange={(e) => savePriority(row, Number(e.target.value))}
          >
            {f[F.priority] == null && <option value="">–</option>}
            {[1, 2, 3, 4].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        );
      case "assignee":
        return (
          <select
            className="cell-input"
            aria-label={`Assigned to of #${id}`}
            value={assigneeOf(row.item)?.displayName ?? ""}
            onChange={(e) => saveAssignee(row, e.target.value)}
          >
            <option value="">Unassigned</option>
            {assignees.map((a) => (
              <option key={a.displayName} value={a.displayName}>
                {a.displayName}
              </option>
            ))}
          </select>
        );
      case "parent":
        return <ParentCell key={`${id}-${row.parentId}`} id={id} value={row.parentId} onSave={(t) => saveParent(row, t)} />;
      case "iteration":
        return <span title={f[F.iteration]}>{lastSegment(f[F.iteration])}</span>;
      case "area":
        return <span title={f[F.area]}>{lastSegment(f[F.area])}</span>;
      case "owner":
        return (
          <select
            className="cell-input"
            aria-label={`Owning team of #${id}`}
            value={row.meta?.owningNodeId ?? ""}
            onChange={(e) => saveOwner(row, e.target.value)}
          >
            <option value="">–</option>
            {node.children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        );
      default:
        return cellText(row, key);
    }
  };

  return (
    <div className="wil">
      <FilterBar value={filter} onChange={setFilter} options={options} />
      <div className="toolbar">
        {!isTeam && (
          <label className="check">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all types
          </label>
        )}
        <span className="muted" aria-live="polite">
          {loading ? "Loading…" : `${visible.length} of ${rows.length} items`}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={exportCsv} disabled={!visible.length}>
          Export CSV
        </button>
      </div>
      <ErrorBar message={loadError && `Could not load work items: ${loadError}`} />
      <ErrorBar message={error} onClose={() => setError(undefined)} />
      {loading && !data ? (
        <Spinner label="Loading work items…" />
      ) : !loadError && rows.length === 0 ? (
        <Empty title="No work items">
          <p>
            No {types.join(", ")} items in {node.name}.
          </p>
        </Empty>
      ) : (
        !loadError && (
          <div className="wil-scroll">
            <table className="grid compact wil-table">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                      <button className="link sort-btn" onClick={() => onSort(c.key)}>
                        {c.label}
                        {sort.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.item.id} data-id={r.item.id}>
                    {columns.map((c) => (
                      <td key={c.key} className={`col-${c.key}`}>
                        {renderCell(r, c.key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length === 0 && <div className="empty">No work items match the filter.</div>}
          </div>
        )
      )}
    </div>
  );
}

/** Text cell that commits on Enter or blur and reverts on Escape. */
function TitleCell({ id, value, onSave }: { id: number; value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="cell-input"
      aria-label={`Title of #${id}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(value);
      }}
      onBlur={() => {
        if (draft !== value) {
          onSave(draft);
          if (!draft.trim()) setDraft(value);
        }
      }}
    />
  );
}

function ParentCell({ id, value, onSave }: { id: number; value: number | null; onSave: (v: string) => void }) {
  const initial = value === null ? "" : String(value);
  const [draft, setDraft] = useState(initial);
  return (
    <input
      className="cell-input num"
      aria-label={`Parent of #${id}`}
      placeholder="–"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(initial);
      }}
      onBlur={() => {
        if (draft.trim() !== initial) {
          onSave(draft);
          setDraft(initial);
        }
      }}
    />
  );
}
