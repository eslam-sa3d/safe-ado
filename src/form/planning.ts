import { ProgramIncrement, Sprint, WorkItemMeta } from "../api/types";
import { isUnder } from "../api/wit";

/**
 * SAFe planning helpers shared by the work item form panel and the Work Item List:
 * assigned PIs (Agile Hive caps them at 5), assigned units, and values derived from the
 * iterations of an item's children (PI involvement, estimated completion).
 */

export const MAX_ASSIGNED_PIS = 5;
export const PI_LIMIT_MESSAGE = `A work item can be assigned to at most ${MAX_ASSIGNED_PIS} PIs.`;

/** Index of `pi` in the meta's assigned PIs, matching the stable id first, then the path. */
export function assignedPiIndex(meta: WorkItemMeta, pi: ProgramIncrement): number {
  const ids = meta.assignedPiIds ?? [];
  return meta.assignedPiPaths.findIndex((path, i) => (!!ids[i] && ids[i] === pi.identifier) || path === pi.path);
}

export function isPiAssigned(meta: WorkItemMeta, pi: ProgramIncrement): boolean {
  return assignedPiIndex(meta, pi) >= 0;
}

/**
 * Adds or removes `pi`, keeping assignedPiIds parallel to assignedPiPaths
 * (unknown ids are kept as ""). Returns null when adding would exceed the limit.
 */
export function toggleAssignedPi(meta: WorkItemMeta, pi: ProgramIncrement): WorkItemMeta | null {
  const paths = [...meta.assignedPiPaths];
  const ids = paths.map((_, i) => meta.assignedPiIds?.[i] ?? "");
  const i = assignedPiIndex(meta, pi);
  if (i >= 0) {
    paths.splice(i, 1);
    ids.splice(i, 1);
  } else {
    if (paths.length >= MAX_ASSIGNED_PIS) return null;
    paths.push(pi.path);
    ids.push(pi.identifier);
  }
  return { ...meta, assignedPiPaths: paths, assignedPiIds: ids };
}

export function toggleAssignedNode(meta: WorkItemMeta, nodeId: string): WorkItemMeta {
  const current = meta.assignedNodeIds ?? [];
  return {
    ...meta,
    assignedNodeIds: current.includes(nodeId) ? current.filter((n) => n !== nodeId) : [...current, nodeId],
  };
}

/** PIs (in cadence order) that contain any of the iterations. */
export function piInvolvement(iterations: (string | undefined)[], pis: ProgramIncrement[]): ProgramIncrement[] {
  return pis.filter((p) => iterations.some((it) => isUnder(it, p.path)));
}

/** Finish date (YYYY-MM-DD) of the latest sprint any of the iterations is planned in. */
export function estimatedCompletion(iterations: (string | undefined)[], pis: ProgramIncrement[]): string | undefined {
  const sprints: Sprint[] = pis.flatMap((p) => p.sprints);
  let latest: string | undefined;
  for (const s of sprints) {
    if (!s.finish || !iterations.some((it) => isUnder(it, s.path))) continue;
    const finish = s.finish.slice(0, 10);
    if (!latest || finish > latest) latest = finish;
  }
  return latest;
}
