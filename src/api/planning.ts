import type { ProgramIncrement } from "./types";

/**
 * PI Planning event support (Agile Hive: "Run PI Planning, System Demos and Inspect & Adapt in a
 * shared digital environment", "Capture confidence during PI Planning"). Documents live in the
 * Extension Data Service (see votesStore / planReviewsStore / inspectAdaptStore in api/data.ts);
 * everything in this module is pure so it can be unit-tested without the SDK.
 */

// ---------------------------------------------------------------------------------------------
// Plan reviews (draft / final)
// ---------------------------------------------------------------------------------------------

export type ReviewStatus = "Not started" | "In review" | "Approved" | "Needs changes";
export const REVIEW_STATUSES: ReviewStatus[] = ["Not started", "In review", "Approved", "Needs changes"];
export type ReviewKind = "draft" | "final";
export const REVIEW_KINDS: { kind: ReviewKind; label: string }[] = [
  { kind: "draft", label: "Draft plan review" },
  { kind: "final", label: "Final plan review" },
];

export interface ReviewEntry {
  status: ReviewStatus;
  notes: string;
}

/** Plan review state of one unit (team, ART) for one PI. id = `${nodeId}|${pi.identifier}`. */
export interface PlanReview {
  id: string;
  nodeId: string;
  piPath: string;
  piId?: string;
  draft: ReviewEntry;
  final: ReviewEntry;
  updatedAt?: string;
  __etag?: number;
}

// ---------------------------------------------------------------------------------------------
// Confidence vote (fist of five)
// ---------------------------------------------------------------------------------------------

export const FIST_VALUES = [1, 2, 3, 4, 5] as const;
export const FIST_LABEL: Record<number, string> = {
  1: "No confidence",
  2: "Little confidence",
  3: "Good confidence",
  4: "High confidence",
  5: "Very high confidence",
};

/** Confidence vote of one unit for one PI. counts[i] = number of people voting i + 1. id = `${nodeId}|${pi.identifier}`. */
export interface ConfidenceVote {
  id: string;
  nodeId: string;
  piPath: string;
  piId?: string;
  counts: number[];
  votedAt?: string;
  __etag?: number;
}

// ---------------------------------------------------------------------------------------------
// Inspect & Adapt problem-solving workshop
// ---------------------------------------------------------------------------------------------

export type ImprovementStatus = "Proposed" | "Accepted" | "Done";
export const IMPROVEMENT_STATUSES: ImprovementStatus[] = ["Proposed", "Accepted", "Done"];

