import * as SDK from "azure-devops-extension-sdk";

/**
 * SAFe Lean Portfolio Management: Epic Lean Business Cases, the Portfolio Kanban stages with
 * WIP limits and the business-case guardrail, value stream budgets per PI and the portfolio
 * canvas. Everything here is pure except currentUserName; the documents are stored in the
 * Extension Data Service (see data.ts: leanCasesStore, portfolioSettingsStore, budgetsStore).
 */

// ---------------------------------------------------------------------------------------------
// Portfolio Kanban stages
// ---------------------------------------------------------------------------------------------

export type PortfolioStage = "funnel" | "reviewing" | "analyzing" | "ready" | "implementing" | "done";

export const PORTFOLIO_STAGES: PortfolioStage[] = ["funnel", "reviewing", "analyzing", "ready", "implementing", "done"];

export const STAGE_LABEL: Record<PortfolioStage, string> = {
  funnel: "Funnel",
  reviewing: "Reviewing",
  analyzing: "Analyzing",
  ready: "Ready",
  implementing: "Implementing",
  done: "Done",
};

const STAGE_INDEX = (s: PortfolioStage) => PORTFOLIO_STAGES.indexOf(s);

/** State category an unmapped stage falls back to (Funnel → Ready are all still proposals). */
const STAGE_CATEGORY: Record<PortfolioStage, string[]> = {
  funnel: ["Proposed"],
  reviewing: ["Proposed"],
  analyzing: ["Proposed"],
  ready: ["Proposed"],
  implementing: ["InProgress", "Resolved"],
  done: ["Completed"],
};

export interface StateInfo {
  name: string;
  category: string;
}

/**
 * The process state an Epic takes in each column: a state named like the stage (e.g. a custom
 * "Analyzing" state), else the first state of the stage's category, else the first state.
 */
export function defaultStageStates(states: StateInfo[]): Record<PortfolioStage, string> {
  const out = {} as Record<PortfolioStage, string>;
  for (const stage of PORTFOLIO_STAGES) {
    const named = states.find((s) => s.name.toLowerCase() === STAGE_LABEL[stage].toLowerCase());
    const byCategory = STAGE_CATEGORY[stage].map((c) => states.find((s) => s.category === c)).find(Boolean);
    out[stage] = (named ?? byCategory ?? states[0])?.name ?? "";
  }
  return out;
}

/** The configured stage → state mapping over the defaults; states the process lacks are ignored. */
export function resolveStageStates(configured: Partial<Record<PortfolioStage, string>> | undefined, states: StateInfo[]): Record<PortfolioStage, string> {
  const out = defaultStageStates(states);
  for (const stage of PORTFOLIO_STAGES) {
    const s = configured?.[stage];
    if (s && states.some((x) => x.name === s)) out[stage] = s;
  }
  return out;
}

/**
 * The column an Epic sits in. Several stages may share a process state (Agile has only "New"
 * before work starts), so the stage the Epic was last moved to is remembered in its business
 * case document and wins while it still matches the Epic's state. Otherwise the first stage
 * mapped to the state, else the state's category decides.
 */
export function stageOf(state: string, category: string, stored: PortfolioStage | undefined, stageStates: Record<PortfolioStage, string>): PortfolioStage {
  if (stored && PORTFOLIO_STAGES.includes(stored) && stageStates[stored] === state) return stored;
  const mapped = PORTFOLIO_STAGES.find((s) => stageStates[s] === state);
  if (mapped) return mapped;
  if (category === "Completed") return "done";
  if (category === "InProgress" || category === "Resolved") return "implementing";
  return "funnel";
}

/** Whether a column holds more items than its WIP limit (no limit, or 0, means unlimited). */
export function overWip(count: number, limit: number | undefined): boolean {
  return !!limit && limit > 0 && count > limit;
}

// ---------------------------------------------------------------------------------------------
// Lean Business Case
// ---------------------------------------------------------------------------------------------

export type GoDecision = "Pending" | "Go" | "No-go" | "Pivot";
export const GO_DECISIONS: GoDecision[] = ["Pending", "Go", "No-go", "Pivot"];

/**
 * An Epic's Lean Business Case (SAFe Epic hypothesis statement, MVP, cost estimates, Epic
 * Owner and the go / no-go decision). id = String(workItemId), like wimeta documents.
 */
