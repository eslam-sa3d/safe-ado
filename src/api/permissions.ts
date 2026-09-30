import { api, getProject } from "./client";
import { foreignProjectOf } from "./projects";

/**
 * What the current user may change (api-version 7.0):
 * - plan: whether the user can save work items in the selected unit's area. Checked with a
 *   validate-only create (nothing is saved), which needs no extra scope and respects sub-area
 *   permissions. Gates boards, objectives, risks, capacity and other planning data.
 * - admin: "Edit project-level information"; managePis: "Create child nodes" on the iteration
 *   root. These use the Security API, which may be unavailable to the extension's token.
 *
 * IMPORTANT: ScaleLane's own data (configuration, objectives, risks, capacity, planning metadata)
 * lives in the Extension Data Service, which Azure DevOps does not permission per area. The
 * read-only mode is a UI safeguard, not an access control; the change log (audit) is the control.
 *
 * When a check fails (error, not a "no"), the capability is listed in `unverified`:
 * - Work item edits stay allowed (fail open): Azure DevOps enforces them on the server anyway.
 * - Writes that go only to the Extension Data Service (objectives, risks, milestones, capacity,
 *   votes, reviews, config) fail closed: see dataCapabilities().
 */
export type CapabilityKey = "admin" | "managePis" | "plan";

export interface Capabilities {
  admin: boolean;
  managePis: boolean;
  plan: boolean;
  /** False until the checks have run; writes that happen automatically wait for this. */
  known?: boolean;
  /** Checks that errored: allowed for Azure DevOps-enforced writes, denied for extension data. */
  unverified?: CapabilityKey[];
}

export const ALL_ALLOWED: Capabilities = { admin: true, managePis: true, plan: true, known: true };

/** Before the checks finish: allowed in the UI (no read-only flash) but not yet confirmed. */
export const UNCONFIRMED: Capabilities = { admin: true, managePis: true, plan: true, known: false };

/**
 * Capabilities for writes that go only to the Extension Data Service. Nothing on the server
 * guards those, so an unverified check means read-only (fail closed).
 */
export function dataCapabilities(can: Capabilities): Capabilities {
  const unverified = can.unverified ?? [];
  if (!unverified.length) return can;
  return {
    ...can,
    admin: can.admin && !unverified.includes("admin"),
    managePis: can.managePis && !unverified.includes("managePis"),
    plan: can.plan && !unverified.includes("plan"),
  };
}

const NS = {
  project: "52d39943-cb85-4d7f-8fa8-c6baac873819",
  area: "83e28ad4-2d72-4ceb-97b0-c7726d5502c3",
  iteration: "bf7bfa03-b2b7-47db-8113-fa2e002cc5b1",
};
const BIT = { genericWrite: 2, createChildren: 4, workItemWrite: 32 };

/**
 * Can the user save work items of `type` in `areaPath`? Uses a validate-only create, so nothing
 * is written. Returns undefined when the answer is unknown (server error, network): a validation
 * error on the fields (400) means the permission check itself passed.
 */
export async function checkPlanIn(areaPath: string, type: string): Promise<boolean | undefined> {
  if (!areaPath || !type) return true;
  try {
    // Areas of other projects (cross-project units) are validated in their own project.
    const route = encodeURIComponent(foreignProjectOf(areaPath) ?? getProject().id);
    await api(`${route}/_apis/wit/workitems/$${encodeURIComponent(type)}?validateOnly=true`, {
      method: "POST",
      contentType: "application/json-patch+json",
      body: [
        { op: "add", path: "/fields/System.Title", value: "ScaleLane permission check" },
        { op: "add", path: "/fields/System.AreaPath", value: areaPath },
      ],
    });
    return true;
  } catch (e: any) {
    const message = String(e?.message ?? "");
    if (e?.status === 403 || /TF237111|does not have permissions|not authorized/i.test(message)) return false;
    return e?.status === 400 ? true : undefined;
  }
}

/** checkPlanIn with an unknown answer treated as allowed (for Azure DevOps-enforced writes). */
export async function canPlanIn(areaPath: string, type: string): Promise<boolean> {
  return (await checkPlanIn(areaPath, type)) ?? true;
}

/** One Security API check; undefined when it could not be answered. */
async function has(namespace: string, bits: number, token: string): Promise<boolean | undefined> {
  try {
    const res = await api<{ value: boolean[] }>(
      `_apis/permissions/${namespace}/${bits}?tokens=${encodeURIComponent(token)}&alwaysAllowAdministrators=true`
    );
    return res.value?.[0];
  } catch {
    return undefined;
  }
}

export async function loadCapabilities(areaRootId?: string, iterationRootId?: string): Promise<Capabilities> {
  const project = getProject().id;
  const [admin, managePis, plan] = await Promise.all([
    has(NS.project, BIT.genericWrite, `$PROJECT:vstfs:///Classification/TeamProject/${project}`),
    iterationRootId ? has(NS.iteration, BIT.createChildren, `vstfs:///Classification/Node/${iterationRootId}`) : Promise.resolve(true),
    areaRootId ? has(NS.area, BIT.workItemWrite, `vstfs:///Classification/Node/${areaRootId}`) : Promise.resolve(true),
  ]);
  const answers = { admin, managePis, plan };
  const unverified = (Object.keys(answers) as CapabilityKey[]).filter((k) => answers[k] === undefined);
  return {
    admin: admin ?? true,
    managePis: managePis ?? true,
    plan: plan ?? true,
    known: true,
    ...(unverified.length ? { unverified } : {}),
  };
}
