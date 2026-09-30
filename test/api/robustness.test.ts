import { afterEach, describe, expect, it } from "vitest";
import { api, mapLimit, retryPolicy } from "../../src/api/client";
import { DEFAULT_RROE_FIELD, isIpIteration, isOnWsjfScale, localToday, wsjfOf, wsjfScore } from "../../src/api/rules";
import { getWorkItems, QueryLimitError, queryIds, typeIn, wiqlPaging } from "../../src/api/wit";
import { callsTo, fail, fake } from "../fakeAdo";

const fetchOnce = (...responses: Response[]) => {
  for (const r of responses) (globalThis.fetch as any).mockImplementationOnce(async () => r);
};
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ message: `status ${code}` }), { status: code, headers });

describe("throttling", () => {
  afterEach(() => {
    retryPolicy.retries = 3;
  });

  it("retries 429 and 503 responses, then succeeds", async () => {
    fetchOnce(status(429, { "Retry-After": "0" }), status(503));
    const res = await api<{ value: unknown[] }>(`${fake.projectId}/_apis/wit/fields`);
    expect(res.value.length).toBeGreaterThan(0);
    expect(fake.calls).toHaveLength(1); // the two throttled answers never reached the fake router
    expect((globalThis.fetch as any).mock.calls.length).toBe(3);
  });

  it("gives up after the configured number of retries", async () => {
    retryPolicy.retries = 1;
    fetchOnce(status(429), status(429));
    await expect(api("anything")).rejects.toThrow("status 429");
  });

  it("does not retry other errors", async () => {
    fail(/wit\/fields/, 500, "server error");
    await expect(api(`${fake.projectId}/_apis/wit/fields`)).rejects.toThrow("server error");
    expect(callsTo(/wit\/fields/)).toHaveLength(1);
  });

  it("caps concurrency and preserves order", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10 + i;
    });
    expect(out).toEqual([50, 11, 42, 23, 34]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });

  it("fetches work item batches at most four at a time", async () => {
    for (let i = 2000; i < 3100; i++) fake.workItems.set(i, { id: i, fields: { "System.Title": `x${i}` } });
    const items = await getWorkItems(Array.from({ length: 1100 }, (_, i) => 2000 + i), ["System.Title"]);
    expect(items).toHaveLength(1100);
    expect(callsTo(/workitemsbatch/)).toHaveLength(6);
  });
});

describe("WIQL paging", () => {
  afterEach(() => {
    wiqlPaging.pageSize = 20000;
    wiqlPaging.maxItems = 200000;
  });

  it("continues past a full page by id so nothing is cut off", async () => {
    wiqlPaging.pageSize = 3;
    const ids = await queryIds("SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] IN ('User Story') ORDER BY [System.Title] ASC");
    // Full first page (ordered by title) -> restart in id order and page through everything.
    expect(ids).toEqual([100, 101, 102, 103, 104, 105]);
    const queries = callsTo(/wiql/).map((c) => c.body.query);
    expect(queries[1]).toMatch(/AND \[System\.Id\] > 0 ORDER BY \[System\.Id\] ASC$/);
    expect(queries[2]).toMatch(/AND \[System\.Id\] > 102 ORDER BY \[System\.Id\] ASC$/);
    expect(queries[1]).not.toContain("System.Title] ASC");
  });

  it("stops with a clear error beyond the maximum", async () => {
    wiqlPaging.pageSize = 2;
    wiqlPaging.maxItems = 3;
    await expect(queryIds("SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] IN ('User Story')")).rejects.toBeInstanceOf(QueryLimitError);
  });

  it("stops when a follow-up page brings nothing new", async () => {
    wiqlPaging.pageSize = 2;
    fake.wiqlOverride = () => ({ workItems: [{ id: 1 }, { id: 2 }] });
    expect(await queryIds("SELECT [System.Id] FROM WorkItems")).toEqual([1, 2]);
  });

  it("makes an empty type list match nothing instead of producing invalid WIQL", () => {
    expect(typeIn([])).toBe("[System.Id] < 0");
    expect(typeIn(["", ""])).toBe("[System.Id] < 0");
  });
});

