import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findNode } from "../../src/api/org";
import { Capabilities } from "../../src/api/permissions";
import { SafeConfig, WorkItem } from "../../src/api/types";
import { getProgramIncrements } from "../../src/api/wit";
import { SafeContext } from "../../src/components/context";
import { ProgramBoard } from "../../src/views/ProgramBoard";
import { ART_A, BLUE, callsTo, fail, fake, GREEN, makeConfig, P, PI1_S1, PI2, PI2_IP, PI2_S1, PI2_S2, RED, seedDocs } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { dataTransfer } from "../utils";

const CHILD = "System.LinkTypes.Hierarchy-Forward";
const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const SUCC = "System.LinkTypes.Dependency-Forward";
const PRED = "System.LinkTypes.Dependency-Reverse";
const REVERSE: Record<string, string> = { [CHILD]: PARENT, [PARENT]: CHILD, [SUCC]: PRED, [PRED]: SUCC };
const url = (id: number) => `${fake.baseUrl}/_apis/wit/workItems/${id}`;

function add(id: number, type: string, title: string, area: string, iteration: string, state = "New"): WorkItem {
  const item: WorkItem = {
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
  };
  fake.workItems.set(id, item);
  return item;
}

/** Adds a link on `a` and, like Azure DevOps, its reverse end on `b` (when known). */
function link(a: number, rel: string, b: number) {
  fake.workItems.get(a)!.relations!.push({ rel, url: url(b), attributes: {} });
  if (REVERSE[rel]) fake.workItems.get(b)!.relations!.push({ rel: REVERSE[rel], url: url(a), attributes: {} });
}

const READ_ONLY: Capabilities = { admin: false, managePis: false, plan: false };

async function renderBoard(opts: { can?: Capabilities; config?: SafeConfig; nodeId?: string } = {}) {
  const config = opts.config ?? makeConfig();
  const pis = await getProgramIncrements(config.piRootIteration);
  const pi = pis.find((p) => p.name === "PI 2")!;
  const result = render(
    <SafeContext.Provider
      value={{
        config,
        saveConfig: vi.fn(async () => undefined),
        node: findNode(config.root, opts.nodeId ?? "n-arta")!,
        selectNode: vi.fn(),
        pis,
        pi,
        reloadPis: vi.fn(),
        can: opts.can,
      }}
    >
      <ProgramBoard />
    </SafeContext.Provider>
  );
  await waitFor(() => expect(screen.queryByText("Loading program board…")).not.toBeInTheDocument());
  return { ...result, pi };
}

const cell = (name: string) => screen.getByRole("group", { name });
const card = (title: string) => screen.getByText(title).closest(".card") as HTMLElement;
const placement = (title: string) => card(title).closest(".board-cell")!.getAttribute("aria-label");
const line = (key: string) => document.querySelector(`path.dep-line[data-dep="${key}"]`) as SVGPathElement | null;
const feature = () => localStorage.setItem("safe-ado-artboard-placement", JSON.stringify("feature"));

