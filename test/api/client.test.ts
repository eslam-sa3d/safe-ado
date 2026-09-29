import { describe, expect, it, vi } from "vitest";
import { api, API_VERSION, ApiError, chunk, getBaseUrl, getProject, wiqlString } from "../../src/api/client";
import { callsTo, fail, fake } from "../fakeAdo";
import * as sdk from "../sdkMock";

describe("client", () => {
  it("pins every request to api-version 7.0 (the highest Server 2022.1 supports)", async () => {
    expect(API_VERSION).toBe("7.0");
    await api(`${fake.projectId}/_apis/wit/fields`);
    expect(fake.calls[0].url).toBe("https://dev.azure.com/org/p1/_apis/wit/fields?api-version=7.0");
  });

  it("appends api-version with & when the path already has a query string", async () => {
    await api(`${fake.projectId}/_apis/wit/classificationnodes/Areas?$depth=10`);
    expect(fake.calls[0].url).toMatch(/\?\$depth=10&api-version=7\.0$/);
  });

  it("normalises the collection URL to end with a slash and caches it", async () => {
    expect(await getBaseUrl()).toBe("https://dev.azure.com/org/");
    sdk.getService.mockClear();
    await getBaseUrl();
    expect(sdk.getService).not.toHaveBeenCalled();
  });

  it("keeps an existing trailing slash (on-prem collection URLs)", async () => {
    vi.resetModules();
    sdk.getService.mockImplementationOnce(async () => ({ getResourceAreaLocation: async () => "https://tfs.local/tfs/DefaultCollection/" }) as any);
    const fresh = await import("../../src/api/client");
    expect(await fresh.getBaseUrl()).toBe("https://tfs.local/tfs/DefaultCollection/");
  });

  it("sends bearer auth, JSON content type and suppresses fed-auth redirects", async () => {
    await api(`${fake.projectId}/_apis/wit/wiql`, { method: "POST", body: { query: "SELECT [System.Id] FROM WorkItems" } });
    const call = fake.calls[0];
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer test-token");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.headers["X-TFS-FedAuthRedirect"]).toBe("Suppress");
    expect(call.body).toEqual({ query: "SELECT [System.Id] FROM WorkItems" });
  });

  it("honours a custom content type", async () => {
    await api(`_apis/wit/workitems/10`, { method: "PATCH", body: [], contentType: "application/json-patch+json" });
    expect(fake.calls[0].headers["Content-Type"]).toBe("application/json-patch+json");
  });

  it("throws ApiError with the server message", async () => {
    fail(/wit\/fields/, 403, "Access denied");
    const err = (await api(`${fake.projectId}/_apis/wit/fields`).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("Access denied");
    expect(err.status).toBe(403);
  });

  it("falls back to status text when the error body is not JSON", async () => {
    fail(/wit\/fields/, 502, undefined, { raw: "<html>gateway</html>" });
    await expect(api(`${fake.projectId}/_apis/wit/fields`)).rejects.toThrow("502 Server Error");
  });

  it("falls back to status text when the JSON error has no message", async () => {
    fetchOnce(new Response(JSON.stringify({ typeKey: "X" }), { status: 400, statusText: "Bad Request" }));
    await expect(api("anything")).rejects.toThrow("400 Bad Request");
  });

  it("returns undefined for 204 No Content", async () => {
    fetchOnce(new Response(null, { status: 204 }));
    await expect(api("anything", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("reads the project from the web context", () => {
    expect(getProject()).toEqual({ id: "p1", name: "Fabrikam" });
  });

  it("escapes WIQL string literals", () => {
    expect(wiqlString("Fabrikam")).toBe("'Fabrikam'");
    expect(wiqlString("O'Brien's team")).toBe("'O''Brien''s team'");
  });

  it("chunks arrays", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it("records calls through the fake", async () => {
    await api(`${fake.projectId}/_apis/wit/fields`);
    expect(callsTo(/wit\/fields$/, "GET")).toHaveLength(1);
  });
});

function fetchOnce(response: Response) {
  (globalThis.fetch as any).mockImplementationOnce(async () => response);
}
