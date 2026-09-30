import { api, getProject } from "./client";

/**
 * What the current user may change (api-version 7.0):
 * - plan: whether the user can save work items in the selected unit's area. Checked with a
 *   validate-only create (nothing is saved), which needs no extra scope and respects sub-area
 *   permissions. Gates boards, objectives, risks, capacity and other planning data.
 * - admin: "Edit project-level information"; managePis: "Create child nodes" on the iteration
 *   root. These use the Security API, which may be unavailable to the extension's token; then
 *   they are unknown and the UI allows the action.
 *
 * IMPORTANT: SAFe Ado's own data (configuration, objectives, risks, capacity, planning metadata)
 * lives in the Extension Data Service, which Azure DevOps does not permission per area. The
 * read-only mode is a UI safeguard, not an access control. Work item changes are always
 * enforced by Azure DevOps itself.
 */
export interface Capabilities {
  admin: boolean;
  managePis: boolean;
  plan: boolean;
  /** False until the checks have run; writes that happen automatically wait for this. */
  known?: boolean;
}

export const ALL_ALLOWED: Capabilities = { admin: true, managePis: true, plan: true, known: true };

/** Before the checks finish: allowed in the UI (no read-only flash) but not yet confirmed. */
export const UNCONFIRMED: Capabilities = { admin: true, managePis: true, plan: true, known: false };

const NS = {
  project: "52d39943-cb85-4d7f-8fa8-c6baac873819",
  area: "83e28ad4-2d72-4ceb-97b0-c7726d5502c3",
  iteration: "bf7bfa03-b2b7-47db-8113-fa2e002cc5b1",
};
const BIT = { genericWrite: 2, createChildren: 4, workItemWrite: 32 };

/**
 * Can the user save work items of `type` in `areaPath`? Uses a validate-only create, so nothing
 * is written. Returns true when the answer is unknown (e.g. validation fails for another reason).
 */
export async function canPlanIn(areaPath: string, type: string): Promise<boolean> {
  if (!areaPath || !type) return true;
  try {
    await api(`${encodeURIComponent(getProject().id)}/_apis/wit/workitems/$${encodeURIComponent(type)}?validateOnly=true`, {
      method: "POST",
      contentType: "application/json-patch+json",
      body: [
        { op: "add", path: "/fields/System.Title", value: "SAFe Ado permission check" },
        { op: "add", path: "/fields/System.AreaPath", value: areaPath },
      ],
    });
    return true;
  } catch (e: any) {
    const message = String(e?.message ?? "");
    return !(e?.status === 403 || /TF237111|does not have permissions|not authorized/i.test(message));
  }
}

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
  return { admin, managePis, plan, known: true };
}
