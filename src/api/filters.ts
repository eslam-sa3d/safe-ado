import { F, WorkItem } from "./types";

/**
 * Shared filter model (Agile Hive's JQL box + "More filters" + quick filters, mapped to ADO).
 * Facets filter client-side; `wiql` is an extra WHERE clause appended server-side.
 */
export interface ItemFilter {
  text: string;
  types: string[];
  states: string[];
  assignees: string[];
  tags: string[];
  wiql: string;
}

export const EMPTY_FILTER: ItemFilter = { text: "", types: [], states: [], assignees: [], tags: [], wiql: "" };

export function isFilterActive(f: ItemFilter): boolean {
  return !!(f.text.trim() || f.types.length || f.states.length || f.assignees.length || f.tags.length || f.wiql.trim());
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

/** Applies the client-side facets. Items with no facet value never match a non-empty facet. */
export function matchesFilter(item: WorkItem, f: ItemFilter): boolean {
  const q = f.text.trim().toLowerCase();
  if (q && !String(item.fields[F.title] ?? "").toLowerCase().includes(q) && String(item.id) !== q) return false;
  if (f.types.length && !f.types.includes(item.fields[F.type])) return false;
  if (f.states.length && !f.states.includes(item.fields[F.state])) return false;
  if (f.assignees.length && !f.assignees.includes(assigneeName(item))) return false;
  if (f.tags.length && !tagsOf(item).some((t) => f.tags.includes(t))) return false;
  return true;
}

export function applyFilter(items: WorkItem[], f: ItemFilter): WorkItem[] {
  return items.filter((i) => matchesFilter(i, f));
}

/** " AND (<clause>)" when an advanced WIQL clause is set, else "". */
export function wiqlSuffix(f: ItemFilter): string {
  const clause = f.wiql.trim();
  return clause ? ` AND (${clause})` : "";
}

/** Inserts the advanced clause before ORDER BY (or at the end) of a flat WIQL query. */
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
  if (f.wiql.trim()) parts.push(`(${f.wiql.trim()})`);
  return parts.join(" AND ");
}
