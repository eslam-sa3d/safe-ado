import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * hub.tsx runs on import, so each test resets the module registry and grabs the fresh
 * SDK mock instance that the re-imported hub will use.
 */
async function freshSdk() {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  return (await import("azure-devops-extension-sdk")) as unknown as typeof import("../sdkMock");
}

describe("hub entry point", () => {
  it("initialises the SDK with theming, renders, then notifies success", async () => {
    const sdk = await freshSdk();
    await import("../../src/hub/hub");
    await waitFor(() => expect(sdk.notifyLoadSucceeded).toHaveBeenCalled());
    expect(sdk.init).toHaveBeenCalledWith({ loaded: false, applyTheme: true });
    expect(sdk.ready).toHaveBeenCalled();
    expect(sdk.notifyLoadFailed).not.toHaveBeenCalled();
    expect(await screen.findByRole("navigation", { name: "SAFe hierarchy" })).toBeInTheDocument();
  });

  it("reports load failure to the host and the page", async () => {
    const sdk = await freshSdk();
    sdk.ready.mockRejectedValueOnce(new Error("handshake failed"));
    await import("../../src/hub/hub");
    await waitFor(() => expect(sdk.notifyLoadFailed).toHaveBeenCalled());
    expect(sdk.notifyLoadSucceeded).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("ScaleLane failed to load: handshake failed");
  });

  it("handles non-Error failures", async () => {
    const sdk = await freshSdk();
    sdk.init.mockRejectedValueOnce("timeout");
    await import("../../src/hub/hub");
    await waitFor(() => expect(document.body.textContent).toBe("ScaleLane failed to load: timeout"));
  });
});
