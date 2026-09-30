import { describe, expect, it } from "vitest";
import {
  burnup,
  burnupFromHistory,
  flowKind,
  historicDailyRate,
  idsQuery,
  inPi,
  inSnapshotWindow,
  MAX_QUERY_IDS,
  normalize,
  openQueryWiql,
  RItem,
  scopeWiql,
  SNAPSHOT_WINDOW_DAYS,
  teamVelocity,
  toDay,
  TOO_MANY_ITEMS,
  workSprints,
} from "../../src/api/reports";
import { ProgramIncrement } from "../../src/api/types";
import { estimatedCompletion as formCompletion } from "../../src/form/planning";
import { epicInOverview } from "../../src/views/reports/OverviewWidget";

const d = (iso: string) => `${iso}T00:00:00Z`;
const day = (iso: string) => toDay(iso);
/** Noon on a calendar date in the local time zone (stays on that date in every zone). */
const localNoon = (date: string) => {
  const [y, m, dd] = date.split("-").map(Number);
  return new Date(y, m - 1, dd, 12).toISOString();
};
const sprint = (pi: string, name: string, start: string, finish: string) => ({ name, path: `${pi}\\${name}`, identifier: `${pi}-${name}`, start: d(start), finish: d(finish) });
const P4 = "P\\PIs\\PI 4";
const P5 = "P\\PIs\\PI 5";
const PI4: ProgramIncrement = {
  name: "PI 4",
  path: P4,
  identifier: "pi4",
  start: d("2026-02-01"),
  finish: d("2026-02-21"),
  sprints: [sprint(P4, "A", "2026-02-01", "2026-02-07"), sprint(P4, "B", "2026-02-08", "2026-02-14"), sprint(P4, "PI 4 IP", "2026-02-15", "2026-02-21")],
};
const PI5: ProgramIncrement = {
  name: "PI 5",
  path: P5,
  identifier: "pi5",
  start: d("2026-03-01"),
  finish: d("2026-03-21"),
  sprints: [sprint(P5, "S1", "2026-03-01", "2026-03-07"), sprint(P5, "S2", "2026-03-08", "2026-03-14"), sprint(P5, "PI 5 IP", "2026-03-15", "2026-03-21")],
};
const cat = (_t: string, s: string) => ({ New: "Proposed", Active: "InProgress", Closed: "Completed", Removed: "Removed" })[s] ?? "InProgress";
let seq = 1;
const item = (over: Partial<RItem> = {}): RItem => ({ id: seq++, type: "User Story", title: "x", state: "New", category: "Proposed", sp: 1, childIds: [], ...over });
const done = (iteration: string, sp: number, closed?: string) => item({ category: "Completed", state: "Closed", sp, iteration, closedDate: closed && localNoon(closed) });

describe("inPi", () => {
  const pi = { identifier: "pi5", path: "P\\PIs\\PI 5" };
  it("matches by id first, then by path ignoring case", () => {
    expect(inPi({ piId: "pi5", piPath: "renamed" }, pi)).toBe(true);
    expect(inPi({ piId: "other", piPath: pi.path }, pi)).toBe(false);
    expect(inPi({ piPath: "p\\pis\\pi 5" }, pi)).toBe(true);
    expect(inPi({ piId: "", piPath: pi.path }, pi)).toBe(true);
    expect(inPi({ piPath: "P\\PIs\\PI 4" }, pi)).toBe(false);
  });
});

describe("flow kinds and tags", () => {
  it("reads tags lower-cased", () => {
    expect(normalize({ id: 1, fields: { "System.Tags": " Tech Debt ; UI;" } }, cat, "sp").tags).toEqual(["tech debt", "ui"]);
    expect(normalize({ id: 2, fields: { "System.Tags": "  " } }, cat, "sp").tags).toBeUndefined();
    expect(normalize({ id: 3, fields: {} }, cat, "sp").tags).toBeUndefined();
  });

  it("classifies Defect, Debt, Enabler and Feature work", () => {
    const types = { enabler: "Enabler", bug: "Bug" };
    expect(flowKind(item({ type: "Bug", tags: ["debt"] }), types)).toBe("Defect");
    expect(flowKind(item({ type: "Enabler", tags: ["tech debt"] }), types)).toBe("Debt");
    expect(flowKind(item({ type: "Enabler" }), types)).toBe("Enabler");
    expect(flowKind(item({ tags: ["debtor"] }), types)).toBe("Feature");
    expect(flowKind(item({ type: "Bug" }))).toBe("Feature");
  });
});