describe("ART board — item set (A4)", () => {
  it("adds features whose children are planned in the PI, without duplicates", async () => {
    add(200, "User Story", "Late story", RED, PI2_S2);
    link(15, CHILD, 200);
    await renderBoard();
    // #15 lives in PI 1 but a child is planned in PI 2 Sprint 2.
    expect(placement("Old feature")).toBe("Team Red / PI 2 Sprint 2");
    // #10 is found both by its own iteration and via its stories: one card.
    expect(screen.getAllByText("Payment API")).toHaveLength(1);
    // The other child of #15 (PI 1) is flagged as unplanned.
    expect(within(card("Old feature")).getByRole("button", { name: "1 children not planned in this PI" })).toBeInTheDocument();
    const ids = callsTo(/wiql/).find((c) => c.body.query.includes("[System.Id] IN ("))!.body.query;
    expect(ids).toContain("[System.Id] IN (15)");
    expect(ids).toContain(`[System.AreaPath] UNDER '${ART_A}'`);
    expect(ids).toContain("[System.WorkItemType] IN ('Feature')");
  });

  it("adds features assigned to the PI in their planning metadata (by id or path)", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    const pi2 = pis.find((p) => p.name === "PI 2")!;
    add(30, "Feature", "Assigned by id", BLUE, P);
    add(31, "Feature", "Assigned by path", RED, P);
    add(32, "Feature", "Other PI", RED, P);
    add(33, "Feature", "Other ART", GREEN, P);
    const meta = (id: number, extra: object) => ({ id: String(id), workItemId: id, assignedNodeIds: [], assignedPiPaths: [], ...extra });
    seedDocs("wimeta", [
      meta(30, { assignedPiIds: [pi2.identifier] }),
      meta(31, { assignedPiPaths: [PI2.toUpperCase()] }),
      meta(32, { assignedPiPaths: ["Fabrikam\\PIs\\PI 1"] }),
      meta(33, { assignedPiIds: [pi2.identifier] }),
    ]);
    await renderBoard();
    expect(placement("Assigned by id")).toBe("Team Blue / PI Backlog");
    expect(placement("Assigned by path")).toBe("Team Red / PI Backlog");
    expect(screen.queryByText("Other PI")).toBeNull();
    expect(screen.queryByText("Other ART")).toBeNull();
  });

  it("ignores parents of removed stories and removed or out-of-scope parents", async () => {
    add(34, "Feature", "Only removed work", RED, P);
    add(210, "User Story", "Gone", RED, PI2_S1, "Removed");
    link(34, CHILD, 210);
    add(35, "Feature", "Removed feature", RED, P, "Removed");
    add(211, "User Story", "Orphan work", RED, PI2_S1);
    link(35, CHILD, 211);
    await renderBoard();
    expect(screen.queryByText("Only removed work")).toBeNull();
    expect(screen.queryByText("Removed feature")).toBeNull();
  });

  it("applies the WIQL clause server-side to both item queries, but not to the story query", async () => {
    add(200, "User Story", "Late story", RED, PI2_S2);
    link(15, CHILD, 200);
    await renderBoard();
    const input = screen.getByLabelText("WIQL clause");
    fireEvent.change(input, { target: { value: "[System.Title] CONTAINS 'Old'" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByText("Payment API")).toBeNull());
    expect(screen.getByText("Old feature")).toBeInTheDocument();
    const last = callsTo(/wiql/).slice(-3).map((c) => c.body.query as string);
    expect(last.filter((q) => q.includes("AND ([System.Title] CONTAINS 'Old')"))).toHaveLength(2);
    expect(last.find((q) => q.includes("('User Story')"))).not.toContain("CONTAINS 'Old'");
  });

  it("applies saved quick filters (their WIQL server-side)", async () => {
    seedDocs("quickfilters", [
      { id: "q1", name: "Wallet only", filter: { text: "", types: [], states: [], assignees: [], tags: [], wiql: "[System.Title] = 'Wallet'" } },
    ]);
    await renderBoard();
    const menu = screen.getByRole("group", { name: "Quick filters" });
    fireEvent.click(await within(menu).findByRole("checkbox", { name: "Wallet only" }));
    await waitFor(() => expect(screen.queryByText("Payment API")).toBeNull());
    expect(screen.getByText("Wallet")).toBeInTheDocument();
  });

  it("shows load errors from the follow-up queries", async () => {
    add(200, "User Story", "Late story", RED, PI2_S2);
    link(15, CHILD, 200);
    fail(/workitemsbatch/, 500, "Batch down");
    render(
      <SafeContext.Provider
        value={{
          config: makeConfig(),
          saveConfig: vi.fn(),
          node: findNode(makeConfig().root, "n-arta")!,
          selectNode: vi.fn(),
          pis: [],
          pi: { name: "PI 2", path: PI2, identifier: "x", sprints: [] },
          reloadPis: vi.fn(),
        }}
      >
        <ProgramBoard />
      </SafeContext.Provider>
    );
    expect(await screen.findByText("Batch down")).toBeInTheDocument();
  });
});

