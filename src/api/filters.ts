import { F, WorkItem } from "./types";

/**
 * Shared filter model (Agile Hive's JQL box + "More filters" + quick filters, mapped to ADO).
 * Facets filter client-side; `wiql` is an extra WHERE clause appended server-side. Views can add
 * SAFe facets (Assigned PIs, owning team, ...) through `extra` plus a value getter per key.
 * `quick` holds active quick filters; each must match (AND).
 */
export interface ItemFilter {
  text: string;
  types: string[];
  states: string[];
  assignees: string[];
  tags: string[];
  wiql: string;
  priorities?: string[];
  iterations?: string[];
  extra?: Record<string, string[]>;
  quick?: QuickFilter[];
}

export interface QuickFilter {
  id: string;
  name: string;
  filter: ItemFilter;
  __etag?: number;
}

/** A view-supplied facet: its label, options, and how to read an item's values. */
export interface ExtraFacet {
  key: string;
  label: string;
  options: string[];
  values: (item: WorkItem) => string[];
}

export const EMPTY_FILTER: ItemFilter = { text: "", types: [], states: [], assignees: [], tags: [], wiql: "" };

const len = (xs?: string[]) => xs?.length ?? 0;

export function isFilterActive(f: ItemFilter): boolean {
  return !!(
    f.text.trim() ||
    f.types.length ||
    f.states.length ||
    f.assignees.length ||
    f.tags.length ||
    f.wiql.trim() ||
    len(f.priorities) ||
    len(f.iterations) ||
    Object.values(f.extra ?? {}).some((v) => v.length) ||
    len(f.quick as unknown as string[])
  );
}

export function assigneeName(item: WorkItem): string {
  return item.fields[F.assignedTo]?.displayName ?? "Unassigned";
}

export function tagsOf(item: WorkItem): string[] {
  return String(item.fields[F.tags] ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
}

export const priorityOf = (item: WorkItem) => (item.fields[F.priority] === undefined || item.fields[F.priority] === null ? "None" : String(item.fields[F.priority]));
export const iterationOf = (item: WorkItem) => {
  const path = String(item.fields[F.iteration] ?? "");
  return path.split("\\").pop() || path;
};

/** Applies the client-side facets (and active quick filters). Items without a value never match a non-empty facet. */
export function matchesFilter(item: WorkItem, f: ItemFilter, extraFacets: ExtraFacet[] = []): boolean {
  const q = f.text.trim().toLowerCase();
  if (q && !String(item.fields[F.title] ?? "").toLowerCase().includes(q) && String(item.id) !== q) return false;
  if (f.types.length && !f.types.includes(item.fields[F.type])) return false;
  if (f.states.length && !f.states.includes(item.fields[F.state])) return false;
  if (f.assignees.length && !f.assignees.includes(assigneeName(item))) return false;
  if (f.tags.length && !tagsOf(item).some((t) => f.tags.includes(t))) return false;
  if (len(f.priorities) && !f.priorities!.includes(priorityOf(item))) return false;
  if (len(f.iterations) && !f.iterations!.includes(iterationOf(item))) return false;
  for (const facet of extraFacets) {
    const selected = f.extra?.[facet.key] ?? [];
    if (selected.length && !facet.values(item).some((v) => selected.includes(v))) return false;
  }
  for (const quick of f.quick ?? []) if (!matchesFilter(item, quick.filter, extraFacets)) return false;
  return true;
}

export function applyFilter(items: WorkItem[], f: ItemFilter, extraFacets: ExtraFacet[] = []): WorkItem[] {
  return items.filter((i) => matchesFilter(i, f, extraFacets));
}

/** All WIQL clauses in effect (own + active quick filters). */
function wiqlClauses(f: ItemFilter): string[] {
  return [f.wiql.trim(), ...(f.quick ?? []).flatMap((q) => wiqlClauses(q.filter))].filter(Boolean);
}

/** " AND (<clause>)" per WIQL clause in effect, else "". */
export function wiqlSuffix(f: ItemFilter): string {
  return wiqlClauses(f)
    .map((c) => ` AND (${c})`)
    .join("");
}

/** Inserts the advanced clause(s) before ORDER BY (or at the end) of a flat WIQL query. */
export function withWiqlFilter(query: string, f: ItemFilter): string {
  const suffix = wiqlSuffix(f);
  if (!suffix) return query;
  const i = query.search(/ ORDER BY /i);
  return i < 0 ? query + suffix : query.slice(0, i) + suffix + query.slice(i);
}

/** Distinct facet options present in `items`. */
export function facetOptions(items: WorkItem[]) {
  const uniq = (xs: string[]) => Array.from(new Set(xs)).sort((a, b) => a.localeCompare(b));
  return {
    types: uniq(items.map((i) => i.fields[F.type]).filter(Boolean)),
    states: uniq(items.map((i) => i.fields[F.state]).filter(Boolean)),
    assignees: uniq(items.map(assigneeName)),
    tags: uniq(items.flatMap(tagsOf)),
    priorities: uniq(items.map(priorityOf)),
    iterations: uniq(items.map(iterationOf).filter(Boolean)),
  };
}

/** Human-readable WIQL equivalent of the facets, for "Copy WIQL". */
export function filterToWiql(f: ItemFilter): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const parts: string[] = [];
  if (f.text.trim()) parts.push(`[System.Title] CONTAINS ${q(f.text.trim())}`);
  if (f.types.length) parts.push(`[System.WorkItemType] IN (${f.types.map(q).join(", ")})`);
  if (f.states.length) parts.push(`[System.State] IN (${f.states.map(q).join(", ")})`);
  if (f.assignees.length) parts.push(`[System.AssignedTo] IN (${f.assignees.map(q).join(", ")})`);
  if (f.tags.length) parts.push("(" + f.tags.map((t) => `[System.Tags] CONTAINS ${q(t)}`).join(" OR ") + ")");
  const prios = (f.priorities ?? []).filter((p) => p !== "None");
  if (prios.length) parts.push(`[Microsoft.VSTS.Common.Priority] IN (${prios.join(", ")})`);
  if (len(f.iterations)) parts.push("(" + f.iterations!.map((i) => `[System.IterationPath] UNDER ${q(i)}`).join(" OR ") + ")");
  for (const c of wiqlClauses(f)) parts.push(`(${c})`);
  return parts.join(" AND ");
}
