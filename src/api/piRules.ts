import { ProgramIncrement, Sprint } from "./types";
import { isIpIteration } from "./rules";

/** Agile Hive PI / iteration rules used by the PIs & Iterations view. */

export const MAX_ITERATIONS = 10;

export type PiStatus = "planned" | "current" | "completed";

/** YYYY-MM-DD part of an ISO date (or "" when missing). */
export const dayOf = (iso?: string) => (iso ?? "").slice(0, 10);

/** The ISO form Azure DevOps expects for iteration dates. */
export const toIso = (day: string) => `${day}T00:00:00Z`;

/** IP iteration detection (shared rule, see api/rules.ts). */
export const isIp = (name: string, piName?: string) => isIpIteration(name, piName);

export function piStatus(pi: Sprint, today: string): PiStatus {
  if (pi.finish && dayOf(pi.finish) < today) return "completed";
  if (pi.start && dayOf(pi.start) <= today) return "current";
  return "planned";
}

interface Range {
  start?: string;
  finish?: string;
}

/** True when two dated ranges share at least one day. Undated ranges never overlap. */
export function overlaps(a: Range, b: Range): boolean {
  if (!a.start || !a.finish || !b.start || !b.finish) return false;
  return dayOf(a.start) <= dayOf(b.finish) && dayOf(b.start) <= dayOf(a.finish);
}

/** Characters Azure DevOps does not allow in iteration (classification node) names. */
export const FORBIDDEN_NAME_CHARS = ["\\", "/", "$", "?", "*", ":", '"', "&", ">", "<", "#", "%", "|", "+"];
export const MAX_NAME_LENGTH = 255;

/**
 * Checks a PI / iteration name against Azure DevOps' classification node naming rules.
 * Returns the problem, or null when the name is acceptable. An empty name is reported by the callers.
 */
export function nameError(name: string): string | null {
  if (!name.trim()) return null;
  if (name.length > MAX_NAME_LENGTH) return `Names can have at most ${MAX_NAME_LENGTH} characters.`;
  const bad = FORBIDDEN_NAME_CHARS.filter((c) => name.includes(c));
  if (bad.length) return `Names cannot contain ${bad.join(" ")} (Azure DevOps does not allow ${FORBIDDEN_NAME_CHARS.join(" ")}).`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return "Names cannot contain control characters.";
  if (/^[\s.]|[\s.]$/.test(name)) return "Names cannot start or end with a space or a period.";
  return null;
}

function dateErrors(start: string, finish: string): string[] {
  if (!start && !finish) return [];
  if (!start || !finish) return ["Enter both a start and a finish date."];
  if (start > finish) return ["The finish date must not be before the start date."];
  return [];
}

/**
 * Validates a PI's name and dates. `editing` is the PI being changed (null when creating).
 * Rules: unique name, both-or-no dates, its iterations stay inside it, no overlap with other PIs.
 */
export function validatePi(
  values: { name: string; start: string; finish: string },
  editing: ProgramIncrement | null,
  pis: ProgramIncrement[]
): string[] {
  const errors: string[] = [];
  const name = values.name.trim();
  const others = pis.filter((p) => p !== editing && p.path !== editing?.path);
  const invalid = nameError(values.name);
  if (!name) errors.push("Enter a name.");
  else if (invalid) errors.push(invalid);
  else if (others.some((p) => p.name.toLowerCase() === name.toLowerCase())) errors.push("A PI with this name already exists.");
  const dates = dateErrors(values.start, values.finish);
  errors.push(...dates);
  if (dates.length || !values.start) return errors;
  const range = { start: values.start, finish: values.finish };
  for (const s of editing?.sprints ?? []) {
    if (s.start && s.finish && (dayOf(s.start) < values.start || dayOf(s.finish) > values.finish)) {
      errors.push(`Iteration "${s.name}" would fall outside the PI.`);
    }
  }
  const clash = others.find((p) => overlaps(range, p));
  if (clash) errors.push(`The dates overlap ${clash.name}.`);
  return errors;
}

/**
 * Validates an iteration of `pi`. `editing` is the iteration being changed (null when adding).
 * Rules: unique name within the PI, both-or-no dates, inside the PI, no overlap with siblings,
 * and at most MAX_ITERATIONS per PI.
 */
export function validateIteration(
  values: { name: string; start: string; finish: string },
  pi: ProgramIncrement,
  editing: Sprint | null
): string[] {
  const errors: string[] = [];
  const name = values.name.trim();
  const siblings = pi.sprints.filter((s) => s.path !== editing?.path);
  if (!editing && pi.sprints.length >= MAX_ITERATIONS) errors.push(`A PI can have at most ${MAX_ITERATIONS} iterations.`);
  const invalid = nameError(values.name);
  if (!name) errors.push("Enter a name.");
  else if (invalid) errors.push(invalid);
  else if (siblings.some((s) => s.name.toLowerCase() === name.toLowerCase())) errors.push("An iteration with this name already exists.");
  const dates = dateErrors(values.start, values.finish);
  errors.push(...dates);
  if (dates.length || !values.start) return errors;
  if (pi.start && pi.finish && (values.start < dayOf(pi.start) || values.finish > dayOf(pi.finish))) {
    errors.push(`The iteration must be inside ${pi.name} (${dayOf(pi.start)} – ${dayOf(pi.finish)}).`);
  }
  const clash = siblings.find((s) => overlaps({ start: values.start, finish: values.finish }, s));
  if (clash) errors.push(`The dates overlap ${clash.name}.`);
  return errors;
}

/** Adds `days` to a YYYY-MM-DD day. */
export function addDays(day: string, days: number): string {
  return new Date(new Date(toIso(day)).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export interface PlannedIteration {
  name: string;
  /** YYYY-MM-DD */
  start: string;
  /** YYYY-MM-DD */
  finish: string;
}

/**
 * Validates an iteration plan for a PI that is about to be created: every row follows the
 * iteration rules against the other rows (valid unique name, both-or-no dates, inside the PI,
 * no overlaps) and the plan has at most MAX_ITERATIONS rows.
 * Returns the errors per row and the errors about the plan as a whole.
 */
export function validatePlan(rows: PlannedIteration[], pi: { name: string; start: string; finish: string }): { rows: string[][]; errors: string[] } {
  const sprints: Sprint[] = rows.map((r, i) => ({
    name: r.name.trim(),
    path: `#${i}`,
    identifier: `#${i}`,
    start: r.start || undefined,
    finish: r.finish || undefined,
  }));
  const target: ProgramIncrement = { name: pi.name, path: "#pi", identifier: "#pi", start: pi.start, finish: pi.finish, sprints };
  const errors = rows.length > MAX_ITERATIONS ? [`A PI can have at most ${MAX_ITERATIONS} iterations.`] : [];
  return { rows: rows.map((r, i) => validateIteration(r, target, sprints[i])), errors };
}
