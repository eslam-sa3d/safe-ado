import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/components/App";
import { useSafe } from "../../src/components/context";
import { dataStore, fake, makeConfig, PI1, PI2 } from "../fakeAdo";
import { PREFS_KEY, renderApp } from "../utils";

const tabs = () => screen.getAllByRole("tab").map((t) => t.textContent);
const prefs = () => JSON.parse(localStorage.getItem(PREFS_KEY())!);

describe("App shell", () => {
  it("shows a spinner while loading, then the portfolio tabs", async () => {
    seed();
    render(<App />);
    expect(screen.getByText("Loading SAFe configuration…")).toBeInTheDocument();
    await screen.findByRole("tab", { name: "Portfolio Kanban" });
    expect(tabs()).toEqual(["Portfolio Kanban", "Work Item Hierarchy", "Risks (ROAM)", "Reports", "PIs & Iterations", "Setup"]);
    expect(screen.getByText("Portfolio", { selector: ".level-badge" })).toBeInTheDocument();
  });

  it("shows ART/team tabs and a breadcrumb that navigates up", async () => {
    await renderApp({ nodeId: "n-red", view: "objectives" });
    expect(tabs()).toEqual(["Program Board", "PI Objectives", "Risks (ROAM)", "Work Item Hierarchy", "Reports", "PIs & Iterations", "Setup"]);
    expect(screen.getByRole("tab", { name: "PI Objectives" })).toHaveAttribute("aria-selected", "true");
    const crumbs = document.querySelector(".breadcrumb") as HTMLElement;
    expect(within(crumbs).getAllByRole("button").map((b) => b.textContent)).toEqual(["Fabrikam", "ART A", "Team Red"]);
    fireEvent.click(within(crumbs).getByRole("button", { name: "ART A" }));
    expect(screen.getByText("Agile Release Train", { selector: ".level-badge" })).toBeInTheDocument();
    expect(prefs().nodeId).toBe("n-arta");
  });

  it("falls back to the first tab when the saved view does not exist at this level", async () => {
    await renderApp({ nodeId: "n-root", view: "board" });
    expect(screen.getByRole("tab", { name: "Portfolio Kanban" })).toHaveAttribute("aria-selected", "true");
  });

  it("falls back to the root when the saved node no longer exists", async () => {
    await renderApp({ nodeId: "deleted-node", view: "setup" });
    expect(document.querySelector(".header .level-badge")).toHaveTextContent("Portfolio");
  });

  it("selects nodes from the sidebar and persists tab choice", async () => {
    await renderApp({ nodeId: "n-root", view: "kanban" });
    fireEvent.click(within(screen.getByRole("navigation")).getByText("Team Green"));
    await screen.findByRole("tab", { name: "Program Board" });
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
    expect(prefs().piPath).toBe(PI1);
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
    await renderApp({ nodeId: "n-arta", view: "setup", config: makeConfig({ piRootIteration: "Fabrikam\\Missing" }) });
    await waitFor(() => expect(screen.getByRole("option", { name: "Undated" })).toBeInTheDocument());
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
    fireEvent.click(screen.getByRole("tab", { name: "Program Board" }));
    expect(await screen.findByText("Payment API")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "PI Objectives" }));
    expect(await screen.findByText("Planned BV (committed)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Work Item Hierarchy" }));
    expect(await screen.findByPlaceholderText("Filter by title or ID")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Reports" }));
    expect(await screen.findByRole("heading", { name: "PI Predictability" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("navigation")).getByText("Fabrikam"));
    // Reports exists at portfolio level too, so the tab is kept
    expect(screen.getByRole("tab", { name: "Reports" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Portfolio Kanban" }));
    expect(await screen.findByText("3 Epics")).toBeInTheDocument();
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
