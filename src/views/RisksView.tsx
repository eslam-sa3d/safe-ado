import { useState } from "react";
import { newId, risksStore } from "../api/data";
import { flatten, subtreeIds } from "../api/org";
import { exposure, Exposure, EXPOSURE_COLOR, EXPOSURE_RANK, ImpactLevel, IMPACTS, PROBABILITIES, Probability } from "../api/risk";
import { LEVEL_LABEL, Risk, ROAM_STATUSES, RoamStatus } from "../api/types";
import { openWorkItem } from "../api/wit";
import { ErrorBar, Field, Modal, Spinner, useAsync, Icon } from "../components/common";
import { useSafe } from "../components/context";

const ROAM_HINT: Record<RoamStatus, string> = {
  Unroamed: "Raised, not yet discussed",
  Resolved: "No longer a concern",
  Owned: "Someone owns follow-up",
  Accepted: "Nothing more can be done",
  Mitigated: "Plan in place to reduce impact",
};

export const riskExposure = (r: Risk) => exposure(r.probability, r.impactLevel);
export const residualExposure = (r: Risk) => exposure(r.residualProbability, r.residualImpact);

/** Highest exposure first, then highest residual exposure, then title. */
export function byExposure(a: Risk, b: Risk): number {
  return (
    EXPOSURE_RANK[riskExposure(b)] - EXPOSURE_RANK[riskExposure(a)] ||
    EXPOSURE_RANK[residualExposure(b)] - EXPOSURE_RANK[residualExposure(a)] ||
    a.title.localeCompare(b.title)
  );
}

function ExposureChip({ label, value }: { label: string; value: Exposure }) {
  return (
    <span className="exposure-chip" style={{ background: EXPOSURE_COLOR[value] }} title={`${label}: ${value}`}>
      {label === "Exposure" ? "" : "Residual "}
      {value}
    </span>
  );
}

