import { calculatedSprintIndex, criticalityByDates, criticalityByIteration, Dependency } from "./dependencies";
import { EXPOSURE_RANK, exposure, Exposure } from "./risk";
import { Criticality, F, IterationCapacity, LINK, Milestone, OrgNode, PiObjective, ProgramIncrement, Risk, Sprint, WorkItem, WorkItemMeta } from "./types";
import { isUnder, relationTargetId } from "./wit";
import { DEFAULT_RROE_FIELD, isIpIteration, localToday, wsjfScore } from "./rules";

/**
 * Pure calculations behind the Reports dashboard (Agile Hive widget formulas).
 * Every date-dependent function takes `today` as a day number (see toDay) so results are
 * deterministic in tests. Days are counted in UTC, matching iteration dates from Azure DevOps.
 */

export const DAY_MS = 86_400_000;

/** Days since the Unix epoch (UTC) for an ISO string or a Date. */
export function toDay(value: string | Date): number {
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Math.floor(t / DAY_MS);
}

/**
 * Day number of an event timestamp (Closed / Changed / Activated date) on the user's local
 * calendar. Iteration dates are calendar days, so an item closed at 20:00 local time must count
 * on that local day even when it is already the next day in UTC.
 */
export function eventDay(timestamp: string): number {
  return toDay(localToday(new Date(timestamp)));
}

