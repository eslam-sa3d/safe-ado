import { api, getProject } from "./client";

/**
 * What the current user may change, checked against Azure DevOps security (api-version 7.0):
 * - admin: "Edit project-level information" (Project namespace, GENERIC_WRITE) — Setup, My Organization.
 * - managePis: "Create child nodes" on the iteration root — PIs & Iterations.
 * - plan: "Edit work items in this node" on the area root — boards, objectives, risks, capacity.
 * When the check itself fails (older servers, missing scope) we fall back to allowing the
 * action; Azure DevOps still enforces its own permissions on every write.
 */
export interface Capabilities {
  admin: boolean;
  managePis: boolean;
  plan: boolean;
}

export const ALL_ALLOWED: Capabilities = { admin: true, managePis: true, plan: true };

const NS = {
  project: "52d39943-cb85-4d7f-8fa8-c6baac873819",
  area: "83e28ad4-2d72-4ceb-97b0-c7726d5502c3",
  iteration: "bf7bfa03-b2b7-47db-8113-fa2e002cc5b1",
};
const BIT = { genericWrite: 2, createChildren: 4, workItemWrite: 32 };

async function has(namespace: string, bits: number, token: string): Promise<boolean> {
  try {
    const res = await api<{ value: boolean[] }>(
      `_apis/permissions/${namespace}/${bits}?tokens=${encodeURIComponent(token)}&alwaysAllowAdministrators=true`
    );
    return res.value?.[0] ?? true;
  } catch {
    return true;
  }
}

export async function loadCapabilities(areaRootId?: string, iterationRootId?: string): Promise<Capabilities> {
  const project = getProject().id;
  const [admin, managePis, plan] = await Promise.all([
    has(NS.project, BIT.genericWrite, `$PROJECT:vstfs:///Classification/TeamProject/${project}`),
    iterationRootId ? has(NS.iteration, BIT.createChildren, `vstfs:///Classification/Node/${iterationRootId}`) : Promise.resolve(true),
    areaRootId ? has(NS.area, BIT.workItemWrite, `vstfs:///Classification/Node/${areaRootId}`) : Promise.resolve(true),
  ]);
  return { admin, managePis, plan };
}