/** ROAM board for PI risks, scoped to the selected node and its descendants. */
export function RisksView() {
  const { node, pi, config } = useSafe();
  const [allPis, setAllPis] = useState(false);
  const [editing, setEditing] = useState<Risk | null>(null);
  const [error, setError] = useState<string>();
  const [over, setOver] = useState<RoamStatus | null>(null);
  const [sortByExposure, setSortByExposure] = useState(false);
  const { data, loading, error: loadError, setData } = useAsync(() => risksStore.list(), []);

  if (loading && !data) return <Spinner />;
  const scope = subtreeIds(node);
  const risks = (data ?? []).filter((r) => scope.has(r.nodeId) && (allPis || r.piPath === pi?.path));
  const nodeName = new Map(flatten(config.root).map((n) => [n.id, n.name]));

  const save = async (r: Risk) => {
    try {
      const saved = await risksStore.save(r);
      setData((prev) => [...(prev ?? []).filter((x) => x.id !== saved.id), saved]);
      setEditing(null);
    } catch (e: any) {
      setError(`Could not save risk: ${e.message}`);
    }
  };
  const remove = async (r: Risk) => {
    if (!window.confirm(`Delete risk "${r.title}"?`)) return;
    try {
      await risksStore.remove(r.id);
      setData((prev) => (prev ?? []).filter((x) => x.id !== r.id));
      setEditing(null);
    } catch (e: any) {
      setError(`Could not delete risk: ${e.message}`);
    }
  };

  return (
    <div>
      <div className="toolbar">
        <strong>{risks.length} risks</strong>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={sortByExposure} onChange={(e) => setSortByExposure(e.target.checked)} /> Sort by exposure
        </label>
        <label className="check">
          <input type="checkbox" checked={allPis} onChange={(e) => setAllPis(e.target.checked)} /> All PIs
        </label>
        <button
          className="btn primary"
          disabled={!pi}
          onClick={() =>
            setEditing({
              id: newId(),
              piPath: pi!.path,
              nodeId: node.id,
              title: "",
              description: "",
              owner: "",
              impact: "Medium",
              status: "Unroamed",
              createdAt: new Date().toISOString(),
            })
          }
        >
          <Icon name="Add" /> New risk
        </button>
      </div>
      <ErrorBar message={loadError ?? error} onClose={() => setError(undefined)} />
      <div className="roam">
        {ROAM_STATUSES.map((status) => {
          const col = risks.filter((r) => r.status === status);
          if (sortByExposure) col.sort(byExposure);
          return (
            <div
              key={status}
              role="group"
              aria-label={`${status} risks`}
              className={"roam-col" + (over === status ? " drop-over" : "")}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(status);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const r = risks.find((x) => x.id === e.dataTransfer.getData("text/plain"));
                if (r && r.status !== status) save({ ...r, status });
              }}
            >
              <div className={"roam-header roam-" + status.toLowerCase()}>
                <span>{status}</span>
                <span className="count">{col.length}</span>
              </div>
              <div className="muted small pad-x">{ROAM_HINT[status]}</div>
              {col.map((r) => (
                <div
                  key={r.id}
                  className={"card risk impact-" + r.impact.toLowerCase()}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", r.id)}
                  onClick={() => setEditing(r)}
                >
                  <div className="card-title">{r.title}</div>
                  <div className="card-meta">
                    <ExposureChip label="Exposure" value={riskExposure(r)} />
                    <ExposureChip label="Residual exposure" value={residualExposure(r)} />
                    <span className="pill" title="Priority">
                      {r.impact}
                    </span>
                    <span className="muted">{nodeName.get(r.nodeId)}</span>
                    {r.owner && <span className="muted">· {r.owner}</span>}
                    {r.workItemId ? (
                      <button
                        className="link small"
                        onClick={(e) => {
                          e.stopPropagation();
                          openWorkItem(r.workItemId!);
                        }}
                      >
                        #{r.workItemId}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {editing && (
        <RiskDialog
          risk={editing}
          isNew={!(data ?? []).some((r) => r.id === editing.id)}
          scopeNodes={flatten(node)}
          onClose={() => setEditing(null)}
          onSave={save}
          onDelete={remove}
        />
      )}
    </div>
  );
}

function RiskDialog(props: {
  risk: Risk;
  isNew: boolean;
  scopeNodes: ReturnType<typeof flatten>;
  onClose: () => void;
  onSave: (r: Risk) => void;
  onDelete: (r: Risk) => void;
}) {
  const [r, setR] = useState(props.risk);
  const set = <K extends keyof Risk>(k: K, v: Risk[K]) => setR({ ...r, [k]: v });
  return (
    <Modal
      title={props.isNew ? "New risk" : "Edit risk"}
      onClose={props.onClose}
      footer={
        <>
          {!props.isNew && (
            <button className="btn danger" onClick={() => props.onDelete(props.risk)}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!r.title.trim()} onClick={() => props.onSave(r)}>
            Save
          </button>
        </>
      }
    >
      <Field label="Title">
        <input autoFocus value={r.title} onChange={(e) => set("title", e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea rows={4} value={r.description} onChange={(e) => set("description", e.target.value)} />
      </Field>
      <div className="field-row">
        <Field label="ROAM status">
          <select value={r.status} onChange={(e) => set("status", e.target.value as RoamStatus)}>
            {ROAM_STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select value={r.impact} onChange={(e) => set("impact", e.target.value as Risk["impact"])}>
            <option>Low</option>
            <option>Medium</option>
            <option>High</option>
          </select>
        </Field>
      </div>
      <fieldset className="risk-assessment">
        <legend>Assessment</legend>
        <div className="field-row">
          <Field label="Probability">
            <select value={r.probability ?? "Unspecified"} onChange={(e) => set("probability", e.target.value as Probability)}>
              {PROBABILITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="Impact">
            <select value={r.impactLevel ?? "Unspecified"} onChange={(e) => set("impactLevel", e.target.value as ImpactLevel)}>
              {IMPACTS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <div className="field">
            <span className="field-label">Exposure</span>
            <span data-testid="exposure">
              <ExposureChip label="Exposure" value={riskExposure(r)} />
            </span>
          </div>
        </div>
        <div className="field-row">
          <Field label="Residual probability">
            <select
              value={r.residualProbability ?? "Unspecified"}
              onChange={(e) => set("residualProbability", e.target.value as Probability)}
            >
              {PROBABILITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="Residual impact">
            <select value={r.residualImpact ?? "Unspecified"} onChange={(e) => set("residualImpact", e.target.value as ImpactLevel)}>
              {IMPACTS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <div className="field">
            <span className="field-label">Residual exposure</span>
            <span data-testid="residual-exposure">
              <ExposureChip label="Residual exposure" value={residualExposure(r)} />
            </span>
          </div>
        </div>
      </fieldset>
      <div className="field-row">
        <Field label="Raised by / belongs to">
          <select value={r.nodeId} onChange={(e) => set("nodeId", e.target.value)}>
            {props.scopeNodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({LEVEL_LABEL[n.level]})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Owner">
          <input value={r.owner} onChange={(e) => set("owner", e.target.value)} />
        </Field>
      </div>
      <Field label="Linked work item ID (optional)">
        <input
          type="number"
          value={r.workItemId ?? ""}
          onChange={(e) => set("workItemId", e.target.value ? Number(e.target.value) : undefined)}
        />
      </Field>
    </Modal>
  );
}
