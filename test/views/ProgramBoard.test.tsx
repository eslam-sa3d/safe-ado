import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProgramIncrement } from "../../src/api/types";
import { ProgramBoard } from "../../src/views/ProgramBoard";
import { ART_A, ART_B, BLUE, callsTo, dataStore, fail, fake, GREEN, makeConfig, PI1_S1, PI2, PI2_IP, PI2_S1, PI2_S2, RED } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { dataTransfer, renderView } from "../utils";

const rowTitles = () => Array.from(document.querySelectorAll(".board-row-header .row-title span")).map((h) => h.textContent);
const cell = (name: string) => screen.getByRole("group", { name });
const card = (title: string) => screen.getByText(title).closest(".card") as HTMLElement;

async function renderBoard(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<ProgramBoard />, opts);
  await waitFor(() => expect(screen.queryByText("Loading program board…")).not.toBeInTheDocument());
  return r;
}

function drag(title: string, target: string, payload?: string) {
  const dt = dataTransfer();
  fireEvent.dragStart(card(title), { dataTransfer: dt });
  const id = payload ?? dt.setData.mock.calls[0][1];
  fireEvent.dragOver(cell(target), { dataTransfer: dt });
  fireEvent.drop(cell(target), { dataTransfer: dataTransfer(id) });
}

