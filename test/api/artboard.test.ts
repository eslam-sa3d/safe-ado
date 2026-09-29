import { describe, expect, it } from "vitest";
import { BoardRow, calculatePlacement, childIdsOf, childTypeOf, milestonesBySprint, rowForArea, sprintIndexForDate } from "../../src/api/artboard";
import { addDays, dayOf, isIp, overlaps, piStatus, validateIteration, validatePi } from "../../src/api/piRules";
import { ProgramIncrement, Sprint, WorkItem } from "../../src/api/types";
import { makeConfig } from "../fakeAdo";

const item = (id: number, area: string, iteration?: string, relations: [string, string][] = []): WorkItem => ({
  id,
  fields: { "System.AreaPath": area, "System.IterationPath": iteration },
  relations: relations.map(([rel, url]) => ({ rel, url })),
});
const rows: BoardRow[] = [
  { key: "b", title: "Bravo", areaPath: "P\\B" },
  { key: "a", title: "Alpha", areaPath: "P\\A" },
  { key: "u", title: "Unassigned" },
];
const S = ["P\\PI\\S1", "P\\PI\\S2"];

describe("artboard helpers", () => {
  it("extracts child ids from hierarchy links only", () => {
    const i = item(1, "P", undefined, [
      ["System.LinkTypes.Hierarchy-Forward", "https://x/_apis/wit/workItems/5"],
      ["System.LinkTypes.Hierarchy-Forward", "https://x/other"],
      ["System.LinkTypes.Dependency-Forward", "https://x/_apis/wit/workItems/6"],
    ]);
    expect(childIdsOf(i)).toEqual([5]);
    expect(childIdsOf({ id: 2, fields: {} })).toEqual([]);
  });

  it("finds the child type one level down the chain", () => {
    const config = makeConfig({ types: { epic: "Epic", capability: "Capability", feature: "Feature", story: "User Story" } });
    expect(childTypeOf(config, "Epic")).toBe("Capability");
    expect(childTypeOf(config, "Capability")).toBe("Feature");
    expect(childTypeOf(config, "User Story")).toBe("");
    expect(childTypeOf(config, "Bug")).toBe("");
  });

  it("matches rows by the most specific area path", () => {
    const nested = [...rows, { key: "a2", title: "A2", areaPath: "P\\A\\Two" }];
    expect(rowForArea("P\\A\\Two\\X", nested)).toBe("a2");
    expect(rowForArea("P\\A", nested)).toBe("a");
    expect(rowForArea("Q", nested)).toBeUndefined();
    expect(rowForArea(undefined, nested)).toBeUndefined();
  });

  it("calculates placement from children, owner and fallbacks", () => {
    const f = item(1, "P\\B", "P\\PI\\S1");
    const kids = [item(2, "P\\B", "P\\PI\\S2"), item(3, "P\\A", "P\\PI\\S2"), item(4, "P\\A", "P\\PI\\S1"), item(5, "P\\A", "Elsewhere")];
    expect(calculatePlacement(f, kids, rows, S)).toEqual({ row: "a", sprint: 1, involved: ["b", "a"], unplanned: [kids[3]] });
    expect(calculatePlacement(f, kids, rows, S, "b").row).toBe("b");
    expect(calculatePlacement(f, kids, rows, S, "zzz").row).toBe("a");
    expect(calculatePlacement(f, [], rows, S)).toEqual({ row: "b", sprint: 0, involved: [], unplanned: [] });
    expect(calculatePlacement(item(9, "Q"), [], rows, S)).toEqual({ row: undefined, sprint: -1, involved: [], unplanned: [] });
  });

  it("finds sprints by date and groups milestones", () => {
    const sprints: Sprint[] = [
      { name: "S1", path: S[0], identifier: "1", start: "2026-01-01T00:00:00Z", finish: "2026-01-14T00:00:00Z" },
      { name: "S2", path: S[1], identifier: "2", start: "2026-01-15T00:00:00Z", finish: "2026-01-28T00:00:00Z" },
      { name: "Undated", path: "x", identifier: "3" },
    ];
    expect(sprintIndexForDate("2026-01-14", sprints)).toBe(0);
    expect(sprintIndexForDate("2026-01-15", sprints)).toBe(1);
    expect(sprintIndexForDate("2026-02-01", sprints)).toBe(-1);
    const ms = [
      { id: "b", nodeId: "n1", title: "Later", date: "2026-01-10" },
      { id: "a", nodeId: "n1", title: "Earlier", date: "2026-01-02" },
      { id: "c", nodeId: "other", title: "Other", date: "2026-01-02" },
      { id: "d", nodeId: "n1", title: "Outside", date: "2027-01-02" },
    ];
    const grouped = milestonesBySprint(ms, ["n1"], sprints);
    expect(Array.from(grouped.keys())).toEqual([0]);
    expect(grouped.get(0)!.map((m) => m.title)).toEqual(["Earlier", "Later"]);
  });
});

