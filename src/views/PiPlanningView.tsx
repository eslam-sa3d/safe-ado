import { useEffect, useRef, useState } from "react";
import { inspectAdaptStore, newId, objectivesStore, planReviewsStore, risksStore, votesStore } from "../api/data";
import { LEVEL_COLOR, scopeAreas, subtreeIds } from "../api/org";
import {
  addVote,
  combineCounts,
  ConfidenceVote,
  confidenceTone,
  distribution,
  emptyReview,
  emptyVote,
  FIST_LABEL,
  FIST_VALUES,
  IMPROVEMENT_STATUSES,
  improvementCounts,
  ImprovementItem,
  ImprovementStatus,
  inPi,
  isLowConfidence,
  normalizeCounts,
  planningId,
  PlanReview,
  REVIEW_KINDS,
  REVIEW_STATUSES,
  ReviewKind,
  reviewRollup,
  ReviewStatus,
  statusSlug,
  voteAverage,
  voteTotal,
} from "../api/planning";
import { LEVEL_LABEL, OrgNode, ProgramIncrement } from "../api/types";
import { createWorkItem, openWorkItem } from "../api/wit";
import { Empty, ErrorBar, fmtDate, Icon, Info, Progress, Spinner, useAsync } from "../components/common";
import { useCan, useSafe } from "../components/context";
import { predictability } from "./ObjectivesView";

interface Store<T> {
  list: () => Promise<T[]>;
  save: (doc: T) => Promise<T>;
  remove: (id: string) => Promise<void>;
}

/**
 * Loads one document collection and serialises writes to it: each update is applied to the latest
 * saved document (fresh etag), so rapid clicks (e.g. several anonymous votes) never conflict.
 */
function useDocs<T extends { id: string; __etag?: number }>(store: Store<T>, what: string, onError: (msg: string) => void) {
  const { data, loading, error, setData } = useAsync(() => store.list(), []);
  const latest = useRef<T[] | undefined>(data);
  latest.current = data;
  const queue = useRef<Promise<void>>(Promise.resolve());

  const update = (id: string, fn: (prev: T | undefined) => T) => {
    queue.current = queue.current.then(async () => {
      const prev = latest.current?.find((d) => d.id === id);
      try {
        const saved = await store.save({ ...fn(prev), __etag: prev?.__etag });
        latest.current = [...(latest.current ?? []).filter((d) => d.id !== id), saved];
        setData(latest.current);
      } catch (e: any) {
        onError(`Could not save ${what}: ${e.message}`);
      }
    });
    return queue.current;
  };
  const remove = (id: string) => {
    queue.current = queue.current.then(async () => {
      try {
        await store.remove(id);
        latest.current = (latest.current ?? []).filter((d) => d.id !== id);
        setData(latest.current);
      } catch (e: any) {
        onError(`Could not delete ${what}: ${e.message}`);
      }
    });
    return queue.current;
  };
  return { data, loading, error, update, remove };
}

/** PI Planning event: plan reviews, confidence vote, PI summary and Inspect & Adapt for an ART / Solution. */
export function PiPlanningView() {
  const { node, pi } = useSafe();
  if (!pi) {
    return (
      <Empty title="PI Planning">
        <p className="muted">Select a Program Increment to run its planning event, confidence vote and Inspect &amp; Adapt.</p>
      </Empty>
    );
  }
  return <PiPlanning key={`${node.id}|${pi.identifier}`} node={node} pi={pi} />;
}

