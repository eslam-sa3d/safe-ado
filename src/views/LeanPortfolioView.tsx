import { useEffect, useState } from "react";
import { budgetsStore, leanCasesStore, newId, portfolioSettingsStore } from "../api/data";
import {
  budgetId,
  DEFAULT_CURRENCY,
  emptySettings,
  epicCost,
  EpicCost,
  findBudget,
  fmtMoney,
  inherited,
  overBudget,
  parseAmount,
  PortfolioSettings,
  spend,
  SpendModel,
  StrategicTheme,
} from "../api/lpm";
import { flatten, pathTo, scopeAreas } from "../api/org";
import { loadTree, scopeQuery } from "../api/queries";
import { piProgress, toDay } from "../api/reports";
import { localToday } from "../api/rules";
import { F, OrgNode } from "../api/types";
import { getStateCategories, isUnder, openNewWorkItem, openWorkItem, queryWorkItems } from "../api/wit";
import { Empty, ErrorBar, Icon, Info, LevelPill, Spinner, useAsync } from "../components/common";
import { useCan, useSafe } from "../components/context";
import { DecisionPill } from "./LeanBusinessCase";

const EPIC_STATUS: Record<EpicCost["status"], string> = {
  ok: "Within estimate",
  beyondMvp: "Beyond MVP estimate",
  forecastOverFull: "Forecast exceeds full estimate",
  actualOverFull: "Actual exceeds full estimate",
};

/**
 * Lean Portfolio (portfolio level): the portfolio canvas (vision and strategic themes), value
 * stream budgets vs. forecast spend per PI with the budget guardrail, and Epic cost vs. the
 * Lean Business Case estimates. Formulas: see lpm.spend and lpm.epicCost.
 */
