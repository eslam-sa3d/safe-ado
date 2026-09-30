import { useState } from "react";
import { newId, objectivesStore } from "../api/data";
import { flatten, LEVEL_COLOR, parentOf, subtreeIds } from "../api/org";
import { LEVEL_LABEL, OrgNode, PiObjective } from "../api/types";
import { openWorkItem } from "../api/wit";
import { ErrorBar, Info, Progress, Spinner, useAsync, Icon } from "../components/common";
import { useCan, useSafe } from "../components/context";

/** SAFe predictability: actual BV of all objectives / planned BV of committed objectives. */
export function predictability(objectives: PiObjective[]): { planned: number; actual: number; pct: number | null } {
  const planned = objectives.filter((o) => o.committed).reduce((s, o) => s + (o.plannedBV || 0), 0);
  const actual = objectives.reduce((s, o) => s + (o.actualBV ?? 0), 0);
  return { planned, actual, pct: planned > 0 ? Math.round((actual / planned) * 100) : null };
}

export function ObjectivesView() {
  const { node, pi, config } = useSafe();
  const canPlan = useCan().plan;
  const [error, setError] = useState<string>();
  const { data, loading, error: loadError, setData } = useAsync(() => objectivesStore.list(), []);

  if (!pi) return null;
  if (loading && !data) return <Spinner />;
  // Match by the PI's stable id first (survives renames), else by path for older documents.
  const all = (data ?? []).filter((o) => (!!o.piId && o.piId === pi.identifier) || o.piPath === pi.path);
  const nodes = new Map(flatten(config.root).map((n) => [n.id, n]));

  const save = async (o: PiObjective) => {
    try {
      const saved = await objectivesStore.save({ ...o, piId: pi.identifier, piPath: pi.path });
      setData((prev) => [...(prev ?? []).filter((x) => x.id !== saved.id), saved]);
    } catch (e: any) {
      setError(`Could not save objective: ${e.message}`);
    }
  };
  const remove = async (o: PiObjective) => {
    if (!window.confirm(`Delete objective "${o.title}"?`)) return;
    try {
      await objectivesStore.remove(o.id);
      setData((prev) => (prev ?? []).filter((x) => x.id !== o.id));
    } catch (e: any) {
      setError(`Could not delete objective: ${e.message}`);
    }
  };

  // The selected node gets its own section, followed by each child (teams of an ART, ARTs of a solution).
  const groups: OrgNode[] = [node, ...node.children];
  const scope = subtreeIds(node);
  const total = predictability(all.filter((o) => scope.has(o.nodeId)));

  return (
    <div className="objectives-view">
      <ErrorBar message={loadError ?? error} onClose={() => setError(undefined)} />
      {!canPlan && <Info>You have read-only access: objectives can be viewed but not changed.</Info>}
      <div className="summary-cards">
        <Stat label="Planned BV (committed)" value={total.planned} />
        <Stat label="Actual BV" value={total.actual} />
        <Stat label="Predictability" value={total.pct === null ? "—" : `${total.pct}%`} tone={tone(total.pct)} />
        <p className="muted small">
          SAFe target range is 80–100%. Uncommitted (stretch) objectives add to actual BV but not to planned BV.
        </p>
      </div>
      {groups.map((g) => (
        <ObjectiveGroup
          key={g.id}
          node={g}
          objectives={all.filter((o) => (g.id === node.id ? o.nodeId === g.id : subtreeIds(g).has(o.nodeId)))}
          editableNodeId={canPlan ? g.id : undefined}
          all={all}
          nodes={nodes}
          parentOf={(nodeId) => parentOf(config.root, nodeId)}
          onSave={save}
          onRemove={remove}
          onAdd={() =>
            save({
              id: newId(),
              piPath: pi.path,
              piId: pi.identifier,
              nodeId: g.id,
              title: "New objective",
              committed: true,
              plannedBV: 5,
              actualBV: null,
              featureIds: [],
            })
          }
        />
      ))}
    </div>
  );
}

