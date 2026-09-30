import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  burnupFromHistory,
  descendantIterations,
  estimatedCompletion,
  firstActiveDates,
  flowMetrics,
  historyFields,
  idsQuery,
  median,
  normalize,
  overviewIds,
  overviewRows,
  RevisionLike,
  RItem,
  snapshotId,
  toDay,
} from "../../src/api/reports";
import { ProgramIncrement } from "../../src/api/types";

const SP = "Microsoft.VSTS.Scheduling.StoryPoints";
const d = (iso: string) => `${iso}T00:00:00Z`;
const day = (iso: string) => toDay(iso);
const PI_PATH = "P\\PIs\\PI 5";
const sprint = (name: string, start: string, finish: string) => ({ name, path: `${PI_PATH}\\${name}`, identifier: name, start: d(start), finish: d(finish) });
const PI5: ProgramIncrement = {
  name: "PI 5",
  path: PI_PATH,
  identifier: "pi5",
  start: d("2026-03-01"),
  finish: d("2026-03-21"),
  sprints: [sprint("S1", "2026-03-01", "2026-03-07"), sprint("S2", "2026-03-08", "2026-03-14"), sprint("PI 5 IP", "2026-03-15", "2026-03-21")],
};
const cat = (_t: string, s: string) => ({ New: "Proposed", Active: "InProgress", Resolved: "Resolved", Closed: "Completed", Removed: "Removed" })[s] ?? "InProgress";

let seq = 1;
const item = (over: Partial<RItem> = {}): RItem => ({ id: seq++, type: "User Story", title: "x", state: "New", category: "Proposed", sp: 1, childIds: [], ...over });

const rev = (id: number, n: number, date: string, f: Record<string, unknown>): RevisionLike => ({
  id,
  rev: n,
  fields: { "System.WorkItemType": "User Story", "System.AreaPath": "P\\A", "System.IterationPath": `${PI_PATH}\\S1`, "System.State": "New", [SP]: 3, "System.ChangedDate": d(date), ...f },
});
const opts = { storyType: "User Story", spField: SP, areas: ["P\\A"], categoryOf: cat };

describe("normalize (v2)", () => {
  it("reads the activated date and the configured RR/OE field", () => {
    const n = normalize({ id: 1, fields: { "Microsoft.VSTS.Common.ActivatedDate": "2026-03-02T00:00:00Z", "Custom.Rroe": 5, "Custom.RROEValue": 1 } }, cat, SP, "Custom.Rroe");
    expect(n.activatedDate).toBe("2026-03-02T00:00:00Z");
    expect(n.rroe).toBe(5);
    expect(normalize({ id: 2, fields: { "Custom.RROEValue": 2 } }, cat, SP, "").rroe).toBe(2);
    expect(normalize({ id: 3, fields: { "Custom.RROEValue": 2 } }, cat, SP).rroe).toBe(2);
  });
});

describe("burnupFromHistory", () => {
  it("rebuilds scope and burned per day from each story's last revision on that day", () => {
    const revisions = [
      rev(1, 1, "2026-02-20", {}),
      rev(1, 2, "2026-03-05", { "System.State": "Closed" }),
      // Joins the PI on day 3, then is removed on day 10.
      rev(2, 1, "2026-02-20", { "System.IterationPath": "P\\Backlog" }),
      rev(2, 2, "2026-03-03", { [SP]: 5 }),
      rev(2, 3, "2026-03-10", { "System.State": "Removed" }),
      // Moves to another unit on day 12; same-day revisions are ordered by rev.
      rev(3, 2, "2026-03-12", { "System.AreaPath": "P\\B" }),
      rev(3, 1, "2026-03-12", {}),
      rev(3, 0, "2026-02-01", { [SP]: "" }),
      // Other types, missing dates and unparseable points are ignored.
      rev(4, 1, "2026-02-20", { "System.WorkItemType": "Feature" }),
      { id: 5, rev: 1, fields: { "System.WorkItemType": "User Story" } },
    ];
    const b = burnupFromHistory(PI5, revisions, opts, day("2026-03-16"))!;
    const at = (iso: string) => b.days.find((x) => x.date === iso)!;
    expect(b.source).toBe("history");
    expect(at("2026-03-01")).toMatchObject({ scope: 3, burned: 0 });
    expect(at("2026-03-03")).toMatchObject({ scope: 8, burned: 0 });
    expect(at("2026-03-05")).toMatchObject({ scope: 8, burned: 3 });
    expect(at("2026-03-10")).toMatchObject({ scope: 3, burned: 3 });
    expect(at("2026-03-11").scope).toBe(3);
    expect(at("2026-03-12")).toMatchObject({ scope: 3, burned: 3 });
    expect(at("2026-03-16")).toMatchObject({ scope: 3, burned: 3 });
    // Future days keep today's scope.
    expect(at("2026-03-20")).toMatchObject({ scope: 3, burned: null });
    expect(b.scope).toBe(3);
    // Rate from completed iterations: S1 burned 3 (7 days), S2 burned 0.
    expect(b.dailyRate).toBe(0.2);
    expect(burnupFromHistory({ ...PI5, start: undefined }, revisions, opts, day("2026-03-16"))).toBeNull();
  });

  it("uses the scope on the last day for a past PI", () => {
    const b = burnupFromHistory(PI5, [rev(1, 1, "2026-02-20", {})], opts, day("2026-05-01"))!;
    expect(b.scope).toBe(3);
    expect(b.todayIndex).toBe(-1);
    expect(b.days.every((x) => x.forecast === null)).toBe(true);
  });

  it("lists the revision fields it needs", () => {
    expect(historyFields(SP)).toEqual(["System.IterationPath", "System.State", "System.WorkItemType", "System.AreaPath", SP, "System.ChangedDate"]);
  });
});

