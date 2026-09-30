import { useState } from "react";
import { leanCasesStore } from "../api/data";
import {
  caseGaps,
  currentUserName,
  emptyCase,
  fmtMoney,
  GO_DECISIONS,
  GoDecision,
  HYPOTHESIS_FIELDS,
  LeanBusinessCase,
  parseAmount,
  withDecision,
} from "../api/lpm";
import { ErrorBar, fmtDate, Modal } from "../components/common";

type TextKey = "epicOwner" | "forCustomers" | "who" | "solution" | "isA" | "that" | "unlike" | "ourSolution" | "businessOutcomes" | "leadingIndicators" | "nfrs" | "mvp";

/** Pill class per decision (Go is good, No-go bad, Pivot a warning). */
export const DECISION_CLASS: Record<GoDecision, string> = {
  Pending: "decision-pending",
  Go: "decision-go",
  "No-go": "decision-nogo",
  Pivot: "decision-pivot",
};

export function DecisionPill({ c }: { c: LeanBusinessCase | undefined }) {
  const decision = c?.decision ?? "Pending";
  const who = c?.decidedBy ? ` by ${c.decidedBy}` : "";
  const when = c?.decidedAt ? ` on ${fmtDate(c.decidedAt)}` : "";
  return (
    <span className={"pill decision " + DECISION_CLASS[decision]} title={`Decision: ${decision}${who}${when}`}>
      {decision}
    </span>
  );
}

/**
 * Editor for an Epic's Lean Business Case: hypothesis statement, outcomes, leading indicators,
 * NFRs, MVP, cost estimates, Epic Owner and the go / no-go decision (who / when recorded).
 */
export function LeanCaseEditor({
  workItemId,
  initial,
  currency,
  readOnly,
  onSaved,
  onCancel,
}: {
  workItemId: number;
  initial: LeanBusinessCase | undefined;
  currency?: string;
  readOnly?: boolean;
  onSaved: (saved: LeanBusinessCase) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<LeanBusinessCase>(initial ?? emptyCase(workItemId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const text = (key: TextKey) => (draft[key] as string | undefined) ?? "";
  const setText = (key: TextKey, value: string) => setDraft((d) => ({ ...d, [key]: value || undefined }));
  const gaps = caseGaps(draft);
  const cur = currency ? ` (${currency})` : "";

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      onSaved(await leanCasesStore.save(draft));
    } catch (e: any) {
      setError(`Could not save the business case: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="lean-case">
      <ErrorBar message={error} onClose={() => setError(undefined)} />
      <fieldset className="lean-case-fields" disabled={readOnly || saving}>
        <label className="field">
          <span className="field-label">Epic Owner</span>
          <input value={text("epicOwner")} onChange={(e) => setText("epicOwner", e.target.value)} />
        </label>
        <div className="field" role="group" aria-label="Epic hypothesis statement">
          <span className="field-label">Epic hypothesis statement</span>
          <div className="lean-hypothesis">
            {HYPOTHESIS_FIELDS.map((f) => (
              <label key={f.key} className="lean-hypothesis-row">
                <span className="muted">{f.label}</span>
                <input aria-label={`Hypothesis: ${f.label}`} value={text(f.key as TextKey)} onChange={(e) => setText(f.key as TextKey, e.target.value)} />
              </label>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="field-label">Business outcomes</span>
          <textarea rows={2} value={text("businessOutcomes")} onChange={(e) => setText("businessOutcomes", e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Leading indicators</span>
          <textarea rows={2} value={text("leadingIndicators")} onChange={(e) => setText("leadingIndicators", e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Non-functional requirements</span>
          <textarea rows={2} value={text("nfrs")} onChange={(e) => setText("nfrs", e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">MVP definition</span>
          <textarea rows={2} value={text("mvp")} onChange={(e) => setText("mvp", e.target.value)} />
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field-label">MVP cost estimate{cur}</span>
            <input
              type="number"
              min={0}
              value={draft.mvpCost ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, mvpCost: parseAmount(e.target.value) }))}
            />
          </label>
          <label className="field">
            <span className="field-label">Full cost estimate{cur}</span>
            <input
              type="number"
              min={0}
              value={draft.fullCost ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, fullCost: parseAmount(e.target.value) }))}
            />
          </label>
        </div>
        <label className="field">
          <span className="field-label">Go / no-go decision</span>
          <select
            value={draft.decision ?? "Pending"}
            onChange={(e) => setDraft((d) => withDecision(d, e.target.value as GoDecision, currentUserName(), new Date().toISOString()))}
          >
            {GO_DECISIONS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        {draft.decidedAt && (
          <p className="small muted lean-decided">
            {draft.decision ?? "Pending"} decided{draft.decidedBy ? ` by ${draft.decidedBy}` : ""} on {fmtDate(draft.decidedAt)}
          </p>
        )}
      </fieldset>
      {gaps.length > 0 && <p className="small muted">The Lean Business Case still needs {gaps.join(", ")}.</p>}
      {currency && (draft.mvpCost !== undefined || draft.fullCost !== undefined) && (
        <p className="small muted">
          MVP {draft.mvpCost !== undefined ? fmtMoney(draft.mvpCost, currency) : "–"} · Full {draft.fullCost !== undefined ? fmtMoney(draft.fullCost, currency) : "–"}
        </p>
      )}
      <div className="lean-case-actions">
        {!readOnly && (
          <button className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save business case"}
          </button>
        )}
        <button className="btn" onClick={onCancel}>
          {readOnly ? "Close" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

/** The Lean Business Case editor in a dialog (Portfolio Kanban cards). */
export function LeanCaseDialog(props: Parameters<typeof LeanCaseEditor>[0] & { title: string }) {
  const { title, ...rest } = props;
  return (
    <Modal title={`Lean Business Case: ${title}`} onClose={props.onCancel}>
      <LeanCaseEditor {...rest} />
    </Modal>
  );
}
