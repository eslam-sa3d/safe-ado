import { ReactNode, useEffect, useMemo, useState } from "react";
import { emptyMeta, metaStore } from "../api/data";
import { EMPTY_FILTER, ExtraFacet, facetOptions, ItemFilter, matchesFilter, wiqlSuffix, withWiqlFilter } from "../api/filters";
import { changeParent } from "../api/teamboard";
import { boardType, findNode, flatten, scopeAreas } from "../api/org";
import { isForeignNode } from "../api/projects";
import { scopeQuery, typeChain } from "../api/queries";
import { F, LINK, OrgNode, ProgramIncrement, SafeConfig, WorkItem, WorkItemMeta } from "../api/types";
import {
  getStateCategories,
  getTeamMembers,
  getWorkItems,
  isUnder,
  openWorkItem,
  queryWorkItems,
  relationTargetId,
  setFields,
} from "../api/wit";
import { CATEGORY_COLOR, Empty, ErrorBar, fmtDate, Info, lastSegment, Spinner, typeColor, useAsync } from "../components/common";
import { useCan, useSafe } from "../components/context";
import { FilterBar } from "../components/FilterBar";
import {
  estimatedCompletion,
  isPiAssigned,
  PI_LIMIT_MESSAGE,
  piInvolvement,
  toggleAssignedNode,
  toggleAssignedPi,
  UNIT_LIMIT_MESSAGE,
} from "../form/planning";

/** A work item row plus the SAFe data derived for it. */
export interface Row {
  item: WorkItem;
  category: string;
  parentId: number | null;
  /** Whether the parent link is stored on this item (Hierarchy-Reverse) or only seen from the parent. */
  parentOnItem: boolean;
  /** Area / iteration paths of the item's (not removed) children; loaded for ARTs and Solutions. */
  childAreas: string[];
  childIterations?: string[];
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
  | "assigned"
  | "pis"
  | "piInvolvement"
  | "completion";

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
  { key: "assigned", label: "Assigned teams" },
  { key: "pis", label: "Assigned PIs" },
  { key: "piInvolvement", label: "PI involvement" },
  { key: "completion", label: "Estimated completion" },
];

const TEAM_COLUMNS: Column[] = [
  { key: "piInvolvement", label: "PI involvement" },
  { key: "pis", label: "Assigned PIs" },
];

export function columnsFor(level: OrgNode["level"]): Column[] {
  if (level === "art" || level === "solution") return [...BASE_COLUMNS, ...PROGRAM_COLUMNS];
  if (level === "team") return [...BASE_COLUMNS, ...TEAM_COLUMNS];
  return BASE_COLUMNS;
}

export interface Person {
  displayName: string;
  uniqueName?: string;
}

export const personKey = (p: Person) => p.uniqueName || p.displayName;

function assigneeOf(item: WorkItem): Person | undefined {
  const v = item.fields[F.assignedTo];
  if (!v) return undefined;
  if (typeof v === "string") return { displayName: v, uniqueName: v };
  return { displayName: v.displayName ?? v.uniqueName ?? "", uniqueName: v.uniqueName };
}

/**
 * Team members first, then people already assigned; deduplicated by unique name, and by display
 * name for people known only by name. Sorted by display name.
 */