/** YYYY-MM-DD of a day number. */
export function dayIso(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (part: number, total: number): number | null => (total > 0 ? Math.round((part / total) * 100) : null);

// ---------------------------------------------------------------------------------------------
// Normalized work items
// ---------------------------------------------------------------------------------------------

export type Category = "Proposed" | "InProgress" | "Resolved" | "Completed" | "Removed" | string;

/** A work item flattened to what the widgets need. */
export interface RItem {
  id: number;
  type: string;
  title: string;
  state: string;
  category: Category;
  /** Story points; null when the field is empty (unestimated). */
  sp: number | null;
  iteration?: string;
  area?: string;
  closedDate?: string;
  parentId?: number;
  childIds: number[];
  assignedTo?: string;
  businessValue?: number;
  timeCriticality?: number;
  /** Risk Reduction / Opportunity Enablement, when the process has the field. */
  rroe?: number;
  effort?: number;
  /** When work started (Microsoft.VSTS.Common.ActivatedDate), for flow time. */
  activatedDate?: string;
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Activated date field of the Agile / CMMI / Scrum processes. */
export const ACTIVATED_DATE = "Microsoft.VSTS.Common.ActivatedDate";

export function normalize(
  wi: WorkItem,
  categoryOf: (type: string, state: string) => string,
  spField: string,
  rroeField: string = DEFAULT_RROE_FIELD
): RItem {
  const f = wi.fields;
  const rels = wi.relations ?? [];
  const parent = rels.find((r) => r.rel === LINK.parent);
  const assigned = f[F.assignedTo];
  return {
    id: wi.id,
    type: f[F.type],
    title: f[F.title] ?? `#${wi.id}`,
    state: f[F.state],
    category: categoryOf(f[F.type], f[F.state]),
    sp: num(f[spField]) ?? null,
    iteration: f[F.iteration],
    area: f[F.area],
    closedDate: f[F.closedDate] || undefined,
    parentId: parent ? relationTargetId(parent.url) ?? undefined : undefined,
    childIds: rels
      .filter((r) => r.rel === LINK.child)
      .map((r) => relationTargetId(r.url))
      .filter((id): id is number => id !== null),
    assignedTo: typeof assigned === "string" ? assigned : assigned?.displayName,
    businessValue: num(f[F.businessValue]),
    timeCriticality: num(f[F.timeCriticality]),
    rroe: num(f[rroeField || DEFAULT_RROE_FIELD]),
    effort: num(f[F.effort]),
    activatedDate: f[ACTIVATED_DATE] || undefined,
  };
}

export const isDone = (i: RItem) => i.category === "Completed";
export const isLive = (i: RItem) => i.category !== "Removed";
export const points = (i: RItem) => i.sp ?? 0;
export const inIteration = (i: RItem, path: string) => isUnder(i.iteration, path);

// ---------------------------------------------------------------------------------------------
// PI / iteration timing
// ---------------------------------------------------------------------------------------------

export type PiStatus = "planned" | "current" | "completed" | "undated";

export function piStatus(p: Sprint, today: number): PiStatus {
  if (!p.start || !p.finish) return "undated";
  if (toDay(p.start) > today) return "planned";
  if (toDay(p.finish) < today) return "completed";
  return "current";
}

/** An iteration is completed once its finish date lies before today. */
export const isCompletedSprint = (s: Sprint, today: number) => !!s.finish && toDay(s.finish) < today;

/** The PI and iteration running on `today`. */
export function currentIteration(pis: ProgramIncrement[], today: number): { pi?: ProgramIncrement; sprint?: Sprint } {
  const pi = pis.find((p) => piStatus(p, today) === "current");
  const sprint = pi?.sprints.find((s) => piStatus(s, today) === "current");
  return { pi, sprint };
}

export interface PiProgress {
  pct: number;
  elapsedDays: number;
  totalDays: number;
  remainingDays: number;
}

/** Share of the PI's calendar days that has elapsed. */
export function piProgress(p: Sprint, today: number): PiProgress | null {
  if (!p.start || !p.finish) return null;
  const start = toDay(p.start);
  const totalDays = Math.max(1, toDay(p.finish) - start + 1);
  const elapsedDays = Math.min(totalDays, Math.max(0, today - start));
  return { pct: Math.round((elapsedDays / totalDays) * 100), elapsedDays, totalDays, remainingDays: totalDays - elapsedDays };
}

/** Agile Hive treats a sprint whose name contains "IP" as the Innovation & Planning iteration. */
export const isIpSprint = (s: Sprint, piName?: string) => isIpIteration(s.name, piName);

// ---------------------------------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------------------------------

export interface PointsSummary {
  planned: number;
  done: number;
  pct: number | null;
  unestimated: number;
  count: number;
}

/** Story Points Burned: done SP ÷ planned SP of (live) stories. */
export function pointsSummary(stories: RItem[]): PointsSummary {
  const live = stories.filter(isLive);
  const planned = live.reduce((s, i) => s + points(i), 0);
  const done = live.filter(isDone).reduce((s, i) => s + points(i), 0);
  return { planned, done, pct: pct(done, planned), unestimated: live.filter((i) => i.sp === null).length, count: live.length };
}

export interface BusinessValue {
  planned: number;
  actual: number;
  pct: number | null;
  /** Objectives without an actual business value yet. */
  missingActual: number;
}

/** Actual BV (all objectives) ÷ planned BV (committed objectives only). */
export function businessValue(objectives: PiObjective[]): BusinessValue {
  const planned = objectives.filter((o) => o.committed).reduce((s, o) => s + (o.plannedBV || 0), 0);
  const actual = objectives.reduce((s, o) => s + (o.actualBV ?? 0), 0);
  const missingActual = objectives.filter((o) => o.actualBV === null || o.actualBV === undefined).length;
  return { planned, actual, pct: pct(actual, planned), missingActual };
}

/** Sum of capacity documents of `nodeIds` for the given iterations. */
export function capacityTotal(docs: IterationCapacity[], nodeIds: Set<string>, sprintPaths: string[]): number {
  const paths = new Set(sprintPaths.map((p) => p.toLowerCase()));
  return docs
    .filter((d) => nodeIds.has(d.nodeId) && paths.has(d.iterationPath.toLowerCase()))
    .reduce((s, d) => s + (Number(d.capacity) || 0), 0);
}

export interface LoadCapacity {
  load: number;
  capacity: number;
  pct: number | null;
  unestimated: number;
}

export function loadVsCapacity(stories: RItem[], capacity: number): LoadCapacity {
  const p = pointsSummary(stories);
  return { load: p.planned, capacity, pct: pct(p.planned, capacity), unestimated: p.unestimated };
}

// ---------------------------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------------------------

/** Completed story points planned in an iteration (or PI) path. */
export function doneIn(stories: RItem[], path: string): number {
  return stories.filter((s) => isLive(s) && isDone(s) && inIteration(s, path)).reduce((a, s) => a + points(s), 0);
}

export interface Velocity {
  value: number | null;
  basis: string;
  /** Number of iterations (team) or PIs (train) the value is based on. */
  samples: number;
}

const byFinish = (a: Sprint, b: Sprint) => (a.finish ?? "").localeCompare(b.finish ?? "");

/**
 * Team velocity (average completed SP per iteration):
 * planned PI → last 5 completed iterations across PIs; current PI → completed iterations
 * of the PI; completed (or undated) PI → all iterations of the PI.
 */
export function teamVelocity(pi: ProgramIncrement, pis: ProgramIncrement[], stories: RItem[], today: number): Velocity {
  const status = piStatus(pi, today);
  let sprints: Sprint[];
  let basis: string;
  if (status === "planned") {
    sprints = pis
      .flatMap((p) => p.sprints)
      .filter((s) => isCompletedSprint(s, today))
      .sort(byFinish)
      .slice(-5);
    basis = "Ø last 5 completed iterations";
  } else if (status === "current") {
    sprints = pi.sprints.filter((s) => isCompletedSprint(s, today));
    basis = "Ø completed iterations of the PI";
  } else {
    sprints = pi.sprints;
    basis = "Ø all iterations of the PI";
  }
  const value = sprints.length ? round1(sprints.reduce((a, s) => a + doneIn(stories, s.path), 0) / sprints.length) : null;
  return { value, basis, samples: sprints.length };
}

/**
 * ART / Solution velocity (completed SP per PI):
 * planned PI → average of the last 5 completed PIs; current → to date; completed → PI total.
 */
export function trainVelocity(pi: ProgramIncrement, pis: ProgramIncrement[], stories: RItem[], today: number): Velocity {
  const status = piStatus(pi, today);
  if (status === "planned") {
    const done = pis
      .filter((p) => piStatus(p, today) === "completed")
      .sort(byFinish)
      .slice(-5);
    const value = done.length ? round1(done.reduce((a, p) => a + doneIn(stories, p.path), 0) / done.length) : null;
    return { value, basis: "Ø last 5 completed PIs", samples: done.length };
  }
  return { value: doneIn(stories, pi.path), basis: status === "current" ? "Velocity to date" : "PI total", samples: 1 };
}

// ---------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------

export type DepSource = "team" | "roadmap" | "combined";

export const DEP_SOURCE_LABEL: Record<DepSource, string> = {
  team: "Team planning",
  roadmap: "Roadmap",
  combined: "Combined",
};

/** Sprint index per item: own sprint, or for parents the latest sprint of a planned child. */
export function placements(items: RItem[], sprintPaths: string[]): Map<number, number> {
  const kids = new Map<number, RItem[]>();
  for (const i of items) if (i.parentId !== undefined) kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i]);
  const out = new Map<number, number>();
  for (const i of items) {
    const children = (kids.get(i.id) ?? []).filter(isLive);
    out.set(i.id, calculatedSprintIndex(i.iteration, children.map((c) => c.iteration), sprintPaths));
  }
  return out;
}

