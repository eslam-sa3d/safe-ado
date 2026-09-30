import { sameUser } from "./audit";
import { pathTo } from "./org";
import { Member, OrgNode } from "./types";

/**
 * SAFe roles of unit members. Older configurations stored the role as free text; those values
 * are mapped case-insensitively to a role, and anything unrecognised becomes "Other" with the
 * original text kept as its label.
 */
export type SafeRole =
  | "rte"
  | "ste"
  | "productManagement"
  | "productOwner"
  | "scrumMaster"
  | "businessOwner"
  | "systemArchitect"
  | "epicOwner"
  | "lpm"
  | "teamMember"
  | "other";

export const SAFE_ROLES: { key: SafeRole; label: string; aliases: string[] }[] = [
  { key: "rte", label: "RTE", aliases: ["rte", "release train engineer"] },
  { key: "ste", label: "Solution Train Engineer", aliases: ["ste", "solution train engineer"] },
  { key: "productManagement", label: "Product Management", aliases: ["pm", "product management", "product manager", "solution management", "solution manager"] },
  { key: "productOwner", label: "Product Owner", aliases: ["po", "product owner"] },
  { key: "scrumMaster", label: "Scrum Master / Team Coach", aliases: ["sm", "scrum master", "team coach", "scrum master/team coach", "agile coach"] },
  { key: "businessOwner", label: "Business Owner", aliases: ["bo", "business owner", "business owners"] },
  { key: "systemArchitect", label: "System Architect", aliases: ["sa", "architect", "system architect", "solution architect", "system architect/engineering"] },
  { key: "epicOwner", label: "Epic Owner", aliases: ["eo", "epic owner"] },
  { key: "lpm", label: "Lean Portfolio Management", aliases: ["lpm", "lean portfolio management", "portfolio management"] },
  { key: "teamMember", label: "Team Member", aliases: ["team member", "member", "dev", "developer", "agile team member"] },
  { key: "other", label: "Other", aliases: ["other"] },
];

const ROLE_LABEL = new Map(SAFE_ROLES.map((r) => [r.key, r.label]));
const normalize = (s: string) => s.toLowerCase().replace(/\s*\/\s*/g, "/").replace(/[().]/g, "").replace(/\s+/g, " ").trim();
const BY_ALIAS = new Map(SAFE_ROLES.flatMap((r) => [...r.aliases, r.label].map((a) => [normalize(a), r.key] as const)));

/** Maps a free-text role ("rte", "Product owner", "Scrum Master / Team Coach") to a SAFe role; "other" when unknown. */
export function parseRole(text: string | undefined): SafeRole {
  return BY_ALIAS.get(normalize(text ?? "")) ?? "other";
}

/** A member's SAFe role: the stored key, else parsed from the (older) free-text role. */
export function memberRole(m: Member): SafeRole {
  return m.safeRole ?? parseRole(m.role);
}

export function roleLabel(role: SafeRole): string {
  return ROLE_LABEL.get(role) ?? "Other";
}

/** A member with a role picked from the list; "other" keeps a custom label. */
export function withRole(m: Member, role: SafeRole, customLabel?: string): Member {
  if (role === "other") return { ...m, safeRole: "other", role: customLabel ?? (memberRole(m) === "other" ? m.role : "") };
  return { ...m, safeRole: role, role: roleLabel(role) };
}

/**
 * Business Owners responsible for a unit: members with that role on the unit or its ancestors
 * (e.g. the ART's Business Owners for a team objective).
 */
export function businessOwnersFor(root: OrgNode, nodeId: string): Member[] {
  return pathTo(root, nodeId).flatMap((n) => (n.members ?? []).filter((m) => memberRole(m) === "businessOwner"));
}

/**
 * May `user` enter Actual BV for an objective of `nodeId`? Only the unit's Business Owners (matched
 * by identity), when any are defined; everyone who can edit the objective otherwise.
 */
export function canRateBusinessValue(root: OrgNode, nodeId: string, user: { id?: string; uniqueName?: string }): { allowed: boolean; owners: Member[] } {
  const owners = businessOwnersFor(root, nodeId);
  return { allowed: owners.length === 0 || owners.some((o) => sameUser(o, user)), owners };
}
