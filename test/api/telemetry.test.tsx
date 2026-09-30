import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPayload,
  hashId,
  setTelemetryBuild,
  setTelemetryOptIn,
  TELEMETRY_SALT,
  TelemetryEvents,
  telemetryAvailable,
  telemetryEnabled,
  track,
} from "../../src/api/telemetry";
import { SafeConfig } from "../../src/api/types";
import { SetupView } from "../../src/views/SetupView";
import { fetchMock, makeConfig } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { renderApp, renderView } from "../utils";

const ENDPOINT = "https://telemetry.example.com/e";

let beacon: ReturnType<typeof vi.fn>;
const sent = () => beacon.mock.calls.map((c) => c[0] as string);
async function bodies(): Promise<any[]> {
  return Promise.all(beacon.mock.calls.map(async (c) => JSON.parse(await (c[1] as Blob).text())));
}

beforeEach(() => {
  beacon = vi.fn(() => true);
  Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true, writable: true });
  setTelemetryBuild({ endpoint: "", version: "9.9.9" });
  setTelemetryOptIn(false);
});

afterEach(() => {
  setTelemetryBuild({ endpoint: "", version: "dev" });
  setTelemetryOptIn(false);
  delete (navigator as any).sendBeacon;
});

describe("telemetry gating", () => {
  it("is off by default: no endpoint in the default build", async () => {
    setTelemetryBuild({ endpoint: "" });
    setTelemetryOptIn(true);
    expect(telemetryAvailable()).toBe(false);
    expect(telemetryEnabled()).toBe(false);
    await track(TelemetryEvents.viewOpened, "reports");
    expect(beacon).not.toHaveBeenCalled();
  });

  it("sends nothing with an endpoint but without the admin opt-in", async () => {
    setTelemetryBuild({ endpoint: ENDPOINT });
    for (const optIn of [undefined, false]) {
      setTelemetryOptIn(optIn);
      await track(TelemetryEvents.piCreated);
    }
    expect(beacon).not.toHaveBeenCalled();
  });

  it("rejects non-https endpoints", () => {
    setTelemetryOptIn(true);
    for (const endpoint of ["http://insecure.example.com", "ftp://x", "not a url", "javascript:alert(1)"]) {
      setTelemetryBuild({ endpoint });
      expect(telemetryEnabled()).toBe(false);
    }
  });

  it("sends when both the endpoint and the opt-in are set", async () => {
    setTelemetryBuild({ endpoint: ENDPOINT });
    setTelemetryOptIn(true);
    expect(telemetryEnabled()).toBe(true);
    await track(TelemetryEvents.viewOpened, "reports");
    expect(sent()).toEqual([ENDPOINT]);
  });
});

describe("telemetry payload", () => {
  it("contains only the event name, version and hashed collection id", async () => {
    setTelemetryBuild({ endpoint: ENDPOINT });
    setTelemetryOptIn(true);
    await track(TelemetryEvents.boardReplanned);
    const [body] = await bodies();
    expect(Object.keys(body).sort()).toEqual(["collection", "event", "schema", "version"]);
    expect(body).toEqual({ schema: 1, event: "board_replanned", version: "9.9.9", collection: await hashId("coll-0000-test") });
    expect(JSON.stringify(body)).not.toContain("coll-0000-test");
    expect(body.collection).toMatch(/^[0-9a-f]{32}$/);
  });

  it("hashes with a salt, deterministically", async () => {
    const a = await hashId("org-1");
    expect(await hashId("org-1")).toBe(a);
    expect(await hashId("org-2")).not.toBe(a);
    expect(await hashId("org-1", "other-salt")).not.toBe(a);
    expect(await hashId("org-1", TELEMETRY_SALT)).toBe(a);
  });

  it("falls back when the host or crypto is unavailable", async () => {
    sdk.getHost.mockImplementationOnce(() => {
      throw new Error("no host");
    });
    setTelemetryBuild({ endpoint: ENDPOINT });
    expect((await buildPayload(TelemetryEvents.configSaved))!.collection).toBe(await hashId("unknown"));

    const subtle = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
    Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true });
    try {
      expect(await hashId("x")).toBe("unavailable");
    } finally {
      if (subtle) Object.defineProperty(globalThis.crypto, "subtle", subtle);
      else delete (globalThis.crypto as any).subtle;
    }
  });

  it("drops unknown events and free-text details", async () => {
    expect(await buildPayload("title_of_my_secret_feature" as any)).toBeUndefined();
    expect(await buildPayload(TelemetryEvents.viewOpened, "Payment API for ACME")).toBeUndefined();
    expect(await buildPayload(TelemetryEvents.viewOpened, "someone@example.com")).toBeUndefined();
    expect((await buildPayload(TelemetryEvents.viewOpened, "teamboard"))!.event).toBe("view_opened.teamboard");
  });
});

