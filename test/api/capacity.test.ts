import { describe, expect, it } from "vitest";
import {
  availableDays,
  capacityMembers,
  capacityPageUrl,
  capacitySettings,
  DEFAULT_WORKING_DAYS,
  deriveCapacity,
  derivedKey,
  DerivedResult,
  effectiveCapacity,
  expandDays,
  loadDerivedCapacity,
  normalizeWorkingDays,
  resolveCapacity,
  totalCapacity,
  totalOrigin,
} from "../../src/api/capacity";
import { findNode } from "../../src/api/org";
import { getProgramIncrements } from "../../src/api/wit";
import { callsTo, fail, fake, makeConfig, PI2_S1 } from "../fakeAdo";

// Monday 5 October 2026 to Friday 16 October 2026: a 2-week iteration with 10 working days.
const START = "2026-10-05T00:00:00Z";
const FINISH = "2026-10-16T00:00:00Z";
const MON_FRI = DEFAULT_WORKING_DAYS;

const member = (name: string, perDay: number | number[], daysOff: { start: string; end: string }[] = []) => ({
  teamMember: { displayName: name, id: name.toLowerCase() },
  activities: (Array.isArray(perDay) ? perDay : [perDay]).map((capacityPerDay, i) => ({ name: i ? "Testing" : "Development", capacityPerDay })),
  daysOff,
});

describe("capacity settings", () => {
  it("defaults to manual story points with 0.8 SP per person-day", () => {
    expect(capacitySettings({})).toEqual({ source: "manual", pointsPerPersonDay: 0.8 });
    expect(capacitySettings({ capacity: { source: "derived" } })).toEqual({ source: "derived", pointsPerPersonDay: 0.8 });
    expect(capacitySettings({ capacity: { source: "hybrid", pointsPerPersonDay: 1 } })).toEqual({ source: "hybrid", pointsPerPersonDay: 1 });
  });

  it("ignores unknown sources and invalid factors", () => {
    expect(capacitySettings({ capacity: { source: "bogus" as never, pointsPerPersonDay: -1 } })).toEqual({ source: "manual", pointsPerPersonDay: 0.8 });
    expect(capacitySettings({ capacity: { source: "derived", pointsPerPersonDay: "x" as never } }).pointsPerPersonDay).toBe(0.8);
  });
});

describe("Azure DevOps response shapes", () => {
  it("reads members from a bare array, a { value } list and a { teamMembers } wrapper", () => {
    const list = [member("Ada", 6)];
    expect(capacityMembers(list)).toBe(list);
    expect(capacityMembers({ count: 1, value: list })).toBe(list);
    expect(capacityMembers({ teamMembers: list, totalCapacityPerDay: 6, totalDaysOff: 0 })).toBe(list);
    expect(capacityMembers(null)).toEqual([]);
    expect(capacityMembers({ something: 1 })).toEqual([]);
  });

  it("normalizes working days given as names or DayOfWeek numbers", () => {
    expect(normalizeWorkingDays(["monday", "Tuesday", "wednesday"])).toEqual([1, 2, 3]);
    expect(normalizeWorkingDays([0, 6, 6, 9])).toEqual([0, 6]);
    expect(normalizeWorkingDays(["funday"])).toEqual(MON_FRI);
    expect(normalizeWorkingDays(undefined)).toEqual(MON_FRI);
  });
});

describe("working days", () => {
  it("expands inclusive day-off ranges and skips unparsable ones", () => {
    expect(Array.from(expandDays([{ start: "2026-10-07T00:00:00Z", end: "2026-10-09T00:00:00Z" }]))).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(Array.from(expandDays([{ start: "2026-10-07", end: undefined as never }]))).toEqual(["2026-10-07"]);
    expect(expandDays([{ start: "garbage", end: "2026-10-09" }]).size).toBe(0);
    expect(expandDays().size).toBe(0);
  });

  it("counts working days excluding weekends and days off", () => {
    expect(availableDays(START, FINISH, MON_FRI)).toBe(10);
    expect(availableDays(START, FINISH, [0, 1, 2, 3, 4, 5, 6])).toBe(12);
    expect(availableDays(START, FINISH, MON_FRI, new Set(["2026-10-07", "2026-10-10"]))).toBe(9); // Saturday off changes nothing
    expect(availableDays("nope", FINISH, MON_FRI)).toBe(0);
  });
});

