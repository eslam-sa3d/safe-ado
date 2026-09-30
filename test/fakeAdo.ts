import { vi } from "vitest";
import type { OrgNode, SafeConfig, WorkItem } from "../src/api/types";
import type { ClassificationNode } from "../src/api/wit";

/**
 * In-memory fake of the Azure DevOps REST surface the extension uses (api-version 7.0),
 * plus the Extension Data Service. Includes a small WIQL evaluator for the query shapes
 * the extension emits, so views run end-to-end against realistic data.
 */

type Json = any;

interface Failure {
  method?: string;
  match: RegExp;
  status: number;
  message?: string;
  raw?: string;
  once?: boolean;
}

export interface Call {
  method: string;
  path: string;
  url: string;
  body: Json;
  headers: Record<string, string>;
}

const DAY = 86_400_000;
/** Local calendar date of a timestamp (the extension compares iteration dates with the user's local "today"). */
export const localDate = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const iso = (t: number) => localDate(t) + "T00:00:00Z";

export const fake = {
  baseUrl: "https://dev.azure.com/org",
  projectId: "p1",
  projectName: "Fabrikam",
  workItems: new Map<number, WorkItem>(),
  types: [] as { name: string; referenceName: string; isDisabled?: boolean }[],
  states: {} as Record<string, { name: string; category: string; color: string }[]>,
  fields: [] as { name: string; referenceName: string; type: string }[],
  areaTree: null as unknown as ClassificationNode,
  iterationTree: null as unknown as ClassificationNode,
  teams: [] as { id: string; name: string }[],
  teamAreas: {} as Record<string, string | undefined>,
  teamFieldRef: "System.AreaPath",
  teamIterations: {} as Record<string, string[]>,
  calls: [] as Call[],
  failures: [] as Failure[],
  wiqlOverride: null as null | ((query: string) => Json),
  nextId: 5000,
  deletedIterations: [] as { path: string; reclassifyId: number }[],
  /** Revision history per work item (rev 1 = the seed), as the reporting revisions API returns it. */
  revisions: new Map<number, { rev: number; fields: Json }[]>(),
  /** Permission answers by "namespace/bits"; missing entries are allowed. */
  permissions: {} as Record<string, boolean>,
  teamMembers: {} as Record<string, { id: string; displayName: string; uniqueName: string; imageUrl?: string }[]>,
  /** Current URL hash of the host page (host navigation service). */
  hash: "",
  /** Areas where the current user may not save work items (validate-only create answers 403). */
  denyWriteAreas: [] as string[],
  /** Other projects of the collection (cross-project portfolios); empty unless a test seeds them. */
  otherProjects: [] as FakeProject[],
};

/** Another project of the same collection, with its own trees and teams. */
export interface FakeProject {
  id: string;
  name: string;
  areaTree: ClassificationNode;
  iterationTree: ClassificationNode;
  teams: { id: string; name: string }[];
  teamAreas: Record<string, string | undefined>;
  teamMembers: Record<string, { id: string; displayName: string; uniqueName: string }[]>;
}

/** The reverse of each link type Azure DevOps keeps in sync automatically. */
export const REVERSE_LINK: Record<string, string> = {
  "System.LinkTypes.Hierarchy-Forward": "System.LinkTypes.Hierarchy-Reverse",
  "System.LinkTypes.Hierarchy-Reverse": "System.LinkTypes.Hierarchy-Forward",
  "System.LinkTypes.Dependency-Forward": "System.LinkTypes.Dependency-Reverse",
  "System.LinkTypes.Dependency-Reverse": "System.LinkTypes.Dependency-Forward",
  "System.LinkTypes.Related": "System.LinkTypes.Related",
};

const linkTarget = (url: string) => Number(/(\d+)$/.exec(url)?.[1]);

/** Adds the reverse end of a link, like Azure DevOps does. */
function addReverse(sourceId: number, rel: string, targetId: number) {
  const reverse = REVERSE_LINK[rel];
  const target = fake.workItems.get(targetId);
  if (!reverse || !target) return;
  const exists = (target.relations ?? []).some((r) => r.rel === reverse && linkTarget(r.url) === sourceId);
  if (!exists) (target.relations ??= []).push({ rel: reverse, url: `${fake.baseUrl}/_apis/wit/workItems/${sourceId}`, attributes: {} });
}

function removeReverse(sourceId: number, rel: string, targetId: number) {
  const reverse = REVERSE_LINK[rel];
  const target = fake.workItems.get(targetId);
  if (!reverse || !target?.relations) return;
  target.relations = target.relations.filter((r) => !(r.rel === reverse && linkTarget(r.url) === sourceId));
}

/** Records a revision snapshot (used by the reporting revisions route). */
export function recordRevision(item: WorkItem, changedDate = new Date().toISOString()) {
  const list = fake.revisions.get(item.id) ?? [];
  const fields = { ...clone(item.fields), "System.ChangedDate": changedDate, "System.Rev": item.rev ?? list.length + 1 };
  list.push({ rev: fields["System.Rev"], fields });
  fake.revisions.set(item.id, list);
}

export const dataStore = {
  values: new Map<string, Json>(),
  collections: new Map<string, Map<string, Json>>(),
  failures: [] as { op: string; error: Error & { status?: number } }[],
};

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function cnode(
  structure: "Area" | "Iteration",
  parts: string[],
  attrs?: { start: number; finish: number },
  children: ClassificationNode[] = [],
  project = fake.projectName
): ClassificationNode {
  const id = fake.nextId++;
  const prefix = project === fake.projectName ? "" : `${project.toLowerCase()}-`;
  return {
    id,
    identifier: `${prefix}${structure.toLowerCase()}-${parts.join("-") || "root"}`.replace(/\s+/g, "_"),
    name: parts.length ? parts[parts.length - 1] : project,
    path: "\\" + [project, structure, ...parts].join("\\"),
    hasChildren: children.length > 0,
    children: children.length ? children : undefined,
    attributes: attrs ? { startDate: iso(attrs.start), finishDate: iso(attrs.finish) } : undefined,
  };
}