describe("ART board — filter bar (A6)", () => {
  it("filters cards client-side by text and facets and counts only visible items", async () => {
    await renderBoard();
    expect(screen.getByText(/4 items ·/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter text"), { target: { value: "wallet" } });
    expect(screen.getByText(/1 items ·/)).toBeInTheDocument();
    expect(screen.queryByText("Payment API")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Payment API")).toBeInTheDocument();
  });

  it("offers Owning team and Involved teams facets", async () => {
    seedDocs("wimeta", [{ id: "12", workItemId: 12, owningNodeId: "n-blue", assignedNodeIds: [], assignedPiPaths: [] }]);
    await renderBoard();
    const owning = screen.getByRole("group", { name: "Owning team filter" });
    expect(within(owning).getAllByRole("checkbox").map((c) => c.parentElement!.textContent!.trim())).toEqual(["None", "Team Blue"]);
    fireEvent.click(within(owning).getByRole("checkbox", { name: "Team Blue" }));
    expect(screen.getByText("Fraud rules")).toBeInTheDocument();
    expect(screen.queryByText("Wallet")).toBeNull();
    fireEvent.click(within(owning).getByRole("checkbox", { name: "Team Blue" }));

    const involved = screen.getByRole("group", { name: "Involved teams filter" });
    expect(within(involved).getAllByRole("checkbox").map((c) => c.parentElement!.textContent!.trim())).toEqual(["Team Blue", "Team Red"]);
    fireEvent.click(within(involved).getByRole("checkbox", { name: "Team Red" }));
    expect(screen.getByText("Payment API")).toBeInTheDocument();
    expect(screen.queryByText("Wallet")).toBeNull();
    expect(screen.queryByText("Fraud rules")).toBeNull();
  });
});

describe("ART board — dependencies (A7)", () => {
  beforeEach(feature);

  it("draws story-level links between the feature cards that own the stories", async () => {
    link(101, SUCC, 102); // story of #10 (Sprint 2) → story of #14 (Sprint 1)
    await renderBoard();
    const l = line("10-14")!;
    expect(l).toHaveClass("dep-line", "critical", "readonly");
    expect(l.querySelector("title")!.textContent).toBe("#10 → #14 (Critical) — consumer is planned before its provider\nvia #101 → #102");
    // Story links can't be removed from the board.
    fireEvent.click(l);
    await new Promise((r) => setTimeout(r, 10));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(screen.getByText(/5 dependencies/)).toBeInTheDocument();
  });

  it("aggregates direct and story links between the same cards (worst criticality) and ignores links inside one card", async () => {
    link(10, SUCC, 14);
    link(101, SUCC, 102);
    link(100, SUCC, 101); // both stories of #10
    await renderBoard();
    const l = line("10-14")!;
    expect(l).toHaveClass("critical");
    expect(l).not.toHaveClass("readonly");
    expect(l.querySelector("title")!.textContent).toContain("via #101 → #102\nClick to remove");
    expect(line("10-10")).toBeNull();
  });

  it("shows partners outside the board in EXTERNAL rows per area, in their calculated sprint", async () => {
    localStorage.setItem("safe-ado-artboard-placement", JSON.stringify("calculated"));
    add(300, "User Story", "Green story", GREEN, PI2_S2);
    link(102, SUCC, 300);
    add(302, "User Story", "Green child", GREEN, PI2_S1);
    link(20, CHILD, 302);
    add(303, "User Story", "Dropped partner", GREEN, PI2_S1, "Removed");
    link(10, SUCC, 303);
    await renderBoard();
    expect(screen.getByText("EXTERNAL")).toBeInTheDocument();
    expect(within(cell("External Team Green / PI 2 Sprint 2")).getByText("Green story")).toBeInTheDocument();
    // #20 is placed by its child in calculated mode.
    expect(within(cell("External Team Green / PI 2 Sprint 1")).getByText("Reports")).toBeInTheDocument();
    expect(line("14-300")).toHaveClass("healthy", "external");
    expect(screen.queryByText("Dropped partner")).toBeNull();
    expect(within(card("Payment API")).getByTitle("Dependencies on items outside this board")).toHaveTextContent("1");
    // External cards open the work item.
    fireEvent.click(card("Green story"));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(300));

    // Feature iteration mode uses the partner's own iteration.
    fireEvent.click(screen.getByRole("button", { name: "Feature iteration" }));
    expect(within(cell("External Team Green / PI 2 IP")).getByText("Reports")).toBeInTheDocument();
  });

  it("puts external partners only scheduled to the PI in the backlog column and hides those outside it", async () => {
    add(304, "Feature", "PI-level partner", GREEN, PI2);
    link(304, SUCC, 14);
    add(301, "User Story", "Past partner", GREEN, PI1_S1);
    link(301, SUCC, 100);
    await renderBoard();
    expect(within(cell("External Team Green / PI Backlog")).getByText("PI-level partner")).toBeInTheDocument();
    expect(screen.queryByText("Past partner")).toBeNull();
    const ind = screen.getByLabelText("Hidden providers of #10");
    expect(ind).toHaveClass("ab-edge", "left");
    expect(ind.getAttribute("title")).toBe("Hidden providers of #10\nAt risk: #301");
  });

  it("shows edge indicators for partners that are filtered out, grouped by criticality", async () => {
    link(10, SUCC, 12);
    await renderBoard();
    fireEvent.change(screen.getByLabelText("Filter text"), { target: { value: "Payment" } });
    const consumers = screen.getByLabelText("Hidden consumers of #10");
    expect(consumers).toHaveClass("right");
    expect(consumers.getAttribute("title")).toBe("Hidden consumers of #10\nAt risk: #12\nHealthy: #11");
    expect(consumers.style.background).toBe("rgb(214, 127, 60)");
    expect(screen.getByLabelText("Hidden providers of #10").getAttribute("title")).toBe("Hidden providers of #10\nAt risk: #12");
    // The external partner #20 is still drawn.
    expect(line("10-20")).not.toBeNull();
    // Indicators follow the criticality filter and the dependency toggle.
    fireEvent.click(screen.getByLabelText("Show at risk dependencies"));
    expect(screen.queryByLabelText("Hidden providers of #10")).toBeNull();
    fireEvent.click(screen.getByLabelText("Show dependencies"));
    expect(screen.queryByLabelText("Hidden consumers of #10")).toBeNull();
  });

  it("shows edge indicators for partners in collapsed rows, including collapsed EXTERNAL rows", async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Team Blue" }));
    expect(screen.getByLabelText("Hidden consumers of #10").getAttribute("title")).toBe("Hidden consumers of #10\nHealthy: #11");
    expect(line("10-11")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse external Team Green" }));
    expect(within(cell("External Team Green / PI 2 IP")).getByText("1 item")).toBeInTheDocument();
    expect(screen.getByLabelText("Hidden consumers of #10").getAttribute("title")).toBe("Hidden consumers of #10\nHealthy: #11, #20");
    fireEvent.click(screen.getByRole("button", { name: "Expand external Team Green" }));
    expect(line("10-20")).not.toBeNull();
    // An external card can carry indicators too.
    fireEvent.click(screen.getByRole("button", { name: "Collapse Team Red" }));
    expect(screen.getByLabelText("Hidden providers of #20").getAttribute("title")).toBe("Hidden providers of #20\nHealthy: #10");
  });

  it("removes a direct dependency to an external partner", async () => {
    await renderBoard();
    fireEvent.click(line("10-20")!);
    expect(window.confirm).toHaveBeenCalledWith("Remove dependency #10 → #20?");
    await waitFor(() => expect(callsTo(/workitems\/10$/, "PATCH")).toHaveLength(1));
    await waitFor(() => expect(line("10-20")).toBeNull());
    expect(screen.queryByText("EXTERNAL")).toBeNull();
  });

  it("uses the configured dependency link types for lines, new links and removal", async () => {
    const BLOCKS = "Custom.Blocks-Forward";
    const BLOCKED = "Custom.Blocks-Reverse";
    fake.workItems.get(12)!.relations!.push({ rel: BLOCKS, url: url(14), attributes: {} });
    fake.workItems.get(10)!.relations!.push({ rel: BLOCKED, url: url(11), attributes: {} });
    const config = makeConfig({ dependencyLink: { forward: BLOCKS, reverse: BLOCKED } });
    await renderBoard({ config });
    expect(screen.getByText(/4 items · 2 dependencies/)).toBeInTheDocument();
    expect(line("12-14")).not.toBeNull();
    expect(line("11-10")).not.toBeNull();

    fireEvent.click(line("12-14")!);
    await waitFor(() => expect(callsTo(/workitems\/12$/, "PATCH")).toHaveLength(1));
    expect(callsTo(/workitems\/12$/, "PATCH")[0].body[0].op).toBe("remove");
    fireEvent.click(line("11-10")!);
    await waitFor(() => expect(callsTo(/workitems\/10$/, "PATCH")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Add dependency" }));
    fireEvent.click(card("Fraud rules"));
    fireEvent.click(card("Wallet"));
    await waitFor(() => expect(callsTo(/workitems\/12$/, "PATCH")).toHaveLength(2));
    expect(callsTo(/workitems\/12$/, "PATCH")[1].body[0].value.rel).toBe(BLOCKS);
  });
});

describe("ART board — read-only (no plan permission)", () => {
  beforeEach(feature);

  it("disables drag and drop, link mode, new items and line removal in feature iteration mode", async () => {
    await renderBoard({ can: READ_ONLY });
    expect(screen.getByText(/read-only access to this area/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add dependency" })).toBeNull();
    expect(screen.queryByTitle("New item here")).toBeNull();
    expect(card("Wallet")).toHaveAttribute("draggable", "false");
    const target = cell("Team Red / PI 2 IP");
    fireEvent.dragOver(target);
    expect(target).not.toHaveClass("drop-over");
    fireEvent.drop(target, { dataTransfer: dataTransfer("14") });
    const l = line("11-14")!;
    expect(l).toHaveClass("readonly");
    expect(l.querySelector("title")!.textContent).not.toContain("Click to remove");
    fireEvent.click(l);
    await new Promise((r) => setTimeout(r, 20));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(callsTo(/workitems\/\d+$/, "PATCH")).toHaveLength(0);
    expect(screen.getByText("Cards are placed by their own Area Path and Iteration Path.")).toBeInTheDocument();
    // Cards still open.
    fireEvent.click(card("Wallet"));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(14));
  });

  it("shows no read-only bar in calculated mode", async () => {
    localStorage.setItem("safe-ado-artboard-placement", JSON.stringify("calculated"));
    await renderBoard({ can: READ_ONLY });
    expect(screen.queryByText(/read-only access/)).toBeNull();
  });
});

describe("ART board — undated and odd data", () => {
  it("rates story links to children without a sprint as at risk", async () => {
    feature();
    add(305, "User Story", "Floating", BLUE, "");
    link(14, CHILD, 305);
    link(101, SUCC, 305);
    await renderBoard();
    expect(line("10-14")).toHaveClass("atRisk");
    expect(BLUE).toBeTruthy();
  });
});
