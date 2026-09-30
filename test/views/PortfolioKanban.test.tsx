import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PortfolioKanban } from "../../src/views/PortfolioKanban";
import { callsTo, dataStore, fail, fake, makeConfig } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { dataTransfer, renderView } from "../utils";

const column = (stage: string) => screen.getByRole("group", { name: `${stage} column` });
const card = (title: string) => screen.getByText(title).closest(".card") as HTMLElement;
const titlesIn = (stage: string) => Array.from(column(stage).querySelectorAll(".card-title")).map((t) => t.textContent);
const coll = (name: string) => `${name}-${fake.projectId}`;
const seed = (name: string, docs: any[]) => dataStore.collections.set(coll(name), new Map(docs.map((d) => [d.id, { ...d, __etag: 1 }])));
const doc = (name: string, id: string) => dataStore.collections.get(coll(name))?.get(id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COMPLETE = { forCustomers: "shoppers", businessOutcomes: "More conversions", mvp: "One-click checkout" };

async function renderKanban(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<PortfolioKanban />, { nodeId: "n-root", ...opts });
  await screen.findByText(/\d+ Epics/);
  return r;
}

describe("Portfolio Kanban", () => {
  it("shows a spinner, then the six SAFe portfolio columns mapped onto Epic states", async () => {
    await renderView(<PortfolioKanban />, { nodeId: "n-root" });
    expect(screen.getByText("Loading portfolio…")).toBeInTheDocument();
    await screen.findByText("3 Epics");
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual([
      "Funnel column",
      "Reviewing column",
      "Analyzing column",
      "Ready column",
      "Implementing column",
      "Done column",
    ]);
    expect(titlesIn("Funnel")).toEqual(["Mobile app", "Unsized idea"]);
    expect(titlesIn("Implementing")).toEqual(["Checkout revamp"]);
    expect(titlesIn("Reviewing")).toEqual([]);
    expect(screen.queryByText("Dropped")).not.toBeInTheDocument();
    // Each header names the Epic state the column sets, coloured like it.
    expect(within(column("Analyzing")).getByText("New")).toHaveClass("kanban-state");
    expect(within(column("Done")).getByText("Closed")).toBeInTheDocument();
    expect(column("Implementing").querySelector(".kanban-header")).toHaveStyle({ borderTopColor: "#007acc" });
  });

  it("puts unmapped states in a column by category and shows the state on the card", async () => {
    fake.workItems.get(3)!.fields["System.State"] = "Resolved";
    await renderKanban();
    expect(titlesIn("Implementing")).toEqual(["Checkout revamp", "Unsized idea"]);
    expect(within(card("Unsized idea")).getByText("Resolved")).toHaveClass("state");
    expect(within(card("Checkout revamp")).queryByText("Active")).toBeNull();
  });

  it("remembers the column per Epic while it still matches the state", async () => {
    seed("leancases", [
      { id: "2", workItemId: 2, stage: "analyzing" },
      // Stale: the Epic is Active now, so its category decides.
      { id: "1", workItemId: 1, stage: "ready" },
    ]);
    await renderKanban();
    expect(titlesIn("Analyzing")).toEqual(["Mobile app"]);
    expect(titlesIn("Implementing")).toEqual(["Checkout revamp"]);
  });

  it("shows WSJF, assignee and the go / no-go decision on cards", async () => {
    seed("leancases", [{ id: "1", workItemId: 1, decision: "Go", decidedBy: "Ada", decidedAt: "2026-01-02T10:00:00Z" }]);
    await renderKanban();
    expect(within(card("Checkout revamp")).getByText("WSJF 1")).toBeInTheDocument();
    expect(within(card("Checkout revamp")).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(card("Checkout revamp")).getByText("Go")).toHaveClass("decision-go");
    expect(within(card("Checkout revamp")).getByText("Go")).toHaveAttribute("title", expect.stringContaining("Decision: Go by Ada on"));
    expect(within(card("Mobile app")).getByText("WSJF 0.3")).toBeInTheDocument();
    expect(within(card("Mobile app")).queryByText("Pending")).toBeNull();
    expect(within(card("Unsized idea")).queryByText(/WSJF/)).toBeNull();
  });

  it("includes RR/OE in cost of delay when the custom field exists, and sorts by WSJF", async () => {
    fake.fields.push({ name: "RR/OE", referenceName: "Custom.RROEValue", type: "integer" });
    Object.assign(fake.workItems.get(3)!.fields, { "Custom.RROEValue": 10, "Microsoft.VSTS.Scheduling.Effort": 5 });
    await renderKanban();
    expect(within(card("Unsized idea")).getByText("WSJF 2")).toBeInTheDocument();
    expect(titlesIn("Funnel")).toEqual(["Mobile app", "Unsized idea"]);
    fireEvent.click(screen.getByLabelText("Sort by WSJF"));
    expect(titlesIn("Funnel")).toEqual(["Unsized idea", "Mobile app"]);
  });

  it("treats a zero cost of delay as unscored", async () => {
    Object.assign(fake.workItems.get(2)!.fields, { "Microsoft.VSTS.Common.BusinessValue": 0, "Microsoft.VSTS.Common.TimeCriticality": 0 });
    await renderKanban();
    expect(within(card("Mobile app")).queryByText(/WSJF/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Sort by WSJF"));
    expect(titlesIn("Funnel")).toEqual(["Mobile app", "Unsized idea"]);
  });

  it("only requests WSJF fields that exist in the process", async () => {
    fake.fields = fake.fields.filter((f) => !/BusinessValue|TimeCriticality|Effort/.test(f.referenceName));
    await renderKanban();
    const fields = callsTo(/workitemsbatch/)[0].body.fields;
    expect(fields).not.toContain("Microsoft.VSTS.Common.BusinessValue");
    expect(fields).not.toContain("Custom.RROEValue");
    expect(screen.queryByText(/WSJF \d/)).not.toBeInTheDocument();
  });

  it("moves between columns that share a state without changing the state", async () => {
    await renderKanban();
    const dt = dataTransfer();
    fireEvent.dragStart(card("Mobile app"), { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith("text/plain", "2");
    fireEvent.dragOver(column("Reviewing"));
    expect(column("Reviewing")).toHaveClass("drop-over");
    fireEvent.drop(column("Reviewing"), { dataTransfer: dataTransfer("2") });
    expect(titlesIn("Reviewing")).toEqual(["Mobile app"]);
    await waitFor(() => expect(doc("leancases", "2")).toMatchObject({ workItemId: 2, stage: "reviewing", decision: "Pending" }));
    expect(callsTo(/workitems\/2$/, "PATCH")).toHaveLength(0);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("changes the Epic state when the column maps to another state", async () => {
    seed("leancases", [{ id: "1", workItemId: 1, stage: "implementing" }]);
    await renderKanban();
    fireEvent.drop(column("Done"), { dataTransfer: dataTransfer("1") });
    expect(titlesIn("Done")).toEqual(["Checkout revamp"]);
    await waitFor(() => expect(callsTo(/workitems\/1$/, "PATCH")).toHaveLength(1));
    expect(callsTo(/workitems\/1$/, "PATCH")[0].body).toEqual([{ op: "add", path: "/fields/System.State", value: "Closed" }]);
    expect(fake.workItems.get(1)!.fields["System.State"]).toBe("Closed");
    await waitFor(() => expect(doc("leancases", "1")).toMatchObject({ stage: "done", __etag: 2 }));
    // Leaving Implementing is not gated.
    expect(confirm).not.toHaveBeenCalled();
  });

  it("guards leaving Analyzing without a Lean Business Case and a Go decision (cancel keeps the Epic)", async () => {
    vi.mocked(confirm).mockReturnValueOnce(false);
    await renderKanban();
    fireEvent.drop(column("Ready"), { dataTransfer: dataTransfer("2") });
    expect(confirm).toHaveBeenCalledWith(
      "#2 is leaving Analyzing without an Epic hypothesis statement, business outcomes, an MVP definition, a Go decision. SAFe requires a Lean Business Case and a Go decision first. Move it anyway?"
    );
    await sleep(20);
    expect(titlesIn("Funnel")).toContain("Mobile app");
    expect(doc("leancases", "2")).toBeUndefined();
  });

  it("lets the guardrail be overridden, and moves a Go Epic without asking", async () => {
    seed("leancases", [{ id: "3", workItemId: 3, ...COMPLETE, decision: "Go" }]);
    await renderKanban();
    fireEvent.drop(column("Implementing"), { dataTransfer: dataTransfer("2") });
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fake.workItems.get(2)!.fields["System.State"]).toBe("Active"));
    vi.mocked(confirm).mockClear();
    fireEvent.drop(column("Ready"), { dataTransfer: dataTransfer("3") });
    await waitFor(() => expect(doc("leancases", "3")).toMatchObject({ stage: "ready", decision: "Go" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(callsTo(/workitems\/3$/, "PATCH")).toHaveLength(0);
  });

  it("names only what is missing when the case is written but not decided", async () => {
    seed("leancases", [{ id: "2", workItemId: 2, ...COMPLETE, decision: "Pivot" }]);
    await renderKanban();
    fireEvent.drop(column("Ready"), { dataTransfer: dataTransfer("2") });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/^#2 is leaving Analyzing without a Go decision\./));
  });

  it("ignores drops onto the same column or with unknown ids", async () => {
    await renderKanban();
    fireEvent.dragOver(column("Funnel"));
    fireEvent.dragLeave(column("Funnel"));
    expect(column("Funnel")).not.toHaveClass("drop-over");
    fireEvent.drop(column("Funnel"), { dataTransfer: dataTransfer("2") });
    fireEvent.drop(column("Funnel"), { dataTransfer: dataTransfer("999") });
    await sleep(20);
    expect(callsTo(/workitems/, "PATCH")).toHaveLength(0);
    expect(dataStore.collections.get(coll("leancases"))).toBeUndefined();
  });

  it("reports failed moves", async () => {
    fail(/workitems\/1$/, 400, "Transition not allowed", { method: "PATCH" });
    await renderKanban();
    fireEvent.drop(column("Done"), { dataTransfer: dataTransfer("1") });
    expect(await screen.findByText("Could not move #1: Transition not allowed")).toBeInTheDocument();
    expect(doc("leancases", "1")).toBeUndefined();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText(/Could not move/)).not.toBeInTheDocument();
  });

  it("reports a failed column save", async () => {
    dataStore.failures.push({ op: "setDocument", error: new Error("Data service down") });
    await renderKanban();
    fireEvent.drop(column("Reviewing"), { dataTransfer: dataTransfer("2") });
    expect(await screen.findByText("Could not move #2: Data service down")).toBeInTheDocument();
  });

  it("shows WIP limits, flags columns over the limit and confirms moves into a full column", async () => {
    seed("lpmsettings", [{ id: "n-root", nodeId: "n-root", wipLimits: { funnel: 1, implementing: 1, analyzing: 2 } }]);
    await renderKanban();
    expect(column("Funnel")).toHaveClass("wip-over");
    expect(within(column("Funnel")).getByTitle("WIP limit 1")).toHaveTextContent("2/1");
    expect(within(column("Analyzing")).getByTitle("WIP limit 2")).toHaveTextContent("0/2");
    expect(within(column("Ready")).getByTitle("No WIP limit")).toHaveTextContent("0");
    expect(column("Implementing")).not.toHaveClass("wip-over");
    expect(screen.getByRole("status")).toHaveTextContent("WIP limit exceeded: Funnel has 2 (limit 1).");

    vi.mocked(confirm).mockReturnValue(false);
    fireEvent.drop(column("Implementing"), { dataTransfer: dataTransfer("2") });
    // Guardrail first, then the WIP limit.
    expect(confirm).toHaveBeenCalledTimes(1);
    vi.mocked(confirm).mockReturnValueOnce(true).mockReturnValueOnce(false);
    fireEvent.drop(column("Implementing"), { dataTransfer: dataTransfer("2") });
    expect(confirm).toHaveBeenLastCalledWith("Implementing is at its WIP limit (1). Move #2 anyway?");
    await sleep(20);
    expect(titlesIn("Implementing")).toEqual(["Checkout revamp"]);
    vi.mocked(confirm).mockReturnValue(true);
  });

  it("configures the column states and WIP limits per portfolio", async () => {
    await renderKanban();
    fireEvent.click(screen.getByRole("button", { name: "Columns & WIP" }));
    const dialog = screen.getByRole("dialog", { name: "Portfolio Kanban columns" });
    expect(within(dialog).getByLabelText("Funnel state")).toHaveValue("New");
    expect(within(dialog).getByLabelText("Implementing state")).toHaveValue("Active");
    fireEvent.change(within(dialog).getByLabelText("Ready state"), { target: { value: "Resolved" } });
    fireEvent.change(within(dialog).getByLabelText("Analyzing WIP limit"), { target: { value: "3" } });
    fireEvent.change(within(dialog).getByLabelText("Done WIP limit"), { target: { value: "0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(doc("lpmsettings", "n-root")).toMatchObject({
      nodeId: "n-root",
      stageStates: { funnel: "New", ready: "Resolved", implementing: "Active", done: "Closed" },
      wipLimits: { analyzing: 3 },
    });
    expect(doc("lpmsettings", "n-root").wipLimits.done).toBeUndefined();
    expect(within(column("Analyzing")).getByTitle("WIP limit 3")).toHaveTextContent("0/3");
    expect(within(column("Ready")).getByText("Resolved")).toBeInTheDocument();
  });

  it("ignores a configured state the process no longer has, and cancels or reports failed column saves", async () => {
    seed("lpmsettings", [{ id: "n-root", nodeId: "n-root", stageStates: { funnel: "Gone", reviewing: "Active" } }]);
    await renderKanban();
    expect(within(column("Funnel")).getByText("New")).toBeInTheDocument();
    expect(titlesIn("Reviewing")).toEqual(["Checkout revamp"]);
    fireEvent.click(screen.getByRole("button", { name: "Columns & WIP" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    dataStore.failures.push({ op: "setDocument", error: new Error("Conflict") });
    fireEvent.click(screen.getByRole("button", { name: "Columns & WIP" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not save the columns: Conflict")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByLabelText("Dismiss"));
    expect(screen.queryByText(/Could not save the columns/)).toBeNull();
  });

  it("edits an Epic's Lean Business Case from its card", async () => {
    await renderKanban();
    fireEvent.click(within(card("Mobile app")).getByRole("button", { name: "Business case of #2" }));
    expect(sdk.workItemForm.openWorkItem).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Lean Business Case: #2 Mobile app" });
    expect(within(dialog).getByText(/still needs an Epic hypothesis statement, business outcomes, an MVP definition/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Epic Owner"), { target: { value: "Grace" } });
    fireEvent.change(within(dialog).getByLabelText("Hypothesis: For"), { target: { value: "commuters" } });
    fireEvent.change(within(dialog).getByLabelText("Hypothesis: our solution"), { target: { value: "works offline" } });
    fireEvent.change(within(dialog).getByLabelText("Business outcomes"), { target: { value: "20% mobile orders" } });
    fireEvent.change(within(dialog).getByLabelText("Leading indicators"), { target: { value: "Daily actives" } });
    fireEvent.change(within(dialog).getByLabelText("Non-functional requirements"), { target: { value: "WCAG AA" } });
    fireEvent.change(within(dialog).getByLabelText("MVP definition"), { target: { value: "Browse and pay" } });
    fireEvent.change(within(dialog).getByLabelText("MVP cost estimate"), { target: { value: "50000" } });
    fireEvent.change(within(dialog).getByLabelText("Full cost estimate"), { target: { value: "-1" } });
    fireEvent.change(within(dialog).getByLabelText("Go / no-go decision"), { target: { value: "Go" } });
    expect(within(dialog).getByText(/Go decided by Ada Lovelace on/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/still needs/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save business case" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const saved = doc("leancases", "2");
    expect(saved).toMatchObject({
      workItemId: 2,
      epicOwner: "Grace",
      forCustomers: "commuters",
      ourSolution: "works offline",
      businessOutcomes: "20% mobile orders",
      leadingIndicators: "Daily actives",
      nfrs: "WCAG AA",
      mvp: "Browse and pay",
      mvpCost: 50000,
      decision: "Go",
      decidedBy: "Ada Lovelace",
    });
    expect(saved.fullCost).toBeUndefined();
    expect(saved.decidedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(within(card("Mobile app")).getByText("Go")).toBeInTheDocument();

    // Now the gate lets it through without asking.
    fireEvent.drop(column("Ready"), { dataTransfer: dataTransfer("2") });
    await waitFor(() => expect(doc("leancases", "2")).toMatchObject({ stage: "ready", epicOwner: "Grace" }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps who decided when the decision is unchanged, and clears emptied fields", async () => {
    seed("leancases", [{ id: "1", workItemId: 1, decision: "No-go", decidedBy: "Bob", decidedAt: "2026-01-02T10:00:00Z", epicOwner: "Old", mvpCost: 10 }]);
    await renderKanban();
    fireEvent.click(within(card("Checkout revamp")).getByRole("button", { name: "Business case of #1" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/No-go decided by Bob on/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Epic Owner"), { target: { value: "" } });
    fireEvent.change(within(dialog).getByLabelText("MVP cost estimate"), { target: { value: "" } });
    fireEvent.change(within(dialog).getByLabelText("Go / no-go decision"), { target: { value: "No-go" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save business case" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(doc("leancases", "1")).toMatchObject({ decision: "No-go", decidedBy: "Bob", decidedAt: "2026-01-02T10:00:00Z" });
    expect(doc("leancases", "1").epicOwner).toBeUndefined();
    expect(doc("leancases", "1").mvpCost).toBeUndefined();
  });

  it("reports a failed business case save and closes the dialog on Cancel", async () => {
    dataStore.failures.push({ op: "setDocument", error: new Error("Quota exceeded") });
    await renderKanban();
    fireEvent.click(within(card("Mobile app")).getByRole("button", { name: "Business case of #2" }));
    fireEvent.click(screen.getByRole("button", { name: "Save business case" }));
    expect(await screen.findByText("Could not save the business case: Quota exceeded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the business case read-only without planning rights", async () => {
    seed("leancases", [{ id: "2", workItemId: 2, mvp: "Browse", mvpCost: 1000 }]);
    await renderKanban({ can: { plan: false } });
    expect(screen.queryByRole("button", { name: "Columns & WIP" })).toBeNull();
    fireEvent.click(within(card("Mobile app")).getByRole("button", { name: "Business case of #2" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("MVP definition")).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Save business case" })).toBeNull();
    fireEvent.click(within(dialog).getByText("Close", { selector: "button.btn" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens epics, creates new ones in the portfolio area, and refreshes", async () => {
    await renderKanban();
    fireEvent.click(card("Checkout revamp"));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(1));

    fireEvent.click(screen.getByRole("button", { name: "New Epic" }));
    await waitFor(() => expect(sdk.workItemForm.openNewWorkItem).toHaveBeenCalledWith("Epic", { "System.AreaPath": "Fabrikam" }));

    const before = callsTo(/wiql/).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(callsTo(/wiql/).length).toBe(before + 1));
  });

  it("explains when no Epic type is mapped", async () => {
    const config = makeConfig();
    config.types.epic = "";
    await renderView(<PortfolioKanban />, { nodeId: "n-root", config });
    expect(await screen.findByRole("heading", { name: "No Epic type mapped" })).toBeInTheDocument();
  });

  it("shows load errors", async () => {
    fail(/wiql/, 500, "Query failed");
    await renderView(<PortfolioKanban />, { nodeId: "n-root" });
    expect(await screen.findByText("Query failed")).toBeInTheDocument();
    expect(screen.getByText("0 Epics")).toBeInTheDocument();
  });
});
