import { DependencyList, ReactNode, useCallback, useEffect, useRef, useState } from "react";

export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const call = useRef(0);

  const run = useCallback((silent = false) => {
    const id = ++call.current;
    if (!silent) setLoading(true);
    setError(undefined);
    fn()
      .then((d) => id === call.current && setData(d))
      .catch((e) => id === call.current && setError(e?.message ?? String(e)))
      .finally(() => id === call.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => run(), [run]);
  return { data, error, loading, reload: run, setData };
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="spinner-wrap">
      <div className="spinner" /> <span>{label}</span>
    </div>
  );
}

export function ErrorBar({ message, onClose }: { message?: string; onClose?: () => void }) {
  if (!message) return null;
  return (
    <div className="msg msg-error" role="alert">
      <span>{message}</span>
      {onClose && (
        <button className="link" onClick={onClose} aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}

export function Info({ children }: { children: ReactNode }) {
  return <div className="msg msg-info">{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Progress({ done, total, label }: { done: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress" title={label ?? `${done} / ${total} (${pct}%)`}>
      <div className="progress-bar" style={{ width: `${Math.min(pct, 100)}%` }} />
      <span className="progress-text">{label ?? `${pct}%`}</span>
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
  footer,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export const TYPE_COLOR: Record<string, string> = {
  Epic: "#ff7b00",
  Capability: "#339947",
  Feature: "#773b93",
  "User Story": "#009ccc",
  "Product Backlog Item": "#009ccc",
  Requirement: "#009ccc",
  Issue: "#b4009e",
};

export function typeColor(type: string): string {
  return TYPE_COLOR[type] ?? "#888";
}

export const CATEGORY_COLOR: Record<string, string> = {
  Proposed: "#b2b2b2",
  InProgress: "#007acc",
  Resolved: "#ff9d00",
  Completed: "#339933",
  Removed: "#666",
};

export function fmtDate(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function lastSegment(path?: string): string {
  if (!path) return "";
  const parts = path.split("\\");
  return parts[parts.length - 1];
}

export function storage<T>(key: string, fallback: T): [() => T, (v: T) => void] {
  return [
    () => {
      try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
      } catch {
        return fallback;
      }
    },
    (v: T) => {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage unavailable */
      }
    },
  ];
}