function tone(pct: number | null): string | undefined {
  if (pct === null) return undefined;
  return pct >= 80 ? "good" : pct >= 60 ? "warn" : "bad";
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className={"stat" + (tone ? " " + tone : "")}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function ObjectiveGroup(props: {
  node: OrgNode;
  objectives: PiObjective[];
  /** Unit whose objectives can be edited here; none when the user is read-only. */
  editableNodeId?: string;
  /** Every objective of the PI (to offer parent objectives and count children). */
  all: PiObjective[];
  nodes: Map<string, OrgNode>;
  parentOf: (nodeId: string) => OrgNode | undefined;
  onSave: (o: PiObjective) => void;
  onRemove: (o: PiObjective) => void;
  onAdd: () => void;
}) {
  const { node, objectives } = props;
  const p = predictability(objectives);
  const sorted = [...objectives].sort((a, b) => Number(b.committed) - Number(a.committed) || b.plannedBV - a.plannedBV);
  return (
    <section className="panel">
      <div className="panel-header">
        <i className="level-square" style={{ background: LEVEL_COLOR[node.level] }} />
        <h3>{node.name}</h3>
        <span className="muted small">{LEVEL_LABEL[node.level]}</span>
        <span className="spacer" />
        <div style={{ width: 180 }}>
          <Progress done={p.actual} total={p.planned} label={p.pct === null ? "No committed BV" : `${p.pct}% predictability`} />
        </div>
        {props.editableNodeId && (
          <button className="btn" onClick={props.onAdd}>
            <Icon name="Add" /> New objective
          </button>
        )}
      </div>
      {sorted.length === 0 ? (
        <p className="muted pad">No objectives for this PI yet.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: "45%" }}>Objective</th>
              <th>Type</th>
              <th title="Business value assigned by Business Owners (1–10)">Planned BV</th>
              <th title="Business value achieved at the end of the PI">Actual BV</th>
              <th>Features</th>
              <th title="Objective of the parent unit (ART or Solution) this objective contributes to">Parent objective</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((o) => {
              const unit = props.nodes.get(o.nodeId);
              const parentUnit = props.parentOf(o.nodeId);
              const showChildren = unit?.level === "art" || unit?.level === "solution";
              return (
              <ObjectiveRow
                key={o.id}
                objective={o}
                parentUnit={parentUnit}
                parentOptions={parentUnit ? props.all.filter((x) => x.nodeId === parentUnit.id) : []}
                childCount={showChildren ? props.all.filter((x) => x.parentId === o.id).length : undefined}
                readOnly={o.nodeId !== props.editableNodeId}
                onSave={props.onSave}
                onRemove={props.onRemove}
              />
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ObjectiveRow({
  objective,
  parentUnit,
  parentOptions,
  childCount,
  readOnly,
  onSave,
  onRemove,
}: {
  objective: PiObjective;
  parentUnit?: OrgNode;
  parentOptions: PiObjective[];
  /** Number of child objectives linked to this one (ART / Solution objectives only). */
  childCount?: number;
  readOnly: boolean;
  onSave: (o: PiObjective) => void;
  onRemove: (o: PiObjective) => void;
}) {
  const [draft, setDraft] = useState(objective);
  const commit = (patch: Partial<PiObjective>) => {
    // Always write against the latest etag from the store, not the one captured in the draft.
    const next = { ...draft, ...patch, __etag: objective.__etag };
    setDraft(next);
    if (JSON.stringify(next) !== JSON.stringify(objective)) onSave(next);
  };
  const bv = (v: string) => (v === "" ? null : Math.max(0, Math.min(10, Number(v))));

  return (
    <tr className={draft.committed ? "" : "uncommitted"}>
      <td>
        <input
          className="cell-input"
          value={draft.title}
          disabled={readOnly}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          onBlur={() => commit({})}
        />
        {childCount !== undefined && (
          <span className="muted small child-count" title="Objectives of child units linked to this objective">
            {childCount} child objective{childCount === 1 ? "" : "s"}
          </span>
        )}
      </td>
      <td>
        <select
          aria-label="Type"
          value={draft.committed ? "c" : "u"}
          disabled={readOnly}
          onChange={(e) => commit({ committed: e.target.value === "c" })}
        >
          <option value="c">Committed</option>
          <option value="u">Uncommitted</option>
        </select>
      </td>
      <td>
        <input
          type="number"
          min={1}
          max={10}
          className="cell-input num"
          value={draft.plannedBV}
          disabled={readOnly}
          onChange={(e) => setDraft({ ...draft, plannedBV: bv(e.target.value) ?? 0 })}
          onBlur={() => commit({})}
        />
      </td>
      <td>
        <input
          type="number"
          min={0}
          max={10}
          className="cell-input num"
          value={draft.actualBV ?? ""}
          placeholder="—"
          disabled={readOnly}
          onChange={(e) => setDraft({ ...draft, actualBV: bv(e.target.value) })}
          onBlur={() => commit({})}
        />
      </td>
      <td>
        <input
          className="cell-input"
          placeholder="e.g. 123, 456"
          value={draft.featureIds.join(", ")}
          disabled={readOnly}
          onChange={(e) =>
            setDraft({
              ...draft,
              featureIds: e.target.value
                .split(/[,\s]+/)
                .map(Number)
                .filter((n) => Number.isInteger(n) && n > 0),
            })
          }
          onBlur={() => commit({})}
        />
        <div className="links">
          {draft.featureIds.map((id) => (
            <button key={id} className="link small" onClick={() => openWorkItem(id)}>
              #{id}
            </button>
          ))}
        </div>
      </td>
      <td>
        {parentUnit ? (
          <select
            aria-label="Parent objective"
            value={draft.parentId ?? ""}
            disabled={readOnly || (parentOptions.length === 0 && !draft.parentId)}
            onChange={(e) => commit({ parentId: e.target.value || undefined })}
            title={`Objectives of ${parentUnit.name}`}
          >
            <option value="">— None —</option>
            {parentOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
            {draft.parentId && !parentOptions.some((p) => p.id === draft.parentId) && (
              <option value={draft.parentId}>(objective not in this PI)</option>
            )}
          </select>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        {!readOnly && (
          <button className="link danger" onClick={() => onRemove(objective)} aria-label="Delete objective">
            Delete
          </button>
        )}
      </td>
    </tr>
  );
}