export const P = "Fabrikam";
export const ART_A = "Fabrikam\\ART A";
export const RED = "Fabrikam\\ART A\\Team Red";
export const BLUE = "Fabrikam\\ART A\\Team Blue";
export const ART_B = "Fabrikam\\ART B";
export const GREEN = "Fabrikam\\ART B\\Team Green";
export const PI1 = "Fabrikam\\PIs\\PI 1";
export const PI2 = "Fabrikam\\PIs\\PI 2";
export const PI2_S1 = "Fabrikam\\PIs\\PI 2\\PI 2 Sprint 1";
export const PI2_S2 = "Fabrikam\\PIs\\PI 2\\PI 2 Sprint 2";
export const PI2_IP = "Fabrikam\\PIs\\PI 2\\PI 2 IP";
export const PI1_S1 = "Fabrikam\\PIs\\PI 1\\PI 1 Sprint 1";

const CHILD = "System.LinkTypes.Hierarchy-Forward";
const SUCC = "System.LinkTypes.Dependency-Forward";
const PRED = "System.LinkTypes.Dependency-Reverse";
const url = (id: number) => `${fake.baseUrl}/_apis/wit/workItems/${id}`;

function wi(id: number, type: string, title: string, area: string, iteration: string, state: string, extra: Json = {}, relations: [string, number][] = []): WorkItem {
  return {
    id,
    rev: 1,
    fields: {
      "System.Id": id,
      "System.Title": title,
      "System.WorkItemType": type,
      "System.State": state,
      "System.AreaPath": area,
      "System.IterationPath": iteration,
      "System.TeamProject": fake.projectName,
      ...extra,
    },
    relations: relations.map(([rel, target]) => ({ rel, url: url(target), attributes: {} })),
  };
}

export function resetFake() {
  const now = Date.now();
  fake.nextId = 5000;
  fake.calls = [];
  fake.failures = [];
  fake.wiqlOverride = null;
  fake.teamFieldRef = "System.AreaPath";
  fake.deletedIterations = [];

  fake.types = [
    { name: "Epic", referenceName: "Microsoft.VSTS.WorkItemTypes.Epic" },
    { name: "Feature", referenceName: "Microsoft.VSTS.WorkItemTypes.Feature" },
    { name: "User Story", referenceName: "Microsoft.VSTS.WorkItemTypes.UserStory" },
    { name: "Task", referenceName: "Microsoft.VSTS.WorkItemTypes.Task" },
    { name: "Bug", referenceName: "Microsoft.VSTS.WorkItemTypes.Bug" },
    { name: "Shared Steps", referenceName: "Microsoft.VSTS.WorkItemTypes.SharedSteps", isDisabled: true },
  ];
  const agileStates = [
    { name: "New", category: "Proposed", color: "b2b2b2" },
    { name: "Active", category: "InProgress", color: "007acc" },
    { name: "Resolved", category: "Resolved", color: "ff9d00" },
    { name: "Closed", category: "Completed", color: "339933" },
    { name: "Removed", category: "Removed", color: "ffffff" },
  ];
  fake.states = { Epic: agileStates, Feature: agileStates, "User Story": agileStates };
  fake.fields = [
    { name: "Title", referenceName: "System.Title", type: "string" },
    { name: "Story Points", referenceName: "Microsoft.VSTS.Scheduling.StoryPoints", type: "double" },
    { name: "Effort", referenceName: "Microsoft.VSTS.Scheduling.Effort", type: "double" },
    { name: "Business Value", referenceName: "Microsoft.VSTS.Common.BusinessValue", type: "integer" },
    { name: "Time Criticality", referenceName: "Microsoft.VSTS.Common.TimeCriticality", type: "double" },
    { name: "Stack Rank", referenceName: "Microsoft.VSTS.Common.StackRank", type: "double" },
    { name: "Priority", referenceName: "Microsoft.VSTS.Common.Priority", type: "integer" },
    { name: "Closed Date", referenceName: "Microsoft.VSTS.Common.ClosedDate", type: "dateTime" },
    { name: "Start Date", referenceName: "Microsoft.VSTS.Scheduling.StartDate", type: "dateTime" },
    { name: "Target Date", referenceName: "Microsoft.VSTS.Scheduling.TargetDate", type: "dateTime" },
  ];

  fake.areaTree = cnode("Area", [], undefined, [
    cnode("Area", ["ART A"], undefined, [cnode("Area", ["ART A", "Team Red"]), cnode("Area", ["ART A", "Team Blue"])]),
    cnode("Area", ["ART B"], undefined, [cnode("Area", ["ART B", "Team Green"])]),
  ]);

  const pi2Start = now - 7 * DAY;
  const pi1Start = now - 70 * DAY;
  fake.iterationTree = cnode("Iteration", [], undefined, [
    cnode("Iteration", ["PIs"], undefined, [
      // Deliberately listed out of date order to exercise sorting.
      cnode("Iteration", ["PIs", "PI 2"], { start: pi2Start, finish: pi2Start + 35 * DAY - DAY }, [
        cnode("Iteration", ["PIs", "PI 2", "PI 2 Sprint 2"], { start: pi2Start + 14 * DAY, finish: pi2Start + 28 * DAY - DAY }),
        cnode("Iteration", ["PIs", "PI 2", "PI 2 Sprint 1"], { start: pi2Start, finish: pi2Start + 14 * DAY - DAY }),
        cnode("Iteration", ["PIs", "PI 2", "PI 2 IP"], { start: pi2Start + 28 * DAY, finish: pi2Start + 35 * DAY - DAY }),
      ]),
      cnode("Iteration", ["PIs", "PI 1"], { start: pi1Start, finish: pi1Start + 28 * DAY - DAY }, [
        cnode("Iteration", ["PIs", "PI 1", "PI 1 Sprint 1"], { start: pi1Start, finish: pi1Start + 14 * DAY - DAY }),
        cnode("Iteration", ["PIs", "PI 1", "PI 1 Sprint 2"], { start: pi1Start + 14 * DAY, finish: pi1Start + 28 * DAY - DAY }),
      ]),
    ]),
    cnode("Iteration", ["Undated"]),
  ]);

  fake.teams = [
    { id: "t-red", name: "Team Red" },
    { id: "t-blue", name: "Team Blue" },
    { id: "t-green", name: "Team Green" },
    { id: "t-arta", name: "ART A Team" },
    { id: "t-fab", name: "Fabrikam Team" },
  ];
  fake.teamAreas = { "t-red": RED, "t-blue": BLUE, "t-green": GREEN, "t-arta": ART_A, "t-fab": undefined };
  fake.teamIterations = {};

  const SP = "Microsoft.VSTS.Scheduling.StoryPoints";
  const items: WorkItem[] = [
    wi(1, "Epic", "Checkout revamp", P, P, "Active",
      { "Microsoft.VSTS.Common.BusinessValue": 8, "Microsoft.VSTS.Common.TimeCriticality": 5, "Microsoft.VSTS.Scheduling.Effort": 13, "System.AssignedTo": { displayName: "Ada Lovelace" } },
      [[CHILD, 10], [CHILD, 11], [CHILD, 14], [CHILD, 12]]),
    wi(2, "Epic", "Mobile app", P, P, "New",
      { "Microsoft.VSTS.Common.BusinessValue": 3, "Microsoft.VSTS.Common.TimeCriticality": 3, "Microsoft.VSTS.Scheduling.Effort": 20 },
      [[CHILD, 20]]),
    wi(3, "Epic", "Unsized idea", P, P, "New"),
    wi(4, "Epic", "Dropped", P, P, "Removed"),
    wi(10, "Feature", "Payment API", RED, PI2_S1, "Active", { [SP]: 8, "System.AssignedTo": { displayName: "Grace Hopper" } },
      [[CHILD, 100], [CHILD, 101], [CHILD, 104], [SUCC, 11], [SUCC, 20]]),
    wi(11, "Feature", "Checkout UI", BLUE, PI2_S2, "New", {}, [[CHILD, 105], [SUCC, 14]]),
    wi(12, "Feature", "Fraud rules", ART_A, PI2, "New", {}, [[SUCC, 10]]),
    wi(13, "Feature", "Legacy cleanup", RED, PI2_S1, "Removed"),
    wi(14, "Feature", "Wallet", BLUE, PI2_S1, "New", {}, [[CHILD, 102], [PRED, 11]]),
    wi(15, "Feature", "Old feature", RED, PI1_S1, "Closed", {}, [[CHILD, 103]]),
    wi(20, "Feature", "Reports", GREEN, PI2_IP, "New"),
    wi(100, "User Story", "Charge card", RED, PI2_S1, "Closed", { [SP]: 5, "Microsoft.VSTS.Common.ClosedDate": new Date(now - 2 * DAY).toISOString(), "Microsoft.VSTS.Common.Priority": 1 }),
    wi(101, "User Story", "Refund card", RED, PI2_S2, "Active", { [SP]: 3 }),
    wi(102, "User Story", "Add wallet", BLUE, PI2_S1, "New", { [SP]: 8 }),
    wi(103, "User Story", "Old story", RED, PI1_S1, "Closed", { [SP]: 2, "Microsoft.VSTS.Common.ClosedDate": new Date(now - 60 * DAY).toISOString() }),
    wi(104, "User Story", "Removed story", RED, PI2_S1, "Removed", { [SP]: 13 }),
    wi(105, "User Story", "Cart page", BLUE, PI2_S2, "Closed", { "Microsoft.VSTS.Common.ClosedDate": new Date(now - 1 * DAY).toISOString() }),
  ];
  fake.workItems = new Map(items.map((i) => [i.id, i]));
  // Seeds list one end of each link; add the other end as Azure DevOps would.
  for (const item of items) for (const r of [...(item.relations ?? [])]) addReverse(item.id, r.rel, linkTarget(r.url));
  fake.revisions = new Map();
  for (const item of items) recordRevision(item, new Date(now - 60 * DAY).toISOString());
  fake.permissions = {};
  fake.teamMembers = {
    "t-red": [{ id: "u-ada", displayName: "Ada Lovelace", uniqueName: "ada@fabrikam.com" }, { id: "u-grace", displayName: "Grace Hopper", uniqueName: "grace@fabrikam.com" }],
    "t-blue": [{ id: "u-alan", displayName: "Alan Turing", uniqueName: "alan@fabrikam.com" }],
  };
  fake.hash = "";
  fake.denyWriteAreas = [];
  fake.otherProjects = [];

  dataStore.values.clear();
  dataStore.collections.clear();
  dataStore.failures = [];
}