export function LeanPortfolioView() {
  const { config, node, pis, pi: shellPi } = useSafe();
  const canPlan = useCan().plan;
  const [piId, setPiId] = useState(shellPi?.identifier ?? "");
  const pi = pis.find((p) => p.identifier === piId) ?? shellPi;
  const [actionError, setActionError] = useState<string>();
  const areas = scopeAreas(node);
  const { epic, story, theme } = config.types;
  const spField = config.storyPointsField;

  const { data, loading, error, reload, setData } = useAsync(async () => {
    const [settingsDocs, budgets, cases, categoryOf] = await Promise.all([
      portfolioSettingsStore.list(),
      budgetsStore.list(),
      leanCasesStore.list(),
      getStateCategories([story]),
    ]);
    const [stories, epics, themeItems] = await Promise.all([
      pi && story && areas.length ? queryWorkItems(scopeQuery([story], areas, pi.path), [F.id, F.type, F.state, F.area, F.iteration, spField]) : Promise.resolve([]),
      epic && areas.length ? loadTree(config, epic, areas) : Promise.resolve([]),
      theme && areas.length ? queryWorkItems(scopeQuery([theme], areas), [F.id, F.title, F.type, F.state]) : Promise.resolve(undefined),
    ]);
    return {
      settings: new Map(settingsDocs.map((s) => [s.nodeId, s])),
      budgets,
      cases: new Map(cases.map((c) => [c.workItemId, c])),
      stories: stories
        .map((s) => ({ area: s.fields[F.area] as string, sp: Number(s.fields[spField] ?? 0) || 0, category: categoryOf(s.fields[F.type], s.fields[F.state]) }))
        .filter((s) => s.category !== "Removed"),
      epics,
      themeItems,
    };
  }, [node.id, pi?.identifier, areas.join("|"), epic, story, theme, spField]);

  if (loading && !data) return <Spinner label="Loading Lean Portfolio…" />;
  if (!data) return <ErrorBar message={error} />;

  const chainOf = (n: OrgNode) => pathTo(config.root, n.id).map((x) => x.id);
  const own = data.settings.get(node.id) ?? emptySettings(node.id);
  const currency = inherited(chainOf(node), data.settings, "currency") ?? DEFAULT_CURRENCY;
  const model: SpendModel = inherited(chainOf(node), data.settings, "spendModel") ?? "points";
  const money = (n: number) => fmtMoney(n, currency);

  const saveSettings = async (nodeId: string, patch: Partial<PortfolioSettings>) => {
    const current = data.settings.get(nodeId) ?? emptySettings(nodeId);
    try {
      const saved = await portfolioSettingsStore.save({ ...current, ...patch });
      setData((d) => d && { ...d, settings: new Map(d.settings).set(nodeId, saved) });
    } catch (e: any) {
      setActionError(`Could not save the portfolio settings: ${e?.message ?? e}`);
    }
  };

  const saveBudget = async (n: OrgNode, amount: number | undefined) => {
    if (!pi) return;
    const existing = findBudget(data.budgets, n.id, pi);
    try {
      if (amount === undefined) {
        if (existing) await budgetsStore.remove(existing.id);
        setData((d) => d && { ...d, budgets: d.budgets.filter((b) => b !== existing) });
        return;
      }
      const saved = await budgetsStore.save({
        id: existing?.id ?? budgetId(n.id, pi.identifier),
        nodeId: n.id,
        piId: pi.identifier,
        piPath: pi.path,
        amount,
        __etag: existing?.__etag,
      });
      setData((d) => d && { ...d, budgets: [...d.budgets.filter((b) => b.id !== saved.id), saved] });
    } catch (e: any) {
      setActionError(`Could not save the budget of ${n.name}: ${e?.message ?? e}`);
    }
  };

  // ---- value streams ----
  const elapsed = pi ? (piProgress(pi, toDay(localToday()))?.pct ?? 0) / 100 : 0;
  const rateKey: "costPerTeamPerPi" | "costPerPoint" = model === "teams" ? "costPerTeamPerPi" : "costPerPoint";
  const streams = flatten(node)
    .filter((n) => n.level !== "team")
    .map((n) => {
      const nAreas = scopeAreas(n);
      const mine = data.stories.filter((s) => nAreas.some((a) => isUnder(s.area, a)));
      const planned = mine.reduce((sum, s) => sum + s.sp, 0);
      const done = mine.filter((s) => s.category === "Completed").reduce((sum, s) => sum + s.sp, 0);
      const teams = flatten(n).filter((t) => t.level === "team").length;
      const chain = chainOf(n);
      const costPerPoint = inherited(chain, data.settings, "costPerPoint");
      const costPerTeamPerPi = inherited(chain, data.settings, "costPerTeamPerPi");
      const s = spend({ model, costPerPoint, costPerTeamPerPi, plannedPoints: planned, donePoints: done, teams, elapsed });
      const budget = pi ? findBudget(data.budgets, n.id, pi)?.amount : undefined;
      const inheritedRate = inherited(chain.slice(0, -1), data.settings, rateKey);
      return { n, planned, done, teams, spend: s, budget, ownRate: data.settings.get(n.id)?.[rateKey], inheritedRate };
    });
  const byId = new Map(streams.map((r) => [r.n.id, r]));
  const overRows = streams.filter((r) => overBudget(r.spend, r.budget));
  const childOver = streams
    .map((r) => {
      const kids = r.n.children.map((c) => byId.get(c.id)).filter((k) => k && k.budget !== undefined);
      const total = kids.reduce((sum, k) => sum + k!.budget!, 0);
      return { r, total, over: kids.length > 0 && r.budget !== undefined && total > r.budget };
    })
    .filter((x) => x.over);

  // ---- epics ----
  const portfolioRate = inherited(chainOf(node), data.settings, "costPerPoint");

  return (
    <div className="lean-portfolio">
      <div className="toolbar">
        <strong>Lean Portfolio</strong>
        <span className="spacer" />
        <label htmlFor="lpm-pi">PI</label>
        <select id="lpm-pi" value={pi?.identifier ?? ""} onChange={(e) => setPiId(e.target.value)} disabled={!pis.length}>
          {!pis.length && <option value="">No PIs yet</option>}
          {pis.map((p) => (
            <option key={p.identifier} value={p.identifier}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => reload()}>
          <Icon name="Refresh" /> Refresh
        </button>
      </div>
      <ErrorBar message={error ?? actionError} onClose={() => setActionError(undefined)} />
      {!canPlan && <Info>You have read-only access: the Lean Portfolio can be viewed but not changed.</Info>}

      <section className="panel" aria-label="Portfolio canvas">
        <div className="panel-header">
          <h3>Portfolio canvas</h3>
        </div>
        <div className="panel-body lpm-canvas">
          <VisionEditor value={own.vision ?? ""} readOnly={!canPlan} onSave={(vision) => saveSettings(node.id, { vision: vision || undefined })} />
          <div className="field">
            <span className="field-label">Strategic themes</span>
            {data.themeItems ? (
              <>
                {data.themeItems.length === 0 && <span className="muted">No {theme} work items in this portfolio yet.</span>}
                <ul className="lpm-themes">
                  {data.themeItems.map((t) => (
                    <li key={t.id}>
                      <button className="link" onClick={() => openWorkItem(t.id).then(() => reload(true))}>
                        {t.fields[F.title]}
                      </button>{" "}
                      <span className="muted small">{t.fields[F.state]}</span>
                    </li>
                  ))}
                </ul>
                {canPlan && (
                  <button className="btn" onClick={() => openNewWorkItem(theme!, { [F.area]: areas[0] }).then(() => reload(true))}>
                    <Icon name="Add" /> New {theme}
                  </button>
                )}
              </>
            ) : (
              <ThemeList themes={own.themes ?? []} readOnly={!canPlan} onChange={(themes) => saveSettings(node.id, { themes })} />
            )}
          </div>
        </div>
      </section>

      <section className="panel" aria-label="Value stream budgets">
        <div className="panel-header">
          <h3>Value stream budgets{pi ? ` · ${pi.name}` : ""}</h3>
          <span className="spacer" />
          <label className="lpm-setting">
            Currency{" "}
            <AmountInput
              text
              label="Currency"
              value={own.currency ?? ""}
              placeholder={currency}
              disabled={!canPlan}
              onCommit={(v) => saveSettings(node.id, { currency: v ? v.toUpperCase() : undefined })}
            />
          </label>
          <label className="lpm-setting">
            Spend model{" "}
            <select
              aria-label="Spend model"
              value={model}
              disabled={!canPlan}
              onChange={(e) => void saveSettings(node.id, { spendModel: e.target.value as SpendModel })}
            >
              <option value="points">Cost per story point</option>
              <option value="teams">Cost per team per PI</option>
            </select>
          </label>
        </div>
        <div className="panel-body">
          {!pi ? (
            <Empty title="No Program Increments found">Budgets are set per PI. Create a PI under PIs & Iterations.</Empty>
          ) : (
            <>
              {overRows.map((r) => (
                <div key={r.n.id} className="msg msg-warning" role="alert">
                  Guardrail: {r.n.name} forecasts {money(r.spend!.forecast)} in {pi.name}, over its budget of {money(r.budget!)}.
                </div>
              ))}
              {childOver.map(({ r, total }) => (
                <div key={r.n.id} className="msg msg-warning" role="alert">
                  Guardrail: the budgets under {r.n.name} add up to {money(total)}, more than its own budget of {money(r.budget!)}.
                </div>
              ))}
              <table className="grid lpm-budgets">
                <thead>
                  <tr>
                    <th>Value stream</th>
                    <th>Budget</th>
                    <th>{model === "teams" ? "Cost / team / PI" : "Cost / SP"}</th>
                    <th>{model === "teams" ? "Teams" : "Planned SP"}</th>
                    <th>Done SP</th>
                    <th>Forecast spend</th>
                    <th>Actual to date</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {streams.map((r) => (
                    <tr key={r.n.id} className={overBudget(r.spend, r.budget) ? "over-budget" : undefined}>
                      <td>
                        {r.n.name} <LevelPill level={r.n.level} />
                      </td>
                      <td>
                        <AmountInput
                          label={`Budget of ${r.n.name}`}
                          value={r.budget !== undefined ? String(r.budget) : ""}
                          disabled={!canPlan}
                          onCommit={(v) => saveBudget(r.n, parseAmount(v))}
                        />
                      </td>
                      <td>
                        <AmountInput
                          label={`Rate of ${r.n.name}`}
                          value={r.ownRate !== undefined ? String(r.ownRate) : ""}
                          placeholder={r.inheritedRate !== undefined ? String(r.inheritedRate) : ""}
                          disabled={!canPlan}
                          onCommit={(v) => saveSettings(r.n.id, { [rateKey]: parseAmount(v) } as Partial<PortfolioSettings>)}
                        />
                      </td>
                      <td>{model === "teams" ? r.teams : r.planned}</td>
                      <td>{r.done}</td>
                      <td>{r.spend ? money(r.spend.forecast) : <span className="muted">No rate</span>}</td>
                      <td>{r.spend ? money(r.spend.actual) : "–"}</td>
                      <td>
                        {r.budget === undefined ? (
                          <span className="muted">No budget</span>
                        ) : overBudget(r.spend, r.budget) ? (
                          <span className="pill budget-over">Over budget</span>
                        ) : r.spend ? (
                          <span className="pill budget-ok">{money(r.budget - r.spend.forecast)} left</span>
                        ) : (
                          <span className="muted">–</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small muted lpm-formula">
                {model === "teams"
                  ? "Forecast spend = cost per team per PI × teams in the value stream. Actual to date = forecast × share of the PI elapsed."
                  : "Forecast spend = cost per story point × story points planned in the PI (live stories in the value stream's areas). Actual to date = cost per story point × completed story points."}{" "}
                An empty rate is inherited from the parent unit.
              </p>
            </>
          )}
        </div>
      </section>

      <section className="panel" aria-label="Epic cost vs. estimate">
        <div className="panel-header">
          <h3>Epic cost vs. estimate</h3>
        </div>
        <div className="panel-body">
          {!portfolioRate && <Info>Set a cost per story point for {node.name} to compare Epic cost with the Lean Business Case estimates.</Info>}
          {data.epics.length === 0 ? (
            <p className="muted">No {epic || "Epic"}s in this portfolio.</p>
          ) : (
            <table className="grid lpm-epics">
              <thead>
                <tr>
                  <th>{epic}</th>
                  <th>Decision</th>
                  <th>Done / total SP</th>
                  <th>Actual cost</th>
                  <th>Forecast cost</th>
                  <th>MVP estimate</th>
                  <th>Full estimate</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.epics.map((t) => {
                  const lc = data.cases.get(t.item.id);
                  const cost = epicCost(t.donePoints, t.points, portfolioRate, lc);
                  return (
                    <tr key={t.item.id}>
                      <td>
                        <button className="link title-link" onClick={() => openWorkItem(t.item.id).then(() => reload(true))}>
                          #{t.item.id} {t.item.fields[F.title]}
                        </button>
                      </td>
                      <td>{lc ? <DecisionPill c={lc} /> : <span className="muted">No business case</span>}</td>
                      <td>
                        {t.donePoints} / {t.points}
                      </td>
                      <td>{cost ? money(cost.actual) : "–"}</td>
                      <td>{cost ? money(cost.forecast) : "–"}</td>
                      <td>{lc?.mvpCost !== undefined ? money(lc.mvpCost) : "–"}</td>
                      <td>{lc?.fullCost !== undefined ? money(lc.fullCost) : "–"}</td>
                      <td>{cost ? <span className={"pill epic-cost-" + cost.status}>{EPIC_STATUS[cost.status]}</span> : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="small muted lpm-formula">Actual cost = completed story points of the Epic's stories × cost per story point; forecast cost = all its story points × cost per story point.</p>
        </div>
      </section>
    </div>
  );
}

/** A text / number input that saves on blur or Enter, and only when the value changed. */
function AmountInput({
  label,
  value,
  placeholder,
  disabled,
  text,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  text?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <input
      className={"cell-input" + (text ? " lpm-currency" : " num")}
      type={text ? "text" : "number"}
      min={text ? undefined : 0}
      maxLength={text ? 3 : undefined}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function VisionEditor({ value, readOnly, onSave }: { value: string; readOnly: boolean; onSave: (v: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="field">
      <span className="field-label">Portfolio vision</span>
      <textarea rows={3} value={draft} disabled={readOnly} onChange={(e) => setDraft(e.target.value)} placeholder="Where is this portfolio heading, and why?" />
      {!readOnly && draft !== value && (
        <span>
          <button className="btn primary" onClick={() => void onSave(draft.trim())}>
            Save vision
          </button>
        </span>
      )}
    </label>
  );
}

/** Strategic themes kept in the portfolio settings (when no Theme work item type is mapped). */
function ThemeList({ themes, readOnly, onChange }: { themes: StrategicTheme[]; readOnly: boolean; onChange: (t: StrategicTheme[]) => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const add = async () => {
    if (!name.trim()) return;
    await onChange([...themes, { id: newId(), name: name.trim(), description: description.trim() || undefined }]);
    setName("");
    setDescription("");
  };
  return (
    <>
      {themes.length === 0 && <span className="muted">No strategic themes yet.</span>}
      <ul className="lpm-themes">
        {themes.map((t) => (
          <li key={t.id}>
            <strong>{t.name}</strong>
            {t.description && <span className="muted"> · {t.description}</span>}
            {!readOnly && (
              <button className="link" aria-label={`Remove theme ${t.name}`} onClick={() => void onChange(themes.filter((x) => x.id !== t.id))}>
                <Icon name="Cancel" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div className="lpm-theme-add">
          <input aria-label="Theme name" placeholder="Theme" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="Theme description" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <button className="btn" onClick={() => void add()} disabled={!name.trim()}>
            <Icon name="Add" /> Add theme
          </button>
        </div>
      )}
    </>
  );
}
