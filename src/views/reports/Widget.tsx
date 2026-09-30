import { ReactNode } from "react";
import { queryUrl } from "../../api/links";
import { idsQuery } from "../../api/reports";
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

/** Marks numbers read from the snapshot stored when the PI ended. */
export function SnapshotNote({ createdAt }: { createdAt: string }) {
  return (
    <div className="snapshot-note muted small" title={`Recorded ${fmtDate(createdAt)}`}>
      <Icon name="Clock" className="small" /> as recorded at PI end
    </div>
  );
}

/** "Open in query": the widget's work items as an ad-hoc Azure Boards query in a new tab. */
export function OpenInQuery({ ids }: { ids: number[] }) {
  const wiql = idsQuery(ids);
  return (
    <button
      className="btn open-query"
      disabled={!wiql}
      title={wiql ? "Open these work items in an Azure Boards query" : "No work items to open"}
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