/** The SAFe hierarchy used by most tests: Portfolio > ART A (Red, Blue) + ART B (Green). */
export function makeConfig(overrides: Partial<SafeConfig> = {}): SafeConfig {
  const node = (id: string, name: string, level: OrgNode["level"], areaPath?: string, teamId?: string, children: OrgNode[] = []): OrgNode => ({
    id, name, level, areaPath, teamId, children,
  });
  return {
    version: 1,
    root: node("n-root", "Fabrikam", "portfolio", P, undefined, [
      node("n-arta", "ART A", "art", ART_A, "t-arta", [
        node("n-red", "Team Red", "team", RED, "t-red"),
        node("n-blue", "Team Blue", "team", BLUE, "t-blue"),
      ]),
      node("n-artb", "ART B", "art", ART_B, undefined, [node("n-green", "Team Green", "team", GREEN, "t-green")]),
    ]),
    piRootIteration: "Fabrikam\\PIs",
    types: { epic: "Epic", capability: "", feature: "Feature", story: "User Story" },
    storyPointsField: "Microsoft.VSTS.Scheduling.StoryPoints",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Cross-project fixture: a second project "Contoso" with ART C / Team Orange
// ---------------------------------------------------------------------------------------------

export const C = "Contoso";
export const ART_C = "Contoso\\ART C";
export const ORANGE = "Contoso\\ART C\\Team Orange";
export const C_ROOT = "Contoso\\Cadence";
export const C_PI2 = "Contoso\\Cadence\\PI 2";
/** Matched to "PI 2 Sprint 1" by dates (different name). */
export const C_PI2_S1 = "Contoso\\Cadence\\PI 2\\Iteration 1";
/** Matched to "PI 2 Sprint 2" by name. */
export const C_PI2_S2 = "Contoso\\Cadence\\PI 2\\PI 2 Sprint 2";

const attrsOf = (n: ClassificationNode | undefined) => {
  const a = n?.attributes;
  return a?.startDate && a.finishDate ? { start: Date.parse(a.startDate), finish: Date.parse(a.finishDate) } : undefined;
};

/**
 * Adds project "Contoso" (id p2): areas ART C / Team Orange, a PI root "Cadence" whose PI 2 matches
 * the host's PI 2 (sprint 1 by dates, sprint 2 by name; no IP iteration, no PI 1), team t-orange,
 * and items 300-303 (Feature 300 is a child of the host's Epic 1).
 */
export function seedCrossProject(): FakeProject {
  const host = (parts: string[]) => findIteration(parts);
  const it = (parts: string[], attrs?: { start: number; finish: number }, children: ClassificationNode[] = []) =>
    cnode("Iteration", parts, attrs, children, C);
  const project: FakeProject = {
    id: "p2",
    name: C,
    areaTree: cnode("Area", [], undefined, [cnode("Area", ["ART C"], undefined, [cnode("Area", ["ART C", "Team Orange"], undefined, [], C)], C)], C),
    iterationTree: it([], undefined, [
      it(["Cadence"], undefined, [
        it(["Cadence", "PI 2"], attrsOf(host(["PIs", "PI 2"])), [
          it(["Cadence", "PI 2", "Iteration 1"], attrsOf(host(["PIs", "PI 2", "PI 2 Sprint 1"]))),
          it(["Cadence", "PI 2", "PI 2 Sprint 2"], attrsOf(host(["PIs", "PI 2", "PI 2 Sprint 2"]))),
        ]),
      ]),
    ]),
    teams: [{ id: "t-orange", name: "Team Orange" }],
    teamAreas: { "t-orange": ORANGE },
    teamMembers: { "t-orange": [{ id: "u-linus", displayName: "Linus Torvalds", uniqueName: "linus@contoso.com" }] },
  };
  fake.otherProjects.push(project);

  const SP = "Microsoft.VSTS.Scheduling.StoryPoints";
  const inC = { "System.TeamProject": C };
  const items: WorkItem[] = [
    wi(300, "Feature", "Partner API", ORANGE, C_PI2_S1, "Active", { ...inC, [SP]: 5 }, [[CHILD, 301], [CHILD, 302], [SUCC, 10]]),
    wi(301, "User Story", "Partner auth", ORANGE, C_PI2_S1, "Closed", { ...inC, [SP]: 5, "Microsoft.VSTS.Common.ClosedDate": new Date().toISOString() }),
    wi(302, "User Story", "Partner docs", ORANGE, C_PI2_S2, "New", { ...inC, [SP]: 3 }),
    wi(303, "Feature", "Contoso backlog", ART_C, C, "New", inC),
  ];
  for (const item of items) fake.workItems.set(item.id, item);
  (fake.workItems.get(1)!.relations ??= []).push({ rel: CHILD, url: url(300), attributes: {} });
  for (const item of items) for (const r of [...(item.relations ?? [])]) addReverse(item.id, r.rel, linkTarget(r.url));
  addReverse(1, CHILD, 300);
  for (const item of items) recordRevision(item);
  return project;
}

/** makeConfig plus ART C (project Contoso, PI root "Contoso\\Cadence") with Team Orange. */
export function makeCrossConfig(overrides: Partial<SafeConfig> = {}): SafeConfig {
  const config = makeConfig(overrides);
  const inC = { projectId: "p2", projectName: C };
  config.root.children.push({
    id: "n-artc",
    name: "ART C",
    level: "art",
    areaPath: ART_C,
    piRootIteration: C_ROOT,
    ...inC,
    children: [{ id: "n-orange", name: "Team Orange", level: "team", areaPath: ORANGE, teamId: "t-orange", ...inC, children: [] }],
  });
  return config;
}

export function seedConfig(config: SafeConfig = makeConfig()) {
  dataStore.values.set(`config-${fake.projectId}`, clone(config));
  return config;
}

export function seedDocs(collection: "objectives" | "risks" | "milestones" | "capacity" | "wimeta" | "quickfilters" | "votes" | "snapshots", docs: Json[]) {
  const map = new Map<string, Json>();
  docs.forEach((d) => map.set(d.id, { ...clone(d), __etag: 1 }));
  dataStore.collections.set(`${collection}-${fake.projectId}`, map);
}

export function docs(collection: "objectives" | "risks" | "milestones" | "capacity" | "wimeta" | "quickfilters" | "votes" | "snapshots"): Json[] {
  return Array.from(dataStore.collections.get(`${collection}-${fake.projectId}`)?.values() ?? []);
}

export function fail(match: RegExp, status = 500, message = "Boom", opts: Partial<Failure> = {}) {
  fake.failures.push({ match, status, message, ...opts });
}

export function callsTo(re: RegExp, method?: string): Call[] {
  return fake.calls.filter((c) => re.test(c.path) && (!method || c.method === method));
}

// ---------------------------------------------------------------------------------------------
// WIQL evaluator
// ---------------------------------------------------------------------------------------------

const unq = (s: string) => s.replace(/''/g, "'");
/** Project context of the WIQL being evaluated (null at collection level, where @project is invalid). */
let wiqlProject: string | null = null;
const STR = "'((?:[^']|'')*)'";

function listAfter(query: string, field: string): string[] | null {
  const m = new RegExp(`${field.replace(/[[\].]/g, "\\$&")} IN \\(([^)]*)\\)`).exec(query);
  if (!m) return null;
  return Array.from(m[1].matchAll(new RegExp(STR, "g"))).map((x: RegExpMatchArray) => unq(x[1]));
}

function allUnder(query: string, field: string): string[] {
  return Array.from(query.matchAll(new RegExp(`${field.replace(/[[\].]/g, "\\$&")} UNDER ${STR}`, "g"))).map((x: RegExpMatchArray) => unq(x[1]));
}

const under = (p: string, parent: string) => p.toLowerCase() === parent.toLowerCase() || p.toLowerCase().startsWith(parent.toLowerCase() + "\\");

function matches(item: WorkItem, types: string[] | null, areas: string[], iterations: string[]): boolean {
  const f = item.fields;
  if (types && !types.includes(f["System.WorkItemType"])) return false;
  if (areas.length && !areas.some((a) => under(f["System.AreaPath"], a))) return false;
  if (iterations.length && !iterations.some((i) => under(f["System.IterationPath"], i))) return false;
  return true;
}

// A small WIQL WHERE-clause parser/evaluator: AND / OR / NOT, parentheses, and the operators
// the extension emits (=, <>, <, >, <=, >=, UNDER, NOT UNDER, IN, NOT IN, CONTAINS, NOT CONTAINS).
// Anything it doesn't understand throws, which the router turns into a 400 like a real server,
// so tests can't silently pass with clauses the fake ignores.

type Tok = { t: "(" | ")" | "and" | "or" | "not" | "field" | "op" | "str" | "num" | "macro" | ","; v: string };

export class WiqlSyntaxError extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\()|(\))|(,)|('(?:[^']|'')*')|(\[[^\]]+\](?:\.\[[^\]]+\])?)|(<>|<=|>=|=|<|>)|(@\w+)|(-?\d+(?:\.\d+)?)|([A-Za-z]+))/y;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(re.lastIndex))) break;
    m = re.exec(src);
    if (!m) throw new WiqlSyntaxError(`TF51005: The query references a field or operator that is not valid near '${src.slice(re.lastIndex, re.lastIndex + 20)}'.`);
    if (m[1]) out.push({ t: "(", v: "(" });
    else if (m[2]) out.push({ t: ")", v: ")" });
    else if (m[3]) out.push({ t: ",", v: "," });
    else if (m[4]) out.push({ t: "str", v: unq(m[4].slice(1, -1)) });
    else if (m[5]) out.push({ t: "field", v: m[5] });
    else if (m[6]) out.push({ t: "op", v: m[6] });
    else if (m[7]) out.push({ t: "macro", v: m[7].toLowerCase() });
    else if (m[8]) out.push({ t: "num", v: m[8] });
    else {
      const w = m[9].toLowerCase();
      if (w === "and" || w === "or" || w === "not") out.push({ t: w, v: w });
      else if (w === "under" || w === "in" || w === "contains") out.push({ t: "op", v: w });
      else throw new WiqlSyntaxError(`TF51005: Unexpected word '${m[9]}' in the query.`);
    }
  }
  return out;
}

