import { describe, expect, it } from "vitest";
import {
  bucket,
  burnup,
  businessValue,
  capacityTotal,
  currentIteration,
  dayIso,
  defaultIterationIndex,
  dependencyRows,
  DepContext,
  doneIn,
  isIpSprint,
  iterationSummary,
  loadVsCapacity,
  milestonesInWindow,
  normalize,
  overviewRows,
  piProgress,
  piStatus,
  placements,
  pointsSummary,
  relativeDays,
  riskRows,
  RItem,
  teamOf,
  teamProgress,
  teamVelocity,
  toDay,
  trainVelocity,
  wsjf,
} from "../../src/api/reports";
import { subtreeIds } from "../../src/api/org";
import { Milestone, OrgNode, PiObjective, ProgramIncrement, Risk, WorkItemMeta } from "../../src/api/types";

const SP = "Microsoft.VSTS.Scheduling.StoryPoints";
const d = (iso: string) => `${iso}T00:00:00Z`;
const day = (iso: string) => toDay(iso);

const PI_PATH = "P\\PIs\\PI 5";
const sprint = (name: string, start: string, finish: string, pi = PI_PATH) => ({
  name,
  path: `${pi}\\${name}`,
  identifier: name,
  start: d(start),
  finish: d(finish),
});
const PI5: ProgramIncrement = {
  name: "PI 5",
  path: PI_PATH,
  identifier: "pi5",
  start: d("2026-03-01"),
  finish: d("2026-03-28"),
  sprints: [
    sprint("S1", "2026-03-01", "2026-03-07"),
    sprint("S2", "2026-03-08", "2026-03-14"),
    sprint("S3", "2026-03-15", "2026-03-21"),
    sprint("PI 5 IP", "2026-03-22", "2026-03-28"),
  ],
};
const PI4: ProgramIncrement = {
  name: "PI 4",
  path: "P\\PIs\\PI 4",
  identifier: "pi4",
  start: d("2026-02-01"),
  finish: d("2026-02-28"),
  sprints: [
    sprint("A", "2026-02-01", "2026-02-07", "P\\PIs\\PI 4"),
    sprint("B", "2026-02-08", "2026-02-14", "P\\PIs\\PI 4"),
    sprint("C", "2026-02-15", "2026-02-21", "P\\PIs\\PI 4"),
    sprint("D", "2026-02-22", "2026-02-28", "P\\PIs\\PI 4"),
  ],
};
const PI6: ProgramIncrement = { ...PI5, name: "PI 6", path: "P\\PIs\\PI 6", start: d("2026-04-01"), finish: d("2026-04-28"), sprints: [] };
const TODAY = day("2026-03-10");

let seq = 1;
const item = (over: Partial<RItem> = {}): RItem => ({
  id: seq++,
  type: "User Story",
  title: "x",
  state: "New",
  category: "Proposed",
  sp: 1,
  childIds: [],
  ...over,
});
const done = (over: Partial<RItem> = {}) => item({ category: "Completed", state: "Closed", ...over });

describe("dates", () => {
  it("converts ISO strings and Dates to UTC day numbers and back", () => {
    expect(toDay("1970-01-02")).toBe(1);
    expect(toDay(new Date("1970-01-03T23:59:00Z"))).toBe(2);
    expect(toDay("2026-03-10T15:00:00.000Z")).toBe(day("2026-03-10"));
    expect(dayIso(day("2026-03-10"))).toBe("2026-03-10");
  });

  it("classifies PIs and iterations as planned, current, completed or undated", () => {
    expect(piStatus(PI5, TODAY)).toBe("current");
    expect(piStatus(PI5, day("2026-03-28"))).toBe("current");
    expect(piStatus(PI5, day("2026-03-29"))).toBe("completed");
    expect(piStatus(PI5, day("2026-02-28"))).toBe("planned");
    expect(piStatus({ ...PI5, start: undefined }, TODAY)).toBe("undated");
  });

  it("finds the PI and iteration running today", () => {
    const now = currentIteration([PI4, PI5], TODAY);
    expect(now.pi?.name).toBe("PI 5");
    expect(now.sprint?.name).toBe("S2");
    expect(currentIteration([PI4, PI5], day("2026-05-01"))).toEqual({ pi: undefined, sprint: undefined });
  });

  it("computes PI progress as elapsed calendar days", () => {
    expect(piProgress(PI5, TODAY)).toEqual({ pct: 32, elapsedDays: 9, totalDays: 28, remainingDays: 19 });
    expect(piProgress(PI5, day("2026-02-01"))).toEqual({ pct: 0, elapsedDays: 0, totalDays: 28, remainingDays: 28 });
    expect(piProgress(PI5, day("2026-06-01"))).toEqual({ pct: 100, elapsedDays: 28, totalDays: 28, remainingDays: 0 });
    expect(piProgress({ ...PI5, finish: undefined }, TODAY)).toBeNull();
  });

  it("recognizes the IP iteration by name", () => {
    expect(isIpSprint(PI5.sprints[3])).toBe(true);
    expect(isIpSprint({ ...PI5.sprints[0], name: "ip sprint" })).toBe(true);
    expect(isIpSprint({ ...PI5.sprints[0], name: "Shipping" })).toBe(false);
  });

  it("describes relative days", () => {
    expect(relativeDays("2026-03-10", TODAY)).toBe("today");
    expect(relativeDays("2026-03-11", TODAY)).toBe("in 1 day");
    expect(relativeDays("2026-03-15", TODAY)).toBe("in 5 days");
    expect(relativeDays("2026-03-09", TODAY)).toBe("1 day ago");
    expect(relativeDays("2026-03-01", TODAY)).toBe("9 days ago");
  });
});

