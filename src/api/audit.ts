import * as SDK from "azure-devops-extension-sdk";

/**
 * Governance helpers for SAFe Ado's own data. The Extension Data Service keeps no history and
 * has no ACLs, so every write through the document stores (see data.ts) is stamped with who
 * changed it and appended to a per-project change log. This file holds the pure parts: the
 * current user, the field-level diff and the retention rules.
 */

/** A person, as recorded in audit stamps and the change log. */
export interface AuditUser {
  id: string;
  displayName: string;
  /** Sign-in name (e.g. ada@fabrikam.com); used to match Business Owners. */
  uniqueName?: string;
}

/** Stamps added to every document written through the stores. */
export interface AuditStamps {
  createdBy?: AuditUser;
  createdAt?: string;
  modifiedBy?: AuditUser;
  modifiedAt?: string;
}

export type AuditAction = "create" | "update" | "delete" | "import";

/** One top-level field that changed; values are compact (long text and objects are truncated). */
export interface FieldChange {
  field: string;
  from?: unknown;
  to?: unknown;
}

/** One entry of the change log (collection `audit-<projectId>`). */
export interface AuditEntry {
  id: string;
  /** Logical collection ("objectives", "risks", "config", ...), without the project suffix. */
  collection: string;
  docId: string;
  action: AuditAction;
  user: AuditUser;
  /** ISO timestamp. */
  at: string;
  /** Title / name of the document, so deleted items stay recognisable. */
  label?: string;
  changes?: FieldChange[];
  __etag?: number;
}

/**
 * Retention of the change log: the newest 2000 entries of the last 180 days. Pruning is
 * opportunistic: about one write in 25 starts a background pass that deletes at most 50 entries,
 * which removes entries faster than writes add them without ever turning into a burst.
 */
export const auditPolicy = {
  maxEntries: 2000,
  maxAgeDays: 180,
  pruneChance: 1 / 25,
  maxDeletesPerPrune: 50,
};

export const UNKNOWN_USER: AuditUser = { id: "", displayName: "Unknown user" };

/** The signed-in user from the SDK; "Unknown user" outside the host (e.g. before SDK.init). */
export function currentUser(): AuditUser {
  try {
    const u = SDK.getUser();
    if (!u) return UNKNOWN_USER;
    return { id: u.id ?? "", displayName: u.displayName || u.name || "Unknown user", ...(u.name ? { uniqueName: u.name } : {}) };
  } catch {
    return UNKNOWN_USER;
  }
}

/** Same person? Matches by identity id, else by sign-in name (case-insensitive). */
export function sameUser(a: { id?: string; uniqueName?: string }, b: { id?: string; uniqueName?: string }): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  return !!a.uniqueName && !!b.uniqueName && a.uniqueName.toLowerCase() === b.uniqueName.toLowerCase();
}

/** Fields that are bookkeeping, not content: never diffed. */
const IGNORED = new Set(["__etag", "createdBy", "createdAt", "modifiedBy", "modifiedAt"]);
const MAX_TEXT = 120;

/** A value small enough for the log: strings and JSON of objects are cut at 120 characters. */
export function compact(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === "number" || typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + "…" : text;
}

/** Top-level fields that differ between two versions of a document (compact values). */
export function diffFields(before: object | undefined, after: object | undefined): FieldChange[] {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).filter((k) => !IGNORED.has(k));
  return keys
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort()
    .map((field) => {
      const from = compact(a[field]);
      const to = compact(b[field]);
      // Large values that differ only past the cut (e.g. the hierarchy) are logged as "changed".
      if (from !== undefined && from === to) return { field };
      return { field, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
    });
}

/** Title-like label of a document, for the log. */
export function docLabel(doc: object | undefined): string | undefined {
  const d = (doc ?? {}) as Record<string, unknown>;
  const label = d.title ?? d.name ?? d.improvement ?? d.problem;
  return typeof label === "string" && label ? String(compact(label)) : undefined;
}

/** Entries to delete: everything older than maxAgeDays, then the oldest beyond maxEntries (at most maxDeletesPerPrune). */
export function entriesToPrune(entries: AuditEntry[], now = Date.now()): AuditEntry[] {
  const cutoff = new Date(now - auditPolicy.maxAgeDays * 86_400_000).toISOString();
  const newestFirst = [...entries].sort(byNewest);
  const drop = newestFirst.filter((e, i) => i >= auditPolicy.maxEntries || e.at < cutoff);
  // Oldest first, so a capped pass removes the entries that matter least.
  return drop.reverse().slice(0, auditPolicy.maxDeletesPerPrune);
}

/** Newest first (ties: by id, which starts with the timestamp). */
export function byNewest(a: AuditEntry, b: AuditEntry): number {
  return b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
}

/** "Ada Lovelace · 3 Jan 2026, 14:05" style text for a stamp. */
export function stampText(user?: AuditUser, at?: string): string {
  const when = at ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  return [user?.displayName, when].filter(Boolean).join(" · ");
}
