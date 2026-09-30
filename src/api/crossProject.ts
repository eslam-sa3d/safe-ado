import { effectivePiRoot, flatten, foreignPiRoot } from "./org";
import { IterationPair, isForeignNode, Mirror, nodeProject, resetCrossProject, sameName, setMirrors } from "./projects";
import { OrgNode, ProgramIncrement, SafeConfig, Sprint } from "./types";
import { getProgramIncrements } from "./wit";

/**
 * Loads the PI trees of the other projects in a configuration and matches them to the host
 * cadence (see api/projects.ts). Problems never block the hub: they come back as notes, and the
 * affected items are simply left out of PI-scoped views.
 */
export interface CrossProjectStatus {
  /** Other projects in the configuration, by name. */
  projects: string[];
  /** Human-readable problems (PI root missing, PIs without a match). */
  notes: string[];
}

export const NO_CROSS_PROJECT: CrossProjectStatus = { projects: [], notes: [] };

/** Units of the configuration (hierarchy and detached) that live in another project. */
export function foreignNodes(config: SafeConfig): OrgNode[] {
  return [config.root, ...(config.detached ?? [])].flatMap(flatten).filter(isForeignNode);
}

/** Changes whenever the cross-project setup changes (units, areas, PI roots); "" for single-project configs. */
export function crossProjectKey(config: SafeConfig): string {
  const nodes = foreignNodes(config);
  if (!nodes.length) return "";
  return JSON.stringify(nodes.map((n) => [n.id, n.projectId, n.areaPath, foreignPiRoot(config, n.id), effectivePiRoot(config, n.id)]));
}

const day = (iso?: string) => (iso ?? "").slice(0, 10);
const sameDates = (a: Sprint, b: Sprint) => !!a.start && !!a.finish && day(a.start) === day(b.start) && day(a.finish) === day(b.finish);

/** The counterpart of `x` in `candidates`: same name (case-insensitive), else identical dates. */
export function matchIteration<T extends Sprint>(x: Sprint, candidates: T[]): T | undefined {
  return candidates.find((c) => sameName(c.name, x.name)) ?? candidates.find((c) => sameDates(c, x));
}

/** Cadence ↔ foreign pairs for the root, each matched PI and each matched sprint; plus what didn't match. */
export function mirrorPairs(
  cadenceRoot: string,
  cadence: ProgramIncrement[],
  foreignRoot: string,
  foreign: ProgramIncrement[]
): { pairs: IterationPair[]; unmatched: string[] } {
  const pairs: IterationPair[] = [{ host: cadenceRoot, foreign: foreignRoot }];
  const unmatched: string[] = [];
  for (const pi of cadence) {
    const other = matchIteration(pi, foreign);
    if (!other) {
      unmatched.push(pi.name);
      continue;
    }
    pairs.push({ host: pi.path, foreign: other.path });
    for (const s of pi.sprints) {
      const o = matchIteration(s, other.sprints);
      if (o) pairs.push({ host: s.path, foreign: o.path });
      else unmatched.push(s.name);
    }
  }
  return { pairs, unmatched };
}

/**
 * Builds and installs the iteration mirrors of `config`. Without units in other projects it only
 * clears the previous state, so single-project configurations behave exactly as before.
 */
export async function prepareCrossProject(config: SafeConfig): Promise<CrossProjectStatus> {
  const nodes = foreignNodes(config);
  if (!nodes.length) {
    resetCrossProject();
    return NO_CROSS_PROJECT;
  }
  // One mirror per (project, foreign PI root, cadence root), with the areas of the units using it.
  const groups = new Map<string, Mirror & { units: string[] }>();
  for (const n of nodes) {
    const project = nodeProject(n).name;
    const foreignRoot = foreignPiRoot(config, n.id);
    const cadenceRoot = effectivePiRoot(config, n.id);
    const key = [project, foreignRoot, cadenceRoot].map((s) => s.toLowerCase()).join("|");
    const g = groups.get(key) ?? { project, foreignRoot, cadenceRoot, areas: [], pairs: [], units: [] };
    if (n.areaPath) g.areas.push(n.areaPath);
    g.units.push(n.name);
    groups.set(key, g);
  }

  const pis = new Map<string, Promise<ProgramIncrement[] | null>>();
  const load = (root: string) => {
    const key = root.toLowerCase();
    if (!pis.has(key)) pis.set(key, getProgramIncrements(root).catch(() => null));
    return pis.get(key)!;
  };

  const notes: string[] = [];
  const mirrors: Mirror[] = [];
  for (const g of Array.from(groups.values())) {
    const [cadence, foreign] = await Promise.all([load(g.cadenceRoot), load(g.foreignRoot)]);
    const { units, ...mirror } = g;
    if (!cadence || !foreign) {
      notes.push(
        `${units.join(", ")} (project ${g.project}): the PI root "${!foreign ? g.foreignRoot : g.cadenceRoot}" was not found, so their items are left out of PI views. Set the unit's PI root in Setup.`
      );
      mirrors.push(mirror);
      continue;
    }
    const { pairs, unmatched } = mirrorPairs(g.cadenceRoot, cadence, g.foreignRoot, foreign);
    if (unmatched.length) {
      notes.push(
        `Project ${g.project} has no iteration matching ${unmatched.slice(0, 5).join(", ")}${
          unmatched.length > 5 ? ` and ${unmatched.length - 5} more` : ""
        } under "${g.foreignRoot}" (matched by name, else by dates); items there don't show in those PIs or sprints.`
      );
    }
    mirrors.push({ ...mirror, pairs });
  }
  // Active even when some mirrors failed: queries still span the projects, only PI matching is missing.
  setMirrors(mirrors, true);
  const projects = Array.from(new Set(nodes.map((n) => nodeProject(n).name)));
  return { projects, notes };
}
