import { Level, OrgNode, SafeConfig } from "./types";

/** Helpers for walking the SAFe organization tree. */

export function flatten(root: OrgNode): OrgNode[] {
  const out: OrgNode[] = [];
  const walk = (n: OrgNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

export function findNode(root: OrgNode, id: string): OrgNode | undefined {
  return flatten(root).find((n) => n.id === id);
}

export function parentOf(root: OrgNode, id: string): OrgNode | undefined {
  return flatten(root).find((n) => n.children.some((c) => c.id === id));
}

export function pathTo(root: OrgNode, id: string): OrgNode[] {
  const walk = (n: OrgNode, trail: OrgNode[]): OrgNode[] | undefined => {
    const next = [...trail, n];
    if (n.id === id) return next;
    for (const c of n.children) {
      const hit = walk(c, next);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(root, []) ?? [root];
}

/** Levels a child of `level` may have. Portfolios may skip the Large Solution level (Essential SAFe). */
export function childLevels(level: Level): Level[] {
  switch (level) {
    case "portfolio":
      return ["solution", "art"];
    case "solution":
      return ["art"];
    case "art":
      return ["team"];
    default:
      return [];
  }
}

/**
 * Area paths that cover a node: its own area path, or else the topmost area paths of its
 * descendants. Used to scope WIQL queries.
 */
export function scopeAreas(node: OrgNode): string[] {
  if (node.areaPath) return [node.areaPath];
  return node.children.flatMap(scopeAreas);
}

/** Work item type that represents "the thing on the board" at a given level. */
export function boardType(config: SafeConfig, level: Level): string {
  switch (level) {
    case "portfolio":
      return config.types.epic;
    case "solution":
      return config.types.capability || config.types.feature;
    default:
      return config.types.feature;
  }
}

/** Row nodes for the program board: an ART shows its teams, a solution its ARTs, a team itself. */
export function boardRows(node: OrgNode): OrgNode[] {
  if (node.level === "team") return [node];
  return node.children.length ? node.children : [node];
}

/** Every node that belongs to `node`'s subtree (used to filter risks/objectives). */
export function subtreeIds(node: OrgNode): Set<string> {
  return new Set(flatten(node).map((n) => n.id));
}

export const LEVEL_COLOR: Record<Level, string> = {
  portfolio: "#2e7d32",
  solution: "#1565c0",
  art: "#c62828",
  team: "#6a1b9a",
};

/** The PI root iteration that applies to a node: its own cadence, the nearest ancestor's, or the project's. */
export function effectivePiRoot(config: SafeConfig, nodeId: string): string {
  // Detached units keep their own chain (detached root -> node).
  const tree = [config.root, ...(config.detached ?? [])].find((t) => findNode(t, nodeId)) ?? config.root;
  const chain = pathTo(tree, nodeId);
  for (let i = chain.length - 1; i >= 0; i--) if (chain[i].piRootIteration) return chain[i].piRootIteration!;
  return config.piRootIteration;
}
