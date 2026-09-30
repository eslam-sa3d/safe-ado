import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getProgramIncrements } from "../../src/api/wit";
import { LeanPortfolioView } from "../../src/views/LeanPortfolioView";
import { callsTo, dataManager, dataStore, fail, fake, makeConfig, P } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { renderApp, renderView } from "../utils";

const coll = (name: string) => `${name}-${fake.projectId}`;
const seed = (name: string, docs: any[]) => dataStore.collections.set(coll(name), new Map(docs.map((d) => [d.id, { ...d, __etag: 1 }])));
const doc = (name: string, id: string) => dataStore.collections.get(coll(name))?.get(id);
const section = (name: string) => screen.getByRole("region", { name });
const row = (name: string) => within(section("Value stream budgets")).getByText(name, { selector: "td" }).closest("tr") as HTMLElement;
const cells = (r: HTMLElement) => Array.from(r.querySelectorAll("td")).map((td) => td.textContent);
const epicRow = (title: string) => within(section("Epic cost vs. estimate")).getByText(new RegExp(title)).closest("tr") as HTMLElement;

async function pi2Id() {
  const pis = await getProgramIncrements("Fabrikam\\PIs");
  return pis.find((p) => p.name === "PI 2")!;
}

async function renderLean(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<LeanPortfolioView />, { nodeId: "n-root", ...opts });
  await screen.findByRole("region", { name: "Value stream budgets" });
  return r;
}

const rootSettings = (extra: object = {}) => ({ id: "n-root", nodeId: "n-root", costPerPoint: 1000, ...extra });