type Pred = (item: WorkItem) => boolean;

function fieldValue(item: WorkItem, field: string): any {
  const name = field.replace(/^\[(?:Source|Target)\]\./, "").replace(/^\[|\]$/g, "");
  if (name === "System.Id") return item.id;
  // Every real work item belongs to the project; test-created items may omit it.
  if (name === "System.TeamProject") return item.fields[name] ?? fake.projectName;
  const v = item.fields[name];
  if (v && typeof v === "object") return v.uniqueName ?? v.displayName;
  return v;
}

function parseWhere(src: string): Pred {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const take = (t?: Tok["t"]) => {
    const tok = toks[i++];
    if (!tok || (t && tok.t !== t)) throw new WiqlSyntaxError(`TF51005: Expected ${t ?? "a token"} in the query.`);
    return tok;
  };
  const value = (): any => {
    const tok = take();
    if (tok.t === "str") return tok.v;
    if (tok.t === "num") return Number(tok.v);
    if (tok.t === "macro") {
      if (tok.v === "@project") {
        if (wiqlProject === null) throw new WiqlSyntaxError("TF51011: The @project macro can only be used in the context of a project.");
        return wiqlProject;
      }
      if (tok.v === "@today") return new Date().toISOString().slice(0, 10);
      throw new WiqlSyntaxError(`TF51005: Unsupported macro ${tok.v}.`);
    }
    throw new WiqlSyntaxError("TF51005: Expected a value.");
  };
  const cond = (): Pred => {
    const field = take("field").v;
    let negate = false;
    if (peek()?.t === "not") {
      take();
      negate = true;
    }
    const op = take("op").v;
    let pred: Pred;
    if (op === "in") {
      take("(");
      const list: any[] = [];
      while (peek()?.t !== ")") {
        list.push(value());
        if (peek()?.t === ",") take(",");
      }
      take(")");
      pred = (it) => list.some((v) => String(v).toLowerCase() === String(fieldValue(it, field) ?? "").toLowerCase());
    } else {
      const v = value();
      pred = (it) => {
        const a = fieldValue(it, field);
        switch (op) {
          case "=": return String(a ?? "").toLowerCase() === String(v).toLowerCase();
          case "<>": return String(a ?? "").toLowerCase() !== String(v).toLowerCase();
          case "<": return a !== undefined && a < v;
          case ">": return a !== undefined && a > v;
          case "<=": return a !== undefined && a <= v;
          case ">=": return a !== undefined && a >= v;
          case "under": return typeof a === "string" && under(a, String(v));
          case "contains": return String(a ?? "").toLowerCase().includes(String(v).toLowerCase());
          default: throw new WiqlSyntaxError(`TF51005: Unsupported operator ${op}.`);
        }
      };
    }
    return negate ? (it) => !pred(it) : pred;
  };
  const factor = (): Pred => {
    if (peek()?.t === "not") {
      take();
      const f = factor();
      return (it) => !f(it);
    }
    if (peek()?.t === "(") {
      take("(");
      const e = expr();
      take(")");
      return e;
    }
    return cond();
  };
  const term = (): Pred => {
    let left = factor();
    while (peek()?.t === "and") {
      take();
      const l = left, r = factor();
      left = (it) => l(it) && r(it);
    }
    return left;
  };
  const expr = (): Pred => {
    let left = term();
    while (peek()?.t === "or") {
      take();
      const l = left, r = term();
      left = (it) => l(it) || r(it);
    }
    return left;
  };
  const result = expr();
  if (i < toks.length) throw new WiqlSyntaxError(`TF51005: Unexpected '${toks[i].v}' in the query.`);
  return result;
}

