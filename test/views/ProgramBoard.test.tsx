import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProgramIncrement } from "../../src/api/types";
import { ProgramBoard } from "../../src/views/ProgramBoard";
import { ART_A, ART_B, BLUE, callsTo, fail, fake, makeConfig, PI2, PI2_S1, PI2_S2, RED } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { dataTransfer, renderView } from "../utils";

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

describe("Program Board", () => {
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
    expect(Array.from(document.querySelectorAll(".board-row-header")).map((h) => h.firstChild!.textContent)).toEqual([
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
    expect(screen.queryByText("Reports")).not.toBeInTheDocument();
    expect(screen.queryByText("Old feature")).not.toBeInTheDocument();

    const wiql = callsTo(/wiql/)[0].body.query;
    expect(wiql).toContain(`[System.AreaPath] UNDER '${ART_A}'`);
    expect(wiql).toContain(`[System.IterationPath] UNDER '${PI2}'`);
  });

  it("summarises items, dependencies and conflicts; shows card metadata", async () => {
    await renderBoard();
    expect(screen.getByText(/4 items · 3 dependencies/)).toBeInTheDocument();
    expect(screen.getByText("· 1 conflicts")).toBeInTheDocument();
    const payment = card("Payment API");
    expect(within(payment).getByText("#10")).toBeInTheDocument();
    expect(within(payment).getByText("Active")).toBeInTheDocument();
    expect(within(payment).getByText("8 pts")).toBeInTheDocument();
    // Successor to feature 20 on another ART counts as external
    expect(within(payment).getByTitle("Dependencies on items outside this board")).toHaveTextContent("↗ 1");
    expect(within(card("Wallet")).queryByTitle("Dependencies on items outside this board")).toBeNull();
    expect(payment).toHaveAttribute("title", "Feature #10: Payment API");
  });

  it("draws dependency lines with ok / warn / conflict severity", async () => {
    await renderBoard();
    const lines = Array.from(document.querySelectorAll("path.dep-line"));
    const byKey = Object.fromEntries(lines.map((l) => [l.querySelector("title")!.textContent!.split("\n")[0].trim(), l.getAttribute("class")]));
    expect(byKey["#10 → #11"]).toBe("dep-line ok");
    expect(byKey["#12 → #10"]).toBe("dep-line warn");
    expect(byKey["#11 → #14 — successor is planned before its predecessor"]).toBe("dep-line conflict");
    expect(lines).toHaveLength(3);
  });

  it("flags same-iteration dependencies as warnings", async () => {
    fake.workItems.get(14)!.fields["System.IterationPath"] = PI2_S2;
    await renderBoard();
    const line = Array.from(document.querySelectorAll("path.dep-line")).find((l) => l.textContent!.startsWith("#11 → #14"));
    expect(line).toHaveClass("warn");
    expect(screen.queryByText(/conflicts/)).not.toBeInTheDocument();
  });

  it("routes lines backwards when the successor sits to the left", async () => {
    const x: Record<string, number> = { "10": 200, "11": 400, "12": 0, "14": 100 };
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const id = /#(\d+):/.exec(this.getAttribute("title") ?? "")?.[1];
      const left = id ? x[id] : 0;
      return { left, top: 10, width: 50, height: 20, right: left + 50, bottom: 30, x: left, y: 10, toJSON() {} } as DOMRect;
    });
    await renderBoard();
    const conflict = document.querySelector("path.dep-line.conflict")!;
    // from card 11's left edge (400) to card 14's right edge (150)
    expect(conflict.getAttribute("d")).toMatch(/^M400,10 C.* 150,10$/);
    const ok = document.querySelector("path.dep-line.ok")!;
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
    await waitFor(() => expect(callsTo(/wiql/).length).toBe(before + 1));
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
    await renderBoard();
    const conflict = document.querySelector("path.dep-line.conflict")!;
    fireEvent.click(conflict);
    expect(window.confirm).toHaveBeenCalledWith("Remove dependency #11 → #14?");
    await waitFor(() => expect(callsTo(/workitems\/11/, "PATCH")).toHaveLength(1));
    await waitFor(() => expect(document.querySelector("path.dep-line.conflict")).toBeNull());
  });

  it("keeps the dependency when the user cancels", async () => {
    (window.confirm as any).mockReturnValueOnce(false);
    await renderBoard();
    fireEvent.click(document.querySelector("path.dep-line.conflict")!);
    await new Promise((r) => setTimeout(r, 20));
    expect(callsTo(/workitems/, "PATCH")).toHaveLength(0);
  });

  it("reports failures removing a dependency", async () => {
    fail(/workitems\/11/, 403, "No permission", { method: "PATCH" });
    await renderBoard();
    fireEvent.click(document.querySelector("path.dep-line.conflict")!);
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
    await waitFor(() => expect(callsTo(/wiql/).length).toBe(before + 1));
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
    expect(Array.from(document.querySelectorAll(".board-row-header")).map((h) => h.firstChild!.textContent)).toEqual(["ART B"]);
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
    expect(Array.from(document.querySelectorAll(".board-row-header")).map((h) => h.firstChild!.textContent)).toEqual(["ART A", "ART B"]);
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
    expect(Array.from(document.querySelectorAll(".board-row-header")).map((h) => h.firstChild!.textContent)).toEqual(["Team Blue"]);
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

async function piNamed(name: string) {
  const { getProgramIncrements } = await import("../../src/api/wit");
  return (await getProgramIncrements("Fabrikam\\PIs")).find((p) => p.name === name);
}