export interface ImprovementItem {
  id: string;
  nodeId: string;
  piPath: string;
  piId?: string;
  problem: string;
  rootCause: string;
  improvement: string;
  owner: string;
  status: ImprovementStatus;
  workItemId?: number;
  createdAt: string;
  __etag?: number;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Document id of a per-unit, per-PI planning document. */
export const planningId = (nodeId: string, pi: Pick<ProgramIncrement, "identifier">) => `${nodeId}|${pi.identifier}`;

/** Whether a PI-scoped document belongs to `pi` (stable id first, path as fallback). */
export function inPi(doc: { piPath: string; piId?: string }, pi: Pick<ProgramIncrement, "identifier" | "path">): boolean {
  return doc.piId ? doc.piId === pi.identifier : doc.piPath === pi.path;
}

export function emptyReview(nodeId: string, pi: ProgramIncrement): PlanReview {
  return {
    id: planningId(nodeId, pi),
    nodeId,
    piPath: pi.path,
    piId: pi.identifier,
    draft: { status: "Not started", notes: "" },
    final: { status: "Not started", notes: "" },
  };
}

export function emptyVote(nodeId: string, pi: ProgramIncrement): ConfidenceVote {
  return { id: planningId(nodeId, pi), nodeId, piPath: pi.path, piId: pi.identifier, counts: emptyCounts() };
}

export const emptyCounts = () => [0, 0, 0, 0, 0];

/** Five non-negative integer counts, whatever was stored. */
export function normalizeCounts(counts?: readonly number[]): number[] {
  return FIST_VALUES.map((_, i) => {
    const n = Math.floor(Number(counts?.[i] ?? 0));
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
}

/** Counts after one more anonymous vote for `value` (1–5). */
export function addVote(counts: readonly number[] | undefined, value: number): number[] {
  const next = normalizeCounts(counts);
  if (value >= 1 && value <= 5) next[Math.round(value) - 1]++;
  return next;
}

/** Counts after withdrawing one vote for `value` (never below zero). */
export function removeVote(counts: readonly number[] | undefined, value: number): number[] {
  const next = normalizeCounts(counts);
  const i = Math.round(value) - 1;
  if (i >= 0 && i < 5 && next[i] > 0) next[i]--;
  return next;
}

/** Counts built from individual anonymous votes (values outside 1–5 are ignored). */
export function countsFromVotes(votes: readonly number[]): number[] {
  return votes.reduce<number[]>((acc, v) => addVote(acc, v), emptyCounts());
}

export function voteTotal(counts?: readonly number[]): number {
  return normalizeCounts(counts).reduce((s, n) => s + n, 0);
}

/** Average fist-of-five score rounded to one decimal, or null without votes. */
export function voteAverage(counts?: readonly number[]): number | null {
  const c = normalizeCounts(counts);
  const total = c.reduce((s, n) => s + n, 0);
  if (!total) return null;
  const sum = c.reduce((s, n, i) => s + n * (i + 1), 0);
  return Math.round((sum / total) * 10) / 10;
}

export interface DistributionBar {
  value: number;
  count: number;
  /** Share of all votes, 0–100 (rounded). */
  pct: number;
}

export function distribution(counts?: readonly number[]): DistributionBar[] {
  const c = normalizeCounts(counts);
  const total = c.reduce((s, n) => s + n, 0);
  return c.map((count, i) => ({ value: i + 1, count, pct: total ? Math.round((count / total) * 100) : 0 }));
}

/** Sum of several units' counts (e.g. all teams of an ART). */
export function combineCounts(list: (readonly number[] | undefined)[]): number[] {
  return list.reduce<number[]>((acc, c) => normalizeCounts(c).map((n, i) => acc[i] + n), emptyCounts());
}

/** SAFe: an average below 3 means the plan should be reworked before committing. */
export const isLowConfidence = (avg: number | null) => avg !== null && avg < 3;

export function confidenceTone(avg: number | null): "good" | "warn" | "bad" | undefined {
  if (avg === null) return undefined;
  return avg >= 4 ? "good" : avg >= 3 ? "warn" : "bad";
}

/**
 * Overall status of one review across units: Approved when every unit is approved, Needs changes
 * when any unit needs changes, Not started when nobody started, In review otherwise.
 */
export function reviewRollup(
  reviews: (PlanReview | undefined)[],
  kind: ReviewKind
): { status: ReviewStatus; counts: Record<ReviewStatus, number> } {
  const counts = Object.fromEntries(REVIEW_STATUSES.map((s) => [s, 0])) as Record<ReviewStatus, number>;
  reviews.forEach((r) => counts[r?.[kind]?.status ?? "Not started"]++);
  const n = reviews.length;
  const status: ReviewStatus =
    n > 0 && counts.Approved === n
      ? "Approved"
      : counts["Needs changes"] > 0
      ? "Needs changes"
      : counts["Not started"] === n
      ? "Not started"
      : "In review";
  return { status, counts };
}

export function improvementCounts(items: ImprovementItem[]): Record<ImprovementStatus, number> {
  const counts = { Proposed: 0, Accepted: 0, Done: 0 } as Record<ImprovementStatus, number>;
  items.forEach((i) => counts[i.status]++);
  return counts;
}

/** CSS-friendly slug of a review status ("Needs changes" -> "needs-changes"). */
export const statusSlug = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