function splitQuery(query: string) {
  const m = /^\s*SELECT\s+.+?\s+FROM\s+(WorkItems|WorkItemLinks)\s*(?:WHERE\s+(.*?))?\s*(?:ORDER BY\s+(.*?))?\s*(?:MODE\s*\((\w+)\))?\s*$/is.exec(query);
  if (!m) throw new WiqlSyntaxError("TF51005: The query is not a valid WIQL SELECT statement.");
  return { from: m[1], where: m[2] ?? "", orderBy: m[3] ?? "", mode: m[4] ?? "" };
}

function evalWiql(query: string, top?: number): Json {
  if (fake.wiqlOverride) return fake.wiqlOverride(query);
  const all = Array.from(fake.workItems.values()).sort((a, b) => a.id - b.id);
  const q = splitQuery(query);

  if (/WorkItemLinks/i.test(q.from)) {
    // "( source conditions ) AND ([System.Links.LinkType] = '...') AND ( target conditions )"
    const [sourcePart, rest = ""] = q.where.split(/\s+AND\s+\(\s*\[System\.Links\.LinkType\][^)]*\)\s*/i);
    const sourcePred = parseWhere(sourcePart);
    const targetPred = rest.trim() ? parseWhere(rest.replace(/^\s*AND\s+/i, "")) : () => true;
    const roots = all.filter(sourcePred);
    const rels: Json[] = [];
    const walk = (parent: WorkItem, depth: number) => {
      if (depth > 10) return;
      for (const r of parent.relations ?? []) {
        if (r.rel !== CHILD) continue;
        const child = fake.workItems.get(Number(/(\d+)$/.exec(r.url)![1]));
        if (!child || !targetPred(child)) continue;
        rels.push({ source: { id: parent.id }, target: { id: child.id }, rel: CHILD });
        walk(child, depth + 1);
      }
    };
    for (const root of roots) {
      rels.push({ source: null, target: { id: root.id }, rel: null });
      walk(root, 0);
    }
    return { workItemRelations: rels };
  }

  let result = q.where ? all.filter(parseWhere(q.where)) : all;
  const order = /\[([^\]]+)\]\s*(ASC|DESC)?/i.exec(q.orderBy);
  if (order) {
    const [, f, dir] = order;
    const key = (it: WorkItem) => (f === "System.Id" ? it.id : it.fields[f]);
    result = [...result].sort((a, b) => {
      const x = key(a), y = key(b);
      if (x === y || (x === undefined && y === undefined)) return a.id - b.id;
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      return (x < y ? -1 : 1) * (dir?.toUpperCase() === "DESC" ? -1 : 1);
    });
  }
  if (top !== undefined) result = result.slice(0, top);
  return { workItems: result.map((i) => ({ id: i.id })) };
}