describe("SAFe normalized estimation", () => {
  it("gives a full-time member 8 points in a 2-week iteration", () => {
    const d = deriveCapacity({ start: START, finish: FINISH, workingDays: MON_FRI, members: [member("Ada", 6)] }, 0.8)!;
    expect(d).toMatchObject({ points: 8, personDays: 10, iterationDays: 10, factor: 0.8 });
    expect(d.members).toEqual([{ name: "Ada", days: 10, counted: true, points: 8 }]);
  });

  it("subtracts team and personal days off", () => {
    const d = deriveCapacity(
      {
        start: START,
        finish: FINISH,
        workingDays: MON_FRI,
        teamDaysOff: [{ start: "2026-10-12T00:00:00Z", end: "2026-10-12T00:00:00Z" }],
        members: [member("Ada", 6, [{ start: "2026-10-14T00:00:00Z", end: "2026-10-15T00:00:00Z" }]), member("Grace", 4)],
      },
      0.8
    )!;
    expect(d.iterationDays).toBe(9);
    expect(d.members.map((m) => [m.name, m.days, m.points])).toEqual([
      ["Ada", 7, 5.6],
      ["Grace", 9, 7.2],
    ]);
    expect(d).toMatchObject({ personDays: 16, points: 12.8 });
  });

  it("counts a member with capacity in any activity and skips members without capacity", () => {
    const d = deriveCapacity(
      {
        start: START,
        finish: FINISH,
        workingDays: MON_FRI,
        members: [member("Part-time", [0, 2]), member("Zero", [0, 0]), { teamMember: { uniqueName: "nobody@x" } }, {}],
      },
      0.8
    )!;
    expect(d.members.map((m) => [m.name, m.counted, m.points])).toEqual([
      ["Part-time", true, 8],
      ["Zero", false, 0],
      ["nobody@x", false, 0],
      ["Unknown member", false, 0],
    ]);
    expect(d.points).toBe(8);
  });

  it("applies the configured factor and team working days", () => {
    expect(deriveCapacity({ start: START, finish: FINISH, workingDays: MON_FRI, members: [member("A", 6), member("B", 6)] }, 1)!.points).toBe(20);
    expect(deriveCapacity({ start: START, finish: FINISH, workingDays: [1, 2, 3, 4, 5, 6], members: [member("A", 6)] }, 0.8)!.points).toBe(8.8);
  });

  it("returns null when nobody has capacity set up", () => {
    expect(deriveCapacity({ start: START, finish: FINISH, workingDays: MON_FRI, members: [] }, 0.8)).toBeNull();
    expect(deriveCapacity({ start: START, finish: FINISH, workingDays: MON_FRI, members: [member("A", 0)] }, 0.8)).toBeNull();
  });
});

