import "@testing-library/jest-dom/vitest";
import { beforeEach, vi } from "vitest";
import { auditPolicy } from "../src/api/audit";
import { retryPolicy } from "../src/api/client";
import { resetCrossProject } from "../src/api/projects";
import { dataManager, fetchMock, resetFake } from "./fakeAdo";

// Retry throttled requests immediately in tests.
retryPolicy.baseDelayMs = 0;
// Pruning of the change log is random in production; tests trigger it explicitly.
auditPolicy.pruneChance = 0;
import * as sdk from "./sdkMock";

vi.mock("azure-devops-extension-sdk", () => import("./sdkMock"));

// jsdom lacks these layout APIs used by the program board.
class ResizeObserverStub {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    this.cb([], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;

if (typeof (globalThis as any).DOMRect === "undefined") {
  (globalThis as any).DOMRect = class {
    constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
    get left() { return this.x; }
    get top() { return this.y; }
    get right() { return this.x + this.width; }
    get bottom() { return this.y + this.height; }
  };
}

// fetch is never unstubbed: async work that outlives a test must hit the fake, never the network.
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  resetFake();
  resetCrossProject();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  fetchMock.mockClear();
  Object.values(dataManager).forEach((fn) => fn.mockClear());
  sdk.workItemForm.openWorkItem.mockClear();
  sdk.workItemForm.openNewWorkItem.mockClear();
});
