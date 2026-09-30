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

/**
 * Why a user-entered WIQL clause can't be appended to a scoped query, or null when it can.
 * The clause is wrapped in "AND (<clause>)" after the project / area / iteration scope, so
 * unbalanced parentheses or quotes (e.g. "1=1) OR (...") would escape that scope, and ORDER BY /
 * ASOF / MODE would change the statement itself.
 */
export function wiqlClauseProblem(clause: string): string | null {
  let depth = 0;
  let quote: string | null = null;
  let outside = "";
  for (let i = 0; i < clause.length; i++) {
    const c = clause[i];
    if (quote) {
      // A doubled quote is an escaped quote inside the literal.
      if (c === quote && clause[i + 1] === quote) i++;
      else if (c === quote) quote = null;
      outside += " ";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      outside += " ";
      continue;
    }
    if (c === "(") depth++;
    if (c === ")" && --depth < 0) return "Unbalanced parentheses in the WIQL clause.";
    outside += c;
  }
  if (quote) return "Unbalanced quotes in the WIQL clause.";
  if (depth !== 0) return "Unbalanced parentheses in the WIQL clause.";
  if (/\bORDER\s+BY\b|\bASOF\b|\bMODE\b/i.test(outside)) return "ORDER BY, ASOF and MODE aren't allowed in a filter clause.";
  return null;
}

/** All WIQL clauses in effect (own + active quick filters); clauses failing the guard are never sent. */
function wiqlClauses(f: ItemFilter): string[] {
  return [f.wiql.trim(), ...(f.quick ?? []).flatMap((q) => wiqlClauses(q.filter))].filter((c) => !!c && !wiqlClauseProblem(c));
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

export interface WiqlExport {
  wiql: string;
  /** True when active facets without a WIQL form (iteration names, priority "None", SAFe facets) were left out. */
  omitted: boolean;
}

/**
 * WIQL equivalent of the filter, for "Copy WIQL". Only valid WIQL is emitted: "Unassigned" becomes
 * `[System.AssignedTo] = ''` (ORed with named assignees); facets WIQL can't express are left out
 * and flagged. Active quick filters are included (ANDed), like they apply.
 */
export function describeWiql(f: ItemFilter): WiqlExport {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const parts: string[] = [];
  let omitted = false;
  if (f.text.trim()) parts.push(`[System.Title] CONTAINS ${q(f.text.trim())}`);
  if (f.types.length) parts.push(`[System.WorkItemType] IN (${f.types.map(q).join(", ")})`);
  if (f.states.length) parts.push(`[System.State] IN (${f.states.map(q).join(", ")})`);
  if (f.assignees.length) {
    const named = f.assignees.filter((a) => a !== "Unassigned");
    const alts = [
      named.length ? `[System.AssignedTo] IN (${named.map(q).join(", ")})` : "",
      named.length < f.assignees.length ? `[System.AssignedTo] = ''` : "",
    ].filter(Boolean);
    parts.push(alts.length > 1 ? `(${alts.join(" OR ")})` : alts[0]);
  }
  if (f.tags.length) parts.push("(" + f.tags.map((t) => `[System.Tags] CONTAINS ${q(t)}`).join(" OR ") + ")");
  const prios = (f.priorities ?? []).filter((p) => p !== "None");
  if (prios.length) parts.push(`[Microsoft.VSTS.Common.Priority] IN (${prios.join(", ")})`);
  if (prios.length < len(f.priorities)) omitted = true;
  // The iteration facet matches the last path segment only, and view facets are client-side data.
  if (len(f.iterations) || Object.values(f.extra ?? {}).some((v) => v.length)) omitted = true;
  const own = f.wiql.trim();
  if (own && !wiqlClauseProblem(own)) parts.push(`(${own})`);
  for (const quick of f.quick ?? []) {
    const sub = describeWiql(quick.filter);
    // An AND chain of self-contained parts: no extra parentheses needed.
    if (sub.wiql) parts.push(sub.wiql);
    omitted ||= sub.omitted;
  }
  return { wiql: parts.join(" AND "), omitted };
}

/** WIQL equivalent of the filter, for "Copy WIQL" (see describeWiql). */
export function filterToWiql(f: ItemFilter): string {
  return describeWiql(f).wiql;
}