describe("firstActiveDates", () => {
  it("keeps the earliest in-progress revision per item", () => {
    const m = firstActiveDates(
      [
        rev(1, 3, "2026-03-05", { "System.State": "Active" }),
        rev(1, 2, "2026-03-03", { "System.State": "Resolved" }),
        rev(1, 4, "2026-03-07", { "System.State": "Active" }),
        rev(2, 1, "2026-03-01", { "System.State": "New" }),
        { id: 3, rev: 1, fields: { "System.State": "Active" } },
      ],
      cat
    );
    expect(m).toEqual(new Map([[1, d("2026-03-03")]]));
  });
});

describe("flowMetrics", () => {
  it("computes velocity per iteration, flow time, load and distribution", () => {
    const items = [
      item({ category: "Completed", closedDate: d("2026-03-06"), activatedDate: d("2026-03-01") }),
      item({ id: 900, category: "Completed", closedDate: d("2026-03-10"), iteration: `${PI_PATH}\\S1` }),
      item({ type: "Feature", category: "Completed", iteration: `${PI_PATH}\\S2` }),
      item({ category: "Completed", closedDate: d("2026-04-10") }),
      item({ category: "InProgress" }),
      item({ category: "Resolved" }),
      item({ category: "Removed" }),
    ];
    const m = flowMetrics(items, PI5, new Map([[900, d("2026-03-08")]]));
    expect(m.completed).toBe(3);
    expect(m.velocity.map((v) => [v.name, v.count, v.ip])).toEqual([
      ["S1", 1, false],
      ["S2", 2, false],
      ["PI 5 IP", 0, true],
    ]);
    expect(m.time).toEqual({ median: 3.5, average: 3.5, samples: 2, missing: 1 });
    expect(m.load).toBe(2);
    expect(m.distribution).toEqual([
      { type: "User Story", count: 2, pct: 67 },
      { type: "Feature", count: 1, pct: 33 },
    ]);
  });

  it("falls back to iteration paths for undated PIs and has empty results without items", () => {
    const undated = { ...PI5, start: undefined, finish: undefined, sprints: [] };
    const m = flowMetrics([item({ category: "Completed", closedDate: d("2026-03-06"), iteration: PI_PATH })], undated);
    expect(m.completed).toBe(1);
    expect(flowMetrics([], PI5)).toMatchObject({ completed: 0, load: 0, distribution: [], time: { median: null, average: null, samples: 0, missing: 0 } });
  });

  it("takes the median of odd and even samples", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("estimated completion", () => {
  it("returns the finish of the latest sprint any iteration is planned in", () => {
    expect(estimatedCompletion([`${PI_PATH}\\S1`, `${PI_PATH}\\S2\\Week 1`, undefined], PI5.sprints)).toBe(d("2026-03-14"));
    expect(estimatedCompletion([`${PI_PATH}\\S1`], [...PI5.sprints, { ...PI5.sprints[0], finish: undefined }])).toBe(d("2026-03-07"));
    expect(estimatedCompletion([PI_PATH], PI5.sprints)).toBeNull();
  });

  it("walks live descendants once, surviving cycles", () => {
    const a = item({ id: 501 });
    const b = item({ id: 502, parentId: 501, iteration: "I1" });
    const c = item({ id: 503, parentId: 502, iteration: "I2" });
    const removed = item({ id: 504, parentId: 501, iteration: "I3", category: "Removed" });
    const cyc = item({ id: 505, parentId: 503, iteration: "I4" });
    const back = item({ id: 501, parentId: 505 });
    const below = descendantIterations([a, b, c, removed, cyc, back]);
    expect(below(501)).toEqual(["I1", "I2", "I4"]);
    expect(below(999)).toEqual([]);
  });
});

describe("queries", () => {
  it("builds an ids query and collects overview ids", () => {
    expect(idsQuery([])).toBeNull();
    expect(idsQuery([0])).toBeNull();
    expect(idsQuery([3, 1, 3])).toContain("[System.Id] IN (1, 3) ORDER BY [System.Id] ASC");
    const f = item({ id: 601, type: "Feature" });
    const s = item({ id: 602, parentId: 601, iteration: PI_PATH });
    const loose = item({ id: 603, iteration: PI_PATH });
    const { rows, orphans } = overviewRows({ items: [f, s, loose], rootType: "Feature", storyType: "User Story", counts: () => true, teams: [] });
    expect(overviewIds([...rows, orphans!])).toEqual([601, 602, 603]);
  });

  it("filters overview roots and excludes stories shown elsewhere", () => {
    const e = item({ id: 701, type: "Epic" });
    const f1 = item({ id: 702, type: "Feature", parentId: 701 });
    const f2 = item({ id: 703, type: "Feature" });
    const s1 = item({ id: 704, parentId: 702 });
    const s2 = item({ id: 705, parentId: 703 });
    const s3 = item({ id: 706 });
    const all = [e, f1, f2, s1, s2, s3];
    const lane = overviewRows({ items: all, rootType: "Feature", storyType: "User Story", counts: () => true, teams: [], rootFilter: (r) => r.parentId === 701 });
    expect(lane.rows.map((r) => r.item.id)).toEqual([702]);
    expect(lane.covered).toEqual(new Set([704]));
    const main = overviewRows({ items: all, rootType: "Capability", storyType: "User Story", counts: () => true, teams: [], exclude: lane.covered });
    expect(main.orphans!.children.map((c) => c.item.id)).toEqual([705, 706]);
  });
});

describe("buildSnapshot", () => {
  const stories = [item({ category: "Completed", sp: 3, iteration: `${PI_PATH}\\S1` }), item({ sp: 2, iteration: `${PI_PATH}\\S2` })];
  it("records points, velocity, load and burnup for teams and trains", () => {
    const now = new Date("2026-04-01T10:00:00Z");
    const today = day("2026-04-01");
    const team = buildSnapshot({ nodeId: "n1", team: true, pi: PI5, stories, piStories: stories, capacity: 10, burnup: null, today, now });
    expect(team).toEqual({
      id: snapshotId("n1", PI5),
      nodeId: "n1",
      piPath: PI_PATH,
      piId: "pi5",
      piName: "PI 5",
      createdAt: "2026-04-01T10:00:00.000Z",
      points: { planned: 5, done: 3, pct: 60, unestimated: 0, count: 2 },
      velocity: { value: 1, basis: "Ø all iterations of the PI", samples: 3 },
      sprintVelocity: [
        { name: "S1", path: `${PI_PATH}\\S1`, done: 3 },
        { name: "S2", path: `${PI_PATH}\\S2`, done: 0 },
        { name: "PI 5 IP", path: `${PI_PATH}\\PI 5 IP`, done: 0 },
      ],
      load: { load: 5, capacity: 10, pct: 50, unestimated: 0 },
      burnup: null,
    });
    expect(team.id).toBe("n1|pi5");
    const train = buildSnapshot({ nodeId: "n2", team: false, pi: PI5, stories, piStories: stories, capacity: 0, burnup: null, today });
    expect(train.velocity).toEqual({ value: 3, basis: "PI total", samples: 1 });
    expect(typeof train.createdAt).toBe("string");
  });
});

describe("event days use the local calendar", () => {
  it("counts a timestamp on the user's local day", async () => {
    const { eventDay, toDay } = await import("../../src/api/reports");
    const local = new Date(2026, 8, 29, 23, 30); // 29 Sep, 23:30 local time
    expect(eventDay(local.toISOString())).toBe(toDay("2026-09-29"));
    expect(eventDay(new Date(2026, 8, 30, 0, 15).toISOString())).toBe(toDay("2026-09-30"));
  });
});
