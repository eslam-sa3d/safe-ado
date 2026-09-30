import { capacityStore, metaStore, objectivesStore, risksStore } from "./data";
import { isForeignNode } from "./projects";
import { OrgNode, SafeConfig } from "./types";
import { ClassificationNode, nodePathToFieldPath } from "./wit";

/**
 * Self-healing keys. SAFe records store both a readable path and the stable node id of their
 * area / iteration. On load we match by id and rewrite paths that were renamed (in ScaleLane or
 * directly in Azure DevOps), and fill in ids for older records that only have a path.
 */
export interface NodeIndex {
  /** identifier -> current field path */
  byId: Map<string, string>;
  /** lower-case field path -> identifier */
  byPath: Map<string, string>;
}

export function indexTree(root: ClassificationNode): NodeIndex {
  const byId = new Map<string, string>();
  const byPath = new Map<string, string>();
  const walk = (n: ClassificationNode) => {
    const path = nodePathToFieldPath(n.path);
    byId.set(n.identifier, path);
    byPath.set(path.toLowerCase(), n.identifier);
    n.children?.forEach(walk);
  };
  walk(root);
  return byId.size ? { byId, byPath } : { byId, byPath };
}

/** Resolves a (path, id) pair against the index: the id wins when it still exists. */
export function resolveKey(path: string | undefined, id: string | undefined, index: NodeIndex): { path?: string; id?: string } {
  if (id && index.byId.has(id)) return { path: index.byId.get(id), id };
  if (path && index.byPath.has(path.toLowerCase())) return { path, id: index.byPath.get(path.toLowerCase()) };
  return { path, id };
}

/** Returns an updated copy of the config when any area / PI root path or id changed, else null. */
export function reconcileConfig(config: SafeConfig, areas: NodeIndex, iterations: NodeIndex): SafeConfig | null {
  let changed = false;
  const fixNode = (n: OrgNode): OrgNode => {
    // Units of other projects are keyed against their own project's trees, which aren't loaded here.
    if (isForeignNode(n)) return { ...n, children: n.children.map(fixNode) };
    const area = n.areaPath || n.areaId ? resolveKey(n.areaPath, n.areaId, areas) : {};
    const cadence = n.piRootIteration || n.piRootId ? resolveKey(n.piRootIteration, n.piRootId, iterations) : {};
    const next: OrgNode = { ...n, children: n.children.map(fixNode) };
    if (area.path !== undefined && (area.path !== n.areaPath || area.id !== n.areaId)) {
      next.areaPath = area.path;
      next.areaId = area.id;
      changed = true;
    }
    if (cadence.path !== undefined && (cadence.path !== n.piRootIteration || cadence.id !== n.piRootId)) {
      next.piRootIteration = cadence.path;
      next.piRootId = cadence.id;
      changed = true;
    }
    return next;
  };
  const root = fixNode(config.root);
  const detached = config.detached?.map(fixNode);
  const piRoot = resolveKey(config.piRootIteration, config.piRootId, iterations);
  const next: SafeConfig = { ...config, root, ...(detached ? { detached } : {}) };
  if (piRoot.path !== config.piRootIteration || piRoot.id !== config.piRootId) {
    next.piRootIteration = piRoot.path ?? config.piRootIteration;
    next.piRootId = piRoot.id;
    changed = true;
  }
  return changed ? next : null;
}

/**
 * Rewrites stored objectives, risks, capacity and PI assignments whose PI / iteration was
 * renamed, and adds ids to older records. Returns how many records were updated.
 */
export async function reconcileDocs(iterations: NodeIndex): Promise<number> {
  let fixed = 0;
  const save = async <T>(store: { save: (d: T) => Promise<T> }, doc: T) => {
    try {
      await store.save(doc);
      fixed++;
    } catch {
      /* another user changed it meanwhile; the next load retries */
    }
  };

  const [objectives, risks, capacity, metas] = await Promise.all([
    objectivesStore.list(),
    risksStore.list(),
    capacityStore.list(),
    metaStore.list(),
  ]);

  for (const store of [
    { docs: objectives, store: objectivesStore },
    { docs: risks, store: risksStore },
  ] as const) {
    for (const doc of store.docs as { piPath: string; piId?: string }[]) {
      const r = resolveKey(doc.piPath, doc.piId, iterations);
      if (r.path !== doc.piPath || r.id !== doc.piId) await save(store.store as any, { ...doc, piPath: r.path!, piId: r.id });
    }
  }
  for (const doc of capacity) {
    const r = resolveKey(doc.iterationPath, doc.iterationId, iterations);
    if (r.path !== doc.iterationPath || r.id !== doc.iterationId) await save(capacityStore, { ...doc, iterationPath: r.path!, iterationId: r.id });
  }
  for (const doc of metas) {
    const ids = doc.assignedPiIds ?? [];
    const pairs = doc.assignedPiPaths.map((path, i) => resolveKey(path, ids[i], iterations));
    const paths = pairs.map((p) => p.path!);
    const newIds = pairs.map((p) => p.id ?? "");
    const same = paths.join("|") === doc.assignedPiPaths.join("|") && newIds.join("|") === ids.join("|");
    if (!same) await save(metaStore, { ...doc, assignedPiPaths: paths, assignedPiIds: newIds });
  }
  return fixed;
}
