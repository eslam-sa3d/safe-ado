import { useRef, useState } from "react";
import { BackupSummary, ImportMode, SafeBackup, summarizeBackup, validateBackup } from "../api/backup";
import { getProject } from "../api/client";
import { DATA_COLLECTIONS, exportData, importData } from "../api/data";
import { SafeConfig } from "../api/types";
import { ErrorBar, Icon, Info, Modal } from "../components/common";
import { AuditLogPanel } from "../components/History";

/**
 * Setup sections for data governance: backup / restore of all ScaleLane data of the project and
 * the project-wide change log. Extension data is removed with the extension, so the backup file
 * is the way to keep it across an uninstall (or to move it to another project).
 */

/** Saves `text` as a file in the browser. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function BackupPanel({ canImport, onConfigRestored }: { canImport: boolean; onConfigRestored: (config: SafeConfig) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [pending, setPending] = useState<{ backup: SafeBackup; summary: BackupSummary }>();
  const fileRef = useRef<HTMLInputElement>(null);

  const doExport = async () => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const backup = await exportData();
      const day = backup.exportedAt.slice(0, 10);
      download(`scalelane-backup-${backup.project.name}-${day}.json`, JSON.stringify(backup, null, 1));
      const total = Object.values(backup.collections).reduce((s, d) => s + d.length, 0);
      setDone(`Exported the configuration and ${total} document${total === 1 ? "" : "s"}.`);
    } catch (e: any) {
      setError(`Could not export: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setError(undefined);
    setDone(undefined);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setError(`${file.name} is not a valid JSON file.`);
      return;
    }
    const { backup, error: invalid } = validateBackup(parsed);
    if (!backup) {
      setError(invalid);
      return;
    }
    setPending({ backup, summary: summarizeBackup(backup, DATA_COLLECTIONS, getProject().id) });
  };

  const restore = async (mode: ImportMode, withConfig: boolean) => {
    const backup = pending!.backup;
    setPending(undefined);
    setBusy(true);
    try {
      const result = await importData(backup, mode);
      if (withConfig && backup.config) await onConfigRestored(backup.config);
      setDone(
        `Restored ${result.written} document${result.written === 1 ? "" : "s"}` +
          (result.deleted ? `, removed ${result.deleted}` : "") +
          (withConfig && backup.config ? " and the configuration" : "") +
          ". Reload the other views to see the data."
      );
    } catch (e: any) {
      setError(`Could not import: ${e?.message ?? e}. Some documents may already have been written; import the file again to finish.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pad form backup-panel">
      <p className="muted small">
        ScaleLane's data (objectives, risks, milestones, capacity, planning records, settings) lives in the Extension Data Service of
        this project. Azure DevOps removes it when the extension is uninstalled and keeps no history of it: export a backup regularly.
      </p>
      <ErrorBar message={error} onClose={() => setError(undefined)} />
      {done && <Info>{done}</Info>}
      <div className="toolbar">
        <button className="btn" disabled={busy} onClick={doExport}>
          <Icon name="Download" /> Export SAFe data
        </button>
        {canImport && (
          <>
            <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Icon name="Export" /> Import…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              aria-label="Backup file"
              hidden
              onChange={(e) => void pick(e.target.files?.[0])}
            />
          </>
        )}
        {!canImport && <span className="muted small">Only project administrators can import a backup.</span>}
      </div>
      {pending && <ImportDialog summary={pending.summary} onCancel={() => setPending(undefined)} onConfirm={restore} />}
    </div>
  );
}

function ImportDialog({
  summary,
  onCancel,
  onConfirm,
}: {
  summary: BackupSummary;
  onCancel: () => void;
  onConfirm: (mode: ImportMode, withConfig: boolean) => void;
}) {
  const [mode, setMode] = useState<ImportMode>("merge");
  const [withConfig, setWithConfig] = useState(summary.hasConfig);
  return (
    <Modal
      title="Import SAFe data"
      onClose={onCancel}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onConfirm(mode, withConfig)}>
            Import
          </button>
        </>
      }
    >
      <p>
        Backup of <strong>{summary.project.name}</strong> from {new Date(summary.exportedAt).toLocaleString()}
        {summary.exportedBy ? ` by ${summary.exportedBy}` : ""}: {summary.total} document{summary.total === 1 ? "" : "s"}
        {summary.hasConfig ? " and the configuration" : ""}.
      </p>
      {summary.otherProject && (
        <div className="msg msg-warning" role="note">
          This backup comes from another project. Area paths, teams and iterations in it may not exist here.
        </div>
      )}
      <table className="grid import-summary">
        <tbody>
          {summary.counts
            .filter((c) => c.count > 0)
            .map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td className="num">{c.count}</td>
              </tr>
            ))}
        </tbody>
      </table>
      {summary.unknown.length > 0 && <p className="muted small">Not restored (unknown to this version): {summary.unknown.join(", ")}</p>}
      <fieldset className="plain-fieldset import-mode">
        <label className="check">
          <input type="radio" name="import-mode" checked={mode === "merge"} onChange={() => setMode("merge")} /> Merge: add and update
          documents, keep the others
        </label>
        <label className="check">
          <input type="radio" name="import-mode" checked={mode === "overwrite"} onChange={() => setMode("overwrite")} /> Overwrite: make
          the data match the backup (documents not in it are deleted; the audit log is kept)
        </label>
        {summary.hasConfig && (
          <label className="check">
            <input type="checkbox" checked={withConfig} onChange={(e) => setWithConfig(e.target.checked)} /> Restore the configuration
            (hierarchy, types, PI root)
          </label>
        )}
      </fieldset>
    </Modal>
  );
}

/** The change log section of Setup; loads only when opened (it can hold thousands of entries). */
export function AuditSection() {
  const [open, setOpen] = useState(false);
  return (
    <div className="audit-section">
      <p className="muted small pad-x">
        Every change to ScaleLane's data is recorded here: who, when, and which fields changed. Azure DevOps cannot restrict who
        changes extension data, so this log is the control. It keeps the latest 2000 changes of the last 180 days.
      </p>
      {open ? (
        <AuditLogPanel />
      ) : (
        <button className="btn pad-x" onClick={() => setOpen(true)}>
          <Icon name="Clock" /> Show audit log
        </button>
      )}
    </div>
  );
}
