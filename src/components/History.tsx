import { useState } from "react";
import { AuditEntry, FieldChange, stampText } from "../api/audit";
import { listAudit } from "../api/data";
import { ErrorBar, Icon, Modal, Spinner, useAsync } from "./common";

/**
 * Who changed what and when, from the change log (see api/data.ts). Used by the History dialog
 * of objectives and risks and by the project-wide Audit log in Setup.
 */

const ACTION_LABEL: Record<AuditEntry["action"], string> = { create: "Created", update: "Changed", delete: "Deleted", import: "Imported" };

/** A logged value as text: empty for "no value", quotes dropped from strings. */
function valueText(v: unknown): string {
  if (v === undefined || v === null || v === "") return "(empty)";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function ChangeText({ change }: { change: FieldChange }) {
  const hasValues = "from" in change || "to" in change;
  return (
    <li>
      <code>{change.field}</code>
      {hasValues ? (
        <>
          : <span className="audit-from">{valueText(change.from)}</span> → <span className="audit-to">{valueText(change.to)}</span>
        </>
      ) : (
        " changed"
      )}
    </li>
  );
}

export function AuditTable({ entries, showDocument }: { entries: AuditEntry[]; showDocument?: boolean }) {
  if (entries.length === 0) return <p className="muted pad">No changes recorded yet.</p>;
  return (
    <table className="grid audit-table">
      <thead>
        <tr>
          <th>When</th>
          <th>Who</th>
          <th>Action</th>
          {showDocument && <th>Item</th>}
          <th>Changes</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} data-testid="audit-entry">
            <td className="nowrap">{stampText(undefined, e.at)}</td>
            <td title={e.user.uniqueName}>{e.user.displayName}</td>
            <td>{ACTION_LABEL[e.action] ?? e.action}</td>
            {showDocument && (
              <td>
                <span className="muted small">{e.collection}</span> {e.label ?? e.docId}
              </td>
            )}
            <td>
              {e.changes?.length ? (
                <ul className="audit-changes">
                  {e.changes.map((c) => (
                    <ChangeText key={c.field} change={c} />
                  ))}
                </ul>
              ) : (
                <span className="muted">{e.action === "import" ? e.label : "—"}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The change history of one document (an objective, a risk). */
export function HistoryDialog({ collection, docId, title, onClose }: { collection: string; docId: string; title: string; onClose: () => void }) {
  const { data, loading, error } = useAsync(() => listAudit({ collection, docId }), [collection, docId]);
  return (
    <Modal
      title={`History: ${title}`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <ErrorBar message={error && `Could not load the history: ${error}`} />
      {loading && !data ? <Spinner /> : <AuditTable entries={data ?? []} />}
    </Modal>
  );
}

/** A small "History" link that opens the dialog. */
export function HistoryButton({ collection, docId, title }: { collection: string; docId: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="link small history-button" aria-label={`History of ${title}`} title="Who changed this and when" onClick={() => setOpen(true)}>
        <Icon name="Clock" className="small" /> History
      </button>
      {open && <HistoryDialog collection={collection} docId={docId} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}

const PAGE = 100;

/** Project-wide change log for Setup: filter by collection and user, newest first. */
export function AuditLogPanel() {
  const { data, loading, error, reload } = useAsync(() => listAudit(), []);
  const [collection, setCollection] = useState("");
  const [user, setUser] = useState("");
  const [shown, setShown] = useState(PAGE);
  const entries = data ?? [];
  const collections = Array.from(new Set(entries.map((e) => e.collection))).sort();
  const users = Array.from(new Map(entries.map((e) => [e.user.id || e.user.displayName, e.user.displayName])).entries()).sort((a, b) =>
    a[1].localeCompare(b[1])
  );
  const visible = entries.filter((e) => (!collection || e.collection === collection) && (!user || (e.user.id || e.user.displayName) === user));

  return (
    <div className="audit-log">
      <div className="toolbar pad-x">
        <select aria-label="Filter by data" value={collection} onChange={(e) => setCollection(e.target.value)}>
          <option value="">All data</option>
          {collections.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select aria-label="Filter by user" value={user} onChange={(e) => setUser(e.target.value)}>
          <option value="">All users</option>
          {users.map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
        <span className="muted small">
          {visible.length} change{visible.length === 1 ? "" : "s"}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => reload()}>
          <Icon name="Refresh" /> Refresh
        </button>
      </div>
      <ErrorBar message={error && `Could not load the audit log: ${error}`} />
      {loading && !data ? <Spinner /> : <AuditTable entries={visible.slice(0, shown)} showDocument />}
      {visible.length > shown && (
        <button className="link pad" onClick={() => setShown(shown + PAGE)}>
          Show more ({visible.length - shown} older)
        </button>
      )}
    </div>
  );
}
