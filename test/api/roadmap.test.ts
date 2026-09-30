import { describe, expect, it } from "vitest";
import {
  addDays,
  autoAssignPis,
  axisTicks,
  dateToX,
  defaultDuration,
  freeLane,
  fromDay,
  overlapDays,
  packLanes,
  planFrom,
  rangeDays,
  resizeRange,
  resolveRange,
  shiftRange,
  shortDate,
  timelineBounds,
  toDay,
  todayIso,
  toIsoDateTime,
  xToDate,
  ZOOM_PX,
} from "../../src/api/roadmap";
import { ProgramIncrement } from "../../src/api/types";

const pi = (path: string, start?: string, finish?: string): ProgramIncrement => ({ name: path, path, identifier: path, start, finish, sprints: [] });

describe("roadmap date helpers", () => {
  it("converts between dates and day numbers, with a local today", () => {
    expect(toDay("1970-01-02")).toBe(1);
    expect(toDay("2026-03-01T00:00:00Z")).toBe(toDay("2026-03-01"));
    expect(fromDay(toDay("2024-02-29"))).toBe("2024-02-29");
    expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    // "Today" is the user's local date, not the UTC date.
    expect(todayIso(new Date(2026, 8, 29, 23, 59).getTime())).toBe("2026-09-29");
    expect(todayIso(new Date(2026, 8, 30, 0, 1).getTime())).toBe("2026-09-30");
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(toIsoDateTime("2026-01-05")).toBe("2026-01-05T00:00:00Z");
    expect(toIsoDateTime("2026-01-05T10:00:00Z")).toBe("2026-01-05T00:00:00Z");
    expect(shortDate("2026-09-28")).toBe("Sep 28");
  });

  it("maps dates to x and back at every zoom", () => {
    for (const ppd of Object.values(ZOOM_PX)) {
      expect(dateToX("2026-01-11", "2026-01-01", ppd)).toBe(10 * ppd);
      expect(dateToX("2025-12-31", "2026-01-01", ppd)).toBe(-ppd);
      expect(xToDate(10 * ppd, "2026-01-01", ppd)).toBe("2026-01-11");
      // Anywhere inside a day's column maps to that day.
      expect(xToDate(10 * ppd + ppd - 0.5, "2026-01-01", ppd)).toBe("2026-01-11");
    }
    expect(ZOOM_PX.weeks).toBeGreaterThan(ZOOM_PX.months);
    expect(ZOOM_PX.months).toBeGreaterThan(ZOOM_PX.quarters);
  });

  it("measures ranges and overlap inclusively", () => {
    expect(rangeDays({ start: "2026-01-01", end: "2026-01-01" })).toBe(1);
    expect(rangeDays({ start: "2026-01-01", end: "2026-01-31" })).toBe(31);
    const a = { start: "2026-01-01", end: "2026-01-10" };
    expect(overlapDays(a, { start: "2026-01-10", end: "2026-01-20" })).toBe(1);
    expect(overlapDays(a, { start: "2026-01-11", end: "2026-01-20" })).toBe(0);
    expect(overlapDays(a, { start: "2025-12-01", end: "2026-02-01" })).toBe(10);
    expect(overlapDays({ start: "2026-02-01", end: "2026-02-02" }, a)).toBe(0);
  });

  it("uses Agile Hive default durations per level", () => {
    expect(defaultDuration("portfolio")).toBe(60);
    expect(defaultDuration("solution")).toBe(30);
    expect(defaultDuration("art")).toBe(21);
    expect(defaultDuration("team")).toBe(21);
    expect(planFrom("2026-01-01", 21)).toEqual({ start: "2026-01-01", end: "2026-01-21" });
    expect(rangeDays(planFrom("2026-01-01", 60))).toBe(60);
    expect(planFrom("2026-01-01", 0)).toEqual({ start: "2026-01-01", end: "2026-01-01" });
  });

  it("shifts and resizes, never below one day", () => {
    const r = { start: "2026-01-10", end: "2026-01-20" };
    expect(shiftRange(r, 5)).toEqual({ start: "2026-01-15", end: "2026-01-25" });
    expect(shiftRange(r, -10)).toEqual({ start: "2025-12-31", end: "2026-01-10" });
    expect(resizeRange(r, "start", -3)).toEqual({ start: "2026-01-07", end: "2026-01-20" });
    expect(resizeRange(r, "start", 30)).toEqual({ start: "2026-01-20", end: "2026-01-20" });
    expect(resizeRange(r, "end", 2)).toEqual({ start: "2026-01-10", end: "2026-01-22" });
    expect(resizeRange(r, "end", -30)).toEqual({ start: "2026-01-10", end: "2026-01-10" });
  });

  it("resolves the planned range from Start/Target Date when set, else from metadata", () => {
    const fields = { "Microsoft.VSTS.Scheduling.StartDate": "2026-02-01T00:00:00Z", "Microsoft.VSTS.Scheduling.TargetDate": "2026-02-10T00:00:00Z" };
    // The ADO fields win, so edits made in Azure DevOps show up on the roadmap.
    expect(resolveRange({ plannedStart: "2026-01-01", plannedEnd: "2026-01-05" }, fields)).toEqual({ start: "2026-02-01", end: "2026-02-10" });
    expect(resolveRange({ plannedStart: "2026-01-01", plannedEnd: "2026-01-05" }, { "Microsoft.VSTS.Scheduling.StartDate": "2026-02-01" })).toEqual({ start: "2026-01-01", end: "2026-01-05" });
    expect(resolveRange({ plannedStart: "2026-01-01" }, fields)).toEqual({ start: "2026-02-01", end: "2026-02-10" });
    expect(resolveRange(undefined, fields)).toEqual({ start: "2026-02-01", end: "2026-02-10" });
    expect(resolveRange(undefined, { "Microsoft.VSTS.Scheduling.StartDate": "2026-02-01" })).toBeUndefined();
    expect(resolveRange()).toBeUndefined();
    // Reversed dates are normalised.
    expect(resolveRange({ plannedStart: "2026-01-09", plannedEnd: "2026-01-02" })).toEqual({ start: "2026-01-02", end: "2026-01-09" });
  });

  it("auto-assigns current/future overlapping PIs and keeps past ones", () => {
    const pis = [
      pi("PI 1", "2026-01-01T00:00:00Z", "2026-03-31T00:00:00Z"),
      pi("PI 2", "2026-04-01T00:00:00Z", "2026-06-30T00:00:00Z"),
      pi("PI 3", "2026-07-01T00:00:00Z", "2026-09-30T00:00:00Z"),
      pi("PI 4", "2026-10-01T00:00:00Z", "2026-12-31T00:00:00Z"),
      pi("Undated"),
    ];
    const today = "2026-05-01";
    // Overlaps PI 2 (current) and PI 3 (future) by one day each side of the boundary.
    expect(autoAssignPis([], { start: "2026-06-30", end: "2026-07-01" }, pis, today)).toEqual(["PI 2", "PI 3"]);
    // Past PI 1 is kept even though the card no longer overlaps it; PI 4 no longer overlaps and is dropped.
    expect(autoAssignPis(["PI 1", "PI 4", "Undated", "Deleted PI"], { start: "2026-05-01", end: "2026-05-10" }, pis, today)).toEqual([
      "PI 1",
      "Undated",
      "Deleted PI",
      "PI 2",
    ]);
    // A past PI overlapping the range is not added.
    expect(autoAssignPis([], { start: "2026-03-01", end: "2026-04-02" }, pis, today)).toEqual(["PI 2"]);
    expect(autoAssignPis(["PI 2"], { start: "2026-04-10", end: "2026-04-20" }, pis, today)).toEqual(["PI 2"]);
  });

  it("computes padded timeline bounds", () => {
    expect(timelineBounds(["2026-03-01", "", "2026-01-15T00:00:00Z", "2026-02-01"])).toEqual({ start: "2026-01-01", end: "2026-03-31" });
    expect(timelineBounds(["2026-03-01"], 0, 0)).toEqual({ start: "2026-03-01", end: "2026-03-01" });
  });

  it("packs lanes, keeping explicit lanes and filling gaps", () => {
    const lanes = packLanes([
      { id: 1, range: { start: "2026-01-01", end: "2026-01-10" } },
      { id: 2, range: { start: "2026-01-05", end: "2026-01-15" } },
      { id: 3, range: { start: "2026-01-11", end: "2026-01-20" } },
      { id: 4, range: { start: "2026-01-01", end: "2026-01-03" }, lane: 5 },
      { id: 5, range: { start: "2026-01-01", end: "2026-01-02" }, lane: -1 },
    ]);
    expect(Object.fromEntries(lanes)).toEqual({ 4: 5, 1: 0, 5: 1, 2: 1, 3: 0 });
    const occ = [
      { range: { start: "2026-01-01", end: "2026-01-10" }, lane: 0 },
      { range: { start: "2026-01-01", end: "2026-01-10" }, lane: 1 },
    ];
    expect(freeLane(0, { start: "2026-01-05", end: "2026-01-06" }, occ)).toBe(2);
    expect(freeLane(0, { start: "2026-01-11", end: "2026-01-12" }, occ)).toBe(0);
    expect(freeLane(-3, { start: "2026-02-01", end: "2026-02-02" }, occ)).toBe(0);
    expect(freeLane(4, { start: "2026-01-05", end: "2026-01-06" }, occ)).toBe(4);
  });

  it("produces axis ticks per zoom level", () => {
    const bounds = { start: "2026-01-01", end: "2026-07-15" };
    const weeks = axisTicks({ start: "2026-09-25", end: "2026-10-13" }, "weeks");
    expect(weeks.map((t) => t.date)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(weeks.every((t) => new Date(t.date + "T00:00:00Z").getUTCDay() === 1)).toBe(true);
    expect(weeks[0].label).toBe("Sep 28");
    // Mondays before 1970 (negative day numbers) are found too.
    expect(axisTicks({ start: "1969-12-26", end: "1969-12-31" }, "weeks").map((t) => t.date)).toEqual(["1969-12-29"]);
    const months = axisTicks(bounds, "months");
    expect(months.map((t) => t.label)).toEqual(["Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026"]);
    expect(axisTicks(bounds, "quarters").map((t) => t.label)).toEqual(["Q1 2026", "Q2 2026", "Q3 2026"]);
  });
});