export interface DepRow {
  provider: RItem;
  consumer: RItem;
  internal: boolean;
  criticality: Criticality;
  /** Roadmap criticality shown next to the team-planning one in "combined" mode. */
  secondary?: Criticality;
}

export interface DepContext {
  items: Map<number, RItem>;
  /** Items that anchor the report (e.g. planned in the PI); a dependency needs one of them. */
  anchorIds: Set<number>;
  inScope: (item: RItem) => boolean;
  placement: Map<number, number>;
  meta: Map<number, WorkItemMeta>;
}

/** Criticality rows for provider→consumer pairs touching the anchor items. */
export function dependencyRows(deps: Dependency[], ctx: DepContext, source: DepSource): DepRow[] {
  const rows: DepRow[] = [];
  for (const d of deps) {
    if (!ctx.anchorIds.has(d.provider) && !ctx.anchorIds.has(d.consumer)) continue;
    const provider = ctx.items.get(d.provider);
    const consumer = ctx.items.get(d.consumer);
    if (!provider || !consumer || !isLive(provider) || !isLive(consumer)) continue;
    const done = isDone(provider);
    const team = criticalityByIteration(ctx.placement.get(provider.id) ?? -1, ctx.placement.get(consumer.id) ?? -1, done);
    const pm = ctx.meta.get(provider.id);
    const cm = ctx.meta.get(consumer.id);
    const roadmap = criticalityByDates({ end: pm?.plannedEnd }, { start: cm?.plannedStart, end: cm?.plannedEnd }, done);
    rows.push({
      provider,
      consumer,
      internal: ctx.inScope(provider) && ctx.inScope(consumer),
      criticality: source === "roadmap" ? roadmap : team,
      secondary: source === "combined" ? roadmap : undefined,
    });
  }
  const rank: Record<Criticality, number> = { critical: 0, atRisk: 1, healthy: 2, resolved: 3 };
  return rows.sort((a, b) => rank[a.criticality] - rank[b.criticality] || a.provider.id - b.provider.id || a.consumer.id - b.consumer.id);
}

// ---------------------------------------------------------------------------------------------
// Burnup
// ---------------------------------------------------------------------------------------------

