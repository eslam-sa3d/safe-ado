import { vi } from "vitest";
import { dataManager, fake } from "./fakeAdo";

/** Stand-in for azure-devops-extension-sdk, wired to the in-memory fake backend. */
export const workItemForm = {
  openWorkItem: vi.fn(async (_id: number) => ({})),
  openNewWorkItem: vi.fn(async (_type: string, _fields: Record<string, unknown>) => undefined),
};

export const hostNavigation = {
  getHash: vi.fn(async () => fake.hash),
  setHash: vi.fn((hash: string) => void (fake.hash = hash)),
  replaceHash: vi.fn((hash: string) => void (fake.hash = hash)),
  onHashChanged: vi.fn((_cb: (hash: string) => void) => undefined),
  openNewWindow: vi.fn((_url: string, _features: string) => undefined),
  navigate: vi.fn((_url: string) => undefined),
};

export const init = vi.fn(async (_opts?: unknown) => undefined);
export const ready = vi.fn(async () => undefined);
export const notifyLoadSucceeded = vi.fn();
export const notifyLoadFailed = vi.fn();
export const getAccessToken = vi.fn(async () => "test-token");
export const getWebContext = vi.fn(() => ({ project: { id: fake.projectId, name: fake.projectName } }));
/** The signed-in user (fake.user); tests switch users by changing it. */
export const getUser = vi.fn(() => ({ ...fake.user, descriptor: `aad.${fake.user.id}`, imageUrl: "" }));
export const getExtensionContext =vi.fn(() => ({ id: "SAFeADO.safe-ado", publisherId: "SAFeADO", extensionId: "safe-ado" }));

export const getService = vi.fn(async (id: string) => {
  switch (id) {
    case "ms.vss-features.location-service":
      // No trailing slash, to exercise normalisation in the client.
      return { getResourceAreaLocation: async () => fake.baseUrl };
    case "ms.vss-features.extension-data-service":
      return { getExtensionDataManager: async () => dataManager };
    case "ms.vss-work-web.work-item-form-navigation-service":
      return workItemForm;
    case "ms.vss-features.host-navigation-service":
      return hostNavigation;
    default:
      throw new Error(`Unexpected service ${id}`);
  }
});
