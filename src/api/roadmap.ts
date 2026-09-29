import { F, Level, ProgramIncrement, WorkItemMeta } from "./types";

/**
 * Pure date / geometry logic for the Roadmap (Agile Hive parity). Dates are whole UTC days;
 * ranges are inclusive and stored as YYYY-MM-DD.
 */

export const DAY_MS = 86_400_000;

export type Zoom = "weeks" | "months" | "quarters";
export const ZOOMS: Zoom[] = ["weeks", "months", "quarters"];
export const ZOOM_LABEL: Record<Zoom, string> = { weeks: "Weeks", months: "Months", quarters: "Quarters" };
/** Pixels per day for each zoom level. */
export const ZOOM_PX: Record<Zoom, number> = { weeks: 20, months: 5, quarters: 2 };

export interface DateRange {
  /** YYYY-MM-DD, inclusive */
  start: string;
  /** YYYY-MM-DD, inclusive */
  end: string;
}

/** Day number (days since 1970-01-01 UTC) of a YYYY-MM-DD or ISO date-time string. */
export function toDay(date: string): number {
  return Math.floor(Date.parse(date.slice(0, 10) + "T00:00:00Z") / DAY_MS);
}

/** YYYY-MM-DD of a day number. */
export function fromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function todayIso(now = Date.now()): string {
  return fromDay(Math.floor(now / DAY_MS));
}

export function addDays(date: string, days: number): string {
  return fromDay(toDay(date) + days);
}

/** ISO date-time (midnight UTC) for Azure DevOps date fields. */
export function toIsoDateTime(date: string): string {
  return `${date.slice(0, 10)}T00:00:00Z`;
}

export function dateToX(date: string, origin: string, pxPerDay: number): number {
  return (toDay(date) - toDay(origin)) * pxPerDay;
}

export function xToDate(x: number, origin: string, pxPerDay: number): string {
  return addDays(origin, Math.floor(x / pxPerDay));
}

/** Number of days in an inclusive range. */
export function rangeDays(r: DateRange): number {
  return toDay(r.end) - toDay(r.start) + 1;
}

/** Days two inclusive ranges share (0 when disjoint). */
export function overlapDays(a: DateRange, b: DateRange): number {
  const start = Math.max(toDay(a.start), toDay(b.start));
  const end = Math.min(toDay(a.end), toDay(b.end));
  return Math.max(0, end - start + 1);
}

/** Agile Hive's default duration when an item is first planned on the roadmap. */
export function defaultDuration(level: Level): number {
  switch (level) {
    case "portfolio":
      return 60;
    case "solution":
      return 30;
    default:
      return 21;
  }
}

export function planFrom(start: string, days: number): DateRange {
  return { start, end: addDays(start, Math.max(1, days) - 1) };
}

export function shiftRange(r: DateRange, days: number): DateRange {
  return { start: addDays(r.start, days), end: addDays(r.end, days) };
}

/** Moves one edge by `days`, never letting the range shrink below one day. */
export function resizeRange(r: DateRange, edge: "start" | "end", days: number): DateRange {
  if (edge === "start") return { start: fromDay(Math.min(toDay(r.start) + days, toDay(r.end))), end: r.end };
  return { start: r.start, end: fromDay(Math.max(toDay(r.end) + days, toDay(r.start))) };
}

/**
 * Planned range of an item: the roadmap metadata, falling back to the ADO Start/Target Date
 * fields. Undefined when the item is unplanned.
 */
