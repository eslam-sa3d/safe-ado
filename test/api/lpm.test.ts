import { describe, expect, it } from "vitest";
import { budgetsStore, leanCasesStore, portfolioSettingsStore } from "../../src/api/data";
import {
  budgetId,
  caseGaps,
  currentUserName,
  defaultStageStates,
  emptyCase,
  emptySettings,
  epicCost,
  findBudget,
  fmtMoney,
  gateGaps,
  hasHypothesis,
  inherited,
  overBudget,
  overWip,
  parseAmount,
  PortfolioSettings,
  resolveStageStates,
  spend,
  stageOf,
  ValueStreamBudget,
  withDecision,
} from "../../src/api/lpm";
import { dataManager, fake } from "../fakeAdo";
import * as sdk from "../sdkMock";

const AGILE = [
  { name: "New", category: "Proposed" },
  { name: "Active", category: "InProgress" },
  { name: "Resolved", category: "Resolved" },
  { name: "Closed", category: "Completed" },
];
const COMPLETE = { ...emptyCase(1), who: "need speed", businessOutcomes: "Revenue", mvp: "Pilot" };

describe("Portfolio Kanban stages", () => {
  it("maps stages onto the process states by category", () => {
    expect(defaultStageStates(AGILE)).toEqual({
      funnel: "New",
      reviewing: "New",
      analyzing: "New",
      ready: "New",
      implementing: "Active",
      done: "Closed",
    });
  });

  it("prefers states named like a stage, falls back to Resolved and to the first state", () => {
    const custom = [
      { name: "Funnel", category: "Proposed" },
      { name: "analyzing", category: "Proposed" },
      { name: "Building", category: "Resolved" },
      { name: "Done", category: "Completed" },
    ];
    expect(defaultStageStates(custom)).toMatchObject({ funnel: "Funnel", reviewing: "Funnel", analyzing: "analyzing", implementing: "Building", done: "Done" });
    expect(defaultStageStates([{ name: "Only", category: "Weird" }])).toMatchObject({ funnel: "Only", done: "Only" });
    expect(defaultStageStates([]).funnel).toBe("");
  });

  it("applies configured states the process has", () => {
    expect(resolveStageStates({ ready: "Active", done: "Gone" }, AGILE)).toMatchObject({ ready: "Active", done: "Closed" });
    expect(resolveStageStates(undefined, AGILE).ready).toBe("New");
  });

  it("finds an Epic's column from the stored stage, the mapping or the category", () => {
    const map = defaultStageStates(AGILE);
    expect(stageOf("New", "Proposed", "analyzing", map)).toBe("analyzing");
    expect(stageOf("Active", "InProgress", "analyzing", map)).toBe("implementing");
    expect(stageOf("New", "Proposed", "bogus" as any, map)).toBe("funnel");
    expect(stageOf("Resolved", "Resolved", undefined, map)).toBe("implementing");
    expect(stageOf("Shipped", "Completed", undefined, map)).toBe("done");
    expect(stageOf("Doing", "InProgress", undefined, map)).toBe("implementing");
    expect(stageOf("Idea", "Proposed", undefined, map)).toBe("funnel");
  });

  it("flags columns over their WIP limit", () => {
    expect(overWip(3, 2)).toBe(true);
    expect(overWip(2, 2)).toBe(false);
    expect(overWip(9, 0)).toBe(false);
    expect(overWip(9, undefined)).toBe(false);
  });
});

describe("Lean Business Case", () => {
  it("lists what a case lacks", () => {
    expect(caseGaps(undefined)).toEqual(["an Epic hypothesis statement", "business outcomes", "an MVP definition"]);
    expect(caseGaps({ ...emptyCase(1), forCustomers: "  " })).toHaveLength(3);
    expect(hasHypothesis({ ...emptyCase(1), unlike: "the rest" })).toBe(true);
    expect(hasHypothesis(undefined)).toBe(false);
    expect(caseGaps(COMPLETE)).toEqual([]);
  });

  it("gates only moves that leave Analyzing", () => {
    expect(gateGaps("analyzing", "ready", { ...COMPLETE, decision: "Go" })).toEqual([]);
    expect(gateGaps("analyzing", "ready", COMPLETE)).toEqual(["a Go decision"]);
    expect(gateGaps("funnel", "done", undefined)).toHaveLength(4);
    expect(gateGaps("funnel", "analyzing", undefined)).toEqual([]);
    expect(gateGaps("ready", "implementing", undefined)).toEqual([]);
    expect(gateGaps("implementing", "reviewing", undefined)).toEqual([]);
  });

  it("records who changed the decision and when", () => {
    const c = emptyCase(7);
    expect(c).toEqual({ id: "7", workItemId: 7, decision: "Pending" });
    expect(withDecision(c, "Pending", "Ada", "t")).toBe(c);
    expect(withDecision({ ...c, decision: undefined }, "Pending", "Ada", "t").decidedBy).toBeUndefined();
    expect(withDecision(c, "Go", "Ada", "2026-01-01")).toMatchObject({ decision: "Go", decidedBy: "Ada", decidedAt: "2026-01-01" });
    expect(withDecision(c, "Pivot", "", "t").decidedBy).toBeUndefined();
  });

  it("reads the signed-in user's name from the SDK", () => {
    expect(currentUserName()).toBe("Ada Lovelace");
    sdk.getUser.mockReturnValueOnce({} as any);
    expect(currentUserName()).toBe("");
    sdk.getUser.mockImplementationOnce(() => {
      throw new Error("not initialised");
    });
    expect(currentUserName()).toBe("");
  });

  it("stores cases, settings and budgets per project", async () => {
    await leanCasesStore.save(emptyCase(5));
    await portfolioSettingsStore.save(emptySettings("n-root"));
    await budgetsStore.save({ id: budgetId("n-root", "pi"), nodeId: "n-root", piId: "pi", piPath: "P\\PI", amount: 1 });
    expect(dataManager.setDocument).toHaveBeenCalledWith(`leancases-${fake.projectId}`, expect.objectContaining({ id: "5" }), expect.anything());
    expect(dataManager.setDocument).toHaveBeenCalledWith(`lpmsettings-${fake.projectId}`, { id: "n-root", nodeId: "n-root" }, expect.anything());
    expect(dataManager.setDocument).toHaveBeenCalledWith(`budgets-${fake.projectId}`, expect.objectContaining({ id: "n-root|pi" }), expect.anything());
    expect(await leanCasesStore.get("5")).toMatchObject({ workItemId: 5 });
  });
});