describe("ART Planning Board — feature iteration mode", () => {
  beforeEach(() => localStorage.setItem("safe-ado-artboard-placement", JSON.stringify("feature")));

  it("shows a spinner, then features placed by team row and iteration column", async () => {
    await renderView(<ProgramBoard />);
    expect(screen.getByText("Loading program board…")).toBeInTheDocument();
    await screen.findByText("Payment API");

    expect(Array.from(document.querySelectorAll(".board-col-header")).map((h) => h.firstChild!.textContent)).toEqual([
      "PI Backlog",
      "PI 2 Sprint 1",
      "PI 2 Sprint 2",
      "PI 2 IP",
    ]);
    expect(rowTitles()).toEqual([
      "Team Red",
      "Team Blue",
      "Unassigned",
    ]);
    expect(within(cell("Team Red / PI 2 Sprint 1")).getByText("Payment API")).toBeInTheDocument();
    expect(within(cell("Team Blue / PI 2 Sprint 2")).getByText("Checkout UI")).toBeInTheDocument();
    expect(within(cell("Team Blue / PI 2 Sprint 1")).getByText("Wallet")).toBeInTheDocument();
    // ART-level feature without a team, scheduled only to the PI
    expect(within(cell("Unassigned / PI Backlog")).getByText("Fraud rules")).toBeInTheDocument();
    // Removed and other-ART / other-PI features are excluded
    expect(screen.queryByText("Legacy cleanup")).not.toBeInTheDocument();
    // Other-ART features only appear as EXTERNAL dependency partners
    expect(screen.getByText("Reports").closest(".card")).toHaveClass("ab-external-card");
    expect(screen.queryByText("Old feature")).not.toBeInTheDocument();

    const wiql = callsTo(/wiql/)[0].body.query;
    expect(wiql).toContain(`[System.AreaPath] UNDER '${ART_A}'`);
    expect(wiql).toContain(`[System.IterationPath] UNDER '${PI2}'`);
  });

  it("summarises items, dependencies and critical ones; shows card metadata", async () => {
    await renderBoard();
    expect(screen.getByText(/4 items · 4 dependencies/)).toBeInTheDocument();
    expect(screen.getByText("· 1 critical")).toBeInTheDocument();
    const payment = card("Payment API");
    expect(within(payment).getByText("#10")).toBeInTheDocument();
    expect(within(payment).getByText("Active")).toBeInTheDocument();
    expect(within(payment).getByText("8 pts")).toBeInTheDocument();
    // Successor to feature 20 on another ART counts as external
    expect(within(payment).getByTitle("Dependencies on items outside this board")).toHaveTextContent(/^\s*1$/);
    expect(within(card("Wallet")).queryByTitle("Dependencies on items outside this board")).toBeNull();
    expect(payment).toHaveAttribute("title", "Feature #10: Payment API");
  });

  it("draws dependency lines with Agile Hive criticality", async () => {
    await renderBoard();
    const lines = Array.from(document.querySelectorAll("path.dep-line"));
    const byKey = Object.fromEntries(lines.map((l) => [l.querySelector("title")!.textContent!.split("\n")[0].trim(), l.getAttribute("class")]));
    expect(byKey["#10 → #11 (Healthy)"]).toBe("dep-line healthy");
    expect(byKey["#12 → #10 (At risk)"]).toBe("dep-line atRisk");
    expect(byKey["#11 → #14 (Critical) — consumer is planned before its provider"]).toBe("dep-line critical");
    // #20 sits on another ART: drawn to its EXTERNAL card
    expect(byKey["#10 → #20 (Healthy)"]).toBe("dep-line healthy external");
    expect(lines).toHaveLength(4);
    expect(lines[0].querySelector("title")!.textContent).toContain("Click to remove");
  });

  it("flags same-iteration dependencies as at risk", async () => {
    fake.workItems.get(14)!.fields["System.IterationPath"] = PI2_S2;
    await renderBoard();
    const line = Array.from(document.querySelectorAll("path.dep-line")).find((l) => l.textContent!.startsWith("#11 → #14"));
    expect(line).toHaveClass("atRisk");
    expect(screen.queryByText(/· \d+ critical/)).not.toBeInTheDocument();
  });

  it("routes lines backwards when the successor sits to the left", async () => {
    const x: Record<string, number> = { "10": 200, "11": 400, "12": 0, "14": 100 };
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const id = /#(\d+):/.exec(this.getAttribute("title") ?? "")?.[1];
      const left = id ? x[id] : 0;
      return { left, top: 10, width: 50, height: 20, right: left + 50, bottom: 30, x: left, y: 10, toJSON() {} } as DOMRect;
    });
    await renderBoard();
    const conflict = document.querySelector("path.dep-line.critical")!;
    // from card 11's left edge (400) to card 14's right edge (150)
    expect(conflict.getAttribute("d")).toMatch(/^M400,10 C.* 150,10$/);
    const ok = document.querySelector("path.dep-line.healthy")!;
    expect(ok.getAttribute("d")).toMatch(/^M250,10 C.* 400,10$/);
    spy.mockRestore();
  });

  it("hides dependency lines when toggled off", async () => {
    await renderBoard();
    fireEvent.click(screen.getByLabelText("Show dependencies"));
    expect(document.querySelector("svg.dep-layer")).toBeNull();
  });

  it("moves a card to another team and iteration by drag and drop", async () => {
    await renderBoard();
    drag("Wallet", "Team Red / PI 2 Sprint 2");
    // optimistic update
    expect(within(cell("Team Red / PI 2 Sprint 2")).getByText("Wallet")).toBeInTheDocument();
    await waitFor(() => expect(callsTo(/workitems\/14/, "PATCH")).toHaveLength(1));
    expect(callsTo(/workitems\/14/, "PATCH")[0].body).toEqual([
      { op: "add", path: "/fields/System.AreaPath", value: RED },
      { op: "add", path: "/fields/System.IterationPath", value: PI2_S2 },
    ]);
    expect(fake.workItems.get(14)!.fields["System.AreaPath"]).toBe(RED);
  });

  it("only changes the iteration when dropped within the same row or onto Unassigned", async () => {
    await renderBoard();
    drag("Payment API", "Team Red / PI 2 IP");
    await waitFor(() => expect(callsTo(/workitems\/10/, "PATCH")).toHaveLength(1));
    expect(callsTo(/workitems\/10/, "PATCH")[0].body).toEqual([
      { op: "add", path: "/fields/System.IterationPath", value: "Fabrikam\\PIs\\PI 2\\PI 2 IP" },
    ]);

    drag("Fraud rules", "Unassigned / PI 2 Sprint 1");
    await waitFor(() => expect(callsTo(/workitems\/12/, "PATCH")).toHaveLength(1));
    expect(callsTo(/workitems\/12/, "PATCH")[0].body).toEqual([{ op: "add", path: "/fields/System.IterationPath", value: PI2_S1 }]);
  });

  it("moves an unscheduled card back from a sprint to the PI backlog", async () => {
    await renderBoard();
    drag("Wallet", "Team Blue / PI Backlog");
    await waitFor(() => expect(callsTo(/workitems\/14/, "PATCH")).toHaveLength(1));
    expect(callsTo(/workitems\/14/, "PATCH")[0].body).toEqual([{ op: "add", path: "/fields/System.IterationPath", value: PI2 }]);
  });

  it("ignores drops that change nothing, have no payload, or reference unknown items", async () => {
    await renderBoard();
    drag("Payment API", "Team Red / PI 2 Sprint 1");
    fireEvent.drop(cell("Team Red / PI 2 Sprint 2"), { dataTransfer: dataTransfer("") });
    fireEvent.drop(cell("Team Red / PI 2 Sprint 2"), { dataTransfer: dataTransfer("999") });
    await new Promise((r) => setTimeout(r, 20));
    expect(callsTo(/workitems\/\d+$/, "PATCH")).toHaveLength(0);
  });

  it("highlights the drop target while dragging over it", async () => {
    await renderBoard();
    const target = cell("Team Blue / PI 2 IP");
    fireEvent.dragOver(target);
    expect(target).toHaveClass("drop-over");
    fireEvent.dragLeave(target);
    expect(target).not.toHaveClass("drop-over");
  });

  it("shows an error when a move fails and lets the user dismiss it", async () => {
    fail(/workitems\/14/, 400, "Rule violation", { method: "PATCH" });
    await renderBoard();
    drag("Wallet", "Team Red / PI 2 Sprint 2");
    expect(await screen.findByText("Could not move #14: Rule violation")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText(/Could not move/)).not.toBeInTheDocument();
  });

  it("opens the work item form on card click and refreshes afterwards", async () => {
    await renderBoard();
    const before = callsTo(/wiql/).length;
    fireEvent.click(card("Payment API"));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(10));
    await waitFor(() => expect(callsTo(/wiql/).length).toBeGreaterThan(before));
  });

  it("creates dependencies in link mode (predecessor, then successor)", async () => {
    await renderBoard();
    const button = screen.getByRole("button", { name: "Add dependency" });
    fireEvent.click(button);
    expect(button).toHaveTextContent("Select predecessor…");
    fireEvent.click(card("Fraud rules"));
    expect(button).toHaveTextContent("Select successor of #12…");
    expect(card("Fraud rules")).toHaveClass("selected");
    fireEvent.click(card("Fraud rules")); // same card: ignored
    fireEvent.click(card("Wallet"));
    await waitFor(() => expect(callsTo(/workitems\/12/, "PATCH")).toHaveLength(1));
    expect(callsTo(/workitems\/12/, "PATCH")[0].body[0].value).toMatchObject({
      rel: "System.LinkTypes.Dependency-Forward",
      url: "https://dev.azure.com/org/_apis/wit/workItems/14",
      attributes: { comment: "Program board dependency" },
    });
    await waitFor(() => expect(button).toHaveTextContent("Select predecessor…"));
    expect(sdk.workItemForm.openWorkItem).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(button).toHaveTextContent("Add dependency");
  });

  it("reports link failures", async () => {
    fail(/workitems\/12/, 400, "Link exists", { method: "PATCH" });
    await renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Add dependency" }));
    fireEvent.click(card("Fraud rules"));
    fireEvent.click(card("Wallet"));
    expect(await screen.findByText("Could not add dependency: Link exists")).toBeInTheDocument();
  });

  it("removes a dependency after confirmation", async () => {
    // Azure DevOps keeps both link ends in sync; the fake only stores what we give it.
    const wallet = fake.workItems.get(14)!;
    wallet.relations = wallet.relations!.filter((r) => !r.rel.includes("Dependency"));
    await renderBoard();
    const conflict = document.querySelector("path.dep-line.critical")!;
    fireEvent.click(conflict);
    expect(window.confirm).toHaveBeenCalledWith("Remove dependency #11 → #14?");
    await waitFor(() => expect(callsTo(/workitems\/11/, "PATCH")).toHaveLength(1));
    await waitFor(() => expect(document.querySelector("path.dep-line.critical")).toBeNull());
  });

  it("keeps the dependency when the user cancels", async () => {
    (window.confirm as any).mockReturnValueOnce(false);
    await renderBoard();
    fireEvent.click(document.querySelector("path.dep-line.critical")!);
    await new Promise((r) => setTimeout(r, 20));
    expect(callsTo(/workitems/, "PATCH")).toHaveLength(0);
  });

  it("reports failures removing a dependency", async () => {
    fail(/workitems\/11/, 403, "No permission", { method: "PATCH" });
    await renderBoard();
    fireEvent.click(document.querySelector("path.dep-line.critical")!);
    expect(await screen.findByText("Could not remove dependency: No permission")).toBeInTheDocument();
  });

  it("creates new items pre-filled with the cell's area and iteration", async () => {
    await renderBoard();
    fireEvent.click(within(cell("Team Blue / PI 2 IP")).getByTitle("New item here"));
    await waitFor(() =>
      expect(sdk.workItemForm.openNewWorkItem).toHaveBeenCalledWith("Feature", {
        "System.AreaPath": BLUE,
        "System.IterationPath": "Fabrikam\\PIs\\PI 2\\PI 2 IP",
      })
    );
    expect(within(cell("Unassigned / PI Backlog")).queryByTitle("New item here")).toBeNull();
  });

  it("falls back to the scope area for new items in rows without an area path", async () => {
    const config = makeConfig();
    config.root.children[0].children[0].areaPath = undefined;
    await renderBoard({ config });
    fireEvent.click(within(cell("Team Red / PI 2 Sprint 1")).getByTitle("New item here"));
    await waitFor(() =>
      expect(sdk.workItemForm.openNewWorkItem).toHaveBeenCalledWith("Feature", expect.objectContaining({ "System.AreaPath": ART_A }))
    );
  });

  it("refreshes on demand", async () => {
    await renderBoard();
    const before = callsTo(/wiql/).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(callsTo(/wiql/).length).toBeGreaterThan(before));
  });

  it("shows an empty state when the PI has no features", async () => {
    await renderBoard({ nodeId: "n-artb", pi: (await piNamed("PI 1"))! });
    expect(screen.getByRole("heading", { name: "No Features in PI 1" })).toBeInTheDocument();
    expect(screen.getByText(ART_B)).toBeInTheDocument();
  });

  it("explains missing teams for an ART and missing children for other levels", async () => {
    const config = makeConfig();
    config.root.children[1].children = [];
    await renderBoard({ config, nodeId: "n-artb" });
    expect(screen.getByText(/This ART has no teams yet/)).toBeInTheDocument();
    // An ART without teams gets a single row for itself
    expect(rowTitles()).toEqual(["ART B"]);
  });

  it("explains missing children on a large solution and shows '(no area configured)'", async () => {
    const config = makeConfig();
    config.root.children.push({ id: "n-sol", name: "Big Solution", level: "solution", children: [] });
    await renderBoard({ config, nodeId: "n-sol" });
    expect(screen.getByText(/This node has no children yet/)).toBeInTheDocument();
    expect(screen.getByText("(no area configured)")).toBeInTheDocument();
  });

  it("uses ARTs as rows at the large-solution level", async () => {
    const config = makeConfig();
    config.root.children = [{ id: "n-sol", name: "Big Solution", level: "solution", areaPath: "Fabrikam", children: config.root.children }];
    await renderBoard({ config, nodeId: "n-sol" });
    expect(rowTitles()).toEqual(["ART A", "ART B"]);
    expect(within(cell("ART B / PI 2 IP")).getByText("Reports")).toBeInTheDocument();
    expect(within(cell("ART A / PI Backlog")).getByText("Fraud rules")).toBeInTheDocument();
  });

  it("places items in the most specific row when team areas are nested", async () => {
    const config = makeConfig();
    const red = config.root.children[0].children[0];
    config.root.children[0].children.push({ id: "n-sub", name: "Red Squad", level: "team", areaPath: `${RED}\\Squad`, children: [] });
    fake.workItems.get(14)!.fields["System.AreaPath"] = `${RED}\\Squad`;
    await renderBoard({ config });
    expect(within(cell("Red Squad / PI 2 Sprint 1")).getByText("Wallet")).toBeInTheDocument();
    expect(within(cell("Team Red / PI 2 Sprint 1")).queryByText("Wallet")).toBeNull();
    expect(red.name).toBe("Team Red");
  });

  it("shows a single row at team level", async () => {
    await renderBoard({ nodeId: "n-blue" });
    expect(rowTitles()).toEqual(["Team Blue"]);
    expect(screen.queryByText(/has no teams/)).not.toBeInTheDocument();
  });

  it("renders nothing without a PI", async () => {
    const { container } = await renderView(<ProgramBoard />, { pi: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it("omits the date subtitle for undated sprints", async () => {
    const pi: ProgramIncrement = { name: "PI X", path: PI2, identifier: "x", sprints: [{ name: "S1", path: PI2_S1, identifier: "s" }] };
    await renderBoard({ pi, pis: [pi] });
    const header = Array.from(document.querySelectorAll(".board-col-header")).find((h) => h.textContent === "S1")!;
    expect(header.querySelector(".muted")).toBeNull();
  });

  it("shows load errors instead of crashing when the first load fails", async () => {
    fail(/wiql/, 400, "WIQL error");
    await renderView(<ProgramBoard />);
    expect(await screen.findByText("WIQL error")).toBeInTheDocument();
    expect(document.querySelector(".board-grid")).toBeNull();
  });

  it("keeps showing the board when a later refresh fails", async () => {
    await renderBoard();
    fail(/wiql/, 500, "Refresh failed");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Refresh failed")).toBeInTheDocument();
  });
});

const DAY = 86_400_000;
const dayOffset = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const story = (id: number, title: string, area: string, iteration: string, state = "New", type = "User Story") => ({
  id,
  rev: 1,
  fields: {
    "System.Id": id,
    "System.Title": title,
    "System.WorkItemType": type,
    "System.State": state,
    "System.AreaPath": area,
    "System.IterationPath": iteration,
  },
  relations: [],
});
function addChild(parent: number, child: ReturnType<typeof story>) {
  fake.workItems.set(child.id, child);
  fake.workItems.get(parent)!.relations!.push({ rel: "System.LinkTypes.Hierarchy-Forward", url: `${fake.baseUrl}/_apis/wit/workItems/${child.id}`, attributes: {} });
}
const placement = (title: string) => card(title).closest(".board-cell")!.getAttribute("aria-label");

describe("ART Planning Board — calculated mode (default)", () => {
  it("places features in the sprint of their last planned child and the team planning it", async () => {
    await renderBoard();
    expect(screen.getByRole("button", { name: "Calculated from team plans" })).toHaveAttribute("aria-pressed", "true");
    // Payment API (own sprint 1) has child 101 planned in sprint 2
    expect(placement("Payment API")).toBe("Team Red / PI 2 Sprint 2");
    expect(placement("Checkout UI")).toBe("Team Blue / PI 2 Sprint 2");
    expect(placement("Wallet")).toBe("Team Blue / PI 2 Sprint 1");
    // No children: falls back to its own iteration (PI backlog) and area (no team row)
    expect(placement("Fraud rules")).toBe("Unassigned / PI Backlog");
    // Children planned in the PI come from one query of the child type in the PI
    expect(callsTo(/wiql/).some((c) => c.body.query.includes("('User Story')") && c.body.query.includes(PI2))).toBe(true);
  });

  it("disables drag-and-drop, link mode, new-item buttons and line removal", async () => {
    await renderBoard();
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
    expect(screen.queryByTitle("New item here")).toBeNull();
    expect(card("Wallet")).toHaveAttribute("draggable", "false");
    const target = cell("Team Red / PI 2 IP");
    fireEvent.dragOver(target);
    expect(target).not.toHaveClass("drop-over");
    fireEvent.drop(target, { dataTransfer: dataTransfer("14") });
    const line = document.querySelector("path.dep-line.critical")!;
    expect(line).toHaveClass("readonly");
    expect(line.querySelector("title")!.textContent).not.toContain("Click to remove");
    fireEvent.click(line);
    await new Promise((r) => setTimeout(r, 20));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(callsTo(/workitems\/\d+$/, "PATCH")).toHaveLength(0);
  });

  it("uses criticality from calculated placement and counts critical dependencies per row", async () => {
    await renderBoard();
    const lines = Array.from(document.querySelectorAll("path.dep-line")).map((l) => l.getAttribute("class"));
    // 10 and 11 now share sprint 2 → at risk; 11 (sprint 2) → 14 (sprint 1) critical
    expect(lines.sort()).toEqual([
      "dep-line atRisk readonly",
      "dep-line atRisk readonly",
      "dep-line critical readonly",
      "dep-line healthy readonly external",
    ]);
    const header = (name: string) => screen.getAllByText(name, { selector: ".row-title span" })[0].closest(".board-row-header") as HTMLElement;
    expect(within(header("Team Blue")).getByText("1 critical")).toHaveClass("danger");
    expect(within(header("Team Red")).getByText("0 critical")).toHaveClass("muted");
    expect(screen.getByText("Critical (1)")).toBeInTheDocument();
    expect(screen.getByText("At risk (2)")).toBeInTheDocument();
    expect(screen.getByText("Healthy (1)")).toBeInTheDocument();
  });

  it("marks dependencies on completed providers as resolved", async () => {
    fake.workItems.get(11)!.fields["System.State"] = "Closed";
    await renderBoard();
    const line = Array.from(document.querySelectorAll("path.dep-line")).find((l) => l.textContent!.startsWith("#11 → #14"))!;
    expect(line).toHaveClass("resolved");
    expect(screen.getByText("Resolved (1)")).toBeInTheDocument();
    expect(screen.queryByText(/· \d+ critical/)).toBeNull();
  });

  it("filters dependency lines by criticality", async () => {
    await renderBoard();
    expect(document.querySelectorAll("path.dep-line")).toHaveLength(4);
    fireEvent.click(screen.getByLabelText("Show critical dependencies"));
    expect(document.querySelector("path.dep-line.critical")).toBeNull();
    expect(document.querySelectorAll("path.dep-line")).toHaveLength(3);
    fireEvent.click(screen.getByLabelText("Show at risk dependencies"));
    expect(document.querySelectorAll("path.dep-line")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Show critical dependencies"));
    expect(document.querySelectorAll("path.dep-line")).toHaveLength(2);
  });

  it("puts a feature in its Owning Unit's row when that unit is a row", async () => {
    const { metaStore } = await import("../../src/api/data");
    await metaStore.save({ id: "12", workItemId: 12, owningNodeId: "n-blue", assignedNodeIds: [], assignedPiPaths: [] });
    await metaStore.save({ id: "10", workItemId: 10, owningNodeId: "n-green", assignedNodeIds: [], assignedPiPaths: [] });
    await metaStore.save({ id: "11", workItemId: 11, owningNodeId: "gone", assignedNodeIds: [], assignedPiPaths: [] });
    await renderBoard();
    expect(placement("Fraud rules")).toBe("Team Blue / PI Backlog");
    expect(within(card("Fraud rules")).getByTitle("Owning team")).toHaveTextContent("Team Blue");
    // Owning unit outside the board's rows: shown, but placement uses the children
    expect(placement("Payment API")).toBe("Team Red / PI 2 Sprint 2");
    expect(within(card("Payment API")).getByTitle("Owning team")).toHaveTextContent("Team Green");
    expect(within(card("Checkout UI")).getByTitle("Owning team")).toHaveTextContent("gone");
    expect(within(card("Wallet")).queryByTitle("Owning team")).toBeNull();
  });

  it("breaks ties between teams planning the last child alphabetically and lists involved teams", async () => {
    addChild(10, story(106, "Blue part", BLUE, PI2_S2));
    // A child of another type and a removed child are ignored
    addChild(10, story(107, "A task", BLUE, PI2_IP, "New", "Task"));
    addChild(10, story(108, "Gone", BLUE, PI2_IP, "Removed"));
    await renderBoard();
    expect(placement("Payment API")).toBe("Team Blue / PI 2 Sprint 2");
    const involved = within(card("Payment API")).getByRole("button", { name: "Involved teams: 2" });
    fireEvent.click(involved);
    expect(within(screen.getByRole("list", { name: "Involved teams" })).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
      "Team Red",
      "Team Blue",
    ]);
    // Clicking inside the popover neither closes it nor opens the work item
    fireEvent.click(screen.getByRole("list", { name: "Involved teams" }));
    expect(sdk.workItemForm.openWorkItem).not.toHaveBeenCalled();
    fireEvent.click(involved);
    expect(screen.queryByRole("list", { name: "Involved teams" })).toBeNull();
    expect(within(card("Fraud rules")).queryByRole("button", { name: /Involved teams/ })).toBeNull();
  });

  it("falls back to the feature's own row when no child is planned in a team row", async () => {
    addChild(12, story(109, "Green work", GREEN, PI2_S1));
    await renderBoard();
    // Column follows the child; row follows the feature's area (ART level → Unassigned)
    expect(placement("Fraud rules")).toBe("Unassigned / PI 2 Sprint 1");
    fireEvent.click(within(card("Fraud rules")).getByRole("button", { name: "Involved teams: 0" }));
    expect(screen.getByText("No children in this board's teams.")).toBeInTheDocument();
  });

  it("warns about children not planned in the PI's iterations and lists them", async () => {
    fake.workItems.get(101)!.fields["System.IterationPath"] = PI1_S1;
    addChild(10, story(110, "Floating", RED, ""));
    await renderBoard();
    expect(placement("Payment API")).toBe("Team Red / PI 2 Sprint 1");
    const warn = within(card("Payment API")).getByRole("button", { name: "2 children not planned in this PI" });
    fireEvent.click(warn);
    const list = screen.getByRole("list", { name: "Unplanned children" });
    expect(within(list).getAllByRole("listitem").map((l) => l.textContent)).toEqual([`#101 Refund card (${PI1_S1})`, "#110 Floating (no iteration)"]);
    fireEvent.click(list);
    expect(sdk.workItemForm.openWorkItem).not.toHaveBeenCalled();
    // switching popovers
    fireEvent.click(within(card("Payment API")).getByRole("button", { name: /Involved teams/ }));
    expect(screen.queryByRole("list", { name: "Unplanned children" })).toBeNull();
    expect(within(card("Wallet")).queryByRole("button", { name: /not planned/ })).toBeNull();
  });

  it("shows the target date when used", async () => {
    fake.workItems.get(11)!.fields["Microsoft.VSTS.Scheduling.TargetDate"] = "2026-12-24T00:00:00Z";
    await renderBoard();
    expect(within(card("Checkout UI")).getByText("Due Dec 24")).toBeInTheDocument();
    expect(within(card("Wallet")).queryByText(/Due/)).toBeNull();
  });

  it("shows milestones of the node and its ancestors in the iteration containing their date", async () => {
    const { milestonesStore } = await import("../../src/api/data");
    await milestonesStore.save({ id: "m1", nodeId: "n-arta", title: "Beta launch", date: dayOffset(10), description: "Public beta" });
    await milestonesStore.save({ id: "m2", nodeId: "n-root", title: "Board review", date: dayOffset(0) });
    await milestonesStore.save({ id: "m3", nodeId: "n-green", title: "Other ART", date: dayOffset(0) });
    await milestonesStore.save({ id: "m4", nodeId: "n-arta", title: "Far future", date: dayOffset(400) });
    await renderBoard();
    const header = (title: string) =>
      Array.from(document.querySelectorAll(".board-col-header")).find((h) => h.firstChild!.textContent === title) as HTMLElement;
    expect(within(header("PI 2 Sprint 2")).getByText("Beta launch")).toHaveAttribute("title", expect.stringContaining("Public beta"));
    expect(within(header("PI 2 Sprint 1")).getByText("Board review")).toBeInTheDocument();
    expect(screen.queryByText("Other ART")).toBeNull();
    expect(screen.queryByText("Far future")).toBeNull();
  });

  it("marks the current iteration", async () => {
    await renderBoard();
    const current = document.querySelector(".board-col-header.current") as HTMLElement;
    expect(current.firstChild!.textContent).toBe("PI 2 Sprint 1");
    expect(within(current).getByText("Today")).toBeInTheDocument();
    expect(document.querySelectorAll(".today-badge")).toHaveLength(1);
  });

  it("collapses and expands rows individually and all at once", async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Team Blue" }));
    expect(screen.queryByText("Wallet")).toBeNull();
    expect(within(cell("Team Blue / PI 2 Sprint 1")).getByText("1 item")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand Team Blue" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Payment API")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand Team Blue" }));
    expect(screen.getByText("Wallet")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(document.querySelectorAll(".card")).toHaveLength(0);
    expect(document.querySelectorAll("path.dep-line")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(document.querySelectorAll(".card")).toHaveLength(5);
  });

  it("switches to feature iteration mode and remembers the choice", async () => {
    const { unmount } = await renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Feature iteration" }));
    expect(placement("Payment API")).toBe("Team Red / PI 2 Sprint 1");
    expect(screen.getByRole("button", { name: "Add dependency" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("safe-ado-artboard-placement")!)).toBe("feature");
    unmount();
    await renderBoard();
    expect(screen.getByRole("button", { name: "Feature iteration" })).toHaveAttribute("aria-pressed", "true");
    // Link mode is reset when switching back
    fireEvent.click(screen.getByRole("button", { name: "Add dependency" }));
    fireEvent.click(screen.getByRole("button", { name: "Calculated from team plans" }));
    expect(screen.queryByRole("button", { name: /Select predecessor/ })).toBeNull();
    fireEvent.click(card("Wallet"));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(14));
  });

  it("keeps working when planning metadata and milestones cannot be loaded", async () => {
    dataStore.failures.push({ op: "getDocuments", error: new Error("denied") }, { op: "getDocuments", error: new Error("denied") });
    await renderBoard();
    expect(placement("Payment API")).toBe("Team Red / PI 2 Sprint 2");
    expect(screen.queryByText("denied")).toBeNull();
  });

  it("skips loading children when the process has no child type", async () => {
    await renderBoard({ config: makeConfig({ types: { epic: "Epic", capability: "", feature: "Feature", story: "" } }) });
    expect(placement("Payment API")).toBe("Team Red / PI 2 Sprint 1");
    expect(callsTo(/workitemsbatch/).some((c) => c.body.fields)).toBe(false);
  });

  it("does not fetch children when no feature has any", async () => {
    fake.workItems.get(20)!.relations = [];
    await renderBoard({ nodeId: "n-artb" });
    expect(placement("Reports")).toBe("Team Green / PI 2 IP");
    expect(callsTo(/workitemsbatch/).some((c) => c.body.fields)).toBe(false);
  });
});

describe("ART Planning Board — dependency removal", () => {
  beforeEach(() => localStorage.setItem("safe-ado-artboard-placement", JSON.stringify("feature")));

  it("removes a dependency stored only on the consumer as a predecessor link", async () => {
    const checkout = fake.workItems.get(11)!;
    checkout.relations = checkout.relations!.filter((r) => !r.rel.includes("Dependency"));
    await renderBoard();
    fireEvent.click(document.querySelector("path.dep-line.critical")!);
    await waitFor(() => expect(callsTo(/workitems\/14/, "PATCH")).toHaveLength(1));
    expect(callsTo(/workitems\/14/, "PATCH")[0].body).toEqual([{ op: "remove", path: "/relations/1" }]);
    await waitFor(() => expect(document.querySelector("path.dep-line.critical")).toBeNull());
  });
});

async function piNamed(name: string) {
  const { getProgramIncrements } = await import("../../src/api/wit");
  return (await getProgramIncrements("Fabrikam\\PIs")).find((p) => p.name === name);
}
