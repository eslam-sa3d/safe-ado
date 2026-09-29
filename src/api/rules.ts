import { F } from "./types";

/**
 * Shared SAFe rules. Every view uses these so dates, IP iterations and WSJF are computed the
 * same way everywhere.
 */

/** Today's date (YYYY-MM-DD) in the user's local time zone, not UTC. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const IP_PATTERN = /\bIP\b|innovation\s*(?:&|and|\+)\s*planning/i;

/**
 * Whether an iteration is an Innovation & Planning iteration. The PI name prefix is removed
 * first, so a PI called e.g. "IP-2026" doesn't mark all of its sprints as IP.
 */
export function isIpIteration(name: string, piName?: string): boolean {
  let rest = name;
  if (piName && rest.toLowerCase().startsWith(piName.toLowerCase())) rest = rest.slice(piName.length);
  return IP_PATTERN.test(rest);
}

/** Default reference name of the optional "Risk Reduction / Opportunity Enablement" field. */
export const DEFAULT_RROE_FIELD = "Custom.RROEValue";

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * WSJF = Cost of Delay ÷ Job Size, where Cost of Delay = Business Value + Time Criticality
 * + RR/OE. Null when there is no job size or no cost-of-delay input at all.
 */
export function wsjfScore(businessValue?: number, timeCriticality?: number, rroe?: number, jobSize?: number): number | null {
  if (!jobSize || jobSize <= 0) return null;
  if (businessValue === undefined && timeCriticality === undefined && rroe === undefined) return null;
  const cod = (businessValue ?? 0) + (timeCriticality ?? 0) + (rroe ?? 0);
  return cod > 0 ? round1(cod / jobSize) : null;
}

const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v) || 0);

/** WSJF from work item fields; `rroeField` is the process's RR/OE field when it has one. */
export function wsjfOf(fields: Record<string, unknown>, rroeField: string = DEFAULT_RROE_FIELD): number | null {
  return wsjfScore(num(fields[F.businessValue]), num(fields[F.timeCriticality]), num(fields[rroeField]), num(fields[F.effort]));
}

/** SAFe's modified Fibonacci scale for WSJF inputs. */
export const WSJF_SCALE = [1, 2, 3, 5, 8, 13, 20, 40, 100];
export const isOnWsjfScale = (n: number) => WSJF_SCALE.includes(n);