export interface LeanBusinessCase {
  id: string;
  workItemId: number;
  /** Portfolio Kanban column the Epic was last moved to (see stageOf). */
  stage?: PortfolioStage;
  epicOwner?: string;
  /** Epic hypothesis statement: For <customers> who <do something> the <solution> is a <how> that <value>, unlike <competition>, our solution <why>. */
  forCustomers?: string;
  who?: string;
  solution?: string;
  isA?: string;
  that?: string;
  unlike?: string;
  ourSolution?: string;
  businessOutcomes?: string;
  leadingIndicators?: string;
  nfrs?: string;
  /** Minimum Viable Product definition. */
  mvp?: string;
  /** Estimated cost of the MVP and of the full Epic, in the portfolio currency. */
  mvpCost?: number;
  fullCost?: number;
  decision?: GoDecision;
  decidedBy?: string;
  /** ISO timestamp of the last decision change. */
  decidedAt?: string;
  __etag?: number;
}

export const HYPOTHESIS_FIELDS: { key: keyof LeanBusinessCase; label: string }[] = [
  { key: "forCustomers", label: "For" },
  { key: "who", label: "who" },
  { key: "solution", label: "the" },
  { key: "isA", label: "is a" },
  { key: "that", label: "that" },
  { key: "unlike", label: "unlike" },
  { key: "ourSolution", label: "our solution" },
];

export function emptyCase(workItemId: number): LeanBusinessCase {
  return { id: String(workItemId), workItemId, decision: "Pending" };
}

const filled = (v: unknown) => typeof v === "string" && v.trim() !== "";

export const hasHypothesis = (c: LeanBusinessCase | undefined) => !!c && HYPOTHESIS_FIELDS.some((f) => filled(c[f.key]));

/**
 * What a Lean Business Case still lacks. It counts as written once it has a hypothesis
 * statement (any part), business outcomes and an MVP definition.
 */
export function caseGaps(c: LeanBusinessCase | undefined): string[] {
  const gaps: string[] = [];
  if (!hasHypothesis(c)) gaps.push("an Epic hypothesis statement");
  if (!filled(c?.businessOutcomes)) gaps.push("business outcomes");
  if (!filled(c?.mvp)) gaps.push("an MVP definition");
  return gaps;
}

/**
 * The SAFe guardrail: an Epic may not move past Analyzing (into Ready, Implementing or Done)
 * without a Lean Business Case and a Go decision. Returns what is missing (empty = allowed).
 */
export function gateGaps(from: PortfolioStage, to: PortfolioStage, c: LeanBusinessCase | undefined): string[] {
  const gate = STAGE_INDEX("analyzing");
  if (STAGE_INDEX(from) > gate || STAGE_INDEX(to) <= gate) return [];
  const gaps = caseGaps(c);
  if (c?.decision !== "Go") gaps.push("a Go decision");
  return gaps;
}

/** Applies a decision change, recording who made it and when (unchanged decisions keep both). */
export function withDecision(c: LeanBusinessCase, decision: GoDecision, by: string, at: string): LeanBusinessCase {
  if ((c.decision ?? "Pending") === decision) return c;
  return { ...c, decision, decidedBy: by || undefined, decidedAt: at };
}