describe("PI rules", () => {
  const sprint = (name: string, start?: string, finish?: string): Sprint => ({
    name,
    path: `P\\PI\\${name}`,
    identifier: name,
    start: start && `${start}T00:00:00Z`,
    finish: finish && `${finish}T00:00:00Z`,
  });
  const pi = (name: string, start?: string, finish?: string, sprints: Sprint[] = []): ProgramIncrement => ({
    ...sprint(name, start, finish),
    path: `P\\${name}`,
    sprints,
  });

  it("classifies PI status and IP iterations", () => {
    expect(piStatus(pi("A", "2026-01-01", "2026-01-31"), "2026-02-01")).toBe("completed");
    expect(piStatus(pi("A", "2026-01-01", "2026-01-31"), "2026-01-31")).toBe("current");
    expect(piStatus(pi("A", "2026-01-01", "2026-01-31"), "2025-12-31")).toBe("planned");
    expect(piStatus(pi("A"), "2026-01-01")).toBe("planned");
    expect(isIp("PI 3 IP")).toBe(true);
    expect(isIp("IP Sprint")).toBe(true);
    expect(isIp("Shipping")).toBe(false);
    expect(dayOf(undefined)).toBe("");
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("detects overlaps only between dated ranges", () => {
    expect(overlaps({ start: "2026-01-01", finish: "2026-01-10" }, { start: "2026-01-10", finish: "2026-01-20" })).toBe(true);
    expect(overlaps({ start: "2026-01-01", finish: "2026-01-09" }, { start: "2026-01-10", finish: "2026-01-20" })).toBe(false);
    expect(overlaps({ start: "2026-01-01" }, { start: "2026-01-01", finish: "2026-01-20" })).toBe(false);
  });

  it("validates PIs", () => {
    const a = pi("PI 1", "2026-01-01", "2026-01-31", [sprint("S1", "2026-01-01", "2026-01-14"), sprint("Loose")]);
    const b = pi("PI 2", "2026-02-01", "2026-02-28");
    expect(validatePi({ name: "PI 3", start: "2026-03-01", finish: "2026-03-31" }, null, [a, b])).toEqual([]);
    expect(validatePi({ name: "PI 3", start: "", finish: "" }, null, [a, b])).toEqual([]);
    expect(validatePi({ name: "PI 1", start: "2026-01-02", finish: "2026-01-31" }, a, [a, b])).toEqual(['Iteration "S1" would fall outside the PI.']);
    expect(validatePi({ name: "pi 2", start: "2026-01-01", finish: "2026-02-02" }, a, [a, b])).toEqual([
      "A PI with this name already exists.",
      "The dates overlap PI 2.",
    ]);
  });

  it("validates iterations", () => {
    const p = pi("PI 1", "2026-01-01", "2026-01-31", [sprint("S1", "2026-01-01", "2026-01-14")]);
    expect(validateIteration({ name: "S2", start: "2026-01-15", finish: "2026-01-28" }, p, null)).toEqual([]);
    expect(validateIteration({ name: "S1", start: "2026-01-02", finish: "2026-01-14" }, p, p.sprints[0])).toEqual([]);
    expect(validateIteration({ name: "s1", start: "2026-01-10", finish: "2026-02-10" }, p, null)).toEqual([
      "An iteration with this name already exists.",
      "The iteration must be inside PI 1 (2026-01-01 – 2026-01-31).",
      "The dates overlap S1.",
    ]);
    // Undated PIs accept any dated iteration
    expect(validateIteration({ name: "X", start: "2030-01-01", finish: "2030-01-02" }, pi("U"), null)).toEqual([]);
  });
});
