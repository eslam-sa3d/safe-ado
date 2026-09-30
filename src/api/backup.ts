import type { AuditUser } from "./audit";
import type { SafeConfig } from "./types";

/**
 * Backup file of ScaleLane's data for one project (see exportData / importData in data.ts).
 * schemaVersion changes only when the file layout changes; new collections don't need a bump.
 */
export const BACKUP_FORMAT = "scalelane-backup";
/** Backups made before the rename (SAFe Ado) import unchanged; that is the migration path. */
export const LEGACY_BACKUP_FORMATS: readonly string[] = ["safe-ado-backup"];
export const BACKUP_SCHEMA_VERSION = 1;

export type BackupDoc = { id: string; __etag?: number } & Record<string, unknown>;
export type ImportMode = "merge" | "overwrite";

export interface SafeBackup {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  exportedBy?: AuditUser;
  project: { id: string; name: string };
  config: SafeConfig | null;
  /** Documents by collection name (objectives, risks, ...). */
  collections: Record<string, BackupDoc[]>;
}

export interface BackupSummary {
  project: { id: string; name: string };
  exportedAt: string;
  exportedBy?: string;
  hasConfig: boolean;
  /** Document count of each known collection in the file. */
  counts: { name: string; count: number }[];
  total: number;
  /** Collections this version does not know (they are not restored). */
  unknown: string[];
  /** The file was exported from another project. */
  otherProject: boolean;
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A plausible configuration: a root unit with a name and children, and the type mapping. */
function validConfig(c: unknown): boolean {
  if (!isObject(c) || !isObject(c.types) || typeof c.piRootIteration !== "string") return false;
  const node = (n: unknown): boolean =>
    isObject(n) && typeof n.id === "string" && typeof n.name === "string" && typeof n.level === "string" && Array.isArray(n.children) && n.children.every(node);
  return node(c.root);
}

/**
 * Checks a parsed file before anything is written. Returns the backup or the first problem found,
 * in words an administrator can act on.
 */
export function validateBackup(value: unknown): { backup?: SafeBackup; error?: string } {
  if (!isObject(value) || (value.format !== BACKUP_FORMAT && !LEGACY_BACKUP_FORMATS.includes(String(value.format)))) return { error: "This is not a ScaleLane backup file." };
  if (typeof value.schemaVersion !== "number" || value.schemaVersion < 1) return { error: "The backup has no valid schema version." };
  if (value.schemaVersion > BACKUP_SCHEMA_VERSION) {
    return { error: `The backup was made by a newer version of ScaleLane (schema ${value.schemaVersion}). Update the extension first.` };
  }
  if (!isObject(value.project) || typeof value.project.id !== "string") return { error: "The backup does not say which project it came from." };
  if (value.config !== null && !validConfig(value.config)) return { error: "The configuration in the backup is damaged." };
  if (!isObject(value.collections)) return { error: "The backup has no document collections." };
  for (const [name, docs] of Object.entries(value.collections)) {
    if (!/^[a-z][a-z0-9]*$/.test(name)) return { error: `Invalid collection name "${name}".` };
    if (!Array.isArray(docs) || !docs.every((d) => isObject(d) && typeof d.id === "string" && d.id !== "")) {
      return { error: `Collection "${name}" has documents without an id.` };
    }
  }
  return { backup: value as SafeBackup };
}

/** What a restore would do, for the confirmation step. */
export function summarizeBackup(backup: SafeBackup, known: string[], projectId: string): BackupSummary {
  const counts = known.map((name) => ({ name, count: backup.collections[name]?.length ?? 0 }));
  return {
    project: { id: backup.project.id, name: backup.project.name ?? backup.project.id },
    exportedAt: backup.exportedAt,
    exportedBy: backup.exportedBy?.displayName,
    hasConfig: !!backup.config,
    counts,
    total: counts.reduce((s, c) => s + c.count, 0),
    unknown: Object.keys(backup.collections).filter((n) => !known.includes(n)),
    otherProject: backup.project.id !== projectId,
  };
}
