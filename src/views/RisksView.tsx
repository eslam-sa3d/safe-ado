import { useState } from "react";
import { newId, risksStore } from "../api/data";
import { flatten, subtreeIds } from "../api/org";
import { exposure, Exposure, EXPOSURE_COLOR, EXPOSURE_RANK, ImpactLevel, IMPACTS, PROBABILITIES, Probability } from "../api/risk";
import { LEVEL_LABEL, Risk, ROAM_STATUSES, RoamStatus } from "../api/types";
import { openWorkItem } from "../api/wit";
import { stampText } from "../api/audit";
import { ErrorBar, Field, Info, Modal, Spinner, useAsync, Icon } from "../components/common";
import { useDataCan, useSafe } from "../components/context";
import { HistoryButton } from "../components/History";
import { PermissionNotice } from "../components/PermissionNotice";

const ROAM_HINT: Record<RoamStatus, string> = {
  Unroamed: "Raised, not yet discussed",
  Resolved: "No longer a concern",
  Owned: "Someone owns follow-up",
  Accepted: "Nothing more can be done",
  Mitigated: "Plan in place to reduce impact",
};

/** Every work item a risk links to: the list plus the legacy single `workItemId`, without duplicates. */
export function riskWorkItemIds(r: Risk): number[] {
  return Array.from(new Set([...(r.workItemIds ?? []), ...(r.workItemId ? [r.workItemId] : [])]));
}

/** Parses "12, 34 56" into positive integer ids (duplicates dropped). */
export function parseIds(text: string): number[] {
  return Array.from(
    new Set(
      text
        .split(/[,\s;]+/)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  );
}

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
      {label === "Exposure" ? "Exposure: " : "Residual: "}
      {value.charAt(0) + value.slice(1).toLowerCase()}
    </span>
  );
}

/** ROAM board for PI risks, scoped to the selected node and its descendants. */
export function RisksView() {
  const { node, pi, config } = useSafe();
  // Risks live only in extension data: an unverified permission means read-only.
  const canPlan = useDataCan().plan;
  const [allPis, setAllPis] = useState(false);
  const [editing, setEditing] = useState<Risk | null>(null);
  const [error, setError] = useState<string>();
  const [over, setOver] = useState<RoamStatus | null>(null);
  const [sortByExposure, setSortByExposure] = useState(false);
  const { data, loading, error: loadError, setData } = useAsync(() => risksStore.list(), []);

  if (loading && !data) return <Spinner />;
  const scope = subtreeIds(node);
  const inPi = (r: Risk) => !!pi && ((!!r.piId && r.piId === pi.identifier) || r.piPath === pi.path);
  const risks = (data ?? []).filter((r) => scope.has(r.nodeId) && (allPis || inPi(r)));
  const nodeName = new Map(flatten(config.root).map((n) => [n.id, n.name]));

  const save = async (r: Risk) => {
    try {
      // Record the PI's stable id with the risk so it survives PI renames.
      const saved = await risksStore.save(inPi(r) && !r.piId ? { ...r, piId: pi!.identifier } : r);
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
        {canPlan && (
        <button
          className="btn primary"
          disabled={!pi}
          onClick={() =>
            setEditing({
              id: newId(),
              piPath: pi!.path,
              piId: pi!.identifier,
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
        )}
      </div>
      <ErrorBar message={loadError ?? error} onClose={() => setError(undefined)} />
      <PermissionNotice needs="plan" />
      {!canPlan && <Info>You have read-only access: risks can be viewed but not changed.</Info>}
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
                if (!canPlan) return;
                e.preventDefault();
                setOver(status);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                if (!canPlan) return;
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
                  draggable={canPlan}
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", r.id)}
                  onClick={() => setEditing(r)}
                >
                  <div className="card-title">{r.title}</div>
                  <div className="card-meta">
                    <ExposureChip label="Exposure" value={riskExposure(r)} />
                    <ExposureChip label="Residual exposure" value={residualExposure(r)} />
                    <span className="pill" title="Priority">
                      Priority: {r.impact}
                    </span>
                    <span className="muted">{nodeName.get(r.nodeId)}</span>
                    {r.owner && <span className="muted">· {r.owner}</span>}
                    {riskWorkItemIds(r).map((id) => (
                      <button
                        key={id}
                        className="link small"
                        onClick={(e) => {
                          e.stopPropagation();
                          openWorkItem(id);
                        }}
                      >
                        #{id}
                      </button>
                    ))}
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
          readOnly={!canPlan}
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
  readOnly?: boolean;
  scopeNodes: ReturnType<typeof flatten>;
  onClose: () => void;
  onSave: (r: Risk) => void;
  onDelete: (r: Risk) => void;
}) {
  const [r, setR] = useState(props.risk);
  const [links, setLinks] = useState(riskWorkItemIds(props.risk).join(", "));
  const set = <K extends keyof Risk>(k: K, v: Risk[K]) => setR({ ...r, [k]: v });
  const readOnly = !!props.readOnly;
  const submit = () => {
    const ids = parseIds(links);
    // workItemId mirrors the first link so older readers still find one.
    props.onSave({ ...r, workItemIds: ids.length ? ids : undefined, workItemId: ids[0] });
  };
  return (
    <Modal
      title={readOnly ? "Risk details" : props.isNew ? "New risk" : "Edit risk"}
      onClose={props.onClose}
      footer={
        readOnly ? (
          <>
            <HistoryButton collection="risks" docId={props.risk.id} title={props.risk.title} />
            <span className="spacer" />
            <button className="btn" onClick={props.onClose}>
              Close
            </button>
          </>
        ) : (
        <>
          {!props.isNew && (
            <button className="btn danger" onClick={() => props.onDelete(props.risk)}>
              Delete
            </button>
          )}
          {!props.isNew && <HistoryButton collection="risks" docId={props.risk.id} title={props.risk.title} />}
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!r.title.trim()} onClick={submit}>
            Save
          </button>
        </>
        )
      }
    >
      <fieldset className="plain-fieldset" disabled={readOnly}>
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
      <Field label="Linked work item IDs (optional)">
        <input value={links} placeholder="e.g. 123, 456" onChange={(e) => setLinks(e.target.value)} />
      </Field>
      </fieldset>
      {(props.risk.createdBy || props.risk.modifiedBy) && (
        <p className="muted small risk-stamps">
          {props.risk.createdBy && <>Raised by {stampText(props.risk.createdBy, props.risk.createdAt)}. </>}
          {props.risk.modifiedBy && <>Last changed by {stampText(props.risk.modifiedBy, props.risk.modifiedAt)}.</>}
        </p>
      )}
    </Modal>
  );
}
