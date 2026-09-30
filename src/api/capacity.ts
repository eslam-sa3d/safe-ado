import { api, ApiError, getBaseUrl, getProject, mapLimit } from "./client";
import { findCapacity } from "./data";
import { CapacitySettings, CapacitySource, IterationCapacity, OrgNode, SafeConfig, Sprint } from "./types";
import { getTeams } from "./wit";

/**
 * Team capacity has two possible sources:
 *  - manual story points per team and iteration, stored by SAFe Ado (IterationCapacity documents);
 *  - Azure DevOps' own team capacity (hours per person per day, activities, days off), converted
 *    to story points with SAFe normalized estimation: every available person-day is worth
 *    `pointsPerPersonDay` points (0.8 by default, so a full-time member in a 2-week iteration
 *    yields 8 points).
 *
 * The project setting (Setup → Capacity) picks the source. `resolveCapacity` is the single place
 * that decides the effective value and its origin, so every view shows the same number.
 */

export const DEFAULT_POINTS_PER_PERSON_DAY = 0.8;

/** Weekday indexes (0 = Sunday) Azure DevOps uses when a team has no working-day settings. */
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export const CAPACITY_SOURCE_LABEL: Record<CapacitySource, string> = {
  manual: "Manual story points",
  derived: "Derived from Azure DevOps team capacity",
  hybrid: "Hybrid (derived, manual override wins)",
};

/** The project's capacity settings with defaults (existing configs keep manual story points). */
export function capacitySettings(config: Pick<SafeConfig, "capacity">): Required<CapacitySettings> {
  const source: CapacitySource = config.capacity?.source === "derived" || config.capacity?.source === "hybrid" ? config.capacity.source : "manual";
  const f = Number(config.capacity?.pointsPerPersonDay);
  return { source, pointsPerPersonDay: Number.isFinite(f) && f > 0 ? f : DEFAULT_POINTS_PER_PERSON_DAY };
}

// ---------------------------------------------------------------------------------------------
// Azure DevOps responses
// ---------------------------------------------------------------------------------------------

export interface DateRange {
  start: string;
  end: string;
}

export interface MemberCapacity {
  teamMember?: { id?: string; displayName?: string; uniqueName?: string };
  activities?: { capacityPerDay?: number; name?: string }[];
  daysOff?: DateRange[];
}

/**
 * Members of a capacities response. Older servers answer with a bare array (or `{ value }`),
 * Azure DevOps Services 7.x wraps them in `{ teamMembers, totalCapacityPerDay, totalDaysOff }`.
 */
export function capacityMembers(res: unknown): MemberCapacity[] {
  if (Array.isArray(res)) return res;
  const r = res as { teamMembers?: unknown; value?: unknown } | null | undefined;
  if (Array.isArray(r?.teamMembers)) return r!.teamMembers as MemberCapacity[];
  if (Array.isArray(r?.value)) return r!.value as MemberCapacity[];
  return [];
}

/** Working days as weekday indexes. Accepts names ("monday") or DayOfWeek numbers; defaults to Mon–Fri. */
export function normalizeWorkingDays(days: unknown): number[] {
  if (!Array.isArray(days)) return DEFAULT_WORKING_DAYS;
  const out = days
    .map((d) => (typeof d === "number" ? d : DAY_NAMES.indexOf(String(d).toLowerCase())))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return out.length ? Array.from(new Set(out)).sort() : DEFAULT_WORKING_DAYS;
}

// ---------------------------------------------------------------------------------------------
// Calculation (pure)
// ---------------------------------------------------------------------------------------------