// ---------------------------------------------------------------------------------------------
// REST router
// ---------------------------------------------------------------------------------------------

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function findIteration(parts: string[], tree = fake.iterationTree): ClassificationNode | undefined {
  let node: ClassificationNode | undefined = tree;
  for (const p of parts) node = node?.children?.find((c) => c.name.toLowerCase() === p.toLowerCase());
  return node;
}

/** Project of a work item (seeded host items may omit System.TeamProject). */
const projectOfItem = (item: WorkItem) => String(item.fields["System.TeamProject"] ?? fake.projectName);
const allProjects = () => [{ id: fake.projectId, name: fake.projectName }, ...fake.otherProjects.map((p) => ({ id: p.id, name: p.name }))];
/** Another project by route segment (id or name). */
const otherProject = (segment: string) => {
  const s = decodeURIComponent(segment).toLowerCase();
  return fake.otherProjects.find((p) => p.id === s || p.name.toLowerCase() === s);
};

/** Whether `path` (field form) exists in a classification tree. */
function inTree(tree: ClassificationNode, path: string): boolean {
  const parts = path.split("\\");
  return parts[0].toLowerCase() === tree.name.toLowerCase() && !!findIteration(parts.slice(1), tree);
}

/**
 * Azure DevOps rejects area / iteration paths of another project (TF401347). For items of the
 * other (seeded) projects the path must also exist in that project's tree.
 */
function treeError(project: string, field: string, value: unknown): string | null {
  if (typeof value !== "string" || (field !== "System.AreaPath" && field !== "System.IterationPath")) return null;
  const valueProject = value.split("\\")[0].toLowerCase();
  const known = allProjects().some((p) => p.name.toLowerCase() === valueProject);
  const invalid = `TF401347: Invalid tree name given for work item, field '${field}' ('${value}').`;
  if (known && valueProject !== project.toLowerCase()) return invalid;
  const other = fake.otherProjects.find((p) => p.name.toLowerCase() === project.toLowerCase());
  if (other && !inTree(field === "System.AreaPath" ? other.areaTree : other.iterationTree, value)) return invalid;
  return null;
}

