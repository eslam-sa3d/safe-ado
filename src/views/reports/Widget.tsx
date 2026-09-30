import { ReactNode, useState } from "react";
import { snapshotsStore } from "../../api/data";
import { queryUrl } from "../../api/links";
import { dayIso, eventDay, openQueryWiql, PiSnapshot, QueryScope } from "../../api/reports";
import { openInNewTab } from "../../api/urlState";
import { openWorkItem } from "../../api/wit";
import { fmtDate, typeColor, Icon } from "../../components/common";

/** A dashboard card. `size` controls how many grid columns it spans. */
export function Widget({
  title,
  size = "small",
  actions,
  children,
  className = "",
}: {
  title: string;
  size?: "small" | "medium" | "wide";
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`widget widget-${size} ${className}`.trim()} aria-label={title}>
      <div className="widget-header">
        <h3>{title}</h3>
        {actions && <div className="widget-actions">{actions}</div>}
      </div>
      <div className="widget-body">{children}</div>
    </section>
  );
}

export function SelectPi() {
  return <p className="muted widget-hint">Select a PI to see this report.</p>;
}

/** Big ratio number with a horizontal bar (value may exceed 100%). */
export function Ratio({
  pct,
  caption,
  tone,
  children,
}: {
  pct: number | null;
  caption: string;
  tone?: "good" | "warn" | "bad";
  children?: ReactNode;
}) {
  return (
    <div className="ratio">
      <div className={"ratio-value" + (tone ? ` ${tone}` : "")}>{pct === null ? "—" : `${pct}%`}</div>
      <div className="ratio-track" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
        <div className={"ratio-fill" + (tone ? ` ${tone}` : "")} style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
      </div>
      <div className="muted small ratio-caption">{caption}</div>
      {children}
    </div>
  );
}

export function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="widget-warning small" role="note">
      <Icon name="Warning" className="small" /> {children}
    </div>
  );
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A work item reference: type colour, title (opens the item) and id. */
export function ItemRef({ item }: { item: { id: number; type: string; title: string } }) {
  return (
    <span className="item-ref">
      <span className="type-bar" style={{ background: typeColor(item.type) }} title={item.type} />
      <button className="link title-link" onClick={() => openWorkItem(item.id)}>
        {item.title}
      </button>
      <span className="muted small">#{item.id}</span>
    </span>
  );
}

/** The local calendar date a snapshot was recorded on. */
export const recordedOn = (createdAt: string) => fmtDate(dayIso(eventDay(createdAt)));

/** Marks numbers read from a stored PI snapshot, with the day it was recorded. */
export function SnapshotNote({ createdAt }: { createdAt: string }) {
  const date = recordedOn(createdAt);
  return (
    <div className="snapshot-note muted small" title={`Snapshot recorded ${date}`}>
      <Icon name="Clock" className="small" /> as recorded on {date}
    </div>
  );
}

/** Says that a PI which ended a while ago has no snapshot, so the numbers are today's. */
export function NoSnapshotNote() {
  return (
    <div className="snapshot-note snapshot-missing muted small" role="note">
      <Icon name="Info" className="small" /> No snapshot was recorded at PI end; showing current data
    </div>
  );
}

/**
 * "Record snapshot now" for a completed PI without a snapshot: stores the current numbers
 * (only when the burnup comes from complete history) and reloads the report.
 */
export function RecordSnapshotButton({ fresh, canPlan, onRecorded }: { fresh?: PiSnapshot; canPlan: boolean; onRecorded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const reason = !canPlan
    ? "You don't have permission to plan in this unit"
    : !fresh
    ? "History too large or unavailable; a snapshot needs the complete history"
    : "Store the current numbers as this PI's snapshot";
  const record = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await snapshotsStore.save({ ...fresh!, createdAt: new Date().toISOString() });
      onRecorded();
    } catch (e: any) {
      setError(`Could not record the snapshot: ${e?.message ?? e}`);
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn record-snapshot" disabled={!canPlan || !fresh || busy} title={reason} onClick={record}>
        <Icon name="Save" className="small" /> Record snapshot now
      </button>
      {error && (
        <span className="small bad-text" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * "Open in query": the widget's work items as an ad-hoc Azure Boards query in a new tab. More
 * than MAX_QUERY_IDS items open the widget's `scope` instead, or disable the button.
 */
export function OpenInQuery({ ids, scope }: { ids: number[]; scope?: QueryScope }) {
  const { wiql, reason, byScope } = openQueryWiql(ids, scope);
  return (
    <button
      className="btn open-query"
      disabled={!wiql}
      title={
        !wiql
          ? reason
          : byScope
          ? "Too many items to list one by one: opens the widget's area, iteration and types as a query"
          : "Open these work items in an Azure Boards query"
      }
      onClick={async () => wiql && openInNewTab(await queryUrl(wiql))}
    >
      <Icon name="OpenInNewTab" className="small" /> Open in query
    </button>
  );
}

/** A small "+" button that creates something, disabled with a reason when the user can't plan. */
export function AddButton({ label, canPlan, onClick }: { label: string; canPlan: boolean; onClick: () => void }) {
  return (
    <button
      className="btn add-button"
      aria-label={label}
      disabled={!canPlan}
      title={canPlan ? label : "You don't have permission to plan in this unit"}
      onClick={onClick}
    >
      +
    </button>
  );
}

/** Where a completed PI's numbers come from: its snapshot, or today's data when none was recorded. */
export function SnapshotInfo({ snapshot, missing }: { snapshot?: PiSnapshot; missing?: boolean }) {
  if (snapshot) return <SnapshotNote createdAt={snapshot.createdAt} />;
  return missing ? <NoSnapshotNote /> : null;
}