describe("team velocity without IP iterations", () => {
  const stories = [done(PI4.sprints[0].path, 10), done(PI4.sprints[1].path, 20), done(PI4.sprints[2].path, 99), done(PI5.sprints[0].path, 6)];
  it("ignores IP iterations for completed, current and planned PIs", () => {
    expect(workSprints(PI4).map((s) => s.name)).toEqual(["A", "B"]);
    expect(teamVelocity(PI4, [PI4, PI5], stories, day("2026-04-01"))).toEqual({ value: 15, basis: "Ø all iterations of the PI", samples: 2 });
    // Running PI 5 during its IP: S1 and S2 are complete, the IP iteration doesn't count.
    expect(teamVelocity(PI5, [PI4, PI5], stories, day("2026-03-20"))).toEqual({ value: 3, basis: "Ø completed iterations of the PI", samples: 2 });
    const PI6: ProgramIncrement = { ...PI5, name: "PI 6", path: "P\\PIs\\PI 6", identifier: "pi6", start: d("2026-04-01"), finish: d("2026-04-21"), sprints: [] };
    // A, B, S1, S2 — never the IP iterations.
    expect(teamVelocity(PI6, [PI4, PI5, PI6], stories, day("2026-03-25"))).toEqual({ value: 9, basis: "Ø last 5 completed iterations", samples: 4 });
  });
});

describe("forecast", () => {
  const history = [done(PI4.sprints[0].path, 7), done(PI4.sprints[1].path, 7), done(PI4.sprints[2].path, 50)];

  it("derives the historic rate from completed work iterations of earlier PIs", () => {
    // 14 SP over the 14 days of A and B (the IP's points and days don't count).
    expect(historicDailyRate(PI5, [PI4, PI5], history, day("2026-03-03"))).toBe(1);
    expect(historicDailyRate(PI5, [PI5], history, day("2026-03-03"))).toBeNull();
    expect(historicDailyRate({ ...PI5, start: undefined }, [PI4, PI5], history, day("2026-03-03"))).toBeNull();
    // PIs after the selected one don't count.
    expect(historicDailyRate(PI4, [PI4, PI5], history, day("2026-04-30"))).toBeNull();
  });

  it("uses the historic rate until the PI completes an iteration, flat during IP", () => {
    const stories = [done(PI5.sprints[0].path, 4, "2026-03-02"), item({ sp: 30, iteration: PI5.sprints[1].path })];
    const early = burnup(PI5, stories, day("2026-03-03"), 1)!;
    expect(early.dailyRate).toBe(1);
    const at = (b: typeof early, iso: string) => b.days.find((x) => x.date === iso)!;
    expect(at(early, "2026-03-03").forecast).toBe(4);
    expect(at(early, "2026-03-14").forecast).toBe(15);
    // The IP days keep the forecast flat, like the ideal line.
    expect(at(early, "2026-03-15").forecast).toBe(15);
    expect(at(early, "2026-03-21").forecast).toBe(15);
    expect(at(early, "2026-03-21").ideal).toBe(at(early, "2026-03-14").ideal);

    // Without history: the burn so far (4 SP over 3 work days).
    expect(burnup(PI5, stories, day("2026-03-03"))!.dailyRate).toBe(1.3);
    expect(burnup(PI5, stories, day("2026-03-03"), null)!.dailyRate).toBe(1.3);

    // Once S1 is complete, the PI's own rate wins over history: 4 SP / 7 days.
    const later = burnup(PI5, stories, day("2026-03-09"), 5)!;
    expect(later.dailyRate).toBe(0.6);
  });

  it("passes the historic rate to the history burnup too", () => {
    const b = burnupFromHistory(
      PI5,
      [{ id: 1, rev: 1, fields: { "System.WorkItemType": "User Story", "System.AreaPath": "P\\A", "System.IterationPath": PI5.sprints[0].path, "System.State": "New", sp: 10, "System.ChangedDate": d("2026-02-20") } }],
      { storyType: "User Story", spField: "sp", areas: ["P\\A"], categoryOf: cat },
      day("2026-03-02"),
      2
    )!;
    expect(b.source).toBe("history");
    expect(b.dailyRate).toBe(2);
    expect(b.days.find((x) => x.date === "2026-03-04")!.forecast).toBe(4);
  });

  it("counts only work days for the burn-so-far rate when today is in the IP", () => {
    const ipOnly: ProgramIncrement = { ...PI5, sprints: [sprint(P5, "PI 5 IP", "2026-03-01", "2026-03-21")] };
    const b = burnup(ipOnly, [done(PI5.path, 3, "2026-03-02")], day("2026-03-05"))!;
    // No work day so far: the rate uses at least one day and the forecast stays flat.
    expect(b.dailyRate).toBe(3);
    expect(b.days.at(-1)!.forecast).toBe(3);
  });
});