function PiPlanning({ node, pi }: { node: OrgNode; pi: ProgramIncrement }) {
  const can = useCan();
  const readOnly = !can.plan;
  const [error, setError] = useState<string>();
  const reviews = useDocs(planReviewsStore, "plan review", setError);
  const votes = useDocs(votesStore, "confidence vote", setError);
  const improvements = useDocs(inspectAdaptStore, "improvement", setError);
  const objectives = useAsync(() => objectivesStore.list(), []);
  const risks = useAsync(() => risksStore.list(), []);

  const loads = [reviews, votes, improvements, objectives, risks];
  if (loads.some((l) => l.loading && !l.data)) return <Spinner />;
  const loadError = loads.map((l) => l.error).find(Boolean);

  const units: OrgNode[] = [node, ...node.children];
  /** The selected node's own documents, or a child's whole subtree (like the Objectives view). */
  const unitScope = (u: OrgNode) => (u.id === node.id ? new Set([u.id]) : subtreeIds(u));
  const scope = subtreeIds(node);
  const piObjectives = (objectives.data ?? []).filter((o) => inPi(o, pi) && scope.has(o.nodeId));
  const piRisks = (risks.data ?? []).filter((r) => inPi(r, pi) && scope.has(r.nodeId));
  const reviewOf = (u: OrgNode) => reviews.data?.find((r) => r.id === planningId(u.id, pi));
  const voteOf = (u: OrgNode) => votes.data?.find((v) => v.id === planningId(u.id, pi));
  const piImprovements = (improvements.data ?? [])
    .filter((i) => inPi(i, pi) && scope.has(i.nodeId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="pi-planning">
      <ErrorBar message={error ?? loadError} onClose={() => setError(undefined)} />
      {readOnly && (
        <div className="readonly-banner">
          <Info>You can view the PI Planning event but not change it (requires "Edit work items in this node").</Info>
        </div>
      )}
      <SummaryPanel node={node} units={units} unitScope={unitScope} objectives={piObjectives} risks={piRisks} />
      <ReviewPanel
        units={units}
        reviewOf={reviewOf}
        readOnly={readOnly}
        onChange={(u, kind, patch) =>
          reviews.update(planningId(u.id, pi), (prev) => {
            const base = prev ?? emptyReview(u.id, pi);
            return {
              ...base,
              piPath: pi.path,
              piId: pi.identifier,
              [kind]: { ...base[kind], ...patch },
              updatedAt: new Date().toISOString(),
            };
          })
        }
      />
      <VotePanel
        node={node}
        units={units}
        voteOf={voteOf}
        readOnly={readOnly}
        onChange={(u, fn) =>
          votes.update(planningId(u.id, pi), (prev) => {
            const base = prev ?? emptyVote(u.id, pi);
            return { ...base, piPath: pi.path, piId: pi.identifier, counts: fn(base.counts), votedAt: new Date().toISOString() };
          })
        }
      />
      <InspectAdaptPanel
        node={node}
        pi={pi}
        units={units}
        unitScope={unitScope}
        objectives={piObjectives}
        items={piImprovements}
        readOnly={readOnly}
        onError={setError}
        onSave={(item) => improvements.update(item.id, (prev) => ({ ...item, __etag: prev?.__etag }))}
        onRemove={(item) => improvements.remove(item.id)}
      />
    </div>
  );
}

function UnitName({ unit }: { unit: OrgNode }) {
  return (
    <span className="pp-unit">
      <i className="level-square" style={{ background: LEVEL_COLOR[unit.level] }} />
      <span>{unit.name}</span>
      <span className="muted small">{LEVEL_LABEL[unit.level]}</span>
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className={"stat" + (tone ? " " + tone : "")}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// PI summary
// ---------------------------------------------------------------------------------------------

function SummaryPanel(props: {
  node: OrgNode;
  units: OrgNode[];
  unitScope: (u: OrgNode) => Set<string>;
  objectives: import("../api/types").PiObjective[];
  risks: import("../api/types").Risk[];
}) {
  const { openView } = useSafe();
  const row = (ids: Set<string>) => {
    const objs = props.objectives.filter((o) => ids.has(o.nodeId));
    const committed = objs.filter((o) => o.committed);
    const open = props.risks.filter((r) => ids.has(r.nodeId) && r.status !== "Resolved");
    return {
      objectives: objs.length,
      committed: committed.length,
      bv: committed.reduce((s, o) => s + (o.plannedBV || 0), 0),
      risks: open.length,
      unroamed: open.filter((r) => r.status === "Unroamed").length,
    };
  };
  const total = row(subtreeIds(props.node));
  return (
    <section className="panel" aria-label="PI summary">
      <div className="panel-header">
        <h3>PI summary</h3>
        <span className="spacer" />
        {openView && (
          <>
            <button className="btn" onClick={() => openView("objectives")}>
              PI Objectives
            </button>
            <button className="btn" onClick={() => openView("risks")}>
              ROAM risks
            </button>
          </>
        )}
      </div>
      <div className="summary-cards pad-x">
        <Stat label="Committed BV" value={total.bv} />
        <Stat label="Objectives" value={total.objectives} />
        <Stat label="Unresolved risks" value={total.risks} tone={total.unroamed > 0 ? "warn" : undefined} />
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Unit</th>
            <th>Objectives (committed)</th>
            <th>Committed BV</th>
            <th>Unresolved risks</th>
            <th>Unroamed</th>
          </tr>
        </thead>
        <tbody>
          {props.units.map((u) => {
            const r = row(props.unitScope(u));
            return (
              <tr key={u.id} aria-label={`${u.name} summary`}>
                <td>
                  <UnitName unit={u} />
                </td>
                <td>
                  {r.objectives} ({r.committed})
                </td>
                <td>{r.bv}</td>
                <td>{r.risks}</td>
                <td className={r.unroamed ? "pp-alert" : undefined}>{r.unroamed}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Plan review board
// ---------------------------------------------------------------------------------------------

function ReviewPanel(props: {
  units: OrgNode[];
  reviewOf: (u: OrgNode) => PlanReview | undefined;
  readOnly: boolean;
  onChange: (u: OrgNode, kind: ReviewKind, patch: Partial<{ status: ReviewStatus; notes: string }>) => void;
}) {
  const all = props.units.map(props.reviewOf);
  return (
    <section className="panel" aria-label="Plan review">
      <div className="panel-header">
        <h3>Plan review</h3>
        <span className="spacer" />
        {REVIEW_KINDS.map(({ kind, label }) => {
          const r = reviewRollup(all, kind);
          return (
            <span key={kind} className={"pp-status pp-" + statusSlug(r.status)} title={`${r.counts.Approved} of ${all.length} approved`}>
              {label}: {r.status}
            </span>
          );
        })}
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Unit</th>
            {REVIEW_KINDS.map(({ kind, label }) => (
              <th key={kind}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.units.map((u) => {
            const review = props.reviewOf(u);
            return (
              <tr key={u.id}>
                <td>
                  <UnitName unit={u} />
                </td>
                {REVIEW_KINDS.map(({ kind, label }) => {
                  const entry = review?.[kind] ?? { status: "Not started" as ReviewStatus, notes: "" };
                  return (
                    <td key={kind} className="pp-review-cell">
                      <select
                        aria-label={`${u.name} ${label} status`}
                        className={"pp-" + statusSlug(entry.status)}
                        value={entry.status}
                        disabled={props.readOnly}
                        onChange={(e) => props.onChange(u, kind, { status: e.target.value as ReviewStatus })}
                      >
                        {REVIEW_STATUSES.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                      <BlurInput
                        label={`${u.name} ${label} notes`}
                        placeholder="Notes"
                        value={entry.notes}
                        disabled={props.readOnly}
                        onCommit={(notes) => props.onChange(u, kind, { notes })}
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** Text input that keeps a local draft and commits it on blur when it changed. */
function BlurInput(props: { label: string; value: string; placeholder?: string; disabled?: boolean; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  return (
    <input
      className="cell-input"
      aria-label={props.label}
      placeholder={props.placeholder}
      value={draft}
      disabled={props.disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== props.value && props.onCommit(draft)}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Confidence vote (fist of five)
// ---------------------------------------------------------------------------------------------

function fmtAvg(avg: number | null): string {
  return avg === null ? "—" : avg.toFixed(1);
}

function VotePanel(props: {
  node: OrgNode;
  units: OrgNode[];
  voteOf: (u: OrgNode) => ConfidenceVote | undefined;
  readOnly: boolean;
  onChange: (u: OrgNode, fn: (counts: number[]) => number[]) => void;
}) {
  const { node } = props;
  const ownAvg = voteAverage(props.voteOf(node)?.counts);
  const children = props.units.filter((u) => u.id !== node.id);
  const combined = combineCounts(children.map((u) => props.voteOf(u)?.counts));
  const combinedAvg = voteAverage(combined);
  const low = [ownAvg, combinedAvg].some(isLowConfidence);
  const lowUnits = props.units.filter((u) => isLowConfidence(voteAverage(props.voteOf(u)?.counts)));

  return (
    <section className="panel" aria-label="Confidence vote">
      <div className="panel-header">
        <h3>Confidence vote</h3>
        <span className="muted small">Fist of five: 1 = no confidence … 5 = very high confidence</span>
      </div>
      <div className="summary-cards pad-x">
        <Stat label={`${node.name} vote`} value={fmtAvg(ownAvg)} tone={confidenceTone(ownAvg)} />
        {children.length > 0 && <Stat label="Teams combined" value={fmtAvg(combinedAvg)} tone={confidenceTone(combinedAvg)} />}
        <div className="pp-dist-wrap">
          <Distribution counts={children.length ? combined : normalizeCounts(props.voteOf(node)?.counts)} label="Combined distribution" />
        </div>
      </div>
      {(low || lowUnits.length > 0) && (
        <div className="pp-warning" role="status">
          <Icon name="Warning" /> Average confidence below 3
          {lowUnits.length > 0 && <> ({lowUnits.map((u) => u.name).join(", ")})</>}: SAFe recommends reworking the plan and voting
          again before committing.
        </div>
      )}
      <table className="grid">
        <thead>
          <tr>
            <th>Unit</th>
            <th>Add anonymous vote</th>
            <th>People per value (1–5)</th>
            <th>Votes</th>
            <th>Average</th>
            <th>Distribution</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.units.map((u) => (
            <VoteRow key={u.id} unit={u} vote={props.voteOf(u)} readOnly={props.readOnly} onChange={(fn) => props.onChange(u, fn)} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function VoteRow(props: { unit: OrgNode; vote?: ConfidenceVote; readOnly: boolean; onChange: (fn: (counts: number[]) => number[]) => void }) {
  const { unit, vote, readOnly } = props;
  const counts = normalizeCounts(vote?.counts);
  const avg = voteAverage(counts);
  const key = counts.join(",");
  const [draft, setDraft] = useState(counts.map(String));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(counts.map(String)), [key]);

  const commit = (i: number) => {
    const n = Math.max(0, Math.floor(Number(draft[i]) || 0));
    if (n === counts[i]) {
      setDraft(counts.map(String));
      return;
    }
    props.onChange((c) => c.map((x, j) => (j === i ? n : x)));
  };

  return (
    <tr className={isLowConfidence(avg) ? "pp-low" : undefined} aria-label={`${unit.name} vote`}>
      <td>
        <UnitName unit={unit} />
        {vote?.votedAt && <div className="muted small">Voted {fmtDate(vote.votedAt)}</div>}
      </td>
      <td>
        <div className="pp-fist">
          {FIST_VALUES.map((v) => (
            <button
              key={v}
              className={"pp-fist-btn pp-fist-" + v}
              title={FIST_LABEL[v]}
              aria-label={`Vote ${v} for ${unit.name}`}
              disabled={readOnly}
              onClick={() => props.onChange((c) => addVote(c, v))}
            >
              {v}
            </button>
          ))}
        </div>
      </td>
      <td>
        <div className="pp-counts">
          {FIST_VALUES.map((v, i) => (
            <input
              key={v}
              type="number"
              min={0}
              className="cell-input num"
              aria-label={`${unit.name} people voting ${v}`}
              value={draft[i]}
              disabled={readOnly}
              onChange={(e) => setDraft(draft.map((d, j) => (j === i ? e.target.value : d)))}
              onBlur={() => commit(i)}
            />
          ))}
        </div>
      </td>
      <td>{voteTotal(counts)}</td>
      <td className={"pp-avg " + (confidenceTone(avg) ?? "")}>{fmtAvg(avg)}</td>
      <td>
        <Distribution counts={counts} label={`${unit.name} distribution`} />
      </td>
      <td>
        {!readOnly && voteTotal(counts) > 0 && (
          <button
            className="link danger"
            onClick={() => window.confirm(`Clear the confidence vote of ${unit.name}?`) && props.onChange(() => normalizeCounts([]))}
          >
            Clear
          </button>
        )}
      </td>
    </tr>
  );
}

function Distribution({ counts, label }: { counts: number[]; label: string }) {
  return (
    <div className="pp-dist" role="group" aria-label={label}>
      {distribution(counts).map((b) => (
        <div key={b.value} className="pp-dist-row" title={`${b.value}: ${b.count} (${b.pct}%)`}>
          <span className="pp-dist-label">{b.value}</span>
          <span className="pp-dist-track">
            <span className={"pp-dist-bar pp-fist-" + b.value} style={{ width: `${b.pct}%` }} />
          </span>
          <span className="pp-dist-count">{b.count}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Inspect & Adapt
// ---------------------------------------------------------------------------------------------

function predictabilityTone(pct: number | null): string | undefined {
  if (pct === null) return undefined;
  return pct >= 80 ? "good" : pct >= 60 ? "warn" : "bad";
}

function InspectAdaptPanel(props: {
  node: OrgNode;
  pi: ProgramIncrement;
  units: OrgNode[];
  unitScope: (u: OrgNode) => Set<string>;
  objectives: import("../api/types").PiObjective[];
  items: ImprovementItem[];
  readOnly: boolean;
  onError: (msg: string) => void;
  onSave: (item: ImprovementItem) => Promise<void>;
  onRemove: (item: ImprovementItem) => Promise<void>;
}) {
  const { config } = useSafe();
  const { node, pi } = props;
  const [creating, setCreating] = useState<string>();
  const total = predictability(props.objectives);
  const counts = improvementCounts(props.items);

  const add = () =>
    props.onSave({
      id: newId(),
      nodeId: node.id,
      piPath: pi.path,
      piId: pi.identifier,
      problem: "",
      rootCause: "",
      improvement: "",
      owner: "",
      status: "Proposed",
      createdAt: new Date().toISOString(),
    });

  const createBacklogItem = async (item: ImprovementItem) => {
    const type = config.types.story || config.types.feature;
    const area = node.areaPath ?? scopeAreas(node)[0];
    setCreating(item.id);
    try {
      const wi = await createWorkItem(type, {
        "System.Title": item.improvement.trim() || item.problem.trim(),
        ...(area ? { "System.AreaPath": area } : {}),
        "System.Tags": "Improvement; I&A",
      });
      await props.onSave({ ...item, workItemId: wi.id });
    } catch (e: any) {
      props.onError(`Could not create backlog item: ${e.message}`);
    } finally {
      setCreating(undefined);
    }
  };

  return (
    <section className="panel" aria-label="Inspect & Adapt">
      <div className="panel-header">
        <h3>Inspect &amp; Adapt</h3>
        <span className="muted small">PI System Demo, quantitative measurement and problem-solving workshop</span>
      </div>
      <h4 className="pad-x">PI predictability</h4>
      <table className="grid">
        <thead>
          <tr>
            <th>Unit</th>
            <th>Planned BV (committed)</th>
            <th>Actual BV</th>
            <th>Predictability</th>
          </tr>
        </thead>
        <tbody>
          {props.units.map((u) => {
            const ids = props.unitScope(u);
            const p = predictability(props.objectives.filter((o) => ids.has(o.nodeId)));
            return (
              <tr key={u.id} aria-label={`${u.name} predictability`}>
                <td>
                  <UnitName unit={u} />
                </td>
                <td>{p.planned}</td>
                <td>{p.actual}</td>
                <td className={"pp-pct " + (predictabilityTone(p.pct) ?? "")}>
                  <div style={{ width: 180 }}>
                    <Progress done={p.actual} total={p.planned} label={p.pct === null ? "—" : `${p.pct}%`} />
                  </div>
                </td>
              </tr>
            );
          })}
          <tr className="pp-total" aria-label="Total predictability">
            <td>
              <strong>Total</strong>
            </td>
            <td>{total.planned}</td>
            <td>{total.actual}</td>
            <td className={"pp-pct " + (predictabilityTone(total.pct) ?? "")}>{total.pct === null ? "—" : `${total.pct}%`}</td>
          </tr>
        </tbody>
      </table>
      <div className="panel-header">
        <h4>Problem-solving workshop</h4>
        <span className="muted small">
          {IMPROVEMENT_STATUSES.map((s) => `${counts[s]} ${s.toLowerCase()}`).join(" · ")}
        </span>
        <span className="spacer" />
        {!props.readOnly && (
          <button className="btn" onClick={add}>
            <Icon name="Add" /> New improvement
          </button>
        )}
      </div>
      {props.items.length === 0 ? (
        <p className="muted pad">No improvement items for this PI yet.</p>
      ) : (
        <table className="grid pp-improvements">
          <thead>
            <tr>
              <th>Problem</th>
              <th>Root cause</th>
              <th>Improvement</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Backlog item</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.items.map((item) => (
              <ImprovementRow
                key={item.id}
                item={item}
                readOnly={props.readOnly}
                creating={creating === item.id}
                onSave={props.onSave}
                onCreate={() => createBacklogItem(item)}
                onRemove={() => window.confirm("Delete this improvement item?") && props.onRemove(item)}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ImprovementRow(props: {
  item: ImprovementItem;
  readOnly: boolean;
  creating: boolean;
  onSave: (item: ImprovementItem) => void;
  onCreate: () => void;
  onRemove: () => void;
}) {
  const { item, readOnly } = props;
  const text = (key: "problem" | "rootCause" | "improvement" | "owner", label: string) => (
    <td>
      <BlurInput label={label} placeholder={label} value={item[key]} disabled={readOnly} onCommit={(v) => props.onSave({ ...item, [key]: v })} />
    </td>
  );
  const canCreate = !readOnly && !item.workItemId && !!(item.improvement.trim() || item.problem.trim());
  return (
    <tr>
      {text("problem", "Problem")}
      {text("rootCause", "Root cause")}
      {text("improvement", "Improvement")}
      {text("owner", "Owner")}
      <td>
        <select
          aria-label="Status"
          value={item.status}
          disabled={readOnly}
          onChange={(e) => props.onSave({ ...item, status: e.target.value as ImprovementStatus })}
        >
          {IMPROVEMENT_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </td>
      <td>
        {item.workItemId ? (
          <button className="link" onClick={() => openWorkItem(item.workItemId!)}>
            #{item.workItemId}
          </button>
        ) : (
          !readOnly && (
            <button className="btn" disabled={!canCreate || props.creating} onClick={props.onCreate}>
              {props.creating ? "Creating…" : "Create backlog item"}
            </button>
          )
        )}
      </td>
      <td>
        {!readOnly && (
          <button className="link danger" aria-label="Delete improvement" onClick={props.onRemove}>
            Delete
          </button>
        )}
      </td>
    </tr>
  );
}
