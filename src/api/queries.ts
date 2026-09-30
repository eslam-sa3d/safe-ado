import { wiqlString } from "./client";
import { projectClause } from "./projects";
import { F, SafeConfig, WorkItem } from "./types";
import { getStateCategories, getWorkItems, iterationUnder, queryLinks, queryWorkItems, typeIn, underAny } from "./wit";

export function baseFields(config: SafeConfig): string[] {
  return [F.id, F.title, F.type, F.state, F.area, F.iteration, F.assignedTo, F.tags, config.storyPointsField];
}

/**
 * Flat query for items of `types` inside `areas`, optionally limited to a PI iteration subtree.
 * Areas in other projects widen the project clause, and the (cadence) iteration to its
 * counterparts in those projects.
 */
export function scopeQuery(types: string[], areas: string[], iterationPath?: string, orderBy: string = F.stackRank): string {
  return [
    `SELECT [System.Id] FROM WorkItems WHERE ${projectClause(areas)}`,
    `AND ${typeIn(types)}`,
    `AND ${underAny("[System.AreaPath]", areas)}`,
    iterationPath ? `AND ${iterationUnder("[System.IterationPath]", iterationPath)}` : "",
    `ORDER BY [${orderBy}] ASC, [System.Id] ASC`,
  ].join(" ");
}

export interface TreeNode {
  item: WorkItem;
  children: TreeNode[];
  category: string;
  points: number;
  donePoints: number;
  count: number;
  doneCount: number;
}

/** The type chain top-down, skipping levels the process does not have. */
export function typeChain(config: SafeConfig): string[] {
  const { epic, capability, feature, story } = config.types;
  return Array.from(new Set([epic, capability, feature, story].filter(Boolean)));
}

/**
 * Loads `rootType` items in scope plus all descendants down to stories, and rolls up
 * story points / counts. Removed items are dropped; completion uses state categories so
 * custom states work.
 */
export async function loadTree(
  config: SafeConfig,
  rootType: string,
  areas: string[],
  iterationPath?: string
): Promise<TreeNode[]> {
  const chain = typeChain(config);
  const below = chain.slice(chain.indexOf(rootType) + 1);
  const fields = baseFields(config);

  let edges: { parent: number | null; child: number }[];
  if (below.length === 0) {
    const items = await queryWorkItems(scopeQuery([rootType], areas, iterationPath), [F.id]);
    edges = items.map((i) => ({ parent: null, child: i.id }));
  } else {
    edges = await queryLinks(
      [
        `SELECT [System.Id] FROM WorkItemLinks WHERE (`,
        projectClause(areas, "[Source].[System.TeamProject]"),
        `AND [Source].[System.WorkItemType] = ${wiqlString(rootType)}`,
        `AND ${underAny("[Source].[System.AreaPath]", areas)}`,
        iterationPath ? `AND ${iterationUnder("[Source].[System.IterationPath]", iterationPath)}` : "",

        `) AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward')`,
        `AND (${typeIn(below, "[Target].[System.WorkItemType]")})`,
        `MODE (Recursive)`,
      ].join(" ")
    );
  }
  if (edges.length === 0) return [];

  const items = await getWorkItems(
    edges.map((e) => e.child),
    fields
  );
  const byId = new Map(items.map((i) => [i.id, i]));
  const categoryOf = await getStateCategories(chain);

  const nodes = new Map<number, TreeNode>();
  for (const item of items) {
    nodes.set(item.id, {
      item,
      children: [],
      category: categoryOf(item.fields[F.type], item.fields[F.state]),
      points: 0,
      donePoints: 0,
      count: 0,
      doneCount: 0,
    });
  }

  const roots: TreeNode[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const child = nodes.get(e.child);
    if (!child || child.category === "Removed") continue;
    const key = `${e.parent}>${e.child}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.parent === null) roots.push(child);
    else nodes.get(e.parent)?.children.push(child);
  }

  const storyType = config.types.story;
  const rollup = (n: TreeNode): void => {
    n.children.forEach(rollup);
    if (n.item.fields[F.type] === storyType || n.children.length === 0) {
      const pts = Number(byId.get(n.item.id)?.fields[config.storyPointsField] ?? 0) || 0;
      const done = n.category === "Completed";
      n.points = pts;
      n.donePoints = done ? pts : 0;
      n.count = 1;
      n.doneCount = done ? 1 : 0;
    } else {
      for (const c of n.children) {
        n.points += c.points;
        n.donePoints += c.donePoints;
        n.count += c.count;
        n.doneCount += c.doneCount;
      }
    }
  };
  roots.forEach(rollup);
  return roots;
}
