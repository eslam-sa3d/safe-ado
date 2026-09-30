import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { findNode } from "../../src/api/org";
import { ProgramIncrement, WorkItem } from "../../src/api/types";
import { getProgramIncrements } from "../../src/api/wit";
import { SafeContext, SafeContextValue } from "../../src/components/context";
import { TeamBoard } from "../../src/views/TeamBoard";
import { ART_A, BLUE, callsTo, dataStore, fail, fake, fetchMock, GREEN, makeConfig, P, PI1, PI1_S1, PI2, PI2_S1, PI2_S2, RED } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { dataTransfer, renderView } from "../utils";

const SP = "Microsoft.VSTS.Scheduling.StoryPoints";
const CHILD = "System.LinkTypes.Hierarchy-Forward";
const SUCC = "System.LinkTypes.Dependency-Forward";
const PRED = "System.LinkTypes.Dependency-Reverse";
const PI1_S2 = "Fabrikam\\PIs\\PI 1\\PI 1 Sprint 2";
const url = (id: number) => `${fake.baseUrl}/_apis/wit/workItems/${id}`;
const cell = (name: string) => screen.getByRole("group", { name });
const card = (title: string) => screen.getByText(title).closest(".card") as HTMLElement;
const mainBar = () => within(document.querySelector(".tb-main .filterbar") as HTMLElement);

function addItem(id: number, type: string, title: string, area: string, iteration: string, state: string, extra: Record<string, unknown> = {}, rels: [string, number][] = []) {
  const item: WorkItem = {
    id,
    rev: 1,
    fields: { "System.Id": id, "System.Title": title, "System.WorkItemType": type, "System.State": state, "System.AreaPath": area, "System.IterationPath": iteration, ...extra },
    relations: rels.map(([rel, t]) => ({ rel, url: url(t), attributes: {} })),
  };
  fake.workItems.set(id, item);
  return item;
}

function seedCollection(name: string, docs: any[]) {
  dataStore.collections.set(`${name}-${fake.projectId}`, new Map(docs.map((d) => [d.id, { ...d, __etag: 1 }])));
}
const collection = (name: string) => Array.from(dataStore.collections.get(`${name}-${fake.projectId}`)?.values() ?? []);

async function settle() {
  await waitFor(() => expect(screen.queryByText("Loading team planning board…")).not.toBeInTheDocument());
  await waitFor(() => expect(screen.queryByText("Loading backlog…")).not.toBeInTheDocument());
}

async function renderBoard(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<TeamBoard />, { nodeId: "n-red", ...opts });
  await settle();
  return r;
}

function drop(target: HTMLElement, payload: string) {
  fireEvent.dragOver(target, { dataTransfer: dataTransfer(payload) });
  fireEvent.drop(target, { dataTransfer: dataTransfer(payload) });
}

/** Routes some requests to a custom answer, everything else to the fake. */
function interceptFetch(handler: (url: string, body: any) => Response | undefined) {
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    return handler(String(input), body) ?? fetchMock(input, init);
  });
}
const jsonResponse = (status: number, message: string) => new Response(JSON.stringify({ message }), { status, headers: { "Content-Type": "application/json" } });

const pisPromise = () => getProgramIncrements("Fabrikam\\PIs");

