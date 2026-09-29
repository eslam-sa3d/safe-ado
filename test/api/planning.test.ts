import { describe, expect, it } from "vitest";
import {
  addVote,
  combineCounts,
  confidenceTone,
  countsFromVotes,
  distribution,
  emptyReview,
  emptyVote,
  ImprovementItem,
  improvementCounts,
  inPi,
  isLowConfidence,
  normalizeCounts,
  planningId,
  PlanReview,
  removeVote,
  reviewRollup,
  statusSlug,
  voteAverage,
  voteTotal,
} from "../../src/api/planning";
import { ProgramIncrement } from "../../src/api/types";

const PI: ProgramIncrement = { name: "PI 2", path: "F\\PIs\\PI 2", identifier: "pi-2", sprints: [] };

describe("planning ids and PI matching", () => {
  it("builds per-node, per-PI ids", () => {
    expect(planningId("n-red", PI)).toBe("n-red|pi-2");
  });

  it("matches by stable id first, then by path", () => {
    expect(inPi({ piPath: "other", piId: "pi-2" }, PI)).toBe(true);
    expect(inPi({ piPath: PI.path, piId: "pi-1" }, PI)).toBe(false);
    expect(inPi({ piPath: PI.path }, PI)).toBe(true);
    expect(inPi({ piPath: "F\\PIs\\PI 1" }, PI)).toBe(false);
  });

  it("creates empty documents carrying piPath and piId", () => {
    expect(emptyReview("n", PI)).toEqual({
      id: "n|pi-2",
      nodeId: "n",
      piPath: PI.path,
      piId: "pi-2",
      draft: { status: "Not started", notes: "" },
      final: { status: "Not started", notes: "" },
    });
    expect(emptyVote("n", PI)).toEqual({ id: "n|pi-2", nodeId: "n", piPath: PI.path, piId: "pi-2", counts: [0, 0, 0, 0, 0] });
  });
});

describe("vote counts", () => {
  it("normalizes to five non-negative integers", () => {
    expect(normalizeCounts()).toEqual([0, 0, 0, 0, 0]);
    expect(normalizeCounts([1, -2, 2.7, NaN])).toEqual([1, 0, 2, 0, 0]);
    expect(normalizeCounts([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5]);
    expect(normalizeCounts(["3" as unknown as number, Infinity])).toEqual([3, 0, 0, 0, 0]);
  });

  it("adds and removes anonymous votes without mutating", () => {
    const c = [0, 1, 0, 0, 0];
    expect(addVote(c, 2)).toEqual([0, 2, 0, 0, 0]);
    expect(c).toEqual([0, 1, 0, 0, 0]);
    expect(addVote(undefined, 5)).toEqual([0, 0, 0, 0, 1]);
    expect(addVote(c, 0)).toEqual(c);
    expect(addVote(c, 6)).toEqual(c);
    expect(removeVote(c, 2)).toEqual([0, 0, 0, 0, 0]);
    expect(removeVote(c, 1)).toEqual(c);
    expect(removeVote(c, 9)).toEqual(c);
    expect(removeVote(undefined, 3)).toEqual([0, 0, 0, 0, 0]);
  });

  it("builds counts from individual votes", () => {
    expect(countsFromVotes([5, 4, 4, 3, 1, 7, 0])).toEqual([1, 0, 1, 2, 1]);
    expect(countsFromVotes([])).toEqual([0, 0, 0, 0, 0]);
  });

  it("totals and averages (one decimal), null without votes", () => {
    expect(voteTotal([1, 0, 1, 2, 1])).toBe(5);
    expect(voteTotal()).toBe(0);
    expect(voteAverage([1, 0, 1, 2, 1])).toBe(3.4);
    expect(voteAverage([0, 0, 1, 0, 0])).toBe(3);
    expect(voteAverage([1, 1, 1, 0, 0])).toBe(2);
    expect(voteAverage([0, 0, 0, 1, 2])).toBe(4.7);
    expect(voteAverage([0, 0, 0, 0, 0])).toBeNull();
    expect(voteAverage(undefined)).toBeNull();
  });

  it("computes distribution bars", () => {
    expect(distribution([1, 0, 1, 2, 0])).toEqual([
      { value: 1, count: 1, pct: 25 },
      { value: 2, count: 0, pct: 0 },
      { value: 3, count: 1, pct: 25 },
      { value: 4, count: 2, pct: 50 },
      { value: 5, count: 0, pct: 0 },
    ]);
    expect(distribution().every((b) => b.pct === 0 && b.count === 0)).toBe(true);
  });

  it("combines several units' counts", () => {
    expect(combineCounts([[1, 0, 0, 0, 0], undefined, [0, 2, 0, 0, 3]])).toEqual([1, 2, 0, 0, 3]);
    expect(combineCounts([])).toEqual([0, 0, 0, 0, 0]);
  });

  it("flags low confidence and picks a tone", () => {
    expect(isLowConfidence(null)).toBe(false);
    expect(isLowConfidence(2.9)).toBe(true);
    expect(isLowConfidence(3)).toBe(false);
    expect(confidenceTone(null)).toBeUndefined();
    expect(confidenceTone(4)).toBe("good");
    expect(confidenceTone(3.5)).toBe("warn");
    expect(confidenceTone(2.5)).toBe("bad");
  });
});

describe("review rollup", () => {
  const review = (draft: PlanReview["draft"]["status"], final: PlanReview["final"]["status"] = "Not started"): PlanReview => ({
    ...emptyReview("n", PI),
    draft: { status: draft, notes: "" },
    final: { status: final, notes: "" },
  });

  it("is Not started when nothing started (or no units)", () => {
    expect(reviewRollup([undefined, review("Not started")], "draft").status).toBe("Not started");
    expect(reviewRollup([], "draft")).toEqual({
      status: "Not started",
      counts: { "Not started": 0, "In review": 0, Approved: 0, "Needs changes": 0 },
    });
  });

  it("is Approved only when every unit approved", () => {
    expect(reviewRollup([review("Approved"), review("Approved")], "draft").status).toBe("Approved");
    expect(reviewRollup([review("Approved"), undefined], "draft").status).toBe("In review");
  });

  it("surfaces Needs changes over anything else", () => {
    const r = reviewRollup([review("Approved"), review("Needs changes"), review("In review"), undefined], "draft");
    expect(r.status).toBe("Needs changes");
    expect(r.counts).toEqual({ "Not started": 1, "In review": 1, Approved: 1, "Needs changes": 1 });
  });

  it("rolls up each review kind separately", () => {
    const list = [review("Approved", "In review"), review("Approved", "Not started")];
    expect(reviewRollup(list, "draft").status).toBe("Approved");
    expect(reviewRollup(list, "final").status).toBe("In review");
  });
});

describe("misc", () => {
  it("counts improvements by status", () => {
    const item = (status: ImprovementItem["status"]) => ({ status }) as ImprovementItem;
    expect(improvementCounts([item("Proposed"), item("Done"), item("Done")])).toEqual({ Proposed: 1, Accepted: 0, Done: 2 });
  });

  it("slugs statuses", () => {
    expect(statusSlug("Needs changes")).toBe("needs-changes");
    expect(statusSlug("Approved")).toBe("approved");
  });
});
