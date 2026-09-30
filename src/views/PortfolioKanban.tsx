import { useState } from "react";
import { emptySettings, gateGaps, LeanBusinessCase, overWip, PORTFOLIO_STAGES, PortfolioSettings, PortfolioStage, resolveStageStates, STAGE_LABEL, stageOf, emptyCase } from "../api/lpm";
import { leanCasesStore, portfolioSettingsStore } from "../api/data";
import { scopeAreas } from "../api/org";
import { baseFields, scopeQuery } from "../api/queries";
import { F, WorkItem } from "../api/types";
import { getFieldNames, getStates, openNewWorkItem, openWorkItem, queryWorkItems, setFields, WitState } from "../api/wit";
import { Empty, ErrorBar, Info, Spinner, useAsync, Icon, Modal } from "../components/common";
import { useCan, useSafe } from "../components/context";
import { wsjfOf } from "../api/rules";
import { DecisionPill, LeanCaseDialog } from "./LeanBusinessCase";

/**
 * WSJF = Cost of Delay / Job Size. Stock processes carry Business Value and Time Criticality;
 * Risk Reduction/Opportunity Enablement is read from a custom field when present.
 */
const RROE_FIELD = "Custom.RROEValue";

const wsjfWith = (rroeField: string) => (item: WorkItem) => wsjfOf(item.fields, rroeField);

/**
 * SAFe Portfolio Kanban: Funnel → Reviewing → Analyzing → Ready → Implementing → Done, mapped
 * onto the process's Epic states (see lpm.stageOf), with WIP limits per column and the Lean
 * Business Case guardrail before an Epic leaves Analyzing.
 */