/** Display name of the signed-in user, or "" when the SDK cannot tell. */
export function currentUserName(): string {
  try {
    return (SDK as unknown as { getUser?: () => { displayName?: string; name?: string } }).getUser?.()?.displayName ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------------------------
// Portfolio settings, budgets and spend
// ---------------------------------------------------------------------------------------------

export interface StrategicTheme {
  id: string;
  name: string;
  description?: string;
}

export type SpendModel = "points" | "teams";

/**
 * Lean Portfolio settings of one hierarchy node (id = node id). Kanban mapping, WIP limits,
 * vision and themes are read from the portfolio node; rates are inherited down the tree.
 */
export interface PortfolioSettings {
  id: string;
  nodeId: string;
  stageStates?: Partial<Record<PortfolioStage, string>>;
  wipLimits?: Partial<Record<PortfolioStage, number>>;
  /** ISO 4217 code (default USD). */
  currency?: string;
  spendModel?: SpendModel;
  costPerPoint?: number;
  costPerTeamPerPi?: number;
  vision?: string;
  themes?: StrategicTheme[];
  __etag?: number;
}

export function emptySettings(nodeId: string): PortfolioSettings {
  return { id: nodeId, nodeId };
}

/** Budget of one value stream (Portfolio / Solution / ART node) for one PI. id = `${nodeId}|${piId}`. */
export interface ValueStreamBudget {
  id: string;
  nodeId: string;
  /** Stable iteration id of the PI (survives renames); piPath is the fallback. */
  piId: string;
  piPath: string;
  amount: number;
  __etag?: number;
}

export const budgetId = (nodeId: string, piId: string) => `${nodeId}|${piId}`;

/** A node's budget for a PI, by the PI's stable id, else by path (case-insensitive). */
export function findBudget(docs: ValueStreamBudget[], nodeId: string, pi: { identifier: string; path: string }): ValueStreamBudget | undefined {
  const mine = docs.filter((d) => d.nodeId === nodeId);
  return mine.find((d) => d.piId === pi.identifier) ?? mine.find((d) => d.piPath.toLowerCase() === pi.path.toLowerCase());
}

export const DEFAULT_CURRENCY = "USD";

/**
 * The first value set on the node or its nearest ancestor. `chain` runs root → node, as
 * org.pathTo returns it.
 */
export function inherited<K extends keyof PortfolioSettings>(chain: string[], settings: Map<string, PortfolioSettings>, key: K): PortfolioSettings[K] | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const v = settings.get(chain[i])?.[key];
    if (v !== undefined && v !== null && (v as unknown) !== "") return v;
  }
  return undefined;
}

export interface SpendInput {
  model: SpendModel;
  costPerPoint?: number;
  costPerTeamPerPi?: number;
  /** Story points of live stories planned in the PI (in the node's areas). */
  plannedPoints: number;
  /** Story points of those stories that are completed. */
  donePoints: number;
  /** Team nodes under the value stream. */
  teams: number;
  /** Share of the PI's calendar days elapsed (0..1). */
  elapsed: number;
}

export interface Spend {
  /** Expected spend for the whole PI. */
  forecast: number;
  /** Spend incurred so far. */
  actual: number;
}

/**
 * Value stream spend for a PI; null when the node has no rate.
 * - points: forecast = cost per story point × planned points; actual = cost per point × completed points.
 * - teams:  forecast = cost per team per PI × teams; actual = forecast × share of the PI elapsed.
 */
export function spend(input: SpendInput): Spend | null {
  if (input.model === "teams") {
    if (!input.costPerTeamPerPi) return null;
    const forecast = input.costPerTeamPerPi * input.teams;
    return { forecast, actual: forecast * Math.min(1, Math.max(0, input.elapsed)) };
  }
  if (!input.costPerPoint) return null;
  return { forecast: input.costPerPoint * input.plannedPoints, actual: input.costPerPoint * input.donePoints };
}

/** The guardrail: forecast spend exceeds a (positive) budget. */
export const overBudget = (s: Spend | null, budget: number | undefined) => !!s && !!budget && budget > 0 && s.forecast > budget;

export interface EpicCost {
  /** Completed story points of the Epic's stories × cost per point. */
  actual: number;
  /** All (live) story points of the Epic's stories × cost per point. */
  forecast: number;
  status: "ok" | "beyondMvp" | "forecastOverFull" | "actualOverFull";
}

/** Epic cost vs. its Lean Business Case estimates; null without a cost per story point. */
export function epicCost(donePoints: number, totalPoints: number, costPerPoint: number | undefined, c: LeanBusinessCase | undefined): EpicCost | null {
  if (!costPerPoint) return null;
  const actual = donePoints * costPerPoint;
  const forecast = totalPoints * costPerPoint;
  const full = c?.fullCost;
  const mvp = c?.mvpCost;
  const status: EpicCost["status"] =
    full && actual > full ? "actualOverFull" : full && forecast > full ? "forecastOverFull" : mvp && actual > mvp ? "beyondMvp" : "ok";
  return { actual, forecast, status };
}

/** A currency amount ("$1,200"); unknown codes fall back to "1,200 XYZ". */
export function fmtMoney(amount: number, currency: string = DEFAULT_CURRENCY): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${Math.round(amount).toLocaleString()} ${currency}`;
  }
}

/** A non-negative number from an input value; undefined when empty or invalid. */
export function parseAmount(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
