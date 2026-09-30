import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCS_URL, extensionVersion, HelpMenu, issueUrl, RELEASES_URL } from "../../src/components/HelpMenu";
import { fake } from "../fakeAdo";
import * as sdk from "../sdkMock";

const defaultContext = sdk.getExtensionContext.getMockImplementation()!;
const opened = () => sdk.hostNavigation.openNewWindow.mock.calls.map((c) => c[0]);

describe("Help menu", () => {
  beforeEach(() => sdk.hostNavigation.openNewWindow.mockClear());
  afterEach(() => sdk.getExtensionContext.mockImplementation(defaultContext));

  const open = (onRestartTour = vi.fn()) => {
    render(<HelpMenu onRestartTour={onRestartTour} />);
    const button = screen.getByRole("button", { name: /Help/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    return { menu: screen.getByRole("menu", { name: "Help" }), onRestartTour, button };
  };

  it("lists the help entries, the keyboard shortcut and the version", () => {
    const { menu } = open();
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent?.trim())).toEqual([
      "Documentation",
      "What's new",
      "Report an issue",
      "Restart tour",
    ]);
    expect(within(menu).getByText("C", { selector: "kbd" })).toBeInTheDocument();
    expect(within(menu).getByText("New work item")).toBeInTheDocument();
    expect(within(menu).getByText("Version dev")).toBeInTheDocument();
  });

  it("opens documentation and release notes in a new tab and closes", async () => {
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Documentation" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(opened()).toEqual([DOCS_URL]));
    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "What's new" }));
    await waitFor(() => expect(opened()).toEqual([DOCS_URL, RELEASES_URL]));
    expect(DOCS_URL).toBe("https://github.com/eslam-sa3d/safe-ado#readme");
    expect(RELEASES_URL).toBe("https://github.com/eslam-sa3d/safe-ado/releases");
  });

  it("prefills an issue with version, host origin and project id only", async () => {
    sdk.getExtensionContext.mockImplementation(() => ({ ...defaultContext(), version: "1.4.2" }));
    open();
    expect(screen.getByText("Version 1.4.2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Report an issue" }));
    await waitFor(() => expect(opened()).toHaveLength(1));
    const url = new URL(opened()[0]);
    expect(url.origin + url.pathname).toBe("https://github.com/eslam-sa3d/safe-ado/issues/new");
    const body = url.searchParams.get("body")!;
    expect(body).toContain("ScaleLane version: 1.4.2");
    expect(body).toContain("Host: https://dev.azure.com");
    expect(body).toContain(`Project id: ${fake.projectId}`);
    expect(body).not.toContain(fake.projectName);
  });

  it("restarts the tour", () => {
    const { onRestartTour } = open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart tour" }));
    expect(onRestartTour).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape, on an outside click and on a second click, but not on inside clicks", () => {
    const { button } = open();
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(button);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("falls back to 'dev' and 'unknown' when the host gives no details", async () => {
    sdk.getExtensionContext.mockImplementation(() => {
      throw new Error("no context");
    });
    expect(extensionVersion()).toBe("dev");
    sdk.getExtensionContext.mockImplementation(defaultContext);
    // A fresh module graph, so the cached collection URL is looked up again (and fails).
    vi.resetModules();
    const freshSdk = (await import("azure-devops-extension-sdk")) as unknown as typeof sdk;
    freshSdk.getService.mockRejectedValueOnce(new Error("no location service"));
    const fresh = await import("../../src/components/HelpMenu");
    const body = new URL(await fresh.issueUrl("9.9.9")).searchParams.get("body")!;
    expect(body).toContain("Host: unknown");
    expect(body).toContain("ScaleLane version: 9.9.9");
  });
});