export function mergePeople(members: Person[], assigned: Person[]): Person[] {
  const byKey = new Map<string, Person>();
  const names = new Set<string>();
  for (const p of [...members, ...assigned]) {
    const key = personKey(p).toLowerCase();
    const name = p.displayName.toLowerCase();
    if (!key || byKey.has(key) || (!p.uniqueName && names.has(name))) continue;
    byKey.set(key, p);
    names.add(name);
  }
  return Array.from(byKey.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Members of every Azure DevOps team backing a unit in `node`'s subtree (a failing team is skipped). */
export async function loadMembers(node: OrgNode): Promise<Person[]> {
  // Teams of other projects (cross-project units) are read from their own project.
  const teams = new Map<string, string | undefined>();
  for (const n of flatten(node)) if (n.teamId && !teams.has(n.teamId)) teams.set(n.teamId, isForeignNode(n) ? n.projectId : undefined);
  const lists = await Promise.all(Array.from(teams).map(([id, project]) => getTeamMembers(id, project).catch(() => [])));

  return lists.flat().map((i) => ({ displayName: i.displayName, uniqueName: i.uniqueName }));
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

/** Names of the assigned PIs: by stable id, else by path, else the path's last segment. */
export function assignedPiNames(meta: WorkItemMeta | undefined, pis: ProgramIncrement[]): string[] {
  if (!meta) return [];
  return meta.assignedPiPaths.map((path, i) => {
    const id = meta.assignedPiIds?.[i];
    return (id && pis.find((p) => p.identifier === id)?.name) || pis.find((p) => p.path === path)?.name || lastSegment(path);
  });
}

/** The SAFe type one level above `type`: Story→Feature, Feature→Capability (or Epic), Capability→Epic. */
export function expectedParentType(config: SafeConfig, type: string): string | undefined {
  const chain = typeChain(config);
  const i = chain.indexOf(type);
  if (i > 0) return chain[i - 1];
  if (i === 0) return config.types.theme || undefined;
  return undefined;
}

/** Loads the unit's items, their parents, child areas / iterations and SAFe metadata. */
async function loadRows(types: string[], chain: string[], areas: string[], filter: ItemFilter, needChildren: boolean): Promise<ListData> {
  // The advanced clause and the WIQL of active quick filters apply server-side.
  const query = withWiqlFilter(scopeQuery(types, areas, undefined, F.id), { ...EMPTY_FILTER, wiql: filter.wiql, quick: filter.quick });
  const [items, categoryOf, metas] = await Promise.all([
    queryWorkItems(query, [], true),
    getStateCategories(Array.from(new Set([...types, ...chain]))),
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

  const kidById = new Map<number, WorkItem>();
  const allKids = Array.from(new Set(Array.from(childIds.values()).flat()));
  if (needChildren && allKids.length) {
    const kids = await getWorkItems(allKids, [F.id, F.area, F.iteration, F.type, F.state]);
    kids.filter((k) => categoryOf(k.fields[F.type], k.fields[F.state]) !== "Removed").forEach((k) => kidById.set(k.id, k));
  }

  const rows = live.map((item): Row => {
    const reverse = (item.relations ?? []).find((r) => r.rel === LINK.parent);
    const onItem = reverse ? relationTargetId(reverse.url) : null;
    const parentId = onItem ?? parentFromForward.get(item.id) ?? null;
    const kids = (childIds.get(item.id) ?? []).map((id) => kidById.get(id)).filter((k): k is WorkItem => !!k);
    return {
      item,
      category: categoryOf(item.fields[F.type], item.fields[F.state]),
      parentId,
      parentOnItem: onItem !== null,
      childAreas: kids.map((k) => k.fields[F.area]).filter((a): a is string => !!a),
      childIterations: kids.map((k) => k.fields[F.iteration]).filter((a): a is string => !!a),
      meta: metaById.get(item.id),
    };
  });
  return { rows };
}

/**
 * One CSV cell. Text starting with =, +, -, @ (also after leading whitespace), tab or CR is
 * prefixed with an apostrophe so spreadsheets don't evaluate it as a formula (CSV injection);
 * then quoted when needed.
 */
export function csvCell(value: string | number): string {
  let s = String(value);
  if (typeof value === "string" && /^(?:[\t\r]|\s*[=+\-@])/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: (string | number)[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean))).sort((a, b) => a.localeCompare(b));

/** Agile Hive's Work Item List: every item of the unit, sortable, filterable and editable inline. */
export function WorkItemList() {
  const { config, node, pis } = useSafe();
  const can = useCan();
  const readOnly = !can.plan;
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
    () => loadRows(types, chain, areas, filter, needChildren),
    [types.join("|"), chain.join("|"), areas.join("|"), wiqlSuffix(filter), needChildren]
  );
  const { data: members } = useAsync(() => (readOnly ? Promise.resolve([]) : loadMembers(node)), [node.id, readOnly]);

  const rows = data?.rows ?? [];
  const options = useMemo(() => facetOptions(rows.map((r) => r.item)), [rows]);
  const people = useMemo(
    () => mergePeople(members ?? [], rows.map((r) => assigneeOf(r.item)).filter((a): a is Person => !!a && !!a.displayName)),
    [members, rows]
  );
  const personFor = (a: Person | undefined): string => {
    if (!a) return "";
    const hit =
      (a.uniqueName && people.find((p) => p.uniqueName?.toLowerCase() === a.uniqueName!.toLowerCase())) ||
      people.find((p) => p.displayName === a.displayName);
    return hit ? personKey(hit) : "";
  };

  const unitName = (id: string) => findNode(config.root, id)?.name ?? "";
  const nodeName = (id?: string) => (id ? node.children.find((c) => c.id === id)?.name ?? "" : "");
  const involvedPis = (row: Row) =>
    (needChildren ? piInvolvement(row.childIterations ?? [], pis) : [piOf(row.item.fields[F.iteration], pis)].filter((p): p is ProgramIncrement => !!p)).map(
      (p) => p.name
    );
  const assignedTeams = (row: Row) => (row.meta?.assignedNodeIds ?? []).map(unitName).filter(Boolean);

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
      case "assigned":
        return assignedTeams(row).join(", ");
      case "pis":
        return assignedPiNames(row.meta, pis).join(", ");
      case "piInvolvement":
        return involvedPis(row).join(", ");
      case "completion":
        return estimatedCompletion(row.childIterations ?? [], pis) ?? "";
    }
  };

  const rowById = useMemo(() => new Map(rows.map((r) => [r.item.id, r])), [rows]);
  const extraFacets = useMemo((): ExtraFacet[] => {
    const facet = (key: string, label: string, get: (r: Row) => string[]): ExtraFacet => ({
      key,
      label,
      options: uniq(rows.flatMap(get)),
      values: (item) => {
        const r = rowById.get(item.id);
        return r ? get(r) : [];
      },
    });
    const pisFacet = facet("pis", "Assigned PIs", (r) => assignedPiNames(r.meta, pis));
    const involvement = facet("piInvolvement", "PI involvement", involvedPis);
    if (isTeam) return [pisFacet, involvement];
    if (!needChildren) return [];
    return [
      pisFacet,
      facet("owner", "Owning team", (r) => [nodeName(r.meta?.owningNodeId)].filter(Boolean)),
      facet("assigned", "Assigned teams", assignedTeams),
      facet("teams", "Teams involved", (r) => teamsInvolved(node, r).map((n) => n.name)),
      involvement,
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, rowById, pis, node, config]);

  const visible = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key)!;
    const filtered = rows.filter((r) => matchesFilter(r.item, filter, extraFacets));
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
  }, [rows, filter, sort, pis, node, extraFacets]);

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

  const saveAssignee = (row: Row, key: string) => {
    const p = people.find((x) => personKey(x) === key);
    const value = p ? personKey(p) : "";
    return optimistic(
      row,
      (r) => withField(r, F.assignedTo, p ? { ...p } : undefined),
      () => setFields(row.item.id, { [F.assignedTo]: value }),
      "the assignee"
    );
  };

  const saveParent = async (row: Row, text: string) => {
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
    const type = row.item.fields[F.type];
    const expected = expectedParentType(config, type);
    if (next !== null && expected) {
      setError(undefined);
      let parent: WorkItem | undefined;
      try {
        [parent] = await getWorkItems([next], [F.id, F.type]);
      } catch (e: any) {
        setError(`Could not check work item #${next}: ${e?.message ?? e}`);
        return;
      }
      if (!parent) {
        setError(`Work item #${next} does not exist.`);
        return;
      }
      const parentType = parent.fields[F.type];
      // Agile Hive lets ART items link straight to Portfolio items (skipping Large Solution).
      const skipAllowed = type === config.types.feature && !!config.types.capability && parentType === config.types.epic;
      if (parentType !== expected && !skipAllowed) {
        setError(`Work item #${next} is of type ${parentType}; the parent of #${row.item.id} (${type}) must be of type ${expected}.`);
        return;
      }
    }
    const old = row.parentId;
    return optimistic(
      row,
      (r) => ({ ...r, parentId: next, parentOnItem: next !== null }),
      async () => {
        // Fresh relations (indexes), so remove + add go in one atomic request when the link is on the item.
        const [current] = await getWorkItems([row.item.id], undefined, true);
        if (!current) throw new Error("the work item no longer exists");
        await changeParent(current, old, next);
      },
      "the parent"
    );
  };

  const saveMeta = (row: Row, next: WorkItemMeta, what: string) =>
    optimistic(
      row,
      (r) => ({ ...r, meta: next }),
      async () => {
        const saved = await metaStore.save(next);
        updateRow(row.item.id, (r) => ({ ...r, meta: saved }));
      },
      what
    );

  const baseMeta = (row: Row) => row.meta ?? emptyMeta(row.item.id);

  const saveOwner = (row: Row, owningNodeId: string) =>
    saveMeta(row, { ...baseMeta(row), owningNodeId: owningNodeId || undefined }, "the owning team");

  const togglePi = (row: Row, pi: ProgramIncrement) => {
    const next = toggleAssignedPi(baseMeta(row), pi);
    if (!next) {
      setError(PI_LIMIT_MESSAGE);
      return;
    }
    return saveMeta(row, next, "the assigned PIs");
  };

  const toggleTeam = (row: Row, nodeId: string) => {
    const next = toggleAssignedNode(baseMeta(row), nodeId);
    if (!next) {
      setError(UNIT_LIMIT_MESSAGE);
      return;
    }
    return saveMeta(row, next, "the assigned teams");
  };

  const exportCsv = () => {
    const csv = toCsv(
      columns.map((c) => c.label),
      visible.map((r) => columns.map((c) => cellText(r, c.key)))
    );
    // The BOM makes Excel read the file as UTF-8 (accents, non-Latin names).
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
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
      case "state":
        return (
          <span className="state">
            <i className="dot" style={{ background: CATEGORY_COLOR[row.category] ?? "#888" }} />
            {f[F.state]}
          </span>
        );
      case "iteration":
        return <span title={f[F.iteration]}>{lastSegment(f[F.iteration])}</span>;
      case "area":
        return <span title={f[F.area]}>{lastSegment(f[F.area])}</span>;
      case "completion": {
        // Sorted and exported as YYYY-MM-DD; shown like every other date.
        const iso = cellText(row, key) as string;
        return iso ? <span title={iso}>{fmtDate(iso)}</span> : "";
      }
    }
    if (readOnly) return cellText(row, key);
    switch (key) {
      case "title":
        return <TitleCell key={`${id}-${f[F.title]}`} id={id} value={f[F.title] ?? ""} onSave={(t) => saveTitle(row, t)} />;
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
            value={personFor(assigneeOf(row.item))}
            onChange={(e) => saveAssignee(row, e.target.value)}
          >
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={personKey(p)} value={personKey(p)} title={p.uniqueName}>
                {p.displayName}
              </option>
            ))}
          </select>
        );
      case "parent":
        return <ParentCell key={`${id}-${row.parentId}`} id={id} value={row.parentId} onSave={(t) => void saveParent(row, t)} />;
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
      case "assigned":
        return (
          <PickerCell
            label={`Assigned teams of #${id}`}
            summary={cellText(row, key) as string}
            options={node.children.map((c) => ({ key: c.id, label: c.name, checked: (row.meta?.assignedNodeIds ?? []).includes(c.id) }))}
            onToggle={(k) => toggleTeam(row, k)}
          />
        );
      case "pis":
        return (
          <PickerCell
            label={`Assigned PIs of #${id}`}
            summary={cellText(row, key) as string}
            options={pis.map((p) => ({ key: p.path, label: p.name, checked: !!row.meta && isPiAssigned(row.meta, p) }))}
            onToggle={(k) => togglePi(row, pis.find((p) => p.path === k)!)}
          />
        );
      default:
        return cellText(row, key);
    }
  };

  return (
    <div className="wil">
      <FilterBar value={filter} onChange={setFilter} options={options} extraFacets={extraFacets} />
      {readOnly && (
        <div className="readonly-banner">
          <Info>You can view this list but not edit it: you lack permission to edit work items in this area.</Info>
        </div>
      )}
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

/** Multi-select popover cell (assigned teams / PIs): the summary shows the selection. */
function PickerCell({
  label,
  summary,
  options,
  onToggle,
}: {
  label: string;
  summary: string;
  options: { key: string; label: string; checked: boolean }[];
  onToggle: (key: string) => void;
}) {
  return (
    <details className="facet cell-picker">
      <summary className="cell-input" title={summary}>
        {summary || "–"}
      </summary>
      <div className="facet-menu" role="group" aria-label={label}>
        {options.length === 0 && <span className="muted small">Nothing to choose</span>}
        {options.map((o) => (
          <label key={o.key} className="check">
            <input type="checkbox" checked={o.checked} onChange={() => onToggle(o.key)} /> {o.label}
          </label>
        ))}
      </div>
    </details>
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