describe("effective capacity", () => {
  const derived = deriveCapacity({ start: START, finish: FINISH, workingDays: MON_FRI, members: [member("Ada", 6), member("Zed", 0)] }, 0.8)!;
  const ok: DerivedResult = { derived, capacityUrl: "https://x/cap" };
  const missing: DerivedResult = { derived: null, reason: "No capacity is set up for the team in Azure DevOps.", capacityUrl: "https://x/cap" };

  it("manual: uses the stored story points and ignores Azure DevOps", () => {
    expect(resolveCapacity({ source: "manual" }, 12, ok)).toMatchObject({ value: 12, origin: "manual", explanation: "Manual: 12 SP entered in SAFe Ado." });
    expect(resolveCapacity({ source: "manual" }, undefined, ok)).toMatchObject({ value: undefined, origin: "none" });
  });

  it("derived: uses Azure DevOps and ignores manual values; explains the calculation", () => {
    const c = resolveCapacity({ source: "derived" }, 12, ok);
    expect(c).toMatchObject({ value: 8, origin: "derived", capacityUrl: "https://x/cap" });
    expect(c.explanation).toContain("10 available person-days × 0.8 SP = 8 SP");
    expect(c.explanation).toContain("1 member with capacity");
    expect(c.explanation).toContain("• Ada: 10 days → 8 SP");
    expect(c.explanation).toContain("• Zed: no capacity per day, not counted");
    expect(resolveCapacity({ source: "derived" }, 12, missing)).toMatchObject({
      value: undefined,
      origin: "none",
      explanation: "Not set: No capacity is set up for the team in Azure DevOps.",
    });
    expect(resolveCapacity({ source: "derived" }, undefined, undefined).explanation).toBe("Not set: Azure DevOps team capacity is not loaded.");
  });

  it("hybrid: a manual value overrides the derived default", () => {
    expect(resolveCapacity({ source: "hybrid" }, undefined, ok)).toMatchObject({ value: 8, origin: "derived" });
    const o = resolveCapacity({ source: "hybrid" }, 5, ok);
    expect(o).toMatchObject({ value: 5, origin: "override", manual: 5 });
    expect(o.explanation).toBe("Manual override: 5 SP (derived from Azure DevOps: 8 SP). Clear it to use the derived value.");
    expect(resolveCapacity({ source: "hybrid" }, 5, missing).explanation).toContain("no derived value — No capacity is set up");
    expect(resolveCapacity({ source: "hybrid" }, 5, undefined).explanation).toContain("(no derived value)");
    expect(resolveCapacity({ source: "hybrid" }, undefined, missing)).toMatchObject({ origin: "none" });
  });

  it("finds the stored value by iteration id or path", () => {
    const sprint = { identifier: "it-1", path: "P\\S1" };
    const docs = [
      { id: "a", nodeId: "n1", iterationPath: "p\\s1", capacity: 7 },
      { id: "b", nodeId: "n2", iterationPath: "X", iterationId: "it-1", capacity: 9 },
      { id: "c", nodeId: "n3", iterationPath: "P\\S1", capacity: "x" as never },
    ];
    const map = new Map([[derivedKey("n1", sprint), ok]]);
    expect(effectiveCapacity({}, docs, map, "n1", sprint)).toMatchObject({ value: 7, origin: "manual" });
    expect(effectiveCapacity({}, docs, undefined, "n2", sprint)).toMatchObject({ value: 9 });
    expect(effectiveCapacity({}, docs, undefined, "n3", sprint)).toMatchObject({ origin: "none" });
    expect(effectiveCapacity({ capacity: { source: "hybrid" } }, docs, map, "n1", sprint)).toMatchObject({ value: 7, origin: "override" });
  });

  it("sums team iterations and summarizes their origins", () => {
    const list = [
      resolveCapacity({ source: "hybrid" }, undefined, ok),
      resolveCapacity({ source: "hybrid" }, 4.5, ok),
      resolveCapacity({ source: "hybrid" }, undefined, missing),
    ];
    const t = totalCapacity(list);
    expect(t).toMatchObject({ value: 12.5, missing: 1, count: 3 });
    expect(totalOrigin(t)).toBe("mixed");
    expect(t.explanation).toBe("12.5 SP from 2 of 3 team iterations: 1 derived (8 SP), 1 override (4.5 SP). 1 not set.");
    const one = totalCapacity([list[0]]);
    expect(totalOrigin(one)).toBe("derived");
    expect(one.explanation).toBe("8 SP from 1 of 1 team iteration: 1 derived (8 SP).");
    const none = totalCapacity([]);
    expect(totalOrigin(none)).toBe("none");
    expect(none.explanation).toBe("0 SP from 0 of 0 team iterations.");
  });

  it("links to the team's capacity page of the iteration", () => {
    expect(capacityPageUrl("https://dev.azure.com/org/", "Fab rikam", "Team Red", "Fab rikam\\PIs\\PI 2\\Sprint 1")).toBe(
      "https://dev.azure.com/org/Fab%20rikam/_sprints/capacity/Team%20Red/Fab%20rikam/PIs/PI%202/Sprint%201"
    );
  });
});

