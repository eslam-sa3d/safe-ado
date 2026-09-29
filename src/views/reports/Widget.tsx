import { ReactNode } from "react";
import { openWorkItem } from "../../api/wit";
import { typeColor, Icon } from "../../components/common";

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