export interface BurnupDay {
  day: number;
  date: string;
  scope: number;
  burned: number | null;
  ideal: number;
  forecast: number | null;
}

export interface Burnup {
  days: BurnupDay[];
  /** Scope on today (or on the PI's last day for a past PI); the ideal line ends here. */
  scope: number;
  bands: { name: string; from: number; to: number; ip: boolean }[];
  /** Index of today in `days`, or -1 when today is outside the PI. */
  todayIndex: number;
  /** Average SP per day used for the forecast. */
  dailyRate: number;
  /** "history": reconstructed from revisions; "current": from the stories' current state. */
  source?: "history" | "current";
}

/** What a burnup needs per day: the scope and the burned points at the end of day `d`. */
interface BurnupInput {
  scopeAt: (d: number) => number;
  burnedAt: (d: number) => number;
  /** Points completed within a (dated) iteration, for the forecast rate. */
  sprintDone: (s: Sprint) => number;
}

/**
 * Burnup over the PI's days: scope and burned per day up to today (scope stays at today's
 * value afterwards); ideal = 0 → scope linearly over the non-IP days; forecast = from today
 * at the average daily velocity of completed iterations (or the burn rate so far when no
 * iteration is complete), capped at scope.
 */
function buildBurnup(pi: ProgramIncrement, today: number, input: BurnupInput, source: Burnup["source"]): Burnup | null {
  if (!pi.start || !pi.finish) return null;
  const start = toDay(pi.start);
  const end = Math.max(start, toDay(pi.finish));
  const ref = Math.min(today, end);
  const scope = input.scopeAt(ref);

  const dated = pi.sprints.filter((s) => s.start && s.finish);
  const isIp = (s: Sprint) => isIpSprint(s, pi.name);
  const ipDay = (d: number) => dated.some((s) => isIp(s) && toDay(s.start!) <= d && d <= toDay(s.finish!));
  const allDays: number[] = [];
  for (let d = start; d <= end; d++) allDays.push(d);
  const workDays = allDays.filter((d) => !ipDay(d)).length;

  const completed = dated.filter((s) => !isIp(s) && isCompletedSprint(s, today));
  const completedDays = completed.reduce((a, s) => a + toDay(s.finish!) - toDay(s.start!) + 1, 0);
  const todayIndex = today >= start && today <= end ? today - start : -1;
  const burnedToday = todayIndex >= 0 ? input.burnedAt(today) : 0;
  const dailyRate =
    completedDays > 0
      ? completed.reduce((a, s) => a + input.sprintDone(s), 0) / completedDays
      : todayIndex >= 0
      ? burnedToday / (today - start + 1)
      : 0;

  let workSoFar = 0;
  const days = allDays.map((d) => {
    if (!ipDay(d)) workSoFar++;
    return {
      day: d,
      date: dayIso(d),
      scope: d <= ref ? input.scopeAt(d) : scope,
      burned: d <= today ? input.burnedAt(d) : null,
      ideal: workDays > 0 ? round1((scope * workSoFar) / workDays) : scope,
      forecast: todayIndex >= 0 && d >= today ? round1(Math.min(scope, burnedToday + dailyRate * (d - today))) : null,
    };
  });

  const bands = dated.map((s) => ({
    name: s.name,
    from: Math.max(0, toDay(s.start!) - start),
    to: Math.min(end, toDay(s.finish!)) - start,
    ip: isIp(s),
  }));
  return { days, scope, bands, todayIndex, dailyRate: round1(dailyRate), source };
}

/**
 * Burnup from the stories' current state: scope = current total SP; burned = cumulative SP
 * of completed stories by closed date.
 */
export function burnup(pi: ProgramIncrement, stories: RItem[], today: number): Burnup | null {
  if (!pi.start || !pi.finish) return null;
  const end = Math.max(toDay(pi.start), toDay(pi.finish));
  const live = stories.filter(isLive);
  const scope = live.reduce((a, s) => a + points(s), 0);
  const closeDay = (s: RItem) => (s.closedDate ? eventDay(s.closedDate) : Math.min(today, end));
  const done = live.filter(isDone).map((s) => ({ day: closeDay(s), sp: points(s) }));
  return buildBurnup(
    pi,
    today,
    {
      scopeAt: () => scope,
      burnedAt: (d) => done.filter((x) => x.day <= d).reduce((a, x) => a + x.sp, 0),
      sprintDone: (s) => doneIn(live, s.path),
    },
    "current"
  );
}