describe("normalize", () => {
  const cat = (_t: string, s: string) => (s === "Closed" ? "Completed" : "Proposed");
  it("flattens fields, parent and children", () => {
    const n = normalize(
      {
        id: 7,
        fields: {
          "System.WorkItemType": "Feature",
          "System.Title": "T",
          "System.State": "Closed",
          "System.IterationPath": "I",
          "System.AreaPath": "A",
          "System.AssignedTo": { displayName: "Ada" },
          "Microsoft.VSTS.Common.ClosedDate": "2026-03-02T10:00:00Z",
          "Microsoft.VSTS.Common.BusinessValue": 8,
          "Microsoft.VSTS.Common.TimeCriticality": "5",
          "Microsoft.VSTS.Scheduling.Effort": 13,
          [SP]: 3,
        },
        relations: [
          { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://x/_apis/wit/workItems/1" },
          { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://x/_apis/wit/workItems/8" },
          { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://x/other" },
        ],
      },
      cat,
      SP
    );
    expect(n).toMatchObject({
      id: 7,
      type: "Feature",
      title: "T",
      category: "Completed",
      sp: 3,
      iteration: "I",
      area: "A",
      parentId: 1,
      childIds: [8],
      assignedTo: "Ada",
      closedDate: "2026-03-02T10:00:00Z",
      businessValue: 8,
      timeCriticality: 5,
      effort: 13,
    });
  });

  it("treats empty or invalid points as unestimated and handles missing data", () => {
    const n = normalize({ id: 9, fields: { "System.State": "New", [SP]: "", "System.AssignedTo": "Bob <b@x>" } }, cat, SP);
    expect(n.sp).toBeNull();
    expect(n.title).toBe("#9");
    expect(n.parentId).toBeUndefined();
    expect(n.assignedTo).toBe("Bob <b@x>");
    expect(normalize({ id: 10, fields: { [SP]: "abc" } }, cat, SP).sp).toBeNull();
    expect(normalize({ id: 11, fields: {}, relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "bad" }] }, cat, SP).parentId).toBeUndefined();
  });
});

describe("KPI formulas", () => {
  it("sums planned and done points, excluding removed stories and counting unestimated ones", () => {
    const p = pointsSummary([item({ sp: 5 }), done({ sp: 3 }), item({ sp: null }), item({ sp: 13, category: "Removed" })]);
    expect(p).toEqual({ planned: 8, done: 3, pct: 38, unestimated: 1, count: 3 });
    expect(pointsSummary([]).pct).toBeNull();
  });

  it("computes business value from committed plan and all actuals", () => {
    const o = (committed: boolean, plannedBV: number, actualBV: number | null) => ({ committed, plannedBV, actualBV }) as PiObjective;
    expect(businessValue([o(true, 10, 8), o(true, 10, null), o(false, 5, 4)])).toEqual({ planned: 20, actual: 12, pct: 60, missingActual: 1 });
    expect(businessValue([o(false, 5, 5)]).pct).toBeNull();
  });

  it("totals capacity of the given teams over the given iterations", () => {
    const docs = [
      { id: "1", nodeId: "a", iterationPath: "P\\S1", capacity: 10 },
      { id: "2", nodeId: "a", iterationPath: "p\\s2", capacity: 5 },
      { id: "3", nodeId: "b", iterationPath: "P\\S1", capacity: 7 },
      { id: "4", nodeId: "a", iterationPath: "P\\S9", capacity: 99 },
      { id: "5", nodeId: "a", iterationPath: "P\\S1", capacity: "x" as unknown as number },
    ];
    expect(capacityTotal(docs, new Set(["a"]), ["P\\S1", "P\\S2"])).toBe(15);
    expect(capacityTotal(docs, new Set(["a", "b"]), ["P\\S1"])).toBe(17);
  });

  it("relates load to capacity", () => {
    expect(loadVsCapacity([item({ sp: 8 }), item({ sp: null })], 10)).toEqual({ load: 8, capacity: 10, pct: 80, unestimated: 1 });
    expect(loadVsCapacity([item({ sp: 8 })], 0).pct).toBeNull();
  });
});

describe("velocity", () => {
  const s = (sprintPath: string, sp: number, isDone = true) => (isDone ? done({ sp, iteration: sprintPath }) : item({ sp, iteration: sprintPath }));
  const stories = [
    s(PI4.sprints[0].path, 10),
    s(PI4.sprints[1].path, 20),
    s(PI4.sprints[2].path, 30),
    s(PI4.sprints[3].path, 40),
    s(PI5.sprints[0].path, 6),
    s(PI5.sprints[0].path, 50, false),
    s(PI5.sprints[1].path, 8),
    done({ sp: 100, iteration: PI5.sprints[0].path, category: "Removed" }),
  ];

  it("counts completed points under an iteration or PI", () => {
    expect(doneIn(stories, PI5.sprints[0].path)).toBe(6);
    expect(doneIn(stories, PI4.path)).toBe(100);
  });

  it("team: current PI averages its completed iterations", () => {
    expect(teamVelocity(PI5, [PI4, PI5], stories, TODAY)).toEqual({ value: 6, basis: "Ø completed iterations of the PI", samples: 1 });
    expect(teamVelocity(PI5, [PI4, PI5], stories, day("2026-03-01")).value).toBeNull();
  });

  it("team: planned PI averages the last 5 completed iterations across PIs", () => {
    // Completed: A,B,C,D,S1 (S2 still running) -> (10+20+30+40+6)/5
    expect(teamVelocity(PI6, [PI4, PI5, PI6], stories, TODAY)).toEqual({ value: 21.2, basis: "Ø last 5 completed iterations", samples: 5 });
    // After S2 completes, A drops out: (20+30+40+6+8)/5
    expect(teamVelocity(PI6, [PI4, PI5, PI6], stories, day("2026-03-15")).value).toBe(20.8);
    expect(teamVelocity(PI6, [PI6], stories, TODAY).value).toBeNull();
  });

  it("team: completed PI averages all of its iterations", () => {
    expect(teamVelocity(PI4, [PI4, PI5], stories, TODAY)).toEqual({ value: 25, basis: "Ø all iterations of the PI", samples: 4 });
  });

  it("train: to date, PI total, or the average of the last 5 completed PIs", () => {
    expect(trainVelocity(PI5, [PI4, PI5], stories, TODAY)).toEqual({ value: 14, basis: "Velocity to date", samples: 1 });
    expect(trainVelocity(PI4, [PI4, PI5], stories, TODAY)).toEqual({ value: 100, basis: "PI total", samples: 1 });
    expect(trainVelocity(PI6, [PI4, PI5, PI6], stories, TODAY)).toEqual({ value: 100, basis: "Ø last 5 completed PIs", samples: 1 });
    expect(trainVelocity(PI6, [PI4, PI5, PI6], stories, day("2026-03-30")).value).toBe(57);
    expect(trainVelocity(PI6, [PI6], stories, TODAY).value).toBeNull();
  });
});

describe("dependencies", () => {
  const paths = PI5.sprints.map((s) => s.path);

  it("places items in their sprint, parents at their latest planned child", () => {
    const f = item({ type: "Feature", iteration: PI_PATH });
    const a = item({ parentId: f.id, iteration: paths[0] });
    const b = item({ parentId: f.id, iteration: paths[2] });
    const gone = item({ parentId: f.id, iteration: paths[3], category: "Removed" });
    const lone = item({ type: "Feature", iteration: paths[1] });
    const p = placements([f, a, b, gone, lone], paths);
    expect(p.get(f.id)).toBe(2);
    expect(p.get(a.id)).toBe(0);
    expect(p.get(lone.id)).toBe(1);
  });

  it("rates criticality by team planning, roadmap dates or both and splits internal/external", () => {
    const a = item({ iteration: paths[0], area: "A" });
    const b = item({ iteration: paths[1], area: "A" });
    const c = item({ iteration: paths[1], area: "Other" });
    const x = done({ iteration: paths[2], area: "A" });
    const gone = item({ category: "Removed" });
    const noise = item({});
    const items = new Map([a, b, c, x, gone, noise].map((i) => [i.id, i]));
    const meta = new Map<number, WorkItemMeta>([
      [b.id, { id: "", workItemId: b.id, assignedNodeIds: [], assignedPiPaths: [], plannedStart: "2026-03-01", plannedEnd: "2026-03-20" }],
      [a.id, { id: "", workItemId: a.id, assignedNodeIds: [], assignedPiPaths: [], plannedStart: "2026-03-05", plannedEnd: "2026-03-10" }],
    ]);
    const ctx: DepContext = {
      items,
      anchorIds: new Set([a.id, b.id, x.id]),
      inScope: (i) => i.area === "A",
      placement: placements([a, b, c, x], paths),
      meta,
    };
    const deps = [
      { provider: b.id, consumer: a.id }, // later sprint -> critical
      { provider: a.id, consumer: c.id }, // earlier -> healthy, external
      { provider: b.id, consumer: c.id }, // same sprint -> at risk
      { provider: x.id, consumer: a.id }, // done -> resolved
      { provider: gone.id, consumer: a.id }, // removed -> skipped
      { provider: 999, consumer: a.id }, // unknown -> skipped
      { provider: noise.id, consumer: c.id }, // no anchor -> skipped
    ];
    const team = dependencyRows(deps, ctx, "team");
    expect(team.map((r) => [r.provider.id, r.consumer.id, r.criticality, r.internal])).toEqual([
      [b.id, a.id, "critical", true],
      [b.id, c.id, "atRisk", false],
      [a.id, c.id, "healthy", false],
      [x.id, a.id, "resolved", true],
    ]);
    expect(team[0].secondary).toBeUndefined();

    const roadmap = dependencyRows(deps, ctx, "roadmap");
    // b ends 03-20 after a ends 03-10 -> critical; c has no dates -> at risk
    expect(roadmap.find((r) => r.provider.id === b.id && r.consumer.id === a.id)!.criticality).toBe("critical");
    expect(roadmap.find((r) => r.provider.id === a.id)!.criticality).toBe("atRisk");

    const combined = dependencyRows(deps, ctx, "combined");
    expect(combined[0]).toMatchObject({ criticality: "critical", secondary: "critical" });
    expect(combined.find((r) => r.provider.id === a.id)).toMatchObject({ criticality: "healthy", secondary: "atRisk" });
  });

  it("orders ties by provider and consumer id", () => {
    const a = item({});
    const b = item({});
    const c = item({});
    const ctx: DepContext = { items: new Map([a, b, c].map((i) => [i.id, i])), anchorIds: new Set([a.id, b.id]), inScope: () => true, placement: new Map(), meta: new Map() };
    const rows = dependencyRows([{ provider: b.id, consumer: c.id }, { provider: a.id, consumer: c.id }, { provider: a.id, consumer: b.id }], ctx, "team");
    expect(rows.map((r) => [r.provider.id, r.consumer.id])).toEqual([
      [a.id, b.id],
      [a.id, c.id],
      [b.id, c.id],
    ]);
  });
});

describe("burnup", () => {
  const paths = PI5.sprints.map((s) => s.path);
  const stories = [
    done({ sp: 4, iteration: paths[0], closedDate: "2026-03-03T12:00:00Z" }),
    done({ sp: 3, iteration: paths[0], closedDate: "2026-03-07T12:00:00Z" }),
    done({ sp: 2, iteration: paths[1], closedDate: "2026-03-09T08:00:00Z" }),
    done({ sp: 1, iteration: paths[1] }), // no closed date -> counted today
    item({ sp: 10, iteration: paths[2] }),
    item({ sp: 50, category: "Removed" }),
  ];

  it("builds scope, burned, ideal (excluding IP) and forecast lines", () => {
    const b = burnup(PI5, stories, TODAY)!;
    expect(b.scope).toBe(20);
    expect(b.days).toHaveLength(28);
    expect(b.todayIndex).toBe(9);
    expect(b.days.every((x) => x.scope === 20)).toBe(true);
    const at = (iso: string) => b.days.find((x) => x.date === iso)!;
    expect(at("2026-03-01").burned).toBe(0);
    expect(at("2026-03-03").burned).toBe(4);
    expect(at("2026-03-07").burned).toBe(7);
    expect(at("2026-03-09").burned).toBe(9);
    expect(at("2026-03-10").burned).toBe(10);
    expect(at("2026-03-11").burned).toBeNull();
    // 21 non-IP days: ideal reaches scope at the end of S3 and stays flat through IP.
    expect(at("2026-03-01").ideal).toBe(1);
    expect(at("2026-03-07").ideal).toBe(6.7);
    expect(at("2026-03-21").ideal).toBe(20);
    expect(at("2026-03-28").ideal).toBe(20);
    // Completed iteration S1 burned 7 SP in 7 days -> 1 SP/day from today's 10.
    expect(b.dailyRate).toBe(1);
    expect(at("2026-03-09").forecast).toBeNull();
    expect(at("2026-03-10").forecast).toBe(10);
    expect(at("2026-03-15").forecast).toBe(15);
    expect(at("2026-03-28").forecast).toBe(20); // capped at scope
    expect(b.bands.map((x) => [x.name, x.from, x.to, x.ip])).toEqual([
      ["S1", 0, 6, false],
      ["S2", 7, 13, false],
      ["S3", 14, 20, false],
      ["PI 5 IP", 21, 27, true],
    ]);
  });

  it("forecasts from the burn rate so far when no iteration is complete", () => {
    const b = burnup(PI5, stories, day("2026-03-05"))!;
    // 4 SP closed + 1 SP without a closed date (counted today) in 5 days -> 1/day
    expect(b.dailyRate).toBe(1);
    expect(b.days[4].forecast).toBe(5);
    expect(b.days[9].forecast).toBe(10);
  });

  it("has no forecast or today marker outside the PI and no ideal ramp without work days", () => {
    const after = burnup(PI5, stories, day("2026-04-10"))!;
    expect(after.todayIndex).toBe(-1);
    // S1..S3 completed: 10 SP over 21 days
    expect(after.dailyRate).toBe(0.5);
    expect(after.days.every((x) => x.forecast === null)).toBe(true);
    expect(after.days[27].burned).toBe(10);
    const before = burnup(PI5, stories, day("2026-02-10"))!;
    expect(before.dailyRate).toBe(0);
    expect(before.days.every((x) => x.burned === null)).toBe(true);

    const allIp: ProgramIncrement = { ...PI5, sprints: [{ ...PI5.sprints[3], name: "IP", start: PI5.start, finish: PI5.finish }, { ...PI5.sprints[0], start: undefined }] };
    const flat = burnup(allIp, stories, TODAY)!;
    expect(flat.days.every((x) => x.ideal === 20)).toBe(true);
    expect(flat.bands).toHaveLength(1);
    expect(burnup({ ...PI5, start: undefined }, stories, TODAY)).toBeNull();
  });
});

describe("milestones, objectives and risks", () => {
  it("filters milestones by node and window, sorted by date and title", () => {
    const m = (id: string, nodeId: string, date: string, title = id): Milestone => ({ id, nodeId, date, title });
    const list = [m("b", "n1", "2026-03-05"), m("a", "n1", "2026-03-05"), m("c", "n2", "2026-03-06"), m("d", "n1", "2026-04-05"), m("e", "n1", "2026-03-01")];
    expect(milestonesInWindow(list, new Set(["n1"]), day("2026-03-01"), day("2026-03-28")).map((x) => x.id)).toEqual(["e", "a", "b"]);
  });

  it("computes BV progress per child and the average", () => {
    const leaf = (id: string): OrgNode => ({ id, name: id, level: "team", children: [] });
    const [a, b, c] = [leaf("a"), leaf("b"), leaf("c")];
    const o = (nodeId: string, plannedBV: number, actualBV: number) => ({ nodeId, committed: true, plannedBV, actualBV }) as PiObjective;
    const r = teamProgress([a, b, c], [o("a", 10, 9), o("b", 10, 6)], subtreeIds);
    expect(r.rows.map((x) => [x.node.id, x.pct])).toEqual([
      ["a", 90],
      ["b", 60],
      ["c", null],
    ]);
    expect(r.average).toBe(75);
    expect(teamProgress([c], [], subtreeIds).average).toBeNull();
  });

  it("ranks risks by exposure then residual exposure then title", () => {
    const r = (title: string, extra: Partial<Risk>) => ({ id: title, title, ...extra }) as Risk;
    const rows = riskRows([
      r("low", { probability: "Very Unlikely", impactLevel: "Insignificant" }),
      r("b-extreme", { probability: "Almost Certain", impactLevel: "Catastrophic", residualProbability: "Unlikely", residualImpact: "Minor" }),
      r("a-extreme", { probability: "Almost Certain", impactLevel: "Catastrophic", residualProbability: "Unlikely", residualImpact: "Minor" }),
      r("extreme-high-residual", { probability: "Almost Certain", impactLevel: "Catastrophic", residualProbability: "Likely", residualImpact: "Major" }),
      r("unrated", {}),
    ]);
    expect(rows.map((x) => [x.risk.title, x.exposure, x.residual])).toEqual([
      ["extreme-high-residual", "EXTREME", "HIGH"],
      ["a-extreme", "EXTREME", "MEDIUM"],
      ["b-extreme", "EXTREME", "MEDIUM"],
      ["unrated", "INTERMEDIATE", "INTERMEDIATE"],
      ["low", "LOW", "INTERMEDIATE"],
    ]);
  });
});

describe("overview", () => {
  const teams: OrgNode[] = [
    { id: "red", name: "Red", level: "team", areaPath: "P\\ART\\Red", children: [] },
    { id: "blue", name: "Blue", level: "team", areaPath: "P\\ART\\Blue", children: [] },
    { id: "art", name: "ART", level: "team", areaPath: "P\\ART", children: [] },
    { id: "none", name: "None", level: "team", children: [] },
  ];

  it("computes WSJF only with an effort and some value", () => {
    expect(wsjf(item({ businessValue: 8, timeCriticality: 5, effort: 13 }))).toBe(1);
    expect(wsjf(item({ businessValue: 3, effort: 20 }))).toBe(0.2);
    expect(wsjf(item({ timeCriticality: 3, effort: 2 }))).toBe(1.5);
    expect(wsjf(item({ businessValue: 3 }))).toBeNull();
    expect(wsjf(item({ effort: 5 }))).toBeNull();
    expect(wsjf(item({ businessValue: 1, effort: 0 }))).toBeNull();
  });

  it("maps an area to the deepest team", () => {
    expect(teamOf("P\\ART\\Red\\Sub", teams)?.id).toBe("red");
    expect(teamOf("P\\ART\\Green", teams)?.id).toBe("art");
    expect(teamOf("Q", teams)).toBeUndefined();
    expect(teamOf(undefined, teams)).toBeUndefined();
  });

  it("buckets state categories into To Do / In Progress / Done", () => {
    expect(bucket("Proposed")).toBe("todo");
    expect(bucket("InProgress")).toBe("inProgress");
    expect(bucket("Resolved")).toBe("inProgress");
    expect(bucket("Completed")).toBe("done");
  });

  it("rolls up counted stories per parent with split, teams and drill-down", () => {
    const f1 = item({ type: "Feature", businessValue: 8, timeCriticality: 2, effort: 5 });
    const f2 = item({ type: "Feature", businessValue: 1, effort: 1 });
    const f3 = item({ type: "Feature" }); // no counted stories -> dropped
    const f4 = item({ type: "Feature", category: "Removed" });
    const s1 = done({ parentId: f1.id, sp: 5, area: "P\\ART\\Red", iteration: "PI" });
    const s2 = item({ parentId: f1.id, sp: 3, area: "P\\ART\\Blue", iteration: "PI", category: "InProgress" });
    const s3 = item({ parentId: f1.id, sp: 8, area: "P\\ART\\Red", iteration: "OTHER" });
    const s4 = item({ parentId: f2.id, sp: 2, area: "Q", iteration: "PI" });
    const s5 = item({ parentId: f3.id, sp: 1, iteration: "OTHER" });
    const orphan = item({ sp: 4, area: "P\\ART\\Blue", iteration: "PI" });
    const outsider = item({ parentId: 9999, sp: 1, area: "P\\ART\\Red", iteration: "PI" });
    const { rows, orphans } = overviewRows({
      items: [f1, f2, f3, f4, s1, s2, s3, s4, s5, orphan, outsider],
      rootType: "Feature",
      storyType: "User Story",
      counts: (s) => s.iteration === "PI",
      teams,
    });
    expect(rows.map((r) => r.item.id)).toEqual([f1.id, f2.id]); // WSJF 2 before 1
    const r1 = rows[0];
    expect(r1).toMatchObject({ wsjf: 2, points: 8, done: 5, pct: 63, split: { todo: 0, inProgress: 3, done: 5 } });
    expect(r1.teams.map((t) => [t.node.id, t.points])).toEqual([
      ["red", 5],
      ["blue", 3],
    ]);
    expect(r1.children.map((c) => c.item.id)).toEqual([s1.id, s2.id]);
    expect(rows[1].teams).toEqual([]);
    expect(orphans!.item.title).toBe("Without parent");
    expect(orphans!.children.map((c) => c.item.id)).toEqual([orphan.id, outsider.id]);
    expect(orphans!.points).toBe(5);
  });

  it("keeps roots by predicate (epic overview), walks intermediate levels and survives cycles", () => {
    const e1 = item({ type: "Epic" });
    const e2 = item({ type: "Epic" });
    const f = item({ type: "Feature", parentId: e1.id });
    const emptyF = item({ type: "Feature", parentId: e1.id });
    const s = done({ parentId: f.id, sp: 2 });
    const loopA = item({ type: "Feature", parentId: e2.id });
    const loopB = item({ type: "Feature", parentId: loopA.id });
    loopA.parentId = loopB.id; // cycle below e2 is unreachable from e2 but must not hang
    const { rows, orphans } = overviewRows({
      items: [e1, e2, f, emptyF, s, loopA, loopB],
      rootType: "Epic",
      storyType: "User Story",
      counts: () => true,
      teams: [],
      keepRoot: () => true,
    });
    expect(rows.map((r) => r.item.id)).toEqual([e1.id, e2.id]);
    expect(rows[0].children.map((c) => c.item.id)).toEqual([f.id]);
    expect(rows[0].points).toBe(2);
    expect(rows[1].points).toBe(0);
    expect(rows[1].pct).toBeNull();
    expect(orphans).toBeNull();

    const cyc1 = item({ type: "Epic" });
    const cyc2 = item({ type: "Epic", parentId: cyc1.id });
    cyc1.parentId = cyc2.id;
    const res = overviewRows({ items: [cyc1, cyc2], rootType: "Epic", storyType: "User Story", counts: () => true, teams: [], keepRoot: () => true });
    expect(res.rows).toHaveLength(2);
  });
});

describe("iteration overview", () => {
  it("summarizes an iteration grouped by parent, orphans last", () => {
    const path = PI5.sprints[0].path;
    const s = iterationSummary(
      [
        item({ iteration: path, sp: 3, parentId: 20 }),
        done({ iteration: path, sp: 2, parentId: 10 }),
        item({ iteration: path, sp: null }),
        item({ iteration: path, sp: 1, parentId: 10 }),
        item({ iteration: PI5.sprints[1].path, sp: 9 }),
        item({ iteration: path, sp: 9, category: "Removed" }),
      ],
      PI5.sprints[0],
      12
    );
    expect(s).toMatchObject({ count: 4, planned: 6, done: 2, capacity: 12 });
    expect(s.groups.map((g) => [g.parentId, g.items.length])).toEqual([
      [10, 2],
      [20, 1],
      [null, 1],
    ]);
    const single = iterationSummary([item({ iteration: path })], PI5.sprints[0], null);
    expect(single.groups.map((g) => g.parentId)).toEqual([null]);
    const two = iterationSummary([item({ iteration: path }), item({ iteration: path, parentId: 3 })], PI5.sprints[0], null);
    expect(two.groups.map((g) => g.parentId)).toEqual([3, null]);
  });

  it("opens on the current iteration, else the first", () => {
    expect(defaultIterationIndex(PI5, TODAY)).toBe(1);
    expect(defaultIterationIndex(PI5, day("2026-06-01"))).toBe(0);
  });
});