describe("loading Azure DevOps team capacity", () => {
  async function setup() {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    const pi = pis.find((p) => p.name === "PI 2")!;
    const config = makeConfig();
    const red = findNode(config.root, "n-red")!;
    const s1 = pi.sprints.find((s) => s.path === PI2_S1)!;
    return { pi, config, red, s1 };
  }
  // Every day counts, so fake iterations (relative to today) have exactly 14 working days.
  const everyDay = () => (fake.teamWorkingDays["t-red"] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);

  it("makes no requests in manual mode or without teams / iterations", async () => {
    const { pi, config, red } = await setup();
    fake.calls = [];
    expect((await loadDerivedCapacity(config, [red], pi.sprints)).size).toBe(0);
    expect((await loadDerivedCapacity({ capacity: { source: "derived" } }, [], pi.sprints)).size).toBe(0);
    expect((await loadDerivedCapacity({ capacity: { source: "derived" } }, [red], [])).size).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  for (const shape of ["teamMembers", "value", "array"] as const) {
    it(`derives points from the ${shape} response shape with api-version 7.0`, async () => {
      const { pi, red, s1 } = await setup();
      everyDay();
      fake.capacityShape = shape;
      fake.teamCapacity[`t-red|${s1.identifier}`] = [member("Ada", 6), member("Grace", [0, 3])];
      fake.teamDaysOff[`t-red|${s1.identifier}`] = [{ start: s1.start!, end: s1.start! }];
      const map = await loadDerivedCapacity({ capacity: { source: "derived", pointsPerPersonDay: 1 } }, [red], [s1]);
      const r = map.get(derivedKey("n-red", s1))!;
      expect(r.derived).toMatchObject({ personDays: 26, points: 26, iterationDays: 13 });
      expect(r.capacityUrl).toBe(`${fake.baseUrl}/Fabrikam/_sprints/capacity/Team%20Red/Fabrikam/PIs/PI%202/PI%202%20Sprint%201`);
      for (const c of callsTo(/_apis\/work\/teamsettings/)) expect(c.url).toContain("api-version=7.0");
      expect(callsTo(/t-red\/_apis\/work\/teamsettings$/)).toHaveLength(1);
      expect(pi.sprints.length).toBeGreaterThan(1);
    });
  }

  it("explains missing capacity: nothing set up, not a team iteration, no team, no dates, failures", async () => {
    const { pi, config, red, s1 } = await setup();
    const [, s2, ip] = [s1, ...pi.sprints.filter((s) => s !== s1)];
    fake.teamIterations["t-red"] = [s2.identifier];
    fail(new RegExp(`GET .*t-red/_apis/work/teamsettings/iterations/${ip.identifier}/capacities`), 500, "Server down");
    fake.teamCapacity[`t-red|${ip.identifier}`] = [];
    const undated = { ...s1, identifier: "undated", start: undefined };
    const noTeam = { ...red, id: "n-x", name: "Team X", teamId: undefined };
    const map = await loadDerivedCapacity({ capacity: { source: "hybrid" } }, [red, noTeam], [s1, s2, ip, undated]);
    expect(map.get(derivedKey("n-red", s1))).toMatchObject({ derived: null, reason: "PI 2 Sprint 1 is not selected as a team iteration in Azure DevOps." });
    expect(map.get(derivedKey("n-red", s2))).toMatchObject({ derived: null, reason: "No capacity is set up for the team in Azure DevOps." });
    expect(map.get(derivedKey("n-red", ip))).toMatchObject({ derived: null, reason: "Could not read the Azure DevOps capacity: Server down" });
    expect(map.get(derivedKey("n-red", undated))).toMatchObject({ derived: null, reason: "PI 2 Sprint 1 has no dates." });
    expect(map.get(derivedKey("n-red", undated))!.capacityUrl).toContain("_sprints/capacity/Team%20Red/");
    expect(map.get(derivedKey("n-x", s1))).toEqual({ derived: null, reason: "No Azure DevOps team is linked to Team X. Link one in Setup." });
    expect(config.capacity).toBeUndefined();
  });

  it("falls back to Mon–Fri, no team days off and the team id when settings requests fail", async () => {
    const { red, s1 } = await setup();
    fake.teamCapacity[`t-red|${s1.identifier}`] = [member("Ada", 6)];
    fail(/GET .*t-red\/_apis\/work\/teamsettings$/, 500);
    fail(/teamdaysoff/, 500);
    fail(/_apis\/projects\/p1\/teams$/, 500);
    const r = (await loadDerivedCapacity({ capacity: { source: "derived" } }, [red], [s1])).get(derivedKey("n-red", s1))!;
    const weekdays = availableDays(s1.start!, s1.finish!, MON_FRI);
    expect(r.derived!.personDays).toBe(weekdays);
    expect(r.capacityUrl).toContain("/_sprints/capacity/t-red/");
  });
});