/** A work item revision as the reporting revisions API returns it. */
export interface RevisionLike {
  id: number;
  rev: number;
  fields: Record<string, any>;
}

export interface HistoryOptions {
  storyType: string;
  spField: string;
  /** Area paths of the unit; stories outside them don't count on that day. */
  areas: string[];
  categoryOf: (type: string, state: string) => string;
}

/** Fields the history burnup and flow time read from revisions. */
export function historyFields(spField: string): string[] {
  return [F.iteration, F.state, F.type, F.area, spField, F.changedDate];
}

/**
 * Burnup reconstructed from revision history. For each day, a story's last revision up to
 * that day decides: SCOPE counts its points when it was a live story planned under the PI in
 * the unit's areas; BURNED counts them when it was also in a Completed state.
 */
export function burnupFromHistory(pi: ProgramIncrement, revisions: RevisionLike[], opts: HistoryOptions, today: number): Burnup | null {
  if (!pi.start || !pi.finish) return null;
  type Entry = { day: number; rev: number; scope: number; done: number };
  const byId = new Map<number, Entry[]>();
  for (const r of revisions) {
    const f = r.fields;
    if (!f[F.changedDate]) continue;
    const category = opts.categoryOf(f[F.type], f[F.state]);
    const counts =
      f[F.type] === opts.storyType && isUnder(f[F.iteration], pi.path) && opts.areas.some((a) => isUnder(f[F.area], a)) && category !== "Removed";
    const sp = counts ? num(f[opts.spField]) ?? 0 : 0;
    const list = byId.get(r.id) ?? [];
    list.push({ day: eventDay(f[F.changedDate]), rev: r.rev, scope: sp, done: category === "Completed" ? sp : 0 });
    byId.set(r.id, list);
  }
  const timelines = Array.from(byId.values()).map((l) => l.sort((a, b) => a.day - b.day || a.rev - b.rev));
  const cache = new Map<number, { scope: number; done: number }>();
  const at = (d: number) => {
    let hit = cache.get(d);
    if (!hit) {
      hit = { scope: 0, done: 0 };
      for (const list of timelines) {
        let last: Entry | undefined;
        for (const e of list) {
          if (e.day > d) break;
          last = e;
        }
        if (last) {
          hit.scope += last.scope;
          hit.done += last.done;
        }
      }
      cache.set(d, hit);
    }
    return hit;
  };
  return buildBurnup(
    pi,
    today,
    {
      scopeAt: (d) => at(d).scope,
      burnedAt: (d) => at(d).done,
      sprintDone: (s) => at(toDay(s.finish!)).done - at(toDay(s.start!) - 1).done,
    },
    "history"
  );
}