describe("snapshot window", () => {
  it("is open for 14 days after the PI's finish", () => {
    const finish = day("2026-03-21");
    expect(SNAPSHOT_WINDOW_DAYS).toBe(14);
    expect(inSnapshotWindow(PI5, finish)).toBe(false);
    expect(inSnapshotWindow(PI5, finish + 1)).toBe(true);
    expect(inSnapshotWindow(PI5, finish + 14)).toBe(true);
    expect(inSnapshotWindow(PI5, finish + 15)).toBe(false);
    expect(inSnapshotWindow({ ...PI5, finish: undefined }, finish + 1)).toBe(false);
  });
});

describe("Open in query length guard", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const scope = { types: ["User Story", "Bug"], areas: ["P\\A", "P\\B's"], iterationPath: "P\\PIs\\PI 5" };

  it("lists up to 200 ids", () => {
    expect(MAX_QUERY_IDS).toBe(200);
    expect(openQueryWiql(ids(200), scope)).toEqual({ wiql: idsQuery(ids(200)) });
    // Duplicates and synthetic ids don't count towards the limit.
    expect(openQueryWiql([...ids(200), ...ids(200), 0], scope).wiql).toBe(idsQuery(ids(200)));
    expect(openQueryWiql([], scope)).toEqual({ wiql: null, reason: "No work items to open" });
  });

  it("opens the widget's scope instead of more than 200 ids, or explains why it can't", () => {
    const r = openQueryWiql(ids(201), scope);
    expect(r.byScope).toBe(true);
    expect(r.wiql).toBe(scopeWiql(scope));
    expect(r.wiql).toBe(
      "SELECT [System.Id], [System.WorkItemType], [System.Title], [System.State], [System.AreaPath], [System.IterationPath] FROM WorkItems " +
        "WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('User Story', 'Bug') " +
        "AND ([System.AreaPath] UNDER 'P\\A' OR [System.AreaPath] UNDER 'P\\B''s') AND [System.IterationPath] UNDER 'P\\PIs\\PI 5' ORDER BY [System.Id] ASC"
    );
    expect(scopeWiql({ types: ["Epic"], areas: ["P"] })).not.toContain("IterationPath] UNDER");
    expect(openQueryWiql(ids(201))).toEqual({ wiql: null, reason: TOO_MANY_ITEMS });
    expect(TOO_MANY_ITEMS).toBe("Too many items to open as a query");
  });
});

describe("estimated completion in the form and list", () => {
  it("delegates to the Reports implementation and returns the date part", () => {
    expect(formCompletion([PI5.sprints[0].path, `${PI5.sprints[1].path}\\Week 1`, undefined], [PI4, PI5])).toBe("2026-03-14");
    expect(formCompletion([PI5.path], [PI4, PI5])).toBeUndefined();
    expect(formCompletion([], [PI4, PI5])).toBeUndefined();
  });
});

describe("Epic Overview on the local calendar", () => {
  it("keeps epics closed within the last 30 local days", () => {
    const today = day("2026-09-30");
    const epic = (closed?: string) => item({ type: "Epic", category: "Completed", closedDate: closed });
    expect(epicInOverview(epic(localNoon("2026-08-31")), today)).toBe(true);
    expect(epicInOverview(epic(localNoon("2026-08-30")), today)).toBe(false);
    expect(epicInOverview(epic(), today)).toBe(false);
    expect(epicInOverview(item({ type: "Epic", category: "Resolved" }), today)).toBe(true);
    expect(epicInOverview(item({ type: "Epic", category: "Proposed" }), today)).toBe(false);
  });
});
