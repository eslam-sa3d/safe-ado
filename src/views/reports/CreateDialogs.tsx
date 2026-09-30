import { useState } from "react";
import { IMPACTS, ImpactLevel, PROBABILITIES, Probability } from "../../api/risk";
import { ErrorBar, Field, Modal } from "../../components/common";

/** Values of a new PI objective (the widget adds ids, PI and unit). */
export interface ObjectiveDraft {
  title: string;
  committed: boolean;
  plannedBV: number;
}

/** Values of a new risk (the widget adds ids, PI and unit). */
export interface RiskDraft {
  title: string;
  owner: string;
  description: string;
  probability: Probability;
  impactLevel: ImpactLevel;
}

function useSubmit<T>(onSave: (draft: T) => Promise<void>, what: string) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (draft: T) => {
    setBusy(true);
    try {
      await onSave(draft);
    } catch (e: any) {
      setError(`Could not save ${what}: ${e?.message ?? e}`);
      setBusy(false);
    }
  };
  return { error, busy, submit };
}

function Footer({ disabled, onCreate, onClose }: { disabled: boolean; onCreate: () => void; onClose: () => void }) {
  return (
    <>
      <button className="btn primary" disabled={disabled} onClick={onCreate}>
        Create
      </button>
      <button className="btn" onClick={onClose}>
        Cancel
      </button>
    </>
  );
}

export function ObjectiveDialog({ piName, onClose, onSave }: { piName: string; onClose: () => void; onSave: (d: ObjectiveDraft) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [committed, setCommitted] = useState(true);
  const [plannedBV, setPlannedBV] = useState("");
  const { error, busy, submit } = useSubmit(onSave, "objective");
  const bv = Number(plannedBV);
  const bvValid = plannedBV !== "" && Number.isFinite(bv) && bv >= 0 && bv <= 10;
  const valid = !!title.trim() && bvValid;
  return (
    <Modal
      title={`New PI objective · ${piName}`}
      onClose={onClose}
      footer={<Footer disabled={busy || !valid} onClose={onClose} onCreate={() => submit({ title: title.trim(), committed, plannedBV: bv })} />}
    >
      <ErrorBar message={error} />
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Planned business value">
        <input
          type="number"
          min={0}
          max={10}
          value={plannedBV}
          aria-invalid={plannedBV !== "" && !bvValid}
          onChange={(e) => setPlannedBV(e.target.value)}
        />
      </Field>
      {plannedBV !== "" && !bvValid && (
        <div className="small bad-text" role="alert">
          Planned business value must be between 0 and 10.
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={committed} onChange={(e) => setCommitted(e.target.checked)} />
        Committed
      </label>
    </Modal>
  );
}

export function RiskDialog({ piName, onClose, onSave }: { piName: string; onClose: () => void; onSave: (d: RiskDraft) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState("");
  const [description, setDescription] = useState("");
  const [probability, setProbability] = useState<Probability>("Unspecified");
  const [impactLevel, setImpactLevel] = useState<ImpactLevel>("Unspecified");
  const { error, busy, submit } = useSubmit(onSave, "risk");
  return (
    <Modal
      title={`New risk · ${piName}`}
      onClose={onClose}
      footer={
        <Footer
          disabled={busy || !title.trim()}
          onClose={onClose}
          onCreate={() => submit({ title: title.trim(), owner: owner.trim(), description: description.trim(), probability, impactLevel })}
        />
      }
    >
      <ErrorBar message={error} />
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Owner">
        <input value={owner} onChange={(e) => setOwner(e.target.value)} />
      </Field>
      <Field label="Probability">
        <select value={probability} onChange={(e) => setProbability(e.target.value as Probability)}>
          {PROBABILITIES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </Field>
      <Field label="Impact">
        <select value={impactLevel} onChange={(e) => setImpactLevel(e.target.value as ImpactLevel)}>
          {IMPACTS.map((i) => (
            <option key={i}>{i}</option>
          ))}
        </select>
      </Field>
      <Field label="Description">
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </Modal>
  );
}