/** First time each item entered an in-progress state (InProgress or Resolved category), from revisions. */
export function firstActiveDates(revisions: RevisionLike[], categoryOf: (type: string, state: string) => string): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of revisions) {
    const changed = r.fields[F.changedDate];
    const category = categoryOf(r.fields[F.type], r.fields[F.state]);
    if (!changed || (category !== "InProgress" && category !== "Resolved")) continue;
    const prev = out.get(r.id);
    if (!prev || Date.parse(changed) < Date.parse(prev)) out.set(r.id, changed);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------------------------

export function relativeDays(date: string, today: number): string {
  const diff = toDay(date) - today;
  if (diff === 0) return "today";
  const n = Math.abs(diff);
  const unit = n === 1 ? "day" : "days";
  return diff > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
}

/** Milestones of `nodeIds` dated within [from, to] (day numbers), by date. */
export function milestonesInWindow(milestones: Milestone[], nodeIds: Set<string>, from: number, to: number): Milestone[] {
  return milestones
    .filter((m) => nodeIds.has(m.nodeId) && toDay(m.date) >= from && toDay(m.date) <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------------------------
// Objectives & risks
// ---------------------------------------------------------------------------------------------

export interface TeamProgress {
  node: OrgNode;
  pct: number | null;
  planned: number;
  actual: number;
}

/** BV achievement per child (subtree objectives) and the average over children that have one. */
export function teamProgress(
  children: OrgNode[],
  objectives: PiObjective[],
  subtree: (n: OrgNode) => Set<string>
): { rows: TeamProgress[]; average: number | null } {
  const rows = children.map((c) => {
    const ids = subtree(c);
    const bv = businessValue(objectives.filter((o) => ids.has(o.nodeId)));
    return { node: c, pct: bv.pct, planned: bv.planned, actual: bv.actual };
  });
  const known = rows.filter((r) => r.pct !== null).map((r) => r.pct as number);
  return { rows, average: known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null };
}

export interface RiskRow {
  risk: Risk;
  exposure: Exposure;
  residual: Exposure;
}

/** Risks with exposure and residual exposure, highest exposure first. */
export function riskRows(risks: Risk[]): RiskRow[] {
  return risks
    .map((risk) => ({
      risk,
      exposure: exposure(risk.probability, risk.impactLevel),
      residual: exposure(risk.residualProbability, risk.residualImpact),
    }))
    .sort(
      (a, b) =>
        EXPOSURE_RANK[b.exposure] - EXPOSURE_RANK[a.exposure] ||
        EXPOSURE_RANK[b.residual] - EXPOSURE_RANK[a.residual] ||
        a.risk.title.localeCompare(b.risk.title)
    );
}

// ---------------------------------------------------------------------------------------------
// PI / Epic overview
// ---------------------------------------------------------------------------------------------

/** WSJF = (Business Value + Time Criticality) ÷ Effort (job size); null without effort. */
export function wsjf(i: RItem): number | null {
  return wsjfScore(i.businessValue, i.timeCriticality, i.rroe, i.effort);
}

/** The deepest team node whose area path contains `area`. */
export function teamOf(area: string | undefined, teams: OrgNode[]): OrgNode | undefined {
  return teams
    .filter((t) => t.areaPath && isUnder(area, t.areaPath))
    .sort((a, b) => b.areaPath!.length - a.areaPath!.length)[0];
}

export interface Split {
  todo: number;
  inProgress: number;
  done: number;
}

export function bucket(category: Category): keyof Split {
  if (category === "Completed") return "done";
  if (category === "Proposed") return "todo";
  return "inProgress";
}

export interface OverviewRow {
  item: RItem;
  wsjf: number | null;
  points: number;
  done: number;
  pct: number | null;
  split: Split;
  teams: { node: OrgNode; points: number }[];
  children: OverviewRow[];
}

/** Aggregates `stories` into one overview row (item may be a synthetic "no parent" group). */
function summarize(item: RItem, stories: RItem[], teams: OrgNode[], children: OverviewRow[]): OverviewRow {
  const split: Split = { todo: 0, inProgress: 0, done: 0 };
  const perTeam = new Map<string, { node: OrgNode; points: number }>();
  for (const s of stories) {
    split[bucket(s.category)] += points(s);
    const t = teamOf(s.area, teams);
    if (t) {
      const e = perTeam.get(t.id) ?? { node: t, points: 0 };
      e.points += points(s);
      perTeam.set(t.id, e);
    }
  }
  const total = split.todo + split.inProgress + split.done;
  return {
    item,
    wsjf: wsjf(item),
    points: total,
    done: split.done,
    pct: pct(split.done, total),
    split,
    teams: Array.from(perTeam.values()).sort((a, b) => b.points - a.points || a.node.name.localeCompare(b.node.name)),
    children,
  };
}

/**
 * Overview rows for `rootType` items. Only descendant stories accepted by `counts` contribute;
 * with `requireStories`, parents without any such story are dropped (PI Overview), otherwise
 * `keepRoot` decides (Epic Overview). Counted stories not under any row form an extra
 * "Without parent" row (id 0).
 */
export function overviewRows(opts: {
  items: RItem[];
  rootType: string;
  storyType: string;
  counts: (story: RItem) => boolean;
  teams: OrgNode[];
  keepRoot?: (root: RItem) => boolean;
  /** Only roots accepted here become rows (e.g. features directly under an epic). */
  rootFilter?: (root: RItem) => boolean;
  /** Stories already shown elsewhere; they don't become "Without parent" orphans. */
  exclude?: Set<number>;
}): { rows: OverviewRow[]; orphans: OverviewRow | null; covered: Set<number> } {
  const live = opts.items.filter(isLive);
  const byId = new Map(live.map((i) => [i.id, i]));
  const kids = new Map<number, RItem[]>();
  for (const i of live) if (i.parentId !== undefined && byId.has(i.parentId)) kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i]);
  const covered = new Set<number>();

  const build = (item: RItem, seen: Set<number>): { row: OverviewRow; stories: RItem[] } | null => {
    if (seen.has(item.id)) return null;
    const trail = new Set(seen).add(item.id);
    if (item.type === opts.storyType) {
      if (!opts.counts(item)) return null;
      return { row: summarize(item, [item], opts.teams, []), stories: [item] };
    }
    const children = (kids.get(item.id) ?? []).map((c) => build(c, trail)).filter((x): x is NonNullable<typeof x> => !!x);
    const stories = children.flatMap((c) => c.stories);
    if (stories.length === 0 && item.type !== opts.rootType) return null;
    return { row: summarize(item, stories, opts.teams, children.map((c) => c.row)), stories };
  };

  const rows: OverviewRow[] = [];
  for (const root of live.filter((i) => i.type === opts.rootType && (!opts.rootFilter || opts.rootFilter(i)))) {
    const built = build(root, new Set())!;
    const keep = opts.keepRoot ? opts.keepRoot(root) : built.stories.length > 0;
    if (!keep) continue;
    built.stories.forEach((s) => covered.add(s.id));
    rows.push(built.row);
  }
  rows.sort((a, b) => (b.wsjf ?? -1) - (a.wsjf ?? -1) || a.item.id - b.item.id);

  const loose = live.filter((i) => i.type === opts.storyType && opts.counts(i) && !covered.has(i.id) && !opts.exclude?.has(i.id));
  const orphans = loose.length
    ? summarize(
        { id: 0, type: "", title: "Without parent", state: "", category: "", sp: null, childIds: [] },
        loose,
        opts.teams,
        loose.map((s) => summarize(s, [s], opts.teams, []))
      )
    : null;
  return { rows, orphans, covered };
}

/**
 * Index over `items` returning the iterations of every live descendant of an item
 * (children, grandchildren, ...). Build once, query per row.
 */
export function descendantIterations(items: RItem[]): (rootId: number) => (string | undefined)[] {
  const kids = new Map<number, RItem[]>();
  for (const i of items) if (i.parentId !== undefined && isLive(i)) kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i]);
  return (rootId) => {
    const out: (string | undefined)[] = [];
    const seen = new Set<number>([rootId]);
    const walk = (id: number) => {
      for (const c of kids.get(id) ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c.iteration);
        walk(c.id);
      }
    };
    walk(rootId);
    return out;
  };
}

