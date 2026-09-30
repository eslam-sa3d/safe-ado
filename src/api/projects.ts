import { api, getProject, wiqlString } from "./client";
import { F, OrgNode, WorkItem } from "./types";

/**
 * Cross-project portfolios. The SAFe configuration lives in one project (the host), but a unit
 * may point to an area path and team in another project of the same collection.
 *
 * - Queries: area and iteration paths start with their project's name, so the projects in scope
 *   follow from the area paths. A scope inside the host project keeps `[System.TeamProject] =
 *   @project`; a scope spanning several projects uses `[System.TeamProject] IN (...)` and runs
 *   at collection level (see wit.queryIds).
 * - PIs: the host cadence (the PI root that applies to the selected unit) defines the PIs. Each
 *   other project has its own iteration tree; a unit there names its PI root in that project
 *   (`piRootIteration`), else the host root's path is assumed in that project. Its PIs and
 *   sprints are matched to the cadence by name, else by identical dates ("mirrors").
 * - Reads map a foreign item's iteration onto the matching cadence path, so boards and reports
 *   see one cadence; the original stays in PROJECT_ITERATION. Writes map cadence paths back to
 *   the item's own project, and refuse to move items between projects.
 */

export interface ProjectRef {
  id: string;
  name: string;
}

/** Field holding a foreign item's original iteration path after it was mapped onto the cadence. */
export const PROJECT_ITERATION = "SafeAdo.ProjectIterationPath";

export class CrossProjectError extends Error {}

const lower = (s: string) => s.toLowerCase();
export const sameName = (a: string | undefined, b: string | undefined) => lower(a ?? "") === lower(b ?? "");

/** All projects of the collection (Setup / My Organization project picker). */
export async function getProjects(): Promise<ProjectRef[]> {
  const res = await api<{ value: ProjectRef[] }>(`_apis/projects?$top=1000`);
  return res.value.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** First segment of an area / iteration path: its project's name. */
export function projectOfPath(path: string | undefined): string {
  return (path ?? "").split("\\")[0];
}

export function isHostProjectName(name: string | undefined): boolean {
  return !name || sameName(name, getProject().name);
}

/**
 * The project of `path` when it is another project of a cross-project configuration; undefined
 * otherwise (single-project configurations always use the host project, exactly as before).
 */
export function foreignProjectOf(path: string | undefined): string | undefined {
  const project = projectOfPath(path);
  return state.active && !isHostProjectName(project) ? project : undefined;
}

/** True for a unit that lives in another project than the host. Old configs (no projectId) are host units. */
export function isForeignNode(node: Pick<OrgNode, "projectId">): boolean {
  return !!node.projectId && node.projectId !== getProject().id;
}

/** The unit's project (the host when unset). */
export function nodeProject(node: Pick<OrgNode, "projectId" | "projectName">): ProjectRef {
  return isForeignNode(node) ? { id: node.projectId!, name: node.projectName ?? node.projectId! } : getProject();
}

/** Route segment for REST calls in a project (id or name); the host project when omitted. */
export function projectRoute(project?: string): string {
  return encodeURIComponent(project || getProject().id);
}

/** Distinct project names of `paths`, in order of first appearance. */
export function scopeProjects(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const name = projectOfPath(p);
    if (name && !out.some((o) => sameName(o, name))) out.push(name);
  }
  return out;
}

/**
 * WIQL project clause for a scope: `@project` for single-project configurations (exactly as before)
 * and while every area is in the host project, else an explicit project list.
 */
export function projectClause(areas: string[], field = "[System.TeamProject]"): string {
  const projects = scopeProjects(areas);
  if (!state.active || projects.every((p) => isHostProjectName(p))) return `${field} = @project`;
  return `${field} IN (${projects.map(wiqlString).join(", ")})`;
}

// ---------------------------------------------------------------------------------------------
// Iteration mirrors (set by crossProject.prepareCrossProject)
// ---------------------------------------------------------------------------------------------

/** One cadence iteration (root, PI or sprint) and its counterpart in another project. */
export interface IterationPair {
  host: string;
  foreign: string;
}

/** The PI tree of one project mirrored onto one cadence. */
export interface Mirror {
  project: string;
  foreignRoot: string;
  cadenceRoot: string;
  /** Area paths of the units using this mirror (to pick the mirror for a write). */
  areas: string[];
  pairs: IterationPair[];
}

const state = {
  active: false,
  mirrors: [] as Mirror[],
  /** Project and area of every work item read this session (for write mapping). */
  homes: new Map<number, { project: string; area?: string }>(),
};

/** Installs the mirrors of the current configuration; `active` when it has units in other projects. */
export function setMirrors(mirrors: Mirror[], active = mirrors.length > 0) {
  state.mirrors = mirrors;
  state.active = active;
}

export function resetCrossProject() {
  state.mirrors = [];
  state.active = false;
  state.homes.clear();
}

/** True while the configuration includes units of other projects. */
export function crossProjectActive(): boolean {
  return state.active;
}

export function getMirrors(): Mirror[] {
  return state.mirrors;
}