describe("Budgets and spend", () => {
  it("finds a budget by PI id, else by path", () => {
    const docs: ValueStreamBudget[] = [
      { id: "a", nodeId: "n1", piId: "old-id", piPath: "P\\PIs\\PI 2", amount: 1 },
      { id: "b", nodeId: "n1", piId: "pi-1", piPath: "P\\PIs\\PI 1", amount: 2 },
      { id: "c", nodeId: "n2", piId: "pi-2", piPath: "x", amount: 3 },
    ];
    expect(findBudget(docs, "n1", { identifier: "pi-1", path: "nope" })?.id).toBe("b");
    expect(findBudget(docs, "n1", { identifier: "pi-2", path: "p\\pis\\pi 2" })?.id).toBe("a");
    expect(findBudget(docs, "n3", { identifier: "pi-2", path: "x" })).toBeUndefined();
  });

  it("inherits settings from the nearest ancestor that sets them", () => {
    const settings = new Map<string, PortfolioSettings>([
      ["root", { id: "root", nodeId: "root", costPerPoint: 100, currency: "EUR" }],
      ["art", { id: "art", nodeId: "art", costPerPoint: 150, currency: "" }],
    ]);
    expect(inherited(["root", "art"], settings, "costPerPoint")).toBe(150);
    expect(inherited(["root", "art"], settings, "currency")).toBe("EUR");
    expect(inherited(["root", "other"], settings, "costPerPoint")).toBe(100);
    expect(inherited(["x"], settings, "costPerTeamPerPi")).toBeUndefined();
  });

  it("computes spend per story point or per team", () => {
    const base = { plannedPoints: 20, donePoints: 5, teams: 3, elapsed: 0.5 };
    expect(spend({ ...base, model: "points", costPerPoint: 100 })).toEqual({ forecast: 2000, actual: 500 });
    expect(spend({ ...base, model: "points" })).toBeNull();
    expect(spend({ ...base, model: "teams", costPerTeamPerPi: 1000 })).toEqual({ forecast: 3000, actual: 1500 });
    expect(spend({ ...base, model: "teams", costPerTeamPerPi: 1000, elapsed: 2 })!.actual).toBe(3000);
    expect(spend({ ...base, model: "teams", costPerTeamPerPi: 1000, elapsed: -1 })!.actual).toBe(0);
    expect(spend({ ...base, model: "teams", costPerPoint: 5 })).toBeNull();
  });

  it("flags forecasts over a positive budget", () => {
    expect(overBudget({ forecast: 11, actual: 0 }, 10)).toBe(true);
    expect(overBudget({ forecast: 10, actual: 0 }, 10)).toBe(false);
    expect(overBudget({ forecast: 11, actual: 0 }, 0)).toBe(false);
    expect(overBudget({ forecast: 11, actual: 0 }, undefined)).toBe(false);
    expect(overBudget(null, 10)).toBe(false);
  });

  it("compares Epic cost with the business case estimates", () => {
    const c = { ...emptyCase(1), mvpCost: 400, fullCost: 1000 };
    expect(epicCost(2, 5, 100, c)).toEqual({ actual: 200, forecast: 500, status: "ok" });
    expect(epicCost(5, 8, 100, c)!.status).toBe("beyondMvp");
    expect(epicCost(5, 12, 100, c)!.status).toBe("forecastOverFull");
    expect(epicCost(11, 12, 100, c)!.status).toBe("actualOverFull");
    expect(epicCost(11, 12, 100, undefined)!.status).toBe("ok");
    expect(epicCost(1, 1, undefined, c)).toBeNull();
  });

  it("formats money and parses amounts", () => {
    expect(fmtMoney(1200, "USD")).toMatch(/\$1,200/);
    expect(fmtMoney(1200)).toMatch(/\$1,200/);
    expect(fmtMoney(1200.4, "not a code")).toBe("1,200 not a code");
    expect(parseAmount("")).toBeUndefined();
    expect(parseAmount(" 12.5 ")).toBe(12.5);
    expect(parseAmount("-3")).toBeUndefined();
    expect(parseAmount("abc")).toBeUndefined();
  });
});