/**
 * Estimated completion: the finish date of the latest sprint any of `iterations` is planned
 * in (items planned on a PI or outside any sprint don't count). Null when none is.
 */
export function estimatedCompletion(iterations: (string | undefined)[], sprints: Sprint[]): string | null {
  let best: string | null = null;
  for (const s of sprints) {
    if (!s.finish || !iterations.some((it) => isUnder(it, s.path))) continue;
    if (!best || toDay(s.finish) > toDay(best)) best = s.finish;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Queries ("Open in query")
// ---------------------------------------------------------------------------------------------

/** WIQL listing exactly the given work items (for "Open in query"); null without ids. */
export function idsQuery(ids: number[]): string | null {
  const unique = Array.from(new Set(ids.filter((id) => id > 0))).sort((a, b) => a - b);
  if (unique.length === 0) return null;
  return (
    `SELECT [${F.id}], [${F.type}], [${F.title}], [${F.state}], [${F.area}], [${F.iteration}] FROM WorkItems ` +
    `WHERE [System.TeamProject] = @project AND [${F.id}] IN (${unique.join(", ")}) ORDER BY [${F.id}] ASC`
  );
}

/** Ids of the rows of an overview tree, including every expanded level (synthetic rows excluded). */
export function overviewIds(rows: OverviewRow[]): number[] {
  const out: number[] = [];
  const walk = (r: OverviewRow) => {
    if (r.item.id > 0) out.push(r.item.id);
    r.children.forEach(walk);
  };
  rows.forEach(walk);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Flow metrics (SAFe flow velocity / time / load / distribution)
// ---------------------------------------------------------------------------------------------

export interface FlowMetrics {
  /** Items completed per iteration of the PI. */
  velocity: { name: string; path: string; ip: boolean; count: number }[];
  /** Items completed in the PI. */
  completed: number;
  /** Days from start (activated) to closed, over completed items with both dates. */
  time: { median: number | null; average: number | null; samples: number; missing: number };
  /** Work in progress now (InProgress or Resolved category). */
  load: number;
  /** Completed items by type, largest share first. */
  distribution: { type: string; count: number; pct: number }[];
}

const within = (iso: string | undefined, s: Sprint) => !!iso && !!s.start && !!s.finish && eventDay(iso) >= toDay(s.start) && eventDay(iso) <= toDay(s.finish);

/** Whether a done item was completed in `s`: by closed date when both are dated, else by iteration path. */
function completedIn(i: RItem, s: Sprint): boolean {
  if (!isDone(i) || !isLive(i)) return false;
  return i.closedDate && s.start && s.finish ? within(i.closedDate, s) : inIteration(i, s.path);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return round1(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
}

/**
 * Flow metrics of `items` (the unit's flow items) for a PI. `firstActive` supplies start
 * dates from revision history for items without an activated date.
 */
export function flowMetrics(items: RItem[], pi: ProgramIncrement, firstActive: Map<number, string> = new Map()): FlowMetrics {
  const done = items.filter((i) => completedIn(i, pi));
  const velocity = pi.sprints.map((s) => ({ name: s.name, path: s.path, ip: isIpSprint(s, pi.name), count: items.filter((i) => completedIn(i, s)).length }));
  const durations: number[] = [];
  let missing = 0;
  for (const i of done) {
    const start = i.activatedDate ?? firstActive.get(i.id);
    if (!start || !i.closedDate) missing++;
    else durations.push(Math.max(0, eventDay(i.closedDate) - eventDay(start)));
  }
  const byType = new Map<string, number>();
  for (const i of done) byType.set(i.type, (byType.get(i.type) ?? 0) + 1);
  return {
    velocity,
    completed: done.length,
    time: {
      median: median(durations),
      average: durations.length ? round1(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      samples: durations.length,
      missing,
    },
    load: items.filter((i) => isLive(i) && (i.category === "InProgress" || i.category === "Resolved")).length,
    distribution: Array.from(byType.entries())
      .map(([type, count]) => ({ type, count, pct: Math.round((count / done.length) * 100) }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  };
}

// ---------------------------------------------------------------------------------------------
// PI snapshots (completed PIs keep the numbers recorded at PI end)
// ---------------------------------------------------------------------------------------------

export interface PiSnapshot {
  /** `${nodeId}|${pi.identifier}` */
  id: string;
  nodeId: string;
  piPath: string;
  piId: string;
  piName: string;
  createdAt: string;
  points: PointsSummary;
  velocity: Velocity;
  /** Completed SP per iteration of the PI. */
  sprintVelocity: { name: string; path: string; done: number }[];
  load: LoadCapacity;
  burnup: Burnup | null;
  __etag?: number;
}

export const snapshotId = (nodeId: string, pi: Sprint) => `${nodeId}|${pi.identifier}`;

/** The numbers of a completed PI as the report shows them, for storing at PI end. */
export function buildSnapshot(opts: {
  nodeId: string;
  team: boolean;
  pi: ProgramIncrement;
  stories: RItem[];
  piStories: RItem[];
  capacity: number;
  burnup: Burnup | null;
  today: number;
  now?: Date;
}): PiSnapshot {
  const { pi, stories, piStories, today } = opts;
  return {
    id: snapshotId(opts.nodeId, pi),
    nodeId: opts.nodeId,
    piPath: pi.path,
    piId: pi.identifier,
    piName: pi.name,
    createdAt: (opts.now ?? new Date()).toISOString(),
    points: pointsSummary(piStories),
    velocity: opts.team ? teamVelocity(pi, [], stories, today) : trainVelocity(pi, [], stories, today),
    sprintVelocity: pi.sprints.map((s) => ({ name: s.name, path: s.path, done: doneIn(stories, s.path) })),
    load: loadVsCapacity(piStories, opts.capacity),
    burnup: opts.burnup,
  };
}

// ---------------------------------------------------------------------------------------------
// Iteration overview (team)
// ---------------------------------------------------------------------------------------------

export interface IterationSummary {
  count: number;
  planned: number;
  done: number;
  capacity: number | null;
  groups: { parentId: number | null; items: RItem[] }[];
}

export function iterationSummary(stories: RItem[], sprint: Sprint, capacity: number | null): IterationSummary {
  const items = stories.filter((s) => isLive(s) && inIteration(s, sprint.path));
  const p = pointsSummary(items);
  const groups = new Map<number | null, RItem[]>();
  for (const i of items) {
    const key = i.parentId ?? null;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  return {
    count: items.length,
    planned: p.planned,
    done: p.done,
    capacity,
    groups: Array.from(groups.entries())
      .map(([parentId, list]) => ({ parentId, items: list }))
      .sort((a, b) => (a.parentId === null ? 1 : b.parentId === null ? -1 : a.parentId - b.parentId)),
  };
}

/** Index of the iteration to show first: the current one, else the first. */
export function defaultIterationIndex(pi: ProgramIncrement, today: number): number {
  return Math.max(0, pi.sprints.findIndex((s) => piStatus(s, today) === "current"));
}