export function resolveRange(meta?: Partial<WorkItemMeta>, fields?: Record<string, any>): DateRange | undefined {
  let start = meta?.plannedStart;
  let end = meta?.plannedEnd;
  if (!start || !end) {
    start = fields?.[F.startDate];
    end = fields?.[F.targetDate];
  }
  if (!start || !end) return undefined;
  const a = start.slice(0, 10);
  const b = end.slice(0, 10);
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

function piRange(pi: ProgramIncrement): DateRange | undefined {
  return pi.start && pi.finish ? { start: pi.start.slice(0, 10), end: pi.finish.slice(0, 10) } : undefined;
}

/**
 * Agile Hive auto-assignment (ART level): every current or future PI (finish >= today)
 * overlapping the range by at least one day. Past PIs already assigned (and paths that are
 * not known PIs) are kept; current/future PIs that no longer overlap are dropped.
 */
export function autoAssignPis(existing: string[], range: DateRange, pis: ProgramIncrement[], today: string): string[] {
  const byPath = new Map(pis.map((p) => [p.path, p]));
  const isPast = (p: ProgramIncrement) => !!p.finish && p.finish.slice(0, 10) < today;
  const keep = existing.filter((path) => {
    const pi = byPath.get(path);
    return !pi || isPast(pi) || !piRange(pi);
  });
  const add = pis.filter((p) => {
    const r = piRange(p);
    return r && !isPast(p) && overlapDays(r, range) >= 1;
  });
  return Array.from(new Set([...keep, ...add.map((p) => p.path)]));
}

/** Timeline bounds covering all `dates` with padding before and after. */
export function timelineBounds(dates: string[], padBefore = 14, padAfter = 30): DateRange {
  const days = dates.filter(Boolean).map(toDay);
  const min = Math.min(...days);
  const max = Math.max(...days);
  return { start: fromDay(min - padBefore), end: fromDay(max + padAfter) };
}

export interface LaneEntry {
  id: number;
  range: DateRange;
  lane?: number;
}

/**
 * Lane per item: explicit lanes are kept; the rest are packed by start date into the lowest
 * lane where they don't overlap anything already placed.
 */
export function packLanes(entries: LaneEntry[]): Map<number, number> {
  const out = new Map<number, number>();
  const placed: { range: DateRange; lane: number }[] = [];
  for (const e of entries) {
    if (e.lane !== undefined && e.lane >= 0) {
      out.set(e.id, e.lane);
      placed.push({ range: e.range, lane: e.lane });
    }
  }
  const rest = entries.filter((e) => !out.has(e.id)).sort((a, b) => a.range.start.localeCompare(b.range.start) || a.id - b.id);
  for (const e of rest) {
    const lane = freeLane(0, e.range, placed);
    out.set(e.id, lane);
    placed.push({ range: e.range, lane });
  }
  return out;
}

/** First lane at or below `target` where `range` does not overlap an occupied slot. */
export function freeLane(target: number, range: DateRange, occupied: { range: DateRange; lane: number }[]): number {
  let lane = Math.max(0, target);
  while (occupied.some((o) => o.lane === lane && overlapDays(o.range, range) > 0)) lane++;
  return lane;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Short "Sep 28" label. */
export function shortDate(date: string): string {
  const d = new Date(toDay(date) * DAY_MS);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Axis ticks for a zoom level: Mondays (weeks), month starts (months) or quarter starts. */
export function axisTicks(bounds: DateRange, zoom: Zoom): { date: string; label: string }[] {
  const out: { date: string; label: string }[] = [];
  const end = toDay(bounds.end);
  for (let day = toDay(bounds.start); day <= end; day++) {
    const d = new Date(day * DAY_MS);
    const month = d.getUTCMonth();
    const year = d.getUTCFullYear();
    if (zoom === "weeks") {
      // Day 0 (1970-01-01) was a Thursday, so Mondays satisfy (day + 3) % 7 === 0.
      if ((((day + 3) % 7) + 7) % 7 === 0) out.push({ date: fromDay(day), label: shortDate(fromDay(day)) });
    } else if (d.getUTCDate() === 1) {
      if (zoom === "months") out.push({ date: fromDay(day), label: `${MONTHS[month]} ${year}` });
      else if (month % 3 === 0) out.push({ date: fromDay(day), label: `Q${month / 3 + 1} ${year}` });
    }
  }
  return out;
}