describe("telemetry transport", () => {
  beforeEach(() => {
    setTelemetryBuild({ endpoint: ENDPOINT });
    setTelemetryOptIn(true);
  });

  it("falls back to a keepalive fetch without credentials when sendBeacon is refused", async () => {
    beacon.mockReturnValue(false);
    fetchMock.mockClear();
    await track(TelemetryEvents.riskCreated);
    const call = fetchMock.mock.calls.find((c) => String(c[0]) === ENDPOINT)!;
    expect(call[1]).toMatchObject({ method: "POST", keepalive: true, credentials: "omit", mode: "no-cors" });
    expect(JSON.parse(String(call[1]!.body))).toMatchObject({ event: "risk_created" });
  });

  it("uses fetch when sendBeacon is missing or throws", async () => {
    delete (navigator as any).sendBeacon;
    fetchMock.mockClear();
    await track(TelemetryEvents.objectiveCreated);
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === ENDPOINT)).toBe(true);

    Object.defineProperty(navigator, "sendBeacon", { value: () => { throw new Error("blocked"); }, configurable: true, writable: true });
    fetchMock.mockClear();
    await track(TelemetryEvents.objectiveCreated);
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === ENDPOINT)).toBe(true);
  });

  it("never throws, even when fetch throws or rejects", async () => {
    delete (navigator as any).sendBeacon;
    const original = globalThis.fetch;
    try {
      vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline"); }));
      await expect(track(TelemetryEvents.piCreated)).resolves.toBeUndefined();
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
      await expect(track(TelemetryEvents.piCreated)).resolves.toBeUndefined();
    } finally {
      vi.stubGlobal("fetch", original);
    }
  });

  it("does not send when opted out while the hash was being computed", async () => {
    const pending = track(TelemetryEvents.piCreated);
    setTelemetryOptIn(false);
    await pending;
    expect(beacon).not.toHaveBeenCalled();
  });
});

describe("telemetry in the hub", () => {
  it("tracks view changes in the App only when opted in", async () => {
    setTelemetryBuild({ endpoint: ENDPOINT });
    const config: SafeConfig = { ...makeConfig(), telemetryOptIn: true };
    await renderApp({ nodeId: "n-arta", view: "reports", config });
    await waitFor(() => expect(beacon).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "Risks (ROAM)" }));
    await waitFor(async () => expect((await bodies()).map((b) => b.event)).toEqual(["view_opened.reports", "view_opened.risks"]));
  });

  it("sends nothing from the App without the opt-in", async () => {
    setTelemetryBuild({ endpoint: ENDPOINT });
    await renderApp({ nodeId: "n-arta", view: "reports" });
    fireEvent.click(screen.getByRole("tab", { name: "Risks (ROAM)" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(beacon).not.toHaveBeenCalled();
  });

  it("Setup has an off-by-default opt-in that is saved in the config", async () => {
    const { ctx } = await renderView(<SetupView firstRun={false} />, { nodeId: "n-root" });
    await screen.findByRole("heading", { name: "Usage data" });
    expect(screen.getByText(/This build has no telemetry endpoint/)).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: /Share anonymous usage data/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    expect((ctx.saveConfig.mock.calls.at(-1)![0] as SafeConfig).telemetryOptIn).toBe(true);
  });

  it("Setup does not warn about a missing endpoint when the build has one", async () => {
    setTelemetryBuild({ endpoint: ENDPOINT });
    await renderView(<SetupView firstRun={false} />, { nodeId: "n-root" });
    await screen.findByRole("heading", { name: "Usage data" });
    expect(screen.queryByText(/This build has no telemetry endpoint/)).not.toBeInTheDocument();
  });
});
