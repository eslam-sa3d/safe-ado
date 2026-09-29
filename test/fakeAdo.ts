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
const iso = (t: number) => new Date(t).toISOString().slice(0, 10) + "T00:00:00Z";

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
};

export const dataStore = {
  values: new Map<string, Json>(),
  collections: new Map<string, Map<string, Json>>(),
  failures: [] as { op: string; error: Error & { status?: number } }[],
};

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function cnode(structure: "Area" | "Iteration", parts: string[], attrs?: { start: number; finish: number }, children: ClassificationNode[] = []): ClassificationNode {
  const id = fake.nextId++;
  return {
    id,
    identifier: `${structure.toLowerCase()}-${parts.join("-") || "root"}`.replace(/\s+/g, "_"),
    name: parts.length ? parts[parts.length - 1] : fake.projectName,
    path: "\\" + [fake.projectName, structure, ...parts].join("\\"),
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
    wi(100, "User Story", "Charge card", RED, PI2_S1, "Closed", { [SP]: 5 }),
    wi(101, "User Story", "Refund card", RED, PI2_S2, "Active", { [SP]: 3 }),
    wi(102, "User Story", "Add wallet", BLUE, PI2_S1, "New", { [SP]: 8 }),
    wi(103, "User Story", "Old story", RED, PI1_S1, "Closed", { [SP]: 2 }),
    wi(104, "User Story", "Removed story", RED, PI2_S1, "Removed", { [SP]: 13 }),
    wi(105, "User Story", "Cart page", BLUE, PI2_S2, "Closed"),
  ];
  fake.workItems = new Map(items.map((i) => [i.id, i]));

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

export function seedConfig(config: SafeConfig = makeConfig()) {
  dataStore.values.set(`config-${fake.projectId}`, clone(config));
  return config;
}

export function seedDocs(collection: "objectives" | "risks", docs: Json[]) {
  const map = new Map<string, Json>();
  docs.forEach((d) => map.set(d.id, { ...clone(d), __etag: 1 }));
  dataStore.collections.set(`${collection}-${fake.projectId}`, map);
}

export function docs(collection: "objectives" | "risks"): Json[] {
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

function evalWiql(query: string): Json {
  if (fake.wiqlOverride) return fake.wiqlOverride(query);
  // "[System.Id] < 0" is how the extension expresses an empty scope.
  const all = query.includes("[System.Id] < 0") ? [] : Array.from(fake.workItems.values()).sort((a, b) => a.id - b.id);

  if (/FROM WorkItemLinks/i.test(query)) {
    const [sourcePart] = query.split(/\) AND \(\[System\.Links\.LinkType\]/);
    const srcType = new RegExp(`\\[Source\\]\\.\\[System\\.WorkItemType\\] = ${STR}`).exec(sourcePart)?.[1];
    const roots = all.filter((i) =>
      matches(i, srcType ? [unq(srcType)] : null, allUnder(sourcePart, "[Source].[System.AreaPath]"), allUnder(sourcePart, "[Source].[System.IterationPath]"))
    );
    const targetTypes = listAfter(query, "[Target].[System.WorkItemType]");
    const rels: Json[] = [];
    const walk = (parent: WorkItem, depth: number) => {
      if (depth > 10) return;
      for (const r of parent.relations ?? []) {
        if (r.rel !== CHILD) continue;
        const child = fake.workItems.get(Number(/(\d+)$/.exec(r.url)![1]));
        if (!child || (targetTypes && !targetTypes.includes(child.fields["System.WorkItemType"]))) continue;
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

  const types = listAfter(query, "[System.WorkItemType]");
  const result = all.filter((i) => matches(i, types, allUnder(query, "[System.AreaPath]"), allUnder(query, "[System.IterationPath]")));
  return { workItems: result.map((i) => ({ id: i.id })) };
}

// ---------------------------------------------------------------------------------------------
// REST router
// ---------------------------------------------------------------------------------------------

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function findIteration(parts: string[]): ClassificationNode | undefined {
  let node: ClassificationNode | undefined = fake.iterationTree;
  for (const p of parts) node = node?.children?.find((c) => c.name.toLowerCase() === p.toLowerCase());
  return node;
}

function route(method: string, path: string, body: Json): Response {
  const P1 = fake.projectId;
  let m: RegExpExecArray | null;

  if (method === "POST" && path === `${P1}/_apis/wit/wiql`) return json(evalWiql(body.query));

  if (method === "POST" && path === `${P1}/_apis/wit/workitemsbatch`) {
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
      if (op.path.startsWith("/fields/")) item.fields[op.path.slice(8)] = op.value;
      else if (op.path === "/relations/-") (item.relations ??= []).push(op.value);
      else if (op.op === "remove" && op.path.startsWith("/relations/")) item.relations!.splice(Number(op.path.slice(11)), 1);
    }
    item.rev = (item.rev ?? 1) + 1;
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

  if (method === "GET" && path === `_apis/projects/${P1}/teams`) return json({ value: [...fake.teams].reverse() });

  if ((m = new RegExp(`^${P1}/([^/]+)/_apis/work/teamsettings/(teamfieldvalues|iterations)$`).exec(path))) {
    const team = decodeURIComponent(m[1]);
    if (m[2] === "teamfieldvalues" && method === "GET") {
      return json({ field: { referenceName: fake.teamFieldRef }, defaultValue: fake.teamAreas[team], values: [] });
    }
    if (m[2] === "iterations" && method === "POST") {
      const list = (fake.teamIterations[team] ??= []);
      if (list.includes(body.id)) return json({ message: "Iteration already assigned" }, 409);
      list.push(body.id);
      return json({ id: body.id });
    }
  }

  return json({ message: `Fake ADO: no route for ${method} ${path}` }, 404);
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
  return route(method, path, body);
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