function route(method: string, path: string, body: Json, full: string): Response {
  const P1 = fake.projectId;
  let m: RegExpExecArray | null;

  // Project-level WIQL resolves @project; collection-level WIQL (cross-project scopes) cannot.
  if (method === "POST" && (path === `${P1}/_apis/wit/wiql` || path === `_apis/wit/wiql`)) {
    const top = new URL(full).searchParams.get("$top");
    wiqlProject = path === `_apis/wit/wiql` ? null : fake.projectName;
    try {
      return json(evalWiql(body.query, top ? Number(top) : undefined));
    } catch (e) {
      if (e instanceof WiqlSyntaxError) return json({ message: e.message }, 400);
      throw e;
    }
  }

  if (method === "GET" && path === `_apis/projects`) return json({ count: allProjects().length, value: allProjects() });

  if (method === "POST" && (path === `${P1}/_apis/wit/workitemsbatch` || path === `_apis/wit/workitemsbatch`)) {
    const known = new Set(fake.fields.map((f) => f.referenceName));
    if (body.fields && body.$expand) return json({ message: "The expand parameter can not be used with the fields parameter." }, 400);
    const bad = (body.fields ?? []).find((f: string) => !f.startsWith("System.") && !known.has(f));
    if (bad) return json({ message: `TF51535: Cannot find field ${bad}.` }, 400);
    if (body.ids.length > 200) return json({ message: "Too many ids" }, 400);
    const value = body.ids
      .map((id: number) => fake.workItems.get(id))
      .filter(Boolean)
      .map((item: WorkItem) => {
        const c = clone(item);
        if (body.fields) {
          c.fields = Object.fromEntries(Object.entries(c.fields).filter(([k]) => body.fields.includes(k)));
          delete c.relations;
        } else if (body.$expand !== "Relations") delete c.relations;
        return c;
      });
    return json({ count: value.length, value });
  }

  if (method === "PATCH" && (m = /^_apis\/wit\/workitems\/(\d+)$/.exec(path))) {
    const item = fake.workItems.get(Number(m[1]));
    if (!item) return json({ message: "TF401232: Work item does not exist" }, 404);
    for (const op of body) {
      const error = op.path.startsWith("/fields/") ? treeError(projectOfItem(item), op.path.slice(8), op.value) : null;
      if (error) return json({ message: error }, 400);
    }
    for (const op of body) {
      if (op.path.startsWith("/fields/")) item.fields[op.path.slice(8)] = op.value;
      else if (op.path === "/relations/-") {
        (item.relations ??= []).push(op.value);
        addReverse(item.id, op.value.rel, linkTarget(op.value.url));
      } else if (op.op === "remove" && op.path.startsWith("/relations/")) {
        const [removed] = item.relations!.splice(Number(op.path.slice(11)), 1);
        if (removed) removeReverse(item.id, removed.rel, linkTarget(removed.url));
      }
    }
    item.rev = (item.rev ?? 1) + 1;
    recordRevision(item);
    return json(clone(item));
  }

  if (method === "POST" && (m = new RegExp(`^${P1}/_apis/wit/workitems/\\$(.+)$`).exec(path))) {
    const type = decodeURIComponent(m[1]);
    if (!fake.types.some((t) => t.name === type)) return json({ message: `TF401326: Invalid work item type ${type}` }, 400);
    if (new URL(full).searchParams.get("validateOnly") === "true") {
      const area = body.find((op: Json) => op.path === "/fields/System.AreaPath")?.value ?? "";
      if (fake.denyWriteAreas.some((d) => under(area, d))) {
        return json({ message: `TF237111: The current user does not have permissions to save work items under the specified area path.` }, 403);
      }
      return json({ id: -1, fields: {} });
    }
    const id = fake.nextId++;
    const fields: Json = { "System.Id": id, "System.WorkItemType": type, "System.State": fake.states[type]?.[0]?.name ?? "New", "System.TeamProject": fake.projectName };
    for (const op of body) if (op.path.startsWith("/fields/")) fields[op.path.slice(8)] = op.value;
    const item: WorkItem = { id, rev: 1, fields, relations: [] };
    fake.workItems.set(id, item);
    return json(clone(item));
  }

  if (method === "GET" && path === `${P1}/_apis/wit/workitemtypes`) return json({ value: fake.types });
  if (method === "GET" && (m = new RegExp(`^${P1}/_apis/wit/workitemtypes/([^/]+)/states$`).exec(path))) {
    return json({ value: fake.states[decodeURIComponent(m[1])] ?? [] });
  }
  if (method === "GET" && path === `${P1}/_apis/wit/fields`) return json({ value: fake.fields });
  if (method === "GET" && path === `${P1}/_apis/wit/classificationnodes/Areas`) return json(fake.areaTree);
  if (method === "GET" && path === `${P1}/_apis/wit/classificationnodes/Iterations`) return json(fake.iterationTree);

  if (method === "POST" && (m = new RegExp(`^${P1}/_apis/wit/classificationnodes/Iterations(/.*)?$`).exec(path))) {
    const parts = (m[1] ?? "").split("/").filter(Boolean).map(decodeURIComponent);
    const parent = findIteration(parts);
    if (!parent) return json({ message: "VS402485: parent not found" }, 404);
    if (parent.children?.some((c) => c.name === body.name)) return json({ message: `VS402371: ${body.name} already exists` }, 409);
    const node: ClassificationNode = {
      id: fake.nextId++,
      identifier: `new-${fake.nextId}`,
      name: body.name,
      path: `${parent.path}\\${body.name}`,
      attributes: body.attributes,
    };
    (parent.children ??= []).push(node);
    parent.hasChildren = true;
    return json(node, 201);
  }

  if ((m = new RegExp(`^${P1}/_apis/wit/classificationnodes/Iterations/(.+)$`).exec(path)) && method !== "POST") {
    const parts = m[1].split("/").map(decodeURIComponent);
    const node = findIteration(parts);
    if (!node) return json({ message: "VS402485: node not found" }, 404);
    if (method === "GET") return json(node);
    if (method === "PATCH") {
      if (body.name) {
        node.name = body.name;
        node.path = node.path.replace(/[^\\]+$/, body.name);
      }
      if (body.attributes) node.attributes = body.attributes;
      return json(node);
    }
    if (method === "DELETE") {
      const parent = findIteration(parts.slice(0, -1))!;
      parent.children = parent.children!.filter((c) => c !== node);
      fake.deletedIterations.push({ path: node.path, reclassifyId: Number(new URL(full).searchParams.get("$reclassifyId")) });
      return new Response(null, { status: 204 });
    }
  }

  // Reporting revisions (used for history-based burnup): all revisions of the requested types.
  // The collection-level route (cross-project scopes) returns the same (the fixture's projects).
  if ((method === "POST" || method === "GET") && (path === `${P1}/_apis/wit/reporting/workitemrevisions` || path === `_apis/wit/reporting/workitemrevisions`)) {
    const types: string[] | undefined = body?.types;
    const fields: string[] | undefined = body?.fields;
    const values = Array.from(fake.revisions.entries())
      .flatMap(([id, revs]) => revs.map((r) => ({ id, rev: r.rev, fields: r.fields })))
      .filter((r) => !types || types.includes(r.fields["System.WorkItemType"]))
      .map((r) => ({ ...r, fields: fields ? Object.fromEntries(Object.entries(r.fields).filter(([k]) => fields.includes(k))) : r.fields }));
    return json({ values, isLastBatch: true, nextLink: null });
  }

  if (method === "GET" && (m = /^_apis\/permissions\/([^/]+)\/(\d+)$/.exec(path))) {
    const url = new URL(full);
    const tokens = (url.searchParams.get("tokens") ?? "").split(",").filter(Boolean);
    const allowed = fake.permissions[`${m[1]}/${m[2]}`] ?? true;
    return json({ count: tokens.length, value: tokens.map(() => allowed) });
  }

  if (method === "GET" && path === `_apis/wit/workitemrelationtypes`) {
    return json({
      value: Object.keys(REVERSE_LINK).map((ref) => ({ referenceName: ref, name: ref.split(".").pop(), attributes: { usage: "workItemLink", topology: ref.includes("Hierarchy") ? "tree" : ref.includes("Dependency") ? "dependency" : "network" } }))
        .concat([{ referenceName: "Custom.Blocks-Forward", name: "Blocks", attributes: { usage: "workItemLink", topology: "dependency" } }]),
    });
  }

  if (method === "GET" && (m = new RegExp(`^_apis/projects/${P1}/teams/([^/]+)/members$`).exec(path))) {
    const team = decodeURIComponent(m[1]);
    return json({ value: (fake.teamMembers[team] ?? []).map((identity) => ({ identity })) });
  }

  if (method === "GET" && path === `_apis/projects/${P1}/teams`) return json({ value: [...fake.teams].reverse() });

  if ((m = new RegExp(`^${P1}/([^/]+)/_apis/work/teamsettings/iterations/([^/]+)$`).exec(path)) && method === "DELETE") {
    const team = decodeURIComponent(m[1]);
    fake.teamIterations[team] = (fake.teamIterations[team] ?? []).filter((i) => i !== m![2]);
    return new Response(null, { status: 204 });
  }

  if ((m = new RegExp(`^${P1}/([^/]+)/_apis/work/teamsettings/(teamfieldvalues|iterations)$`).exec(path))) {
    const team = decodeURIComponent(m[1]);
    if (m[2] === "teamfieldvalues" && method === "GET") {
      return json({ field: { referenceName: fake.teamFieldRef }, defaultValue: fake.teamAreas[team], values: [] });
    }
    if (m[2] === "iterations" && method === "GET") {
      const all: ClassificationNode[] = [];
      const walk = (n: ClassificationNode) => (all.push(n), n.children?.forEach(walk));
      walk(fake.iterationTree);
      const value = (fake.teamIterations[team] ?? [])
        .map((idf) => all.find((n) => n.identifier === idf))
        .filter(Boolean)
        .map((n) => ({ id: n!.identifier, name: n!.name, path: n!.path.replace(/^\\/, "").replace("\\Iteration", ""), attributes: n!.attributes }));
      return json({ count: value.length, value });
    }
    if (m[2] === "iterations" && method === "POST") {
      const list = (fake.teamIterations[team] ??= []);
      if (list.includes(body.id)) return json({ message: "Iteration already assigned" }, 409);
      list.push(body.id);
      return json({ id: body.id });
    }
  }

  const other = routeOtherProject(method, path, body, full);
  if (other) return other;

  return json({ message: `Fake ADO: no route for ${method} ${path}` }, 404);
}