describe("Team Planning Board v2", () => {
  it("shows 'no access' for a sibling whose query is denied, without and with expanding", async () => {
    interceptFetch((u, body) => (/wiql/.test(u) && body?.query?.includes(`UNDER '${BLUE}'`) ? jsonResponse(403, "Access denied") : undefined));
    await renderBoard();
    expect(await screen.findByText("You don't have access to Team Blue")).toBeInTheDocument();
    expect(screen.queryByTitle("Unresolved critical dependencies")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand team Team Blue" }));
    await waitFor(() => expect(screen.queryByText("Loading Team Blue…")).toBeNull());
    expect(screen.getAllByText("You don't have access to Team Blue")).toHaveLength(1);
    expect(screen.queryByText(/Could not load Team Blue/)).toBeNull();
  });

  it("shows an unavailable count for other sibling errors and tolerates unreadable dependency ends", async () => {
    interceptFetch((u, body) => (/wiql/.test(u) && body?.query?.includes(`UNDER '${BLUE}'`) ? jsonResponse(500, "Blue broke") : undefined));
    await renderBoard();
    expect(await screen.findByTitle("Blue broke")).toHaveTextContent("critical count unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Expand team Team Blue" }));
    expect(await screen.findByText("Could not load Team Blue: Blue broke")).toBeInTheDocument();
  });

  it("rates sibling dependency ends it can't read as not critical", async () => {
    fake.workItems.get(102)!.relations = [{ rel: PRED, url: url(777), attributes: {} }];
    addItem(777, "User Story", "Hidden provider", GREEN, PI2_S2, "New");
    interceptFetch((u, body) => (/workitemsbatch/.test(u) && body?.ids?.includes(777) && body?.fields ? jsonResponse(500, "nope") : undefined));
    await renderBoard();
    expect(await screen.findByTitle("Unresolved critical dependencies")).toHaveTextContent("0 critical");
  });

  it("reloads an expanded sibling block after a drop", async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Expand team Team Blue" }));
    await screen.findByText("Add wallet");
    drop(cell("Independent / PI 2 Sprint 2"), "story:102");
    await waitFor(() => expect(within(cell("Independent / PI 2 Sprint 2")).getByText("Add wallet")).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText("Add wallet")).toHaveLength(1));
  });

  it("marks unplanned items planned elsewhere, ART feature assignments and PIs; requests only existing WSJF fields", async () => {
    addItem(106, "User Story", "In PI 1", RED, PI1_S1, "Active");
    addItem(107, "User Story", "PI level", RED, PI2, "New");
    addItem(108, "User Story", "Plain", RED, P, "New");
    addItem(16, "Feature", "Next up", ART_A, PI1, "New");
    const pis = await pisPromise();
    seedCollection("wimeta", [
      { id: "12", workItemId: 12, assignedNodeIds: ["n-red", "n-blue", "n-x"], assignedPiPaths: [PI2, "Fabrikam\\PIs\\PI 9"], assignedPiIds: [pis.find((p) => p.name === "PI 2")!.identifier] },
    ]);
    fake.fields = fake.fields.filter((f) => f.referenceName !== "Microsoft.VSTS.Scheduling.Effort");
    await renderBoard();
    const team = screen.getByRole("tabpanel", { name: "Team backlog" });
    expect(within(card("In PI 1")).getByText("Planned in PI 1")).toBeInTheDocument();
    expect(within(card("PI level")).getByText("In PI 2, no sprint")).toBeInTheDocument();
    expect(card("Plain").querySelector(".tb-marker")).toBeNull();
    expect(within(team).queryByText("Refund card")).toBeNull();

    // Sidebar filter: state facet
    fireEvent.click(within(team).getByRole("checkbox", { name: "Active" }));
    expect(within(team).queryByText("Plain")).toBeNull();
    expect(within(team).getByText("In PI 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "ART" }));
    const art = await screen.findByRole("tabpanel", { name: "ART backlog" });
    await within(art).findByText("Fraud rules");
    const fraud = within(art).getByText("Fraud rules").closest(".card") as HTMLElement;
    expect(within(fraud).getByText("Assigned here")).toBeInTheDocument();
    expect(within(fraud).getByText("Assigned to Team Blue, n-x")).toBeInTheDocument();
    expect(within(fraud).getByTitle("Assigned PIs")).toHaveTextContent("PIs: PI 2, PI 9");
    expect(within(within(art).getByText("Next up").closest(".card") as HTMLElement).getByText("Planned in PI 1")).toBeInTheDocument();
    const batch = callsTo(/workitemsbatch/).map((c) => c.body).find((b) => b.fields?.includes("Microsoft.VSTS.Common.BusinessValue"));
    expect(batch.fields).not.toContain("Microsoft.VSTS.Scheduling.Effort");
    expect(batch.fields).toContain("Microsoft.VSTS.Common.TimeCriticality");
  });

  it("highlights valid drop targets while dragging a story or a feature", async () => {
    const pis = await pisPromise();
    const pi2 = pis.find((p) => p.name === "PI 2")!;
    const pi: ProgramIncrement = { ...pi2, sprints: pi2.sprints.map((s, i) => (i === 0 ? { ...s, start: "2020-01-01T00:00:00Z", finish: "2020-01-14T00:00:00Z" } : s)) };
    await renderBoard({ pi, pis });
    const pastCell = card("Charge card").closest(".tb-cell") as HTMLElement;
    expect(pastCell).toHaveClass("past");
    fireEvent.dragStart(card("Refund card"), { dataTransfer: dataTransfer() });
    expect(cell("Independent / PI 2 IP")).toHaveClass("drop-valid");
    expect(pastCell).toHaveClass("drop-invalid");
    expect(screen.getByRole("group", { name: "Add swimlane" })).toHaveClass("drop-invalid");
    expect(document.querySelector(".tb-grid")).toHaveClass("tb-dragging");
    fireEvent.dragEnd(card("Refund card"));
    expect(cell("Independent / PI 2 IP")).not.toHaveClass("drop-valid");

    fireEvent.click(screen.getByRole("tab", { name: "ART" }));
    const art = await screen.findByRole("tabpanel", { name: "ART backlog" });
    const fraud = (await within(art).findByText("Fraud rules")).closest(".card")!;
    fireEvent.dragStart(fraud, { dataTransfer: dataTransfer() });
    expect(screen.getByRole("group", { name: "Add swimlane" })).toHaveClass("drop-valid");
    expect(cell("Payment API / PI 2 Sprint 2")).toHaveClass("drop-valid");
    expect(cell("Independent / PI 2 Sprint 2")).toHaveClass("drop-invalid");
    drop(screen.getByRole("group", { name: "Add swimlane" }), "feature:12");
    expect(document.querySelector(".tb-grid")).not.toHaveClass("tb-dragging");
    await screen.findByRole("group", { name: "Fraud rules / PI 2 Sprint 2" });
    fireEvent.dragStart(fraud, { dataTransfer: dataTransfer() });
    fireEvent.dragEnd(fraud);
    expect(document.querySelector(".tb-grid")).not.toHaveClass("tb-dragging");
  });

  it("shows rolled-over shadow cards in completed sprints", async () => {
    const pis = await pisPromise();
    const pi1 = pis.find((p) => p.name === "PI 1")!;
    addItem(110, "User Story", "Moved within PI", RED, PI1_S2, "Active");
    addItem(111, "User Story", "Blue item", BLUE, PI1_S2, "Active");
    addItem(112, "User Story", "Moved back", RED, PI1_S1, "Active");
    const rev = (id: number, iteration: string, area = RED) => ({ rev: 1, fields: { "System.WorkItemType": "User Story", "System.IterationPath": iteration, "System.AreaPath": area } });
    fake.revisions.set(101, [rev(101, PI1_S1), rev(101, PI2_S2)]);
    fake.revisions.set(110, [rev(110, PI1_S1), rev(110, PI1_S2)]);
    fake.revisions.set(111, [rev(111, PI1_S1, BLUE)]);
    fake.revisions.set(112, [rev(112, PI1_S2)]);
    await renderBoard({ pi: pi1, pis });
    await waitFor(() => expect(screen.getAllByText("Rolled over")).toHaveLength(2));
    const main = within(document.querySelector(".tb-main") as HTMLElement);
    const refund = main.getByText("Refund card").closest(".card") as HTMLElement;
    expect(refund).toHaveClass("tb-shadow");
    expect(refund.getAttribute("title")).toContain("now in PI 2 Sprint 2");
    expect(refund).toHaveAttribute("draggable", "false");
    expect(refund.closest(".tb-cell")).toHaveClass("past");
    // The real card of 110 sits in Sprint 2, its shadow in Sprint 1
    expect(main.getAllByText("Moved within PI")).toHaveLength(2);
    expect(main.queryByText("Blue item")).toBeNull();
    expect(main.getAllByText("Moved back")).toHaveLength(1);
    fireEvent.click(refund);
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(101));
  });

  it("reports rolled-over load failures", async () => {
    const pis = await pisPromise();
    fail(/workitemrevisions/, 500, "History offline");
    await renderBoard({ pi: pis.find((p) => p.name === "PI 1")!, pis });
    expect(await screen.findByText("Could not load rolled-over items: History offline")).toBeInTheDocument();
    expect(screen.getByText("Old story")).toBeInTheDocument();
  });

  it("records the PI as Assigned PI when creating in a cell", async () => {
    const pis = await pisPromise();
    const pi2 = pis.find((p) => p.name === "PI 2")!;
    await renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Create in Payment API / PI 2 Sprint 2" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Fresh" } });
    fireEvent.submit(screen.getByRole("dialog"));
    await waitFor(() => expect(within(cell("Payment API / PI 2 Sprint 2")).getByText("Fresh")).toBeInTheDocument());
    const created = Array.from(fake.workItems.values()).find((w) => w.fields["System.Title"] === "Fresh")!;
    expect(collection("wimeta")).toEqual([
      expect.objectContaining({ id: String(created.id), workItemId: created.id, assignedPiPaths: [PI2], assignedPiIds: [pi2.identifier] }),
    ]);
  });

  it("filters by Parent feature and Assigned PIs facets and quick filters", async () => {
    addItem(106, "User Story", "Loose story", RED, PI2_S1, "New");
    seedCollection("wimeta", [{ id: "101", workItemId: 101, assignedNodeIds: [], assignedPiPaths: [PI1] }]);
    seedCollection("quickfilters", [
      { id: "q1", name: "Payment only", filter: { text: "", types: [], states: [], assignees: [], tags: [], wiql: "", extra: { parent: ["#10 Payment API"] } } },
      { id: "q2", name: "MVP", filter: { text: "", types: [], states: [], assignees: [], tags: [], wiql: "[System.Tags] CONTAINS 'MVP'" } },
    ]);
    await renderBoard();
    const parents = screen.getByRole("group", { name: "Parent feature filter" });
    expect(within(parents).getAllByRole("checkbox").map((c) => c.parentElement!.textContent!.trim())).toEqual(["#10 Payment API", "None"]);
    fireEvent.click(within(parents).getByRole("checkbox", { name: "None" }));
    expect(screen.queryByText("Charge card")).toBeNull();
    expect(screen.getByText("Loose story")).toBeInTheDocument();
    fireEvent.click(within(parents).getByRole("checkbox", { name: "None" }));

    const pis = screen.getByRole("group", { name: "Assigned PIs filter" });
    expect(within(pis).getAllByRole("checkbox").map((c) => c.parentElement!.textContent!.trim())).toEqual(["PI 1", "PI 2"]);
    fireEvent.click(within(pis).getByRole("checkbox", { name: "PI 1" }));
    expect(screen.getByText("Refund card")).toBeInTheDocument();
    expect(screen.queryByText("Charge card")).toBeNull();
    fireEvent.click(within(pis).getByRole("checkbox", { name: "PI 1" }));

    const quick = mainBar().getByRole("group", { name: "Quick filters" });
    fireEvent.click(await within(quick).findByRole("checkbox", { name: "Payment only" }));
    expect(screen.queryByText("Loose story")).toBeNull();
    expect(screen.getByText("Charge card")).toBeInTheDocument();
    fireEvent.click(within(quick).getByRole("checkbox", { name: "MVP" }));
    await waitFor(() => expect(callsTo(/wiql/).some((c) => c.body.query.includes("AND ([System.Tags] CONTAINS 'MVP')"))).toBe(true));
    await waitFor(() => expect(screen.queryByText("Charge card")).toBeNull());
  });

  it("shows edge indicators for undrawn dependency partners and places externals by children or date", async () => {
    const pis = await pisPromise();
    const pi2 = pis.find((p) => p.name === "PI 2")!;
    const ipStart = pi2.sprints[2].start!.slice(0, 10);
    addItem(120, "User Story", "Child in S2", GREEN, PI2_S2, "New");
    fake.workItems.get(12)!.relations!.push({ rel: CHILD, url: url(120), attributes: {} });
    addItem(30, "Feature", "Dated feature", GREEN, P, "New", { "Microsoft.VSTS.Scheduling.TargetDate": `${ipStart}T00:00:00Z` });
    addItem(31, "Epic", "Far epic", GREEN, P, "New", { "Microsoft.VSTS.Scheduling.TargetDate": "2099-01-01T00:00:00Z" });
    addItem(106, "User Story", "Loose", RED, PI2_S1, "New", {}, [[SUCC, 101], [SUCC, 12], [SUCC, 30], [PRED, 31]]);
    await renderBoard();

    // Externals: Fraud rules by its child's sprint, Dated feature by target date, Far epic outside with its date
    // Fraud rules has no sprint of its own; its child in Sprint 2 places it in a cell, not outside
    expect(card("Fraud rules").closest(".tb-cell")).toBeTruthy();
    const dated = card("Dated feature");
    expect(within(dated).getByTitle("Target date")).toBeInTheDocument();
    expect(dated.closest(".tb-cell")).toBeTruthy();
    expect(card("Far epic").closest(".tb-outside")).toBeTruthy();
    expect(within(card("Far epic")).getByTitle("Target date")).toBeInTheDocument();

    expect(screen.queryByLabelText("Hidden consumers of #106")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Payment API" }));
    const edge = await screen.findByLabelText("Hidden consumers of #106");
    expect(edge).toHaveClass("right");
    expect(edge.getAttribute("title")).toContain("Healthy: #101");
    // Criticality filter and "Show dependencies" hide markers too
    fireEvent.click(screen.getByRole("checkbox", { name: /Healthy/ }));
    expect(screen.queryByLabelText("Hidden consumers of #106")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Healthy/ }));
    await screen.findByLabelText("Hidden consumers of #106");
    fireEvent.click(screen.getByRole("checkbox", { name: /Show dependencies/ }));
    expect(screen.queryByLabelText("Hidden consumers of #106")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Show dependencies/ }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Payment API" }));

    // Filtering the consumer out: the provider side gets the marker on the other card
    fireEvent.change(mainBar().getByRole("textbox", { name: "Filter text" }), { target: { value: "refund" } });
    const left = await screen.findByLabelText("Hidden providers of #101");
    expect(left).toHaveClass("left");
  });

  it("uses the configured dependency link type", async () => {
    addItem(106, "User Story", "Blocker", RED, PI2_S1, "New", {}, [["Custom.Blocks-Forward", 101], [SUCC, 100]]);
    await renderBoard({ config: makeConfig({ dependencyLink: { forward: "Custom.Blocks-Forward", reverse: "Custom.Blocks-Reverse" } }) });
    expect(screen.getByText(/3 stories · 1 dependencies/)).toBeInTheDocument();
  });

  it("opens the parent from the card's parent lozenge", async () => {
    await renderBoard();
    fireEvent.click(within(card("Charge card")).getByTitle("Parent feature"));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(10));
    expect(sdk.workItemForm.openWorkItem).not.toHaveBeenCalledWith(100);
  });

  it("is read-only without plan permission", async () => {
    seedCollection("wimeta", [{ id: "14", workItemId: 14, assignedNodeIds: ["n-red"], assignedPiPaths: [PI2] }]);
    const config = makeConfig();
    const pis = await getProgramIncrements(config.piRootIteration);
    const value: SafeContextValue = {
      config,
      saveConfig: vi.fn(),
      node: findNode(config.root, "n-red")!,
      selectNode: vi.fn(),
      pis,
      pi: pis.find((p) => p.name === "PI 2"),
      reloadPis: vi.fn(),
      can: { admin: false, managePis: false, plan: false },
    };
    render(
      <SafeContext.Provider value={value}>
        <TeamBoard />
      </SafeContext.Provider>
    );
    await settle();
    await screen.findByText("Charge card");
    expect(screen.getByText("Read-only: you don't have permission to plan in this area.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /PI 2 Sprint/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "Add swimlane" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Create in/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /of capacity/ })).toBeNull();
    expect(screen.getAllByTitle(/read-only/)).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove swimlane/ })).toBeNull();
    expect(card("Refund card")).toHaveAttribute("draggable", "false");
    expect(screen.getByText("Wallet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "ART" }));
    const art = await screen.findByRole("tabpanel", { name: "ART backlog" });
    const fraud = (await within(art).findByText("Fraud rules")).closest(".card")!;
    expect(fraud).toHaveAttribute("draggable", "false");
  });

  it("shows a read-only empty state without drag hints", async () => {
    for (const id of [100, 101]) fake.workItems.get(id)!.fields["System.IterationPath"] = PI1_S1;
    const config = makeConfig();
    const pis = await getProgramIncrements(config.piRootIteration);
    render(
      <SafeContext.Provider
        value={{ config, saveConfig: vi.fn(), node: findNode(config.root, "n-red")!, selectNode: vi.fn(), pis, pi: pis[1], reloadPis: vi.fn(), can: { admin: true, managePis: true, plan: false } }}
      >
        <TeamBoard />
      </SafeContext.Provider>
    );
    await settle();
    const info = await screen.findByText(/are planned in PI 2 yet/);
    expect(info.textContent).not.toContain("Drag stories");
  });

  it("rolls over into a later PI and reads history without a start date for undated PIs", async () => {
    // Undated PI start: no startDateTime is sent
    const pis = await pisPromise();
    const pi1 = { ...pis.find((p) => p.name === "PI 1")!, start: undefined };
    fake.revisions.set(101, [{ rev: 1, fields: { "System.WorkItemType": "User Story", "System.IterationPath": PI1_S1, "System.AreaPath": RED } }]);
    await renderBoard({ pi: pi1, pis });
    await waitFor(() => expect(screen.getAllByText("Rolled over")).toHaveLength(1));
    expect(callsTo(/workitemrevisions/)[0].url).not.toContain("startDateTime");
  });
});
