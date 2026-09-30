import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type SdkMock = typeof import("../sdkMock") & { register: ReturnType<typeof vi.fn>; getContributionId: ReturnType<typeof vi.fn> };

/**
 * form.tsx runs on import. The shared SDK mock has no register/getContributionId, so this
 * file extends it for the fresh module registry each test uses.
 */
async function freshSdk(): Promise<SdkMock> {
  vi.resetModules();
  vi.doMock("azure-devops-extension-sdk", async () => ({
    ...(await import("../sdkMock")),
    register: vi.fn(),
    getContributionId: vi.fn(() => "ScaleLane.scalelane.safe-work-item-form-group"),
  }));
  document.body.innerHTML = '<div id="root"></div>';
  return (await import("azure-devops-extension-sdk")) as unknown as SdkMock;
}

describe("form entry point", () => {
  it("initialises the SDK, registers the form listener, renders and notifies success", async () => {
    const sdk = await freshSdk();
    await import("../../src/form/form");
    await waitFor(() => expect(sdk.notifyLoadSucceeded).toHaveBeenCalled());
    expect(sdk.init).toHaveBeenCalledWith({ loaded: false, applyTheme: true });
    expect(sdk.register).toHaveBeenCalledWith("ScaleLane.scalelane.safe-work-item-form-group", expect.objectContaining({ onLoaded: expect.any(Function) }));
    expect(sdk.notifyLoadFailed).not.toHaveBeenCalled();
    await waitFor(() => expect(document.getElementById("root")!.textContent).not.toBe(""));
  });

  it("reports load failure to the host and the page", async () => {
    const sdk = await freshSdk();
    sdk.ready.mockRejectedValueOnce(new Error("handshake failed"));
    await import("../../src/form/form");
    await waitFor(() => expect(sdk.notifyLoadFailed).toHaveBeenCalled());
    expect(sdk.register).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("ScaleLane failed to load: handshake failed");
  });

  it("handles non-Error failures", async () => {
    const sdk = await freshSdk();
    sdk.init.mockRejectedValueOnce("timeout");
    await import("../../src/form/form");
    await waitFor(() => expect(document.body.textContent).toBe("ScaleLane failed to load: timeout"));
  });
});