/** Routes of the other (seeded) projects: trees, teams, members, team areas and item creation. */
function routeOtherProject(method: string, path: string, body: Json, full: string): Response | null {
  let m: RegExpExecArray | null;
  if (method === "GET" && (m = /^([^/]+)\/_apis\/wit\/classificationnodes\/(Areas|Iterations)$/.exec(path)) && otherProject(m[1])) {
    const p = otherProject(m[1])!;
    return json(m[2] === "Areas" ? p.areaTree : p.iterationTree);
  }
  if (method === "GET" && (m = /^_apis\/projects\/([^/]+)\/teams$/.exec(path)) && otherProject(m[1])) {
    return json({ value: otherProject(m[1])!.teams });
  }
  if (method === "GET" && (m = /^_apis\/projects\/([^/]+)\/teams\/([^/]+)\/members$/.exec(path)) && otherProject(m[1])) {
    return json({ value: (otherProject(m[1])!.teamMembers[decodeURIComponent(m[2])] ?? []).map((identity) => ({ identity })) });
  }
  if (method === "GET" && (m = /^([^/]+)\/([^/]+)\/_apis\/work\/teamsettings\/teamfieldvalues$/.exec(path)) && otherProject(m[1])) {
    return json({ field: { referenceName: "System.AreaPath" }, defaultValue: otherProject(m[1])!.teamAreas[decodeURIComponent(m[2])], values: [] });
  }
  if (method === "POST" && (m = /^([^/]+)\/_apis\/wit\/workitems\/\$(.+)$/.exec(path)) && otherProject(m[1])) {
    const p = otherProject(m[1])!;
    const type = decodeURIComponent(m[2]);
    if (!fake.types.some((t) => t.name === type)) return json({ message: `TF401326: Invalid work item type ${type}` }, 400);
    for (const op of body) {
      const error = op.path.startsWith("/fields/") ? treeError(p.name, op.path.slice(8), op.value) : null;
      if (error) return json({ message: error }, 400);
    }
    if (new URL(full).searchParams.get("validateOnly") === "true") return json({ id: -1, fields: {} });
    const id = fake.nextId++;
    const fields: Json = { "System.Id": id, "System.WorkItemType": type, "System.State": fake.states[type]?.[0]?.name ?? "New", "System.TeamProject": p.name };
    for (const op of body) if (op.path.startsWith("/fields/")) fields[op.path.slice(8)] = op.value;
    const item: WorkItem = { id, rev: 1, fields, relations: [] };
    fake.workItems.set(id, item);
    return json(clone(item));
  }
  return null;
}


export const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  const full = String(input);
  const base = fake.baseUrl + "/";
  // Anything outside the fake collection is a test bug: fail loudly rather than touching the network.
  if (!full.startsWith(base)) throw new Error(`Unexpected URL ${full}`);
  // Path segments stay URL-encoded; routes decode the parts they capture.
  const [path] = full.slice(base.length).split("?");
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  fake.calls.push({ method, path, url: full, body, headers: (init.headers ?? {}) as Record<string, string> });

  const failure = fake.failures.find((f) => (!f.method || f.method === method) && f.match.test(`${method} ${decodeURIComponent(path)}`));
  if (failure) {
    if (failure.once) fake.failures.splice(fake.failures.indexOf(failure), 1);
    if (failure.raw !== undefined) return new Response(failure.raw, { status: failure.status, statusText: "Server Error" });
    return json({ message: failure.message }, failure.status);
  }
  return route(method, path, body, full);
});

// ---------------------------------------------------------------------------------------------
// Extension Data Service
// ---------------------------------------------------------------------------------------------

function dataFailure(op: string) {
  const i = dataStore.failures.findIndex((f) => f.op === op);
  if (i >= 0) throw dataStore.failures.splice(i, 1)[0].error;
}

export const dataManager = {
  getValue: vi.fn(async (key: string) => {
    dataFailure("getValue");
    return clone(dataStore.values.get(key));
  }),
  setValue: vi.fn(async (key: string, value: Json) => {
    dataFailure("setValue");
    dataStore.values.set(key, clone(value));
    return clone(value);
  }),
  getDocuments: vi.fn(async (collection: string) => {
    dataFailure("getDocuments");
    const c = dataStore.collections.get(collection);
    if (!c) throw Object.assign(new Error(`Document collection '${collection}' does not exist.`), { status: 404 });
    return Array.from(c.values()).map(clone);
  }),
  getDocument: vi.fn(async (collection: string, id: string) => {
    dataFailure("getDocument");
    const doc = dataStore.collections.get(collection)?.get(id);
    if (!doc) throw Object.assign(new Error(`Document '${id}' does not exist.`), { status: 404 });
    return clone(doc);
  }),
  setDocument: vi.fn(async (collection: string, doc: Json) => {
    dataFailure("setDocument");
    if (!dataStore.collections.has(collection)) dataStore.collections.set(collection, new Map());
    const c = dataStore.collections.get(collection)!;
    const existing = c.get(doc.id);
    if (existing && doc.__etag !== undefined && doc.__etag !== existing.__etag) {
      throw Object.assign(new Error("The document has been modified (etag mismatch)"), { status: 409 });
    }
    const saved = { ...clone(doc), __etag: (existing?.__etag ?? 0) + 1 };
    c.set(doc.id, saved);
    return clone(saved);
  }),
  deleteDocument: vi.fn(async (collection: string, id: string) => {
    dataFailure("deleteDocument");
    dataStore.collections.get(collection)?.delete(id);
  }),
};
