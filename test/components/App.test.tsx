import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/components/App";
import { useSafe } from "../../src/components/context";
import { callsTo, dataManager, dataStore, fake, makeConfig, PI1, PI2 } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { PREFS_KEY, renderApp } from "../utils";

const tabs = () => screen.getAllByRole("tab").map((t) => t.textContent);
const prefs = () => JSON.parse(localStorage.getItem(PREFS_KEY())!);

describe("App shell", () => {
  it("shows a spinner while loading, then the portfolio tabs", async () => {
    seed();
    render(<App />);
    expect(screen.getByText("Loading SAFe configuration…")).toBeInTheDocument();
    await screen.findByRole("tab", { name: "Portfolio Kanban" });
    expect(tabs()).toEqual([
      "Reports", "Roadmap", "Portfolio Kanban", "Risks (ROAM)", "Work Item List", "Work Item Hierarchy",
      "My Organization", "PIs & Iterations", "Setup",
    ]);
    expect(screen.getByRole("tab", { name: "Reports" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Portfolio", { selector: ".level-badge" })).toBeInTheDocument();
  });

  it("shows ART/team tabs and a breadcrumb that navigates up", async () => {
    await renderApp({ nodeId: "n-red", view: "objectives" });
    expect(tabs()).toEqual([
      "Reports", "Team Planning Board", "PI Objectives", "Risks (ROAM)", "Work Item List", "Work Item Hierarchy",
      "My Organization", "PIs & Iterations", "Setup",
    ]);
    expect(screen.getByRole("tab", { name: "PI Objectives" })).toHaveAttribute("aria-selected", "true");
    const crumbs = document.querySelector(".breadcrumb") as HTMLElement;
    expect(within(crumbs).getAllByRole("button").map((b) => b.textContent)).toEqual(["Fabrikam", "ART A", "Team Red"]);
    fireEvent.click(within(crumbs).getByRole("button", { name: "ART A" }));
    expect(screen.getByText("Agile Release Train", { selector: ".level-badge" })).toBeInTheDocument();
    expect(prefs().nodeId).toBe("n-arta");
  });

  it("falls back to the first tab (Reports) when the saved view does not exist at this level", async () => {
    await renderApp({ nodeId: "n-root", view: "board" });
    expect(screen.getByRole("tab", { name: "Reports" })).toHaveAttribute("aria-selected", "true");
  });

  it("names the planning board per level and offers the team board only to teams", async () => {
    await renderApp({ nodeId: "n-arta", view: "setup" });
    expect(screen.getByRole("tab", { name: "ART Planning Board" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Team Planning Board" })).toBeNull();
    const config = (await import("../fakeAdo")).makeConfig();
    config.root.children = [{ id: "n-sol", name: "Big Solution", level: "solution", areaPath: "Fabrikam", children: config.root.children }];
    cleanup();
    await renderApp({ nodeId: "n-sol", view: "setup", config });
    expect(screen.getByRole("tab", { name: "Solution Planning Board" })).toBeInTheDocument();
  });

  it("falls back to the root when the saved node no longer exists", async () => {
    await renderApp({ nodeId: "deleted-node", view: "setup" });
    expect(document.querySelector(".header .level-badge")).toHaveTextContent("Portfolio");
  });

  it("selects nodes from the sidebar and persists tab choice", async () => {
    await renderApp({ nodeId: "n-root", view: "kanban" });
    fireEvent.click(within(screen.getByRole("navigation")).getByText("Team Green"));
    await screen.findByRole("tab", { name: "Team Planning Board" });
    fireEvent.click(screen.getByRole("tab", { name: "Reports" }));
    expect(screen.getByRole("tab", { name: "Reports" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "PIs & Iterations" }));
    expect(prefs()).toMatchObject({ nodeId: "n-green", view: "pis" });
  });

  it("defaults to the PI running today and lets the user switch PI", async () => {
    await renderApp({ nodeId: "n-arta", view: "setup" });
    const select = (await screen.findByLabelText("PI")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(PI2));
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringMatching(/^PI 1 \(.+ – .+\)$/),
      expect.stringMatching(/^PI 2 \(/),
    ]);
    fireEvent.change(select, { target: { value: PI1 } });
    expect(select.value).toBe(PI1);
    // The choice is remembered by the PI's stable iteration id, which survives renames.
    expect(prefs().piPath).toBe("iteration-PIs-PI_1");
  });

  it("restores a saved PI selection", async () => {
    await renderApp({ nodeId: "n-arta", view: "setup", piPath: PI1 });
    await waitFor(() => expect((screen.getByLabelText("PI") as HTMLSelectElement).value).toBe(PI1));
  });

  it("falls back to the latest PI when none is running today", async () => {
    const piNodes = fake.iterationTree.children![0].children!;
    piNodes.forEach((pi) => (pi.attributes = { startDate: "2020-01-01T00:00:00Z", finishDate: "2020-02-01T00:00:00Z" }));
    piNodes[0].attributes = { startDate: "2020-03-01T00:00:00Z", finishDate: "2020-04-01T00:00:00Z" }; // PI 2 is later
    await renderApp({ nodeId: "n-arta", view: "setup" });
    await waitFor(() => expect((screen.getByLabelText("PI") as HTMLSelectElement).value).toBe(PI2));
  });

  it("shows the no-PI empty state with a shortcut to PI management", async () => {
    await renderApp({ nodeId: "n-arta", view: "board", config: makeConfig({ piRootIteration: "Fabrikam\\Undated" }) });
    expect(await screen.findByText("No Program Increments found")).toBeInTheDocument();
    expect(screen.getByLabelText("PI")).toBeDisabled();
    expect(screen.getByRole("option", { name: "No PIs yet" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create a PI" }));
    expect(screen.getByRole("heading", { name: "Create a PI" })).toBeInTheDocument();
  });

  it("lists PIs without dates", async () => {
    // A PI root whose children have no dates (the project root has PIs and Undated).
    await renderApp({ nodeId: "n-arta", view: "setup", config: makeConfig({ piRootIteration: "Fabrikam" }) });
    await waitFor(() => expect(screen.getByRole("option", { name: "Undated" })).toBeInTheDocument());
  });

  it("reports a missing PI root instead of treating every iteration as a PI", async () => {
    await renderApp({ nodeId: "n-arta", view: "setup", config: makeConfig({ piRootIteration: "Fabrikam\\Missing" }) });
    expect(await screen.findByText(/The PI root iteration "Fabrikam\\Missing" was not found/)).toBeInTheDocument();
  });

  it("reports PI loading errors", async () => {
    fake.failures.push({ match: /Iterations/, status: 500, message: "iteration service down" });
    await renderApp({ nodeId: "n-arta", view: "setup" });
    expect(await screen.findByText("Could not load PIs: iteration service down")).toBeInTheDocument();
  });

  it("starts in Setup with a banner on first run, and leaves first-run mode after saving", async () => {
    await renderApp({ config: null, view: "board" });
    expect(screen.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/Welcome to SAFe Ado/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Work Item Hierarchy" }));
    expect(screen.getByText(/SAFe Ado is not configured for this project yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(dataStore.values.get("config-p1")).toBeTruthy());
    await waitFor(() => expect(screen.queryByText(/Welcome to SAFe Ado/)).not.toBeInTheDocument());
  });

  it("refreshes the PI picker after creating a PI (end to end)", async () => {
    await renderApp({ nodeId: "n-arta", view: "pis" });
    await screen.findByRole("heading", { name: "Create a PI" });
    await waitFor(() => expect(screen.getByLabelText("PI name")).toHaveValue("PI 3"));
    fireEvent.click(screen.getByRole("button", { name: "Create PI" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /^PI 3 \(/ })).toBeInTheDocument());
  });

  it("renders every view through the shell", async () => {
    await renderApp({ nodeId: "n-arta", view: "risks" });
    expect(await screen.findByRole("group", { name: "Unroamed risks" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "ART Planning Board" }));
    expect(await screen.findByText("Payment API")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "PI Objectives" }));
    expect(await screen.findByText("Planned BV (committed)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Work Item Hierarchy" }));
    expect(await screen.findByPlaceholderText("Filter by title or ID")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Reports" }));
    expect(await screen.findByRole("heading", { name: "PI Predictability" })).toBeInTheDocument();
    for (const tab of ["Roadmap", "Work Item List", "My Organization"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(screen.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    }
    fireEvent.click(screen.getByRole("tab", { name: "Reports" }));
    fireEvent.click(within(screen.getByRole("navigation")).getByText("Team Red"));
    fireEvent.click(screen.getByRole("tab", { name: "Team Planning Board" }));
    expect(screen.getByRole("tab", { name: "Team Planning Board" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(screen.getByRole("navigation")).getByText("Fabrikam"));
    // Reports exists at portfolio level too, so the tab is kept
    expect(screen.getByRole("tab", { name: "Reports" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Portfolio Kanban" }));
    expect(await screen.findByText("3 Epics")).toBeInTheDocument();
  });

  it("opens the unit, view and PI from a deep link and keeps the URL in sync", async () => {
    seed();
    localStorage.setItem(PREFS_KEY(), JSON.stringify({ nodeId: "n-root", view: "reports", piPath: "" }));
    fake.hash = "node=n-blue&view=risks&pi=iteration-PIs-PI_1";
    render(<App />);
    expect(await screen.findByRole("tab", { name: "Risks (ROAM)" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".header .level-badge")).toHaveTextContent("Team");
    await waitFor(() => expect((screen.getByLabelText("PI") as HTMLSelectElement).value).toBe(PI1));
    fireEvent.click(screen.getByRole("tab", { name: "Work Item List" }));
    await waitFor(() => expect(fake.hash).toBe("node=n-blue&view=workitems&pi=iteration-PIs-PI_1"));
  });

  it("reloads every view from the global Refresh button", async () => {
    await renderApp({ nodeId: "n-arta", view: "hierarchy" });
    await screen.findByRole("button", { name: "Payment API" });
    const before = callsTo(/wiql/).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));
    await waitFor(() => expect(callsTo(/wiql/).length).toBeGreaterThan(before));
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
  });

  it("heals a renamed area path on load and saves it for admins", async () => {
    const config = makeConfig();
    await renderApp({ nodeId: "n-arta", view: "setup", config });
    await waitFor(() => expect(dataStore.values.get("config-p1").root.children[0].areaId).toBeTruthy());
    cleanup();
    // Rename ART A in Azure DevOps; the stored id finds it again.
    const artA = fake.areaTree.children![0];
    artA.name = "ART Alpha";
    artA.path = artA.path.replace("ART A", "ART Alpha");
    const fixChildren = (n: typeof artA) => n.children?.forEach((c) => ((c.path = `${n.path}\\${c.name}`), fixChildren(c)));
    fixChildren(artA);
    render(<App />);
    await waitFor(() => expect(dataStore.values.get("config-p1").root.children[0].areaPath).toBe("Fabrikam\\ART Alpha"));
    expect(dataStore.values.get("config-p1").root.children[0].children[0].areaPath).toBe("Fabrikam\\ART Alpha\\Team Red");
  });

  it("does not write healed config for users who can't edit the project", async () => {
    fake.permissions["52d39943-cb85-4d7f-8fa8-c6baac873819/2"] = false;
    await renderApp({ nodeId: "n-arta", view: "setup" });
    await waitFor(() => expect(callsTo(/_apis\/permissions/).length).toBe(3));
    await new Promise((r) => setTimeout(r, 30));
    expect(dataStore.values.get("config-p1").root.children[0].areaId).toBeUndefined();
  });

  it("opens a detached unit from the sidebar", async () => {
    const config = makeConfig();
    config.detached = [{ id: "n-loose", name: "Loose team", level: "team", areaPath: "Fabrikam\\ART B", children: [] }];
    await renderApp({ nodeId: "n-root", view: "reports", config });
    fireEvent.click(within(screen.getByRole("list", { name: "Unattached units" })).getByText("Loose team"));
    await waitFor(() => expect(document.querySelector(".header .level-badge")).toHaveTextContent("Team"));
  });

  it("shows a load error when configuration cannot be read", async () => {
    dataStore.failures.push({ op: "getValue", error: new Error("storage offline") });
    render(<App />);
    expect(await screen.findByText("Could not load SAFe configuration: storage offline")).toBeInTheDocument();
  });

  it("stringifies non-Error load failures", async () => {
    dataStore.failures.push({ op: "getValue", error: "weird" as any });
    render(<App />);
    expect(await screen.findByText("Could not load SAFe configuration: weird")).toBeInTheDocument();
  });

  it("throws a clear error when useSafe is used outside the provider", () => {
    const Probe = () => {
      useSafe();
      return null;
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow("SafeContext missing");
    spy.mockRestore();
  });
});

function seed() {
  dataStore.values.set("config-p1", makeConfig());
}

describe("App shell: help, tour, shortcuts, read-only", () => {
  const PROJECT_WRITE = "52d39943-cb85-4d7f-8fa8-c6baac873819/2";
  const AREA_WRITE = "83e28ad4-2d72-4ceb-97b0-c7726d5502c3/32";
  const tour = () => screen.queryByRole("region", { name: "Guided tour" });

  it("shows the tour for a first-time view and restarts it from the Help menu", async () => {
    await renderApp({ nodeId: "n-arta", view: "organization" });
    expect(await screen.findByRole("region", { name: "Guided tour" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(tour()).toBeNull();
    await waitFor(() => expect(dataStore.values.get(`toursSeen-${fake.projectId}`)).toEqual(["organization"]));
    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart tour" }));
    expect(await screen.findByRole("region", { name: "Guided tour" })).toBeInTheDocument();
  });

  it("does not show the tour on Setup during the first run", async () => {
    await renderApp({ config: null, view: "board" });
    expect(screen.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(dataManager.getValue).toHaveBeenCalledWith(`toursSeen-${fake.projectId}`, expect.anything()));
    await new Promise((r) => setTimeout(r, 20));
    expect(tour()).toBeNull();
  });

  it("offers Open in Azure Boards for the selected unit", async () => {
    sdk.hostNavigation.openNewWindow.mockClear();
    await renderApp({ nodeId: "n-red", view: "organization" });
    fireEvent.click(screen.getByRole("button", { name: "Open in Azure Boards" }));
    await waitFor(() => expect(sdk.hostNavigation.openNewWindow).toHaveBeenCalledWith(`${fake.baseUrl}/Fabrikam/_backlogs/backlog/Team%20Red`, ""));
  });

  it("opens a new work item with 'c' for the selected unit in the current PI", async () => {
    await renderApp({ nodeId: "n-arta", view: "organization" });
    await waitFor(() => expect((screen.getByLabelText("PI") as HTMLSelectElement).value).toBe(PI2));
    fireEvent.keyDown(document.body, { key: "c" });
    await waitFor(() =>
      expect(sdk.workItemForm.openNewWorkItem).toHaveBeenCalledWith("Feature", { "System.AreaPath": "Fabrikam\\ART A", "System.IterationPath": PI2 })
    );
  });

  it("shows a Read-only pill and disables the shortcut without admin and plan rights", async () => {
    fake.permissions[PROJECT_WRITE] = false;
    fake.permissions[AREA_WRITE] = false;
    await renderApp({ nodeId: "n-arta", view: "organization" });
    expect(await screen.findByText("Read-only", { selector: ".readonly-pill" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "c" });
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.workItemForm.openNewWorkItem).not.toHaveBeenCalled();
  });

  it("has no Read-only pill when the user can plan", async () => {
    fake.permissions[PROJECT_WRITE] = false;
    await renderApp({ nodeId: "n-arta", view: "organization" });
    await waitFor(() => expect(callsTo(/_apis\/permissions/).length).toBe(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Read-only", { selector: ".readonly-pill" })).toBeNull();
  });
});