const DAY = 86_400_000;
/** Calendar day (UTC midnight) of an ISO date or date-time; NaN when unparsable. */
const dayOf = (iso: string) => Date.parse(String(iso).slice(0, 10) + "T00:00:00Z");
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The calendar days (YYYY-MM-DD) covered by the given inclusive ranges. */
export function expandDays(ranges: DateRange[] = []): Set<string> {
  const out = new Set<string>();
  for (const r of ranges) {
    const from = dayOf(r.start);
    const to = dayOf(r.end ?? r.start);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    // Guard against absurd ranges (a year is plenty for an iteration).
    for (let t = from; t <= to && t - from <= 366 * DAY; t += DAY) out.add(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Working days from start to finish (inclusive) that are not in any of the `off` sets. */
export function availableDays(start: string, finish: string, workingDays: number[], ...off: Set<string>[]): number {
  const from = dayOf(start);
  const to = dayOf(finish);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  let n = 0;
  for (let t = from; t <= to; t += DAY) {
    const d = new Date(t);
    const key = d.toISOString().slice(0, 10);
    if (workingDays.includes(d.getUTCDay()) && !off.some((s) => s.has(key))) n++;
  }
  return n;
}

export interface MemberBreakdown {
  name: string;
  /** Working days of the iteration the member is available (team and personal days off excluded). */
  days: number;
  /** Whether the member has capacity per day > 0 in any activity (only those count). */
  counted: boolean;
  points: number;
}

export interface DerivedCapacity {
  points: number;
  /** Available person-days of the counted members. */
  personDays: number;
  /** Working days of the iteration minus team days off. */
  iterationDays: number;
  factor: number;
  members: MemberBreakdown[];
}

/**
 * SAFe normalized estimation from Azure DevOps team capacity: each member with capacity per
 * day > 0 contributes (available working days × factor) points. Returns null when no member has
 * any capacity set (the team has not set up capacity for the iteration).
 */
export function deriveCapacity(
  input: { start: string; finish: string; workingDays: number[]; teamDaysOff?: DateRange[]; members: MemberCapacity[] },
  factor: number
): DerivedCapacity | null {
  const teamOff = expandDays(input.teamDaysOff);
  const members = input.members.map((m): MemberBreakdown => {
    const counted = (m.activities ?? []).some((a) => Number(a.capacityPerDay) > 0);
    const days = availableDays(input.start, input.finish, input.workingDays, teamOff, expandDays(m.daysOff));
    return {
      name: m.teamMember?.displayName ?? m.teamMember?.uniqueName ?? "Unknown member",
      days,
      counted,
      points: counted ? round1(days * factor) : 0,
    };
  });
  if (!members.some((m) => m.counted)) return null;
  const personDays = members.filter((m) => m.counted).reduce((s, m) => s + m.days, 0);
  return {
    points: round1(personDays * factor),
    personDays,
    iterationDays: availableDays(input.start, input.finish, input.workingDays, teamOff),
    factor,
    members,
  };
}

// ---------------------------------------------------------------------------------------------
// Loading from Azure DevOps (api-version 7.0)
// ---------------------------------------------------------------------------------------------

/** Derived capacity of one team for one iteration, or why there is none. */
export interface DerivedResult {
  derived: DerivedCapacity | null;
  /** Why `derived` is null (no team linked, nothing set up in Azure DevOps, request failed…). */
  reason?: string;
  /** The team's capacity page in Azure DevOps for the iteration. */
  capacityUrl?: string;
}

export type DerivedMap = Map<string, DerivedResult>;

export const derivedKey = (nodeId: string, sprint: Pick<Sprint, "identifier">) => `${nodeId}|${sprint.identifier}`;

const p = () => encodeURIComponent(getProject().id);
const teamBase = (teamId: string) => `${p()}/${encodeURIComponent(teamId)}/_apis/work/teamsettings`;

export async function getTeamWorkingDays(teamId: string): Promise<number[]> {
  const res = await api<{ workingDays?: unknown }>(teamBase(teamId));
  return normalizeWorkingDays(res?.workingDays);
}

export async function getTeamCapacities(teamId: string, iterationId: string): Promise<MemberCapacity[]> {
  return capacityMembers(await api<unknown>(`${teamBase(teamId)}/iterations/${encodeURIComponent(iterationId)}/capacities`));
}

export async function getTeamDaysOff(teamId: string, iterationId: string): Promise<DateRange[]> {
  const res = await api<{ daysOff?: DateRange[] } | undefined>(`${teamBase(teamId)}/iterations/${encodeURIComponent(iterationId)}/teamdaysoff`);
  return res?.daysOff ?? [];
}

/** The team's capacity page of the iteration (Boards → Sprints → Capacity). */
export function capacityPageUrl(baseUrl: string, projectName: string, teamName: string, iterationPath: string): string {
  const iteration = iterationPath.split("\\").map(encodeURIComponent).join("/");
  return `${baseUrl}${encodeURIComponent(projectName)}/_sprints/capacity/${encodeURIComponent(teamName)}/${iteration}`;
}

/**
 * Reads Azure DevOps team capacity for the given teams and iterations. Does nothing (no
 * requests) when the project uses manual capacity. Failures are reported per entry, never thrown.
 */
export async function loadDerivedCapacity(config: Pick<SafeConfig, "capacity">, teams: OrgNode[], sprints: Sprint[]): Promise<DerivedMap> {
  const settings = capacitySettings(config);
  const out: DerivedMap = new Map();
  if (settings.source === "manual" || teams.length === 0 || sprints.length === 0) return out;

  const [base, names] = await Promise.all([getBaseUrl(), getTeams().catch(() => [])]);
  const project = getProject().name;
  const pairs = teams.flatMap((team) => sprints.map((sprint) => ({ team, sprint })));
  const workingDays = new Map<string, Promise<number[]>>();
  const daysOf = (teamId: string) => {
    if (!workingDays.has(teamId)) workingDays.set(teamId, getTeamWorkingDays(teamId).catch(() => DEFAULT_WORKING_DAYS));
    return workingDays.get(teamId)!;
  };

  await mapLimit(pairs, 4, async ({ team, sprint }) => {
    const key = derivedKey(team.id, sprint);
    if (!team.teamId) {
      out.set(key, { derived: null, reason: `No Azure DevOps team is linked to ${team.name}. Link one in Setup.` });
      return;
    }
    const teamName = names.find((t) => t.id === team.teamId)?.name ?? team.teamId;
    const capacityUrl = capacityPageUrl(base, project, teamName, sprint.path);
    if (!sprint.start || !sprint.finish) {
      out.set(key, { derived: null, reason: `${sprint.name} has no dates.`, capacityUrl });
      return;
    }
    try {
      const [wd, members, teamDaysOff] = await Promise.all([
        daysOf(team.teamId),
        getTeamCapacities(team.teamId, sprint.identifier),
        getTeamDaysOff(team.teamId, sprint.identifier).catch(() => [] as DateRange[]),
      ]);
      const derived = deriveCapacity({ start: sprint.start, finish: sprint.finish, workingDays: wd, teamDaysOff, members }, settings.pointsPerPersonDay);
      out.set(key, derived ? { derived, capacityUrl } : { derived: null, reason: "No capacity is set up for the team in Azure DevOps.", capacityUrl });
    } catch (e: any) {
      const reason =
        e instanceof ApiError && e.status === 404
          ? `${sprint.name} is not selected as a team iteration in Azure DevOps.`
          : `Could not read the Azure DevOps capacity: ${e?.message ?? e}`;
      out.set(key, { derived: null, reason, capacityUrl });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Effective capacity (the one place that decides what views show)
// ---------------------------------------------------------------------------------------------

/** Where an effective capacity value comes from. */
export type CapacityOrigin = "manual" | "derived" | "override" | "none";

export const ORIGIN_LABEL: Record<CapacityOrigin, string> = {
  manual: "manual",
  derived: "derived",
  override: "override",
  none: "not set",
};

export interface EffectiveCapacity {
  /** Story points, undefined when not set. */
  value: number | undefined;
  origin: CapacityOrigin;
  source: CapacitySource;
  manual?: number;
  derived?: DerivedCapacity | null;
  reason?: string;
  capacityUrl?: string;
  /** Tooltip text explaining the value. */
  explanation: string;
}

function derivedText(d: DerivedCapacity): string {
  const counted = d.members.filter((m) => m.counted);
  const lines = d.members.map((m) => `• ${m.name}: ${m.counted ? `${m.days} days → ${m.points} SP` : "no capacity per day, not counted"}`);
  return [
    `Derived from Azure DevOps team capacity (SAFe normalized estimation): ${d.personDays} available person-days × ${d.factor} SP = ${d.points} SP.`,
    `${counted.length} member${counted.length === 1 ? "" : "s"} with capacity; ${d.iterationDays} working days in the iteration (weekends and team days off excluded), minus personal days off.`,
    ...lines,
  ].join("\n");
}

/**
 * Resolves the capacity to show for one team and iteration.
 *  - manual: the stored story points;
 *  - derived: the value computed from Azure DevOps (manual values are ignored);
 *  - hybrid: a stored manual value overrides the derived one.
 */
export function resolveCapacity(settings: Pick<CapacitySettings, "source">, manual: number | undefined, derived: DerivedResult | undefined): EffectiveCapacity {
  const source = settings.source;
  const d = derived?.derived ?? null;
  const base = { source, manual, derived: d, reason: derived?.reason, capacityUrl: derived?.capacityUrl };
  if (source === "manual") {
    return manual === undefined
      ? { ...base, value: undefined, origin: "none", explanation: "Not set: no capacity entered in SAFe Ado." }
      : { ...base, value: manual, origin: "manual", explanation: `Manual: ${manual} SP entered in SAFe Ado.` };
  }
  if (source === "hybrid" && manual !== undefined) {
    const from = d ? `derived from Azure DevOps: ${d.points} SP` : `no derived value${derived?.reason ? ` — ${derived.reason}` : ""}`;
    return { ...base, value: manual, origin: "override", explanation: `Manual override: ${manual} SP (${from}). Clear it to use the derived value.` };
  }
  if (d) return { ...base, value: d.points, origin: "derived", explanation: derivedText(d) };
  const why = derived?.reason ?? "Azure DevOps team capacity is not loaded.";
  return { ...base, value: undefined, origin: "none", explanation: `Not set: ${why}` };
}

/** Effective capacity of `nodeId` in `sprint` from the stored documents and the derived map. */
export function effectiveCapacity(
  config: Pick<SafeConfig, "capacity">,
  docs: IterationCapacity[],
  derived: DerivedMap | undefined,
  nodeId: string,
  sprint: Pick<Sprint, "identifier" | "path">
): EffectiveCapacity {
  const doc = findCapacity(docs, nodeId, sprint);
  const manual = doc && Number.isFinite(Number(doc.capacity)) ? Number(doc.capacity) : undefined;
  return resolveCapacity(capacitySettings(config), manual, derived?.get(derivedKey(nodeId, sprint)));
}

export interface CapacityTotal {
  value: number;
  /** Distinct origins of the entries that have a value. */
  origins: CapacityOrigin[];
  /** Entries without a value. */
  missing: number;
  count: number;
  explanation: string;
}

/** Sums effective capacities (e.g. all teams of an ART over a PI's iterations). */
export function totalCapacity(list: EffectiveCapacity[]): CapacityTotal {
  const set = list.filter((c) => c.value !== undefined);
  const value = round1(set.reduce((s, c) => s + c.value!, 0));
  const origins = Array.from(new Set(set.map((c) => c.origin)));
  const missing = list.length - set.length;
  const parts = (["manual", "derived", "override"] as CapacityOrigin[])
    .map((o) => {
      const of = set.filter((c) => c.origin === o);
      return of.length ? `${of.length} ${ORIGIN_LABEL[o]} (${round1(of.reduce((s, c) => s + c.value!, 0))} SP)` : "";
    })
    .filter(Boolean);
  const explanation =
    `${value} SP from ${set.length} of ${list.length} team iteration${list.length === 1 ? "" : "s"}` +
    (parts.length ? `: ${parts.join(", ")}` : "") +
    (missing ? `. ${missing} not set.` : ".");
  return { value, origins, missing, count: list.length, explanation };
}

/** One origin for a badge: the single origin, "mixed" when several, or "none". */
export function totalOrigin(t: CapacityTotal): CapacityOrigin | "mixed" {
  return t.origins.length === 0 ? "none" : t.origins.length === 1 ? t.origins[0] : "mixed";
}