describe("Lean Portfolio view", () => {
  it("shows a spinner, then value streams with the PI's planned and completed points", async () => {
    await renderView(<LeanPortfolioView />, { nodeId: "n-root" });
    expect(screen.getByText("Loading Lean Portfolio…")).toBeInTheDocument();
    await screen.findByRole("heading", { name: "Value stream budgets · PI 2" });
    expect(Array.from(section("Value stream budgets").querySelectorAll("tbody tr")).map((r) => r.querySelector("td")!.textContent)).toEqual([
      "Fabrikam Portfolio",
      "ART A Agile Release Train",
      "ART B Agile Release Train",
    ]);
    // PI 2 stories: 5 (closed) + 3 + 8 live, 13 removed.
    expect(cells(row("Fabrikam"))).toEqual(["Fabrikam Portfolio", "", "", "16", "5", "No rate", "–", "No budget"]);
    expect(cells(row("ART B")).slice(3, 5)).toEqual(["0", "0"]);
    expect(screen.getByText(/Forecast spend = cost per story point × story points planned in the PI/)).toBeInTheDocument();
    expect(screen.getByText(/Set a cost per story point for Fabrikam/)).toBeInTheDocument();
  });

  it("compares forecast spend with the budget and raises guardrail warnings", async () => {
    const pi = await pi2Id();
    seed("lpmsettings", [rootSettings()]);
    seed("budgets", [
      { id: `n-root|${pi.identifier}`, nodeId: "n-root", piId: pi.identifier, piPath: pi.path, amount: 20000 },
      { id: `n-arta|${pi.identifier}`, nodeId: "n-arta", piId: pi.identifier, piPath: pi.path, amount: 10000 },
      // Found by path (e.g. written before the PI got a new id).
      { id: "legacy", nodeId: "n-artb", piId: "old", piPath: pi.path.toUpperCase(), amount: 15000 },
    ]);
    await renderLean();
    expect(cells(row("Fabrikam")).slice(3)).toEqual(["16", "5", "$16,000", "$5,000", "$4,000 left"]);
    expect(within(row("ART A")).getByText("Over budget")).toHaveClass("budget-over");
    expect(row("ART A")).toHaveClass("over-budget");
    expect(within(row("ART B")).getByText("$15,000 left")).toBeInTheDocument();
    expect(within(row("ART A")).getByLabelText("Rate of ART A")).toHaveAttribute("placeholder", "1000");
    const alerts = within(section("Value stream budgets")).getAllByRole("alert").map((a) => a.textContent);
    expect(alerts).toEqual([
      "Guardrail: ART A forecasts $16,000 in PI 2, over its budget of $10,000.",
      "Guardrail: the budgets under Fabrikam add up to $25,000, more than its own budget of $20,000.",
    ]);
  });

  it("saves, updates and clears a budget for the selected PI", async () => {
    const pi = await pi2Id();
    await renderLean();
    const input = screen.getByLabelText("Budget of ART B");
    fireEvent.change(input, { target: { value: "5000" } });
    fireEvent.blur(input);
    const id = `n-artb|${pi.identifier}`;
    await waitFor(() => expect(doc("budgets", id)).toMatchObject({ nodeId: "n-artb", piId: pi.identifier, piPath: pi.path, amount: 5000, __etag: 1 }));
    fireEvent.change(input, { target: { value: "6000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(doc("budgets", id)).toMatchObject({ amount: 6000, __etag: 2 }));
    // Unchanged value: nothing saved.
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    await waitFor(() => expect(doc("budgets", id)).toBeUndefined());
    expect(dataManager.setDocument).toHaveBeenCalledTimes(2);
    // Clearing a budget that does not exist is a no-op.
    const b = screen.getByLabelText("Budget of ART A");
    fireEvent.change(b, { target: { value: "x" } });
    fireEvent.blur(b);
  });

  it("overrides the inherited rate per value stream", async () => {
    seed("lpmsettings", [rootSettings()]);
    await renderLean();
    const rate = screen.getByLabelText("Rate of ART A");
    fireEvent.change(rate, { target: { value: "2000" } });
    fireEvent.blur(rate);
    await waitFor(() => expect(cells(row("ART A"))[5]).toBe("$32,000"));
    expect(doc("lpmsettings", "n-arta")).toMatchObject({ nodeId: "n-arta", costPerPoint: 2000 });
    expect(cells(row("Fabrikam"))[5]).toBe("$16,000");
  });

  it("switches to cost per team per PI, with actual spend by elapsed PI time", async () => {
    await renderLean();
    fireEvent.change(screen.getByLabelText("Spend model"), { target: { value: "teams" } });
    await waitFor(() => expect(doc("lpmsettings", "n-root")).toMatchObject({ spendModel: "teams" }));
    expect(await screen.findByText("Cost / team / PI")).toBeInTheDocument();
    const rate = screen.getByLabelText("Rate of Fabrikam");
    fireEvent.change(rate, { target: { value: "10000" } });
    fireEvent.blur(rate);
    // 3 teams; PI 2 is 7 of 35 days in (20%).
    await waitFor(() => expect(cells(row("Fabrikam")).slice(3, 7)).toEqual(["3", "5", "$30,000", "$6,000"]));
    expect(cells(row("ART A")).slice(3, 7)).toEqual(["2", "5", "$20,000", "$4,000"]);
    expect(doc("lpmsettings", "n-root")).toMatchObject({ costPerTeamPerPi: 10000, spendModel: "teams" });
    expect(screen.getByText(/Forecast spend = cost per team per PI × teams/)).toBeInTheDocument();
  });

  it("uses the configured currency", async () => {
    seed("lpmsettings", [rootSettings()]);
    await renderLean();
    const currency = screen.getByLabelText("Currency");
    expect(currency).toHaveAttribute("placeholder", "USD");
    fireEvent.change(currency, { target: { value: "eur" } });
    fireEvent.blur(currency);
    await waitFor(() => expect(doc("lpmsettings", "n-root")).toMatchObject({ currency: "EUR", costPerPoint: 1000 }));
    expect(cells(row("Fabrikam"))[5]).toMatch(/€16,000/);
    fireEvent.change(currency, { target: { value: "" } });
    fireEvent.blur(currency);
    await waitFor(() => expect(doc("lpmsettings", "n-root").currency).toBeUndefined());
  });

  it("switches PI with its own picker", async () => {
    await renderLean();
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    fireEvent.change(screen.getByLabelText("PI"), { target: { value: pis.find((p) => p.name === "PI 1")!.identifier } });
    expect(await screen.findByRole("heading", { name: "Value stream budgets · PI 1" })).toBeInTheDocument();
    await waitFor(() => expect(cells(row("Fabrikam")).slice(3, 5)).toEqual(["2", "2"]));
  });

  it("explains that budgets need a PI", async () => {
    await renderView(<LeanPortfolioView />, { nodeId: "n-root", pis: [], pi: null });
    expect(await screen.findByRole("heading", { name: "No Program Increments found" })).toBeInTheDocument();
    expect(screen.getByLabelText("PI")).toBeDisabled();
    expect(screen.getByText("No PIs yet")).toBeInTheDocument();
  });

  it("compares each Epic's cost with its Lean Business Case estimates", async () => {
    seed("lpmsettings", [rootSettings()]);
    seed("leancases", [
      { id: "1", workItemId: 1, mvpCost: 4000, fullCost: 20000, decision: "Go" },
      { id: "2", workItemId: 2, fullCost: 10 },
    ]);
    await renderLean();
    // Epic 1: 16 live points (5 + 3 + 8), 5 completed.
    expect(cells(epicRow("Checkout revamp"))).toEqual(["#1 Checkout revamp", "Go", "5 / 16", "$5,000", "$16,000", "$4,000", "$20,000", "Beyond MVP estimate"]);
    expect(cells(epicRow("Mobile app")).slice(1)).toEqual(["Pending", "0 / 0", "$0", "$0", "–", "$10", "Within estimate"]);
    expect(within(epicRow("Unsized idea")).getByText("No business case")).toBeInTheDocument();
    expect(screen.queryByText(/Dropped/)).toBeNull();
    fireEvent.click(within(epicRow("Checkout revamp")).getByRole("button"));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(1));
  });

  it("shows no Epic costs without a rate", async () => {
    await renderLean();
    expect(cells(epicRow("Checkout revamp")).slice(3, 5)).toEqual(["–", "–"]);
    expect(cells(epicRow("Checkout revamp"))[7]).toBe("–");
  });

  it("says when the portfolio has no Epics", async () => {
    const config = makeConfig();
    config.types.epic = "";
    await renderLean({ config });
    expect(screen.getByText("No Epics in this portfolio.")).toBeInTheDocument();
  });

  it("keeps the portfolio vision and strategic themes", async () => {
    await renderLean();
    expect(screen.getByText("No strategic themes yet.")).toBeInTheDocument();
    const vision = screen.getByLabelText("Portfolio vision");
    fireEvent.change(vision, { target: { value: "  The easiest way to pay  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save vision" }));
    await waitFor(() => expect(doc("lpmsettings", "n-root")).toMatchObject({ vision: "The easiest way to pay" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save vision" })).toBeNull());

    expect(screen.getByRole("button", { name: "Add theme" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Theme name"), { target: { value: "Mobile first" } });
    fireEvent.change(screen.getByLabelText("Theme description"), { target: { value: "Half of revenue on phones" } });
    fireEvent.click(screen.getByRole("button", { name: "Add theme" }));
    await waitFor(() => expect(doc("lpmsettings", "n-root").themes).toHaveLength(1));
    expect(doc("lpmsettings", "n-root").themes[0]).toMatchObject({ name: "Mobile first", description: "Half of revenue on phones" });
    expect(await screen.findByText("Mobile first")).toBeInTheDocument();
    expect(screen.getByLabelText("Theme name")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Theme name"), { target: { value: "Cloud" } });
    fireEvent.click(screen.getByRole("button", { name: "Add theme" }));
    await screen.findByText("Cloud");
    expect(doc("lpmsettings", "n-root").themes[1].description).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Remove theme Mobile first" }));
    await waitFor(() => expect(doc("lpmsettings", "n-root").themes.map((t: any) => t.name)).toEqual(["Cloud"]));
  });

  it("lists Theme work items when a Theme type is mapped", async () => {
    fake.types.push({ name: "Strategic Theme", referenceName: "Custom.Theme" });
    fake.states["Strategic Theme"] = [{ name: "New", category: "Proposed", color: "b2b2b2" }];
    fake.workItems.set(900, { id: 900, rev: 1, fields: { "System.Id": 900, "System.Title": "Go global", "System.WorkItemType": "Strategic Theme", "System.State": "New", "System.AreaPath": P, "System.IterationPath": P } });
    const config = makeConfig();
    config.types.theme = "Strategic Theme";
    await renderLean({ config });
    fireEvent.click(await screen.findByRole("button", { name: "Go global" }));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(900));
    fireEvent.click(screen.getByRole("button", { name: "New Strategic Theme" }));
    await waitFor(() => expect(sdk.workItemForm.openNewWorkItem).toHaveBeenCalledWith("Strategic Theme", { "System.AreaPath": "Fabrikam" }));
    expect(screen.queryByLabelText("Theme name")).toBeNull();
  });

  it("says when no Theme work items exist yet", async () => {
    const config = makeConfig();
    config.types.theme = "Epic";
    fake.workItems.forEach((w) => w.fields["System.WorkItemType"] === "Epic" && (w.fields["System.AreaPath"] = "Elsewhere"));
    await renderLean({ config, can: { plan: false } });
    expect(screen.getByText("No Epic work items in this portfolio yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Epic" })).toBeNull();
  });

  it("is read-only without planning rights", async () => {
    seed("lpmsettings", [rootSettings({ vision: "Grow", themes: [{ id: "t", name: "Cloud" }] })]);
    await renderLean({ can: { plan: false } });
    expect(screen.getByText(/read-only access: the Lean Portfolio can be viewed/)).toBeInTheDocument();
    expect(screen.getByLabelText("Budget of Fabrikam")).toBeDisabled();
    expect(screen.getByLabelText("Spend model")).toBeDisabled();
    expect(screen.getByLabelText("Portfolio vision")).toBeDisabled();
    expect(screen.queryByLabelText("Theme name")).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove theme/ })).toBeNull();
  });

  it("reports failed saves", async () => {
    await renderLean();
    dataStore.failures.push({ op: "setDocument", error: new Error("Denied") });
    fireEvent.change(screen.getByLabelText("Spend model"), { target: { value: "teams" } });
    expect(await screen.findByText("Could not save the portfolio settings: Denied")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dismiss"));

    dataStore.failures.push({ op: "setDocument", error: new Error("Throttled") });
    const b = screen.getByLabelText("Budget of ART A");
    fireEvent.change(b, { target: { value: "1" } });
    fireEvent.blur(b);
    expect(await screen.findByText("Could not save the budget of ART A: Throttled")).toBeInTheDocument();
  });

  it("shows load errors", async () => {
    fail(/wiql/, 500, "Query failed");
    await renderView(<LeanPortfolioView />, { nodeId: "n-root" });
    expect(await screen.findByText("Query failed")).toBeInTheDocument();
  });

  it("reloads on Refresh", async () => {
    await renderLean();
    const before = callsTo(/wiql/).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(callsTo(/wiql/).length).toBeGreaterThan(before));
  });

  it("is a portfolio tab in the hub", async () => {
    await renderApp({ nodeId: "n-root", view: "lean" });
    expect(screen.getByRole("tab", { name: "Lean Portfolio" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("region", { name: "Portfolio canvas" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("tree")).getByText("ART A"));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Lean Portfolio" })).toBeNull());
  });
});

