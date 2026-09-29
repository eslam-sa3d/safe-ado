import { useEffect, useState } from "react";
import { getUserValue, milestonesStore, newId, setUserValue } from "../../api/data";
import { findNode, pathTo } from "../../api/org";
import { dayIso, milestonesInWindow, relativeDays, toDay } from "../../api/reports";
import { Milestone } from "../../api/types";
import { ErrorBar, Field, fmtDate, Modal, Icon } from "../../components/common";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { SelectPi, Widget } from "./Widget";

const PREF = "milestonesIncludeParents";

/**
 * Milestone Overview: the unit's milestones (optionally its parents' too) in the PI, or
 * from 30 days ago to 5 years ahead on the portfolio.
 */
export function MilestonesWidget({ data, today }: { data: ReportData; today: number }) {
  const { config, node, pi } = useSafe();
  const [includeParents, setIncludeParents] = useState(false);
  const [created, setCreated] = useState<Milestone[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let live = true;
    getUserValue<boolean>(PREF, false)
      .then((v) => live && setIncludeParents(!!v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const toggle = (v: boolean) => {
    setIncludeParents(v);
    setUserValue(PREF, v).catch(() => undefined);
  };

  const portfolio = node.level === "portfolio";
  const range: [number, number] | null = portfolio
    ? [today - 30, today + 5 * 365]
    : pi?.start && pi.finish
    ? [toDay(pi.start), toDay(pi.finish)]
    : null;
  const ids = new Set(includeParents ? pathTo(config.root, node.id).map((n) => n.id) : [node.id]);
  const all = [...data.milestones.filter((m) => !created.some((c) => c.id === m.id)), ...created];
  const list = range ? milestonesInWindow(all, ids, range[0], range[1]) : [];
  const nameOf = (id: string) => findNode(config.root, id)?.name;

  const actions = (
    <>
      <label className="check small">
        <input type="checkbox" checked={includeParents} onChange={(e) => toggle(e.target.checked)} />
        Include parent levels
      </label>
      <button className="btn" aria-label="Add milestone" onClick={() => setAdding(true)}>
        +
      </button>
    </>
  );

  return (
    <Widget title="Milestone Overview" size="medium" actions={actions}>
      {!portfolio && !pi ? (
        <SelectPi />
      ) : !range ? (
        <p className="muted widget-hint">{pi!.name} has no start and finish dates.</p>
      ) : list.length === 0 ? (
        <p className="muted widget-hint">No milestones {portfolio ? "in this period" : `in ${pi!.name}`}.</p>
      ) : (
        <ul className="milestone-list">
          {list.map((m) => (
            <li key={m.id} className={toDay(m.date) < today ? "past" : undefined}>
              <span className="milestone-diamond" aria-hidden="true">
                <Icon name="DiamondSolid" className="small" />
              </span>
              <span className="milestone-title" title={m.description}>
                {m.title}
              </span>
              {m.nodeId !== node.id && <span className="pill">{nameOf(m.nodeId)}</span>}
              <span className="spacer" />
              <span className="small">{fmtDate(m.date)}</span>
              <span className="muted small milestone-rel">{relativeDays(m.date, today)}</span>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <MilestoneDialog
          initialDate={dayIso(pi?.start && !portfolio && toDay(pi.start) > today ? toDay(pi.start) : today)}
          onClose={() => setAdding(false)}
          onSave={async (draft) => {
            const saved = await milestonesStore.save({ id: newId(), nodeId: node.id, ...draft });
            setCreated((prev) => [...prev, saved]);
            setAdding(false);
          }}
        />
      )}
    </Widget>
  );
}

function MilestoneDialog({
  initialDate,
  onClose,
  onSave,
}: {
  initialDate: string;
  onClose: () => void;
  onSave: (m: { title: string; date: string; description?: string }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(initialDate);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await onSave({ title: title.trim(), date, description: description.trim() || undefined });
    } catch (e: any) {
      setError(`Could not save milestone: ${e?.message ?? e}`);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New milestone"
      onClose={onClose}
      footer={
        <>
          <button className="btn primary" disabled={busy || !title.trim() || !date} onClick={submit}>
            Create
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <ErrorBar message={error} />
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Date">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </Modal>
  );
}