describe("fake WIQL fidelity", () => {
  it("rejects syntax the server would reject", async () => {
    await expect(queryIds("SELECT [System.Id] FROM WorkItems WHERE [System.State] = ")).rejects.toThrow(/TF51005/);
    await expect(queryIds("SELECT [System.Id] FROM WorkItems WHERE [System.State] LIKE 'x'")).rejects.toThrow(/TF51005/);
  });

  it("evaluates filter clauses, NOT and ordering", async () => {
    const q = (where: string) => queryIds(`SELECT [System.Id] FROM WorkItems WHERE ${where}`);
    expect(await q("[System.WorkItemType] = 'Epic' AND NOT [System.State] = 'New'")).toEqual([1, 4]);
    expect(await q("[System.WorkItemType] = 'Epic' AND [System.State] NOT IN ('New', 'Removed')")).toEqual([1]);
    expect(await q("[System.Title] CONTAINS 'card' AND [System.Id] >= 101")).toEqual([101]);
    expect(await q("[System.AssignedTo] = 'Ada Lovelace'")).toEqual([1]);
    expect(await queryIds("SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Epic' ORDER BY [System.Id] DESC")).toEqual([4, 3, 2, 1]);
  });
});

describe("shared rules", () => {
  it("uses the local calendar date for today", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    expect(localToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("detects IP iterations case-insensitively, ignoring the PI name", () => {
    expect(isIpIteration("PI 2 IP")).toBe(true);
    expect(isIpIteration("PI 2 ip")).toBe(true);
    expect(isIpIteration("Innovation & Planning")).toBe(true);
    expect(isIpIteration("Innovation and Planning")).toBe(true);
    expect(isIpIteration("PI 2 Sprint 1")).toBe(false);
    expect(isIpIteration("IP-2026 Sprint 1", "IP-2026")).toBe(false);
    expect(isIpIteration("IP-2026 IP", "IP-2026")).toBe(true);
  });

  it("computes one WSJF everywhere, including RR/OE", () => {
    expect(wsjfScore(8, 5, 0, 13)).toBe(1);
    expect(wsjfScore(8, 5, 13, 13)).toBe(2);
    expect(wsjfScore(undefined, undefined, undefined, 5)).toBeNull();
    expect(wsjfScore(3, 3, 3, 0)).toBeNull();
    expect(wsjfScore(0, 0, 0, 5)).toBeNull();
    expect(wsjfOf({ "Microsoft.VSTS.Common.BusinessValue": 3, "Microsoft.VSTS.Scheduling.Effort": 2, [DEFAULT_RROE_FIELD]: 3 })).toBe(3);
    expect(wsjfOf({ "Microsoft.VSTS.Common.BusinessValue": "", "Microsoft.VSTS.Scheduling.Effort": 2 })).toBeNull();
    expect(wsjfOf({ "Custom.Rroe": 4, "Microsoft.VSTS.Scheduling.Effort": 2 }, "Custom.Rroe")).toBe(2);
    expect(isOnWsjfScale(13)).toBe(true);
    expect(isOnWsjfScale(4)).toBe(false);
  });
});

describe("safety of retries and paging", () => {
  it("does not retry a write that answered 503 (it may have been applied)", async () => {
    fetchOnce(status(503));
    await expect(api("_apis/wit/workitems/10", { method: "PATCH", body: [] })).rejects.toThrow("status 503");
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });

  it("finds ORDER BY only outside string literals", async () => {
    const { orderByIndex } = await import("../../src/api/wit");
    expect(orderByIndex("SELECT x WHERE [System.Title] = 'a ORDER BY b' ORDER BY [System.Id]")).toBe(46);
    expect(orderByIndex("SELECT x WHERE [System.Title] = 'no ORDER BY here'")).toBe(-1);
  });
});