export function PortfolioKanban() {
  const { config, node } = useSafe();
  // The configured RR/OE field ("" = none), else the conventional default.
  const rroeField = config.rroeField ?? RROE_FIELD;
  const wsjf = wsjfWith(rroeField);
  const canPlan = useCan().plan;
  const epic = config.types.epic;
  const areas = scopeAreas(node);
  const [sortByWsjf, setSortByWsjf] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>();
  const [editing, setEditing] = useState<WorkItem>();
  const [configuring, setConfiguring] = useState(false);

  const { data, loading, error, reload, setData } = useAsync(async () => {
    // Only request WSJF fields that exist; the batch API rejects unknown field names.
    const known = new Set((await getFieldNames()).map((f) => f.referenceName));
    const wsjfFields = [F.businessValue, F.timeCriticality, F.effort, rroeField].filter((f) => f && known.has(f));
    const [states, items, cases, settings] = await Promise.all([
      getStates(epic),
      queryWorkItems(scopeQuery([epic], areas), [...baseFields(config), ...wsjfFields]),
      leanCasesStore.list(),
      portfolioSettingsStore.get(node.id),
    ]);
    const visible = states.filter((s) => s.category !== "Removed");
    return {
      states: visible,
      // Items in Removed (or unknown) states have no column, so they are not counted either.
      items: items.filter((i) => visible.some((s) => s.name === i.fields[F.state])),
      cases: new Map(cases.map((c) => [c.workItemId, c])),
      settings: settings ?? emptySettings(node.id),
    };
  }, [epic, areas.join("|"), rroeField, node.id]);

  if (!epic) return <Empty title="No Epic type mapped">Set the Epic work item type in Setup.</Empty>;
  if (loading && !data) return <Spinner label="Loading portfolio…" />;

  const states = data?.states ?? [];
  const stageStates = resolveStageStates(data?.settings.stageStates, states);
  const limits = data?.settings.wipLimits ?? {};
  const categoryOf = (state: string) => states.find((s) => s.name === state)?.category ?? "Proposed";
  const stageFor = (i: WorkItem): PortfolioStage =>
    stageOf(i.fields[F.state], categoryOf(i.fields[F.state]), data?.cases.get(i.id)?.stage, stageStates);
  const inStage = (stage: PortfolioStage) => (data?.items ?? []).filter((i) => stageFor(i) === stage);

  const move = async (item: WorkItem, stage: PortfolioStage) => {
    const from = stageFor(item);
    if (from === stage) return;
    const current = data!.cases.get(item.id);
    const gaps = gateGaps(from, stage, current);
    if (gaps.length && !confirm(`#${item.id} is leaving Analyzing without ${gaps.join(", ")}. SAFe requires a Lean Business Case and a Go decision first. Move it anyway?`)) return;
    const count = inStage(stage).length + 1;
    if (overWip(count, limits[stage]) && !confirm(`${STAGE_LABEL[stage]} is at its WIP limit (${limits[stage]}). Move #${item.id} anyway?`)) return;

    const state = stageStates[stage];
    const nextCase: LeanBusinessCase = { ...(current ?? emptyCase(item.id)), stage };
    const cases = new Map(data!.cases).set(item.id, nextCase);
    setData({ ...data!, cases, items: data!.items.map((i) => (i.id === item.id ? { ...i, fields: { ...i.fields, [F.state]: state } } : i)) });
    try {
      if (item.fields[F.state] !== state) await setFields(item.id, { [F.state]: state });
      await leanCasesStore.save(nextCase);
    } catch (e: any) {
      setActionError(`Could not move #${item.id}: ${e.message}`);
    }
    reload(true);
  };

  const sorted = (list: WorkItem[]) =>
    sortByWsjf ? [...list].sort((a, b) => (wsjf(b) ?? -1) - (wsjf(a) ?? -1)) : list;

  const overLimit = PORTFOLIO_STAGES.filter((s) => overWip(inStage(s).length, limits[s]));

  return (
    <div>
      <div className="toolbar">
        <strong>{data?.items.length ?? 0} {epic}s</strong>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={sortByWsjf} onChange={(e) => setSortByWsjf(e.target.checked)} /> Sort by WSJF
        </label>
        {canPlan && (
          <button className="btn" onClick={() => setConfiguring(true)} disabled={!data}>
            <Icon name="Settings" /> Columns & WIP
          </button>
        )}
        {canPlan && (
          <button className="btn" onClick={() => openNewWorkItem(epic, { [F.area]: areas[0] }).then(() => reload(true))}>
            <Icon name="Add" /> New {epic}
          </button>
        )}
        <button className="btn" onClick={() => reload()}>
          <Icon name="Refresh" /> Refresh
        </button>
      </div>
      <ErrorBar message={error ?? actionError} onClose={() => setActionError(undefined)} />
      {!canPlan && <Info>You have read-only access: {epic}s can be viewed but not moved or created here.</Info>}
      {overLimit.length > 0 && (
        <div className="msg msg-warning" role="status">
          WIP limit exceeded:{" "}
          {overLimit.map((s) => `${STAGE_LABEL[s]} has ${inStage(s).length} (limit ${limits[s]})`).join("; ")}. Finish or pull back work before starting more.
        </div>
      )}
      <div className="kanban">
        {data &&
          PORTFOLIO_STAGES.map((stage) => {
            const col = sorted(inStage(stage));
            const limit = limits[stage];
            const exceeded = overWip(col.length, limit);
            const state = states.find((s) => s.name === stageStates[stage]);
            return (
              <div
                key={stage}
                role="group"
                aria-label={`${STAGE_LABEL[stage]} column`}
                className={"kanban-col" + (over === stage ? " drop-over" : "") + (exceeded ? " wip-over" : "")}
                onDragOver={(e) => {
                  if (!canPlan) return;
                  e.preventDefault();
                  setOver(stage);
                }}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  if (!canPlan) return;
                  const id = Number(e.dataTransfer.getData("text/plain"));
                  const item = data.items.find((i) => i.id === id);
                  if (item) void move(item, stage);
                }}
              >
                <div className="kanban-header" style={state ? { borderTopColor: `#${state.color}` } : undefined}>
                  <span>
                    {STAGE_LABEL[stage]}
                    <span className="muted small kanban-state"> {stageStates[stage]}</span>
                  </span>
                  <span className={"count" + (exceeded ? " over" : "")} title={limit ? `WIP limit ${limit}` : "No WIP limit"}>
                    {exceeded && <Icon name="Warning" />}
                    {limit ? `${col.length}/${limit}` : col.length}
                  </span>
                </div>
                {col.map((i) => {
                  const score = wsjf(i);
                  const lc = data.cases.get(i.id);
                  return (
                    <div
                      key={i.id}
                      className="card"
                      style={{ borderLeftColor: "#ff7b00" }}
                      draggable={canPlan}
                      onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i.id))}
                      onClick={() => openWorkItem(i.id).then(() => reload(true))}
                    >
                      <div className="card-title">{i.fields[F.title]}</div>
                      <div className="card-meta">
                        <span className="muted">#{i.id}</span>
                        {i.fields[F.state] !== stageStates[stage] && <span className="state">{i.fields[F.state]}</span>}
                        {score !== null && (
                          <span className="pill" title="(Business Value + Time Criticality + RR/OE) ÷ Effort">
                            WSJF {score}
                          </span>
                        )}
                        {lc && <DecisionPill c={lc} />}
                        {i.fields[F.assignedTo]?.displayName && <span className="muted">{i.fields[F.assignedTo].displayName}</span>}
                        <button
                          className="link small"
                          aria-label={`Business case of #${i.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(i);
                          }}
                        >
                          Business case
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
      </div>
      {editing && data && (
        <LeanCaseDialog
          title={`#${editing.id} ${editing.fields[F.title]}`}
          workItemId={editing.id}
          initial={data.cases.get(editing.id)}
          readOnly={!canPlan}
          onCancel={() => setEditing(undefined)}
          onSaved={(saved) => {
            setData({ ...data, cases: new Map(data.cases).set(saved.workItemId, saved) });
            setEditing(undefined);
          }}
        />
      )}
      {configuring && data && (
        <ColumnsDialog
          states={states}
          settings={data.settings}
          onClose={() => setConfiguring(false)}
          onSaved={(settings) => {
            setData({ ...data, settings });
            setConfiguring(false);
          }}
        />
      )}
    </div>
  );
}

/** Stage → Epic state mapping and WIP limits of the portfolio (saved per portfolio node). */
function ColumnsDialog({
  states,
  settings,
  onClose,
  onSaved,
}: {
  states: WitState[];
  settings: PortfolioSettings;
  onClose: () => void;
  onSaved: (s: PortfolioSettings) => void;
}) {
  const [mapping, setMapping] = useState(resolveStageStates(settings.stageStates, states));
  const [limits, setLimits] = useState<Partial<Record<PortfolioStage, number>>>(settings.wipLimits ?? {});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      onSaved(await portfolioSettingsStore.save({ ...settings, stageStates: mapping, wipLimits: limits }));
    } catch (e: any) {
      setError(`Could not save the columns: ${e?.message ?? e}`);
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Portfolio Kanban columns"
      onClose={onClose}
      footer={
        <>
          <button className="btn primary" onClick={() => void save()} disabled={saving}>
            Save
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <ErrorBar message={error} onClose={() => setError(undefined)} />
      <p className="small muted">
        Each SAFe column sets the Epic state below when a card is dropped into it. Several columns may share a state; the column is then remembered per Epic.
      </p>
      <table className="grid compact">
        <thead>
          <tr>
            <th>Column</th>
            <th>Epic state</th>
            <th>WIP limit</th>
          </tr>
        </thead>
        <tbody>
          {PORTFOLIO_STAGES.map((stage) => (
            <tr key={stage}>
              <td>{STAGE_LABEL[stage]}</td>
              <td>
                <select aria-label={`${STAGE_LABEL[stage]} state`} value={mapping[stage]} onChange={(e) => setMapping({ ...mapping, [stage]: e.target.value })}>
                  {states.map((s) => (
                    <option key={s.name}>{s.name}</option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  className="cell-input num"
                  type="number"
                  min={0}
                  aria-label={`${STAGE_LABEL[stage]} WIP limit`}
                  value={limits[stage] ?? ""}
                  onChange={(e) => {
                    const n = Math.floor(Number(e.target.value));
                    setLimits({ ...limits, [stage]: e.target.value && n > 0 ? n : undefined });
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