const isUnderPath = (path: string, parent: string) => sameName(path, parent) || lower(path).startsWith(lower(parent) + "\\");

/**
 * A foreign iteration path mapped onto the cadence: exact matches map to their pair; a path below
 * a matched PI (e.g. an unmatched sprint) maps to that PI. Other paths are returned unchanged.
 */
export function toCadencePath(path: string): string {
  if (!state.active || !path || isHostProjectName(projectOfPath(path))) return path;
  let best: IterationPair | undefined;
  for (const m of state.mirrors) {
    for (const p of m.pairs) {
      if (isUnderPath(path, p.foreign) && (!best || p.foreign.length > best.foreign.length)) best = p;
    }
  }
  return best ? best.host : path;
}

/** A cadence path plus its counterparts in other projects (for `UNDER` clauses). */
export function expandIteration(hostPath: string): string[] {
  const out = [hostPath];
  if (!state.active) return out;
  for (const m of state.mirrors) {
    for (const p of m.pairs) if (sameName(p.host, hostPath) && !out.some((o) => sameName(o, p.foreign))) out.push(p.foreign);
  }
  return out;
}

/**
 * The counterpart of cadence path `hostPath` in `project` (for writes). Prefers the mirror used
 * by the unit that owns `area`. Throws a CrossProjectError when the project has no match.
 */
export function toProjectPath(hostPath: string, project: string, area?: string): string {
  if (isHostProjectName(project) || sameName(projectOfPath(hostPath), project)) return hostPath;
  const candidates = state.mirrors
    .filter((m) => sameName(m.project, project))
    .sort((a, b) => Number(ownsArea(b, area)) - Number(ownsArea(a, area)));
  for (const m of candidates) {
    const pair = m.pairs.find((p) => sameName(p.host, hostPath));
    if (pair) return pair.foreign;
  }
  const root = candidates[0]?.foreignRoot ?? `${project}\\…`;
  throw new CrossProjectError(
    `Project "${project}" has no iteration matching "${hostPath}". Create it under "${root}" with the same name or dates, or set the unit's PI root in Setup.`
  );
}

function ownsArea(m: Mirror, area: string | undefined): boolean {
  return !!area && m.areas.some((a) => isUnderPath(area, a));
}

// ---------------------------------------------------------------------------------------------
// Items: normalise reads, map writes
// ---------------------------------------------------------------------------------------------

/** Maps foreign iterations onto the cadence (in place) and, with `record`, remembers each item's project. */
export function normalizeItems<T extends Pick<WorkItem, "id" | "fields">>(items: T[], record = true): T[] {
  for (const item of items) {
    const f = item.fields ?? {};
    const area = f[F.area] as string | undefined;
    const project = (f["System.TeamProject"] as string | undefined) || projectOfPath(area);
    if (record && project) state.homes.set(item.id, { project, area: area ?? state.homes.get(item.id)?.area });
    const iteration = f[F.iteration] as string | undefined;
    if (!state.active || !iteration) continue;
    const mapped = toCadencePath(iteration);
    if (mapped !== iteration) {
      f[PROJECT_ITERATION] = iteration;
      f[F.iteration] = mapped;
    }
  }
  return items;
}

/** Whether mapping writes to `id` needs its project first (unknown item, iteration or area change). */
export function needsHome(id: number, paths: string[]): boolean {
  return state.active && !state.homes.has(id) && paths.some((p) => p === `/fields/${F.iteration}` || p === `/fields/${F.area}`);
}

type Op = { op: string; path: string; value?: unknown };

/**
 * Maps iteration writes of an item in another project to that project's paths, and refuses area
 * changes that would move an item between projects (Azure DevOps needs "Move to team project").
 */
export function mapWriteOps<T extends Op>(id: number, ops: T[]): T[] {
  if (!state.active) return ops;
  const home = state.homes.get(id);
  if (!home) return ops;
  const areaOp = ops.find((o) => o.path === `/fields/${F.area}` && typeof o.value === "string");
  const area = (areaOp?.value as string | undefined) ?? home.area;
  if (areaOp && !sameName(projectOfPath(areaOp.value as string), home.project)) {
    throw new CrossProjectError(
      `#${id} belongs to project "${home.project}" and can't be moved to "${projectOfPath(areaOp.value as string)}" here. Use "Move to team project" in Azure Boards.`
    );
  }
  const mapped = ops.map((o) =>
    o.path === `/fields/${F.iteration}` && typeof o.value === "string" ? { ...o, value: toProjectPath(o.value, home.project, area) } : o
  );
  if (areaOp) state.homes.set(id, { ...home, area });
  return mapped;
}

/** Fields of a new item in `project` with the cadence iteration mapped to that project. */
export function mapNewItemFields<T extends Record<string, unknown>>(fields: T): T {
  const area = fields[F.area] as string | undefined;
  const project = projectOfPath(area);
  const iteration = fields[F.iteration];
  if (!state.active || !area || isHostProjectName(project) || typeof iteration !== "string") return fields;
  return { ...fields, [F.iteration]: toProjectPath(iteration, project, area) };
}
