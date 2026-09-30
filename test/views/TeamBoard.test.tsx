import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkItem } from "../../src/api/types";
import { TeamBoard } from "../../src/views/TeamBoard";
import { BLUE, callsTo, dataStore, fail, fake, GREEN, makeConfig, P, PI1_S1, PI2, PI2_IP, PI2_S1, PI2_S2, RED } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { dataTransfer, renderView } from "../utils";

const SP = "Microsoft.VSTS.Scheduling.StoryPoints";
const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const CHILD = "System.LinkTypes.Hierarchy-Forward";
const SUCC = "System.LinkTypes.Dependency-Forward";
const url = (id: number) => `${fake.baseUrl}/_apis/wit/workItems/${id}`;

const cell = (name: string) => screen.getByRole("group", { name });
const card = (title: string) => screen.getByText(title).closest(".card") as HTMLElement;
const mainBar = () => within(document.querySelector(".tb-main .filterbar") as HTMLElement);
const sideSearch = () => within(screen.getByRole("tabpanel")).getByRole("textbox", { name: "Filter text" });

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

async function renderBoard(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<TeamBoard />, { nodeId: "n-red", ...opts });
  await waitFor(() => expect(screen.queryByText("Loading team planning board…")).not.toBeInTheDocument());
  await waitFor(() => expect(screen.queryByText("Loading backlog…")).not.toBeInTheDocument());
  return r;
}

function drop(target: HTMLElement, payload: string) {
  fireEvent.dragOver(target, { dataTransfer: dataTransfer(payload) });
  fireEvent.drop(target, { dataTransfer: dataTransfer(payload) });
}

const patches = (id: number) => callsTo(new RegExp(`^_apis/wit/workitems/${id}$`), "PATCH").map((c) => c.body);

describe("Team Planning Board", () => {
  it("renders nothing without a PI and a hint above team level", async () => {
    const { container, unmount } = await renderView(<TeamBoard />, { nodeId: "n-red", pi: null });
    expect(container).toBeEmptyDOMElement();
    unmount();
    await renderView(<TeamBoard />, { nodeId: "n-arta" });
    expect(screen.getByText(/available for teams/)).toBeInTheDocument();
  });

  it("shows sprint columns, the Today marker, feature swimlanes and the Independent lane", async () => {
    addItem(106, "User Story", "Loose story", RED, PI2_IP, "New", { [SP]: 2, "System.Tags": "MVP; UX", "System.AssignedTo": { displayName: "Ada" } });
    await renderView(<TeamBoard />, { nodeId: "n-red" });
    expect(screen.getByText("Loading team planning board…")).toBeInTheDocument();
    await screen.findByText("Charge card");

    const headers = Array.from(document.querySelectorAll(".tb-col-header .tb-col-title")).map((h) => h.firstChild!.textContent);
    expect(headers).toEqual(["PI 2 Sprint 1", "PI 2 Sprint 2", "PI 2 IP"]);
    expect(within(document.querySelector(".tb-col-header.current") as HTMLElement).getByText("Today")).toBeInTheDocument();
    expect(document.querySelectorAll(".tb-today")).toHaveLength(1);

    expect(within(cell("Payment API / PI 2 Sprint 1")).getByText("Charge card")).toBeInTheDocument();
    expect(within(cell("Payment API / PI 2 Sprint 2")).getByText("Refund card")).toBeInTheDocument();
    expect(within(cell("Independent / PI 2 IP")).getByText("Loose story")).toBeInTheDocument();
    expect(screen.queryByText("Removed story")).not.toBeInTheDocument();
    const lanes = Array.from(document.querySelectorAll(".tb-lane-title")).map((l) => l.textContent);
    expect(lanes).toEqual(["Payment API", "Independent"]);

    const charge = card("Charge card");
    expect(within(charge).getByText("#100")).toBeInTheDocument();
    expect(within(charge).getByText("Closed")).toBeInTheDocument();
    expect(within(charge).getByText("5 pts")).toBeInTheDocument();
    expect(within(charge).getByTitle("Parent feature")).toHaveTextContent("Payment API");
    expect(screen.getByText(/3 stories · 0 dependencies/)).toBeInTheDocument();

    // Extended layout shows assignee and tags, and is remembered
    expect(within(card("Loose story")).queryByText("Ada")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Extended" }));
    expect(within(card("Loose story")).getByText("Ada")).toBeInTheDocument();
    expect(within(card("Loose story")).getByText("UX")).toBeInTheDocument();
    expect(within(card("Charge card")).getByText("Unassigned")).toBeInTheDocument();
    expect(localStorage.getItem("safe-ado-teamboard-layout")).toBe('"extended"');
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(within(card("Loose story")).queryByText("Ada")).toBeNull();

    const storyQuery = callsTo(/wiql/)[0].body.query;
    expect(storyQuery).toContain(`[System.AreaPath] UNDER '${RED}'`);
    expect(storyQuery).toContain(`[System.IterationPath] UNDER '${PI2}'`);
  });

  it("shows load / capacity per iteration, highlights overload and edits capacity", async () => {
    seedCollection("capacity", [{ id: `n-red|${PI2_S1}`, nodeId: "n-red", iterationPath: PI2_S1, capacity: 4 }]);
    await renderBoard();
    const s1 = screen.getByRole("button", { name: "Load 5 of capacity 4 for PI 2 Sprint 1" });
    expect(s1.querySelector(".overload")).toHaveTextContent("5");
    const s2 = screen.getByRole("button", { name: "Load 3 of capacity not set for PI 2 Sprint 2" });
    expect(s2).toHaveTextContent("3 / –");
    expect(s2.querySelector(".overload")).toBeNull();

    // Enter saves a new capacity document
    fireEvent.click(s2);
    const input = screen.getByRole("spinbutton", { name: "Capacity for PI 2 Sprint 2" });
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("button", { name: "Load 3 of capacity 10 for PI 2 Sprint 2" });
    // New capacity documents are keyed by the iteration's stable id (survives renames).
    expect(collection("capacity").find((c) => c.iterationPath === PI2_S2)).toMatchObject({
      id: "n-red|iteration-PIs-PI_2-PI_2_Sprint_2",
      iterationId: "iteration-PIs-PI_2-PI_2_Sprint_2",
      nodeId: "n-red",
      capacity: 10,
    });

    // Blur saves an update of an existing document (keeping its etag)
    fireEvent.click(screen.getByRole("button", { name: /for PI 2 Sprint 1/ }));
    const input1 = screen.getByRole("spinbutton", { name: "Capacity for PI 2 Sprint 1" });
    expect(input1).toHaveValue(4);
    fireEvent.change(input1, { target: { value: "6" } });
    fireEvent.blur(input1);
    await screen.findByRole("button", { name: "Load 5 of capacity 6 for PI 2 Sprint 1" });
    expect(collection("capacity").find((c) => c.iterationPath === PI2_S1)).toMatchObject({ capacity: 6, __etag: 2 });

    // Escape cancels; unchanged values are not saved
    const saves = dataStore.collections.get(`capacity-${fake.projectId}`)!.size;
    fireEvent.click(screen.getByRole("button", { name: /for PI 2 IP/ }));
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Capacity for PI 2 IP" }), { key: "Escape" });
    expect(screen.queryByRole("spinbutton")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /for PI 2 Sprint 1/ }));
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" });
    expect(dataStore.collections.get(`capacity-${fake.projectId}`)!.size).toBe(saves);

    // Invalid input is rejected
    fireEvent.click(screen.getByRole("button", { name: /for PI 2 IP/ }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "-3" } });
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("Capacity must be a non-negative number");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    // Save failures surface
    dataStore.failures.push({ op: "setDocument", error: new Error("Quota exceeded") });
    fireEvent.click(screen.getByRole("button", { name: /for PI 2 IP/ }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "8" } });
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save capacity: Quota exceeded");
  });

  it("locks completed iterations: greyed, no drop zones, no create, no moves", async () => {
    const pis = await import("../../src/api/wit").then((m) => m.getProgramIncrements("Fabrikam\\PIs"));
    const pi1 = pis.find((p) => p.name === "PI 1")!;
    await renderBoard({ pi: pi1 });
    expect(document.querySelectorAll(".tb-col-header.past")).toHaveLength(2);
    expect(screen.queryByText("Today")).toBeNull();
    expect(screen.queryByRole("group", { name: /PI 1 Sprint/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Create in/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Capacity|of capacity/ })).toBeNull();
    expect(screen.getAllByTitle(/capacity is locked/)).toHaveLength(2);
    const old = card("Old story");
    expect(old.closest(".tb-cell")).toHaveClass("past");
    expect(old).toHaveAttribute("draggable", "false");
    expect(within(old).queryByRole("button", { name: /Actions/ })).toBeNull();
    expect(within(old).getByTitle("Parent feature")).toHaveTextContent("Old feature");
  });

  it("drags a Team backlog story into a feature swimlane: sets iteration and parent", async () => {
    addItem(106, "User Story", "Backlog story", RED, P, "New", { [SP]: 2, "Microsoft.VSTS.Common.Priority": 2 });
    await renderBoard();
    const backlog = screen.getByRole("tabpanel", { name: "Team backlog" });
    const item = within(backlog).getByText("Backlog story").closest(".card") as HTMLElement;
    // Old/closed stories and stories planned in the PI are not unplanned
    expect(within(backlog).queryByText("Old story")).toBeNull();
    expect(within(backlog).queryByText("Refund card")).toBeNull();

    const dt = dataTransfer();
    fireEvent.dragStart(item, { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith("text/plain", "story:106");
    drop(cell("Payment API / PI 2 Sprint 2"), "story:106");

    await waitFor(() => expect(within(cell("Payment API / PI 2 Sprint 2")).getByText("Backlog story")).toBeInTheDocument());
    expect(patches(106)[0]).toEqual([{ op: "add", path: "/fields/System.IterationPath", value: PI2_S2 }]);
    expect(fake.workItems.get(106)!.relations!.map((r) => [r.rel, r.url])).toEqual([[PARENT, url(10)]]);
    await waitFor(() => expect(within(screen.getByRole("tabpanel", { name: "Team backlog" })).queryByText("Backlog story")).toBeNull());
  });

  it("moves a board card to Independent (removing the parent from the feature side) and between lanes", async () => {
    addItem(106, "User Story", "Own parent", RED, PI2_S1, "New", {}, [[PARENT, 12]]);
    await renderBoard();
    // 106's parent 12 is an ART feature planned in the PI → its own lane
    expect(within(cell("Fraud rules / PI 2 Sprint 1")).getByText("Own parent")).toBeInTheDocument();

    const dt = dataTransfer();
    fireEvent.dragStart(card("Refund card"), { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith("text/plain", "story:101");
    drop(cell("Independent / PI 2 IP"), "story:101");
    await waitFor(() => expect(within(cell("Independent / PI 2 IP")).getByText("Refund card")).toBeInTheDocument());
    expect(fake.workItems.get(101)!.fields["System.IterationPath"]).toBe(PI2_IP);
    expect(fake.workItems.get(10)!.relations!.some((r) => r.rel === CHILD && r.url === url(101))).toBe(false);

    // Same sprint, other lane: only the parent changes (own-side link removed, new one added)
    drop(cell("Payment API / PI 2 Sprint 1"), "story:106");
    await waitFor(() => expect(within(cell("Payment API / PI 2 Sprint 1")).getByText("Own parent")).toBeInTheDocument());
    expect(fake.workItems.get(106)!.relations!.map((r) => r.url)).toEqual([url(10)]);
    expect(patches(106).some((ops) => ops.some((o: any) => o.path === "/fields/System.IterationPath"))).toBe(false);

    // Dropping where it already is changes nothing
    const before = callsTo(/workitems\/106$/, "PATCH").length;
    drop(cell("Payment API / PI 2 Sprint 1"), "story:106");
    await waitFor(() => expect(callsTo(/workitemsbatch/).length).toBeGreaterThan(0));
    expect(callsTo(/workitems\/106$/, "PATCH").length).toBe(before);
  });

  it("moves a story from another team into the team area; ignores bad payloads; reports failures", async () => {
    await renderBoard();
    drop(cell("Independent / PI 2 Sprint 2"), "story:102");
    await waitFor(() => expect(fake.workItems.get(102)!.fields["System.AreaPath"]).toBe(RED));
    expect(fake.workItems.get(102)!.fields["System.IterationPath"]).toBe(PI2_S2);
    await screen.findByText("Add wallet");

    const n = fake.calls.length;
    fireEvent.dragOver(cell("Independent / PI 2 IP"));
    expect(cell("Independent / PI 2 IP")).toHaveClass("drop-over");
    fireEvent.dragLeave(cell("Independent / PI 2 IP"));
    expect(cell("Independent / PI 2 IP")).not.toHaveClass("drop-over");
    drop(cell("Independent / PI 2 Sprint 2"), "garbage");
    expect(fake.calls.length).toBe(n);

    drop(cell("Independent / PI 2 Sprint 2"), "story:9999");
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not move #9999: the work item no longer exists");

    fail(/PATCH _apis\/wit\/workitems\/101/, 409, "Rule error");
    drop(cell("Independent / PI 2 Sprint 1"), "story:101");
    expect(await screen.findByText("Could not move #101: Rule error")).toBeInTheDocument();
  });

  it("loads the ART tab lazily and drags a feature to create a swimlane, then removes it", async () => {
    await renderBoard();
    const featureQueries = () => callsTo(/wiql/).filter((c) => /WorkItemType\] IN \('Feature'\)/.test(c.body.query) && !/IterationPath/.test(c.body.query));
    expect(featureQueries()).toHaveLength(0);
    fireEvent.click(screen.getByRole("tab", { name: "ART" }));
    const art = await screen.findByRole("tabpanel", { name: "ART backlog" });
    await within(art).findByText("Fraud rules");
    expect(featureQueries()).toHaveLength(1);
    // Removed and closed features are excluded; other ARTs too
    expect(within(art).queryByText("Legacy cleanup")).toBeNull();
    expect(within(art).queryByText("Old feature")).toBeNull();
    expect(within(art).queryByText("Reports")).toBeNull();

    const dt = dataTransfer();
    fireEvent.dragStart(within(art).getByText("Fraud rules").closest(".card")!, { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith("text/plain", "feature:12");
    drop(screen.getByRole("group", { name: "Add swimlane" }), "feature:12");

    await screen.findByRole("group", { name: "Fraud rules / PI 2 Sprint 1" });
    expect(collection("wimeta")).toEqual([
      expect.objectContaining({ id: "12", workItemId: 12, assignedNodeIds: ["n-red"], assignedPiPaths: [PI2] }),
    ]);
    // Dropping it again is a no-op
    const saves = collection("wimeta")[0].__etag;
    drop(cell("Fraud rules / PI 2 Sprint 2"), "feature:12");
    expect(collection("wimeta")[0].__etag).toBe(saves);

    fireEvent.click(screen.getByRole("button", { name: "Remove swimlane Fraud rules" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Fraud rules / PI 2 Sprint 1" })).toBeNull());
    expect(collection("wimeta")[0]).toMatchObject({ assignedNodeIds: [], assignedPiPaths: [] });
    // Lanes with stories can't be removed
    expect(screen.queryByRole("button", { name: "Remove swimlane Payment API" })).toBeNull();
  });

  it("shows assigned features as lanes; removing keeps the PI while other teams are assigned", async () => {
    seedCollection("wimeta", [
      { id: "14", workItemId: 14, assignedNodeIds: ["n-red", "n-blue"], assignedPiPaths: [PI2] },
      { id: "11", workItemId: 11, assignedNodeIds: ["n-red"], assignedPiPaths: ["Fabrikam\\PIs\\PI 1"] },
    ]);
    dataStore.failures.push({ op: "setDocument", error: new Error("Conflict") });
    await renderBoard();
    expect(cell("Wallet / PI 2 Sprint 1")).toBeInTheDocument();
    // Assigned to another PI only → no lane
    expect(screen.queryByRole("group", { name: "Checkout UI / PI 2 Sprint 1" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove swimlane Wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent('Could not remove swimlane "Wallet": Conflict');
    fireEvent.click(screen.getByRole("button", { name: "Remove swimlane Wallet" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Wallet / PI 2 Sprint 1" })).toBeNull());
    expect(collection("wimeta").find((m) => m.id === "14")).toMatchObject({ assignedNodeIds: ["n-blue"], assignedPiPaths: [PI2] });
  });

  it("creates a story in a cell and links it to the swimlane feature", async () => {
    fake.types.push({ name: "Bug", referenceName: "Microsoft.VSTS.WorkItemTypes.Bug" } as any);
    await renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Create in Payment API / PI 2 Sprint 2" }));
    const dialog = screen.getByRole("dialog", { name: "Create work item" });
    expect(within(dialog).getByRole("combobox", { name: "Type" })).toHaveValue("User Story");
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["User Story", "Bug"]);
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "  New thing " } });
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Story points" }), { target: { value: "5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(within(cell("Payment API / PI 2 Sprint 2")).getByText("New thing")).toBeInTheDocument());
    const post = callsTo(/_apis\/wit\/workitems\/\$/, "POST")[0];
    expect(post.path).toContain("$User%20Story");
    expect(post.body).toEqual([
      { op: "add", path: "/fields/System.Title", value: "New thing" },
      { op: "add", path: "/fields/System.AreaPath", value: RED },
      { op: "add", path: "/fields/System.IterationPath", value: PI2_S2 },
      { op: "add", path: `/fields/${SP}`, value: 5 },
    ]);
    const created = fake.workItems.get(Number(post.path.length && Array.from(fake.workItems.keys()).pop()))!;
    expect(created.relations!.map((r) => [r.rel, r.url])).toEqual([[PARENT, url(10)]]);
    expect(screen.queryByRole("dialog")).toBeNull();

    // Independent: a Bug, no points, no parent link
    fireEvent.click(screen.getByRole("button", { name: "Create in Independent / PI 2 IP" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "A bug" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "Bug" } });
    fireEvent.submit(screen.getByRole("dialog"));
    await waitFor(() => expect(within(cell("Independent / PI 2 IP")).getByText("A bug")).toBeInTheDocument());
    const bug = Array.from(fake.workItems.values()).find((w) => w.fields["System.Title"] === "A bug")!;
    expect(bug.fields["System.WorkItemType"]).toBe("Bug");
    expect(bug.fields[SP]).toBeUndefined();
    expect(bug.relations).toEqual([]);

    // Cancel and failures
    fireEvent.click(screen.getByRole("button", { name: "Create in Independent / PI 2 Sprint 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fail(/POST .*workitems\/\$/, 400, "TF401326: nope");
    fireEvent.click(screen.getByRole("button", { name: "Create in Independent / PI 2 Sprint 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Fails" } });
    fireEvent.submit(screen.getByRole("dialog"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not create the work item: TF401326: nope");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("card menu removes a story from the board (to the PI root iteration) and opens it; click opens", async () => {
    await renderBoard();
    const refund = card("Refund card");
    fireEvent.click(within(refund).getByRole("button", { name: "Actions for #101" }));
    expect(sdk.workItemForm.openWorkItem).not.toHaveBeenCalled();
    fireEvent.click(within(refund).getByRole("menuitem", { name: "Open" }));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(101));

    fireEvent.click(within(card("Refund card")).getByRole("button", { name: "Actions for #101" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from board" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Payment API / PI 2 Sprint 2" })?.textContent).not.toContain("Refund card"));
    expect(fake.workItems.get(101)!.fields["System.IterationPath"]).toBe("Fabrikam\\PIs");
    // It is now unplanned
    await within(screen.getByRole("tabpanel", { name: "Team backlog" })).findByText("Refund card");

    sdk.workItemForm.openWorkItem.mockClear();
    const loads = callsTo(/wiql/).length;
    fireEvent.click(card("Charge card"));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(100));
    await waitFor(() => expect(callsTo(/wiql/).length).toBeGreaterThan(loads));

    sdk.workItemForm.openWorkItem.mockRejectedValueOnce(new Error("Form unavailable"));
    fireEvent.click(card("Charge card"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open #100: Form unavailable");
  });

  it("collapses swimlanes individually and all at once", async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Payment API" }));
    expect(screen.queryByRole("group", { name: "Payment API / PI 2 Sprint 1" })).toBeNull();
    expect(cell("Independent / PI 2 Sprint 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand Payment API" }));
    expect(cell("Payment API / PI 2 Sprint 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByRole("group", { name: /Sprint 1$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand Independent" }));
    expect(cell("Independent / PI 2 Sprint 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(cell("Payment API / PI 2 Sprint 1")).toBeInTheDocument();
  });

  it("loads sibling lanes lazily, read-only; the critical dependency count shows without expanding", async () => {
    // Blue's Wallet story needs Red's Refund card (Sprint 2) in Sprint 1 → critical
    fake.workItems.get(102)!.relations = [{ rel: "System.LinkTypes.Dependency-Reverse", url: url(101), attributes: {} }];
    await renderBoard();
    const blueQueries = () => callsTo(/wiql/).filter((c) => c.body.query.includes(`UNDER '${BLUE}'`));
    // A light count query runs with the board; the lanes are not loaded yet
    expect(await screen.findByTitle("Unresolved critical dependencies")).toHaveTextContent("1 critical");
    expect(blueQueries()).toHaveLength(1);
    expect(screen.queryByText("Add wallet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand team Team Blue" }));
    expect(screen.getByText("Loading Team Blue…")).toBeInTheDocument();
    await screen.findByText("Add wallet");
    expect(blueQueries()).toHaveLength(2);
    expect(screen.getByText("Cart page")).toBeInTheDocument();
    expect(screen.getByTitle("Unresolved critical dependencies")).toHaveTextContent("1 critical");
    // Read-only: no drop zones, create buttons or menus for Blue lanes
    expect(screen.queryByRole("group", { name: "Wallet / PI 2 Sprint 1" })).toBeNull();
    const wallet = card("Add wallet");
    expect(wallet).toHaveAttribute("draggable", "false");
    expect(within(wallet).queryByRole("button", { name: /Actions/ })).toBeNull();
    fireEvent.click(wallet);
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(102));
    // Sibling swimlanes collapse too
    fireEvent.click(await screen.findByRole("button", { name: "Collapse Wallet" }));
    expect(screen.queryByText("Add wallet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand Wallet" }));
    await screen.findByText("Add wallet");

    // Collapsing keeps the count; empty lanes (filtered out) are hidden
    fireEvent.click(screen.getByRole("button", { name: "Collapse team Team Blue" }));
    expect(screen.queryByText("Add wallet")).toBeNull();
    expect(screen.getByText("1 critical")).toBeInTheDocument();
    fireEvent.change(mainBar().getByRole("textbox", { name: "Filter text" }), { target: { value: "nothing matches" } });
    fireEvent.click(screen.getByRole("button", { name: "Expand team Team Blue" }));
    expect(await screen.findByText("No stories of Team Blue in PI 2.")).toBeInTheDocument();
  });

  it("reports sibling load failures inside the block", async () => {
    await renderBoard();
    fail(/wiql/, 500, "Blue is down");
    fireEvent.click(screen.getByRole("button", { name: "Expand team Team Blue" }));
    expect(await screen.findByText("Could not load Team Blue: Blue is down")).toBeInTheDocument();
  });

  it("draws dependency lines by criticality, lists external items and filters by criticality", async () => {
    // Refund card (S2) -> Add wallet (Blue, S1): critical. Charge card (closed) -> Refund card: resolved.
    // Refund card -> Reports (Green, IP): healthy. Loose (S1) -> Old story (outside the PI): at risk
    addItem(106, "User Story", "Loose", RED, PI2_S1, "New", {}, [[SUCC, 103]]);
    fake.workItems.get(101)!.relations = [
      { rel: SUCC, url: url(102), attributes: {} },
      { rel: SUCC, url: url(20), attributes: {} },
    ];
    fake.workItems.get(100)!.relations = [{ rel: SUCC, url: url(101), attributes: {} }];
    await renderBoard();
    expect(screen.getByText(/3 stories · 4 dependencies/)).toBeInTheDocument();
    expect(screen.getByText("· 1 critical")).toBeInTheDocument();

    const lines = () =>
      Object.fromEntries(
        Array.from(document.querySelectorAll("path.tb-dep")).map((l) => [l.querySelector("title")!.textContent, l.getAttribute("class")])
      );
    expect(lines()).toEqual({
      "#101 → #102: Critical": "dep-line tb-dep critical",
      "#101 → #20: Healthy": "dep-line tb-dep healthy",
      "#100 → #101: Resolved": "dep-line tb-dep resolved",
      "#106 → #103: At risk": "dep-line tb-dep atRisk",
    });

    // EXTERNAL block grouped by area, placed by iteration; outside-PI items listed separately
    expect(screen.getByText("EXTERNAL")).toBeInTheDocument();
    const wallet = card("Add wallet");
    expect(wallet.closest(".tb-cell")).toBeTruthy();
    const areaTitles = Array.from(document.querySelectorAll(".tb-lane-header.external .tb-lane-title")).map((t) => t.getAttribute("title"));
    expect(areaTitles).toEqual([BLUE, RED, GREEN]);
    expect(card("Old story").closest(".tb-outside")).toHaveTextContent("Outside PI 2");
    expect(card("Reports").closest(".tb-cell")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Critical/ }));
    expect(Object.keys(lines())).not.toContain("#101 → #102: Critical");
    expect(Object.keys(lines())).toHaveLength(3);
    fireEvent.click(screen.getByRole("checkbox", { name: /Critical/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Show dependencies/ }));
    expect(document.querySelectorAll("path.tb-dep")).toHaveLength(0);
  });

  it("filters cards by text/facets, swimlanes and a server-side WIQL clause", async () => {
    addItem(106, "User Story", "Loose story", RED, PI2_IP, "New");
    await renderBoard();
    fireEvent.change(mainBar().getByRole("textbox", { name: "Filter text" }), { target: { value: "refund" } });
    expect(screen.queryByText("Charge card")).toBeNull();
    expect(screen.getByText("Refund card")).toBeInTheDocument();
    fireEvent.click(mainBar().getByRole("button", { name: "Clear filters" }));

    const menu = screen.getByRole("group", { name: "Swimlane filter" });
    expect(within(menu).getAllByRole("checkbox").map((c) => c.parentElement!.textContent!.trim())).toEqual(["#10 Payment API", "Independent"]);
    fireEvent.click(within(menu).getByRole("checkbox", { name: /Independent/ }));
    expect(screen.queryByRole("group", { name: "Payment API / PI 2 Sprint 1" })).toBeNull();
    expect(cell("Independent / PI 2 IP")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("checkbox", { name: /Independent/ }));
    expect(cell("Payment API / PI 2 Sprint 1")).toBeInTheDocument();

    const wiql = screen.getByRole("textbox", { name: "WIQL clause" });
    fireEvent.change(wiql, { target: { value: "[System.Tags] CONTAINS 'MVP'" } });
    fireEvent.keyDown(wiql, { key: "Enter" });
    await waitFor(() => expect(callsTo(/wiql/).some((c) => c.body.query.includes("AND ([System.Tags] CONTAINS 'MVP') ORDER BY"))).toBe(true));
    // The clause is evaluated server-side: no story is tagged MVP, so the board empties.
    await waitFor(() => expect(screen.queryByText("Refund card")).toBeNull());
  });

  it("searches and sorts the Team and ART backlogs", async () => {
    addItem(106, "User Story", "Alpha", RED, P, "New", { [SP]: 1, "Microsoft.VSTS.Common.Priority": 3 });
    addItem(107, "User Story", "Beta", RED, P, "Active", { [SP]: 8, "Microsoft.VSTS.Common.Priority": 1 });
    addItem(108, "User Story", "Gamma", RED, P, "New");
    await renderBoard();
    const titles = () => Array.from(screen.getByRole("tabpanel").querySelectorAll(".card-title")).map((t) => t.textContent);
    expect(titles()).toEqual(["Alpha", "Beta", "Gamma"]);
    const sort = screen.getByRole("combobox", { name: "Sort by" });
    expect(within(sort).queryByRole("option", { name: "WSJF" })).toBeNull();
    fireEvent.change(sort, { target: { value: "priority" } });
    expect(titles()).toEqual(["Beta", "Alpha", "Gamma"]);
    fireEvent.change(sort, { target: { value: "points" } });
    expect(titles()).toEqual(["Beta", "Alpha", "Gamma"]);
    fireEvent.change(sort, { target: { value: "id" } });
    expect(titles()).toEqual(["Alpha", "Beta", "Gamma"]);
    fireEvent.change(sideSearch(), { target: { value: "#107" } });
    expect(titles()).toEqual(["Beta"]);
    fireEvent.change(sideSearch(), { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "ART" }));
    await within(screen.getByRole("tabpanel", { name: "ART backlog" })).findByText("Payment API");
    // Search box is reset per tab
    expect(sideSearch()).toHaveValue("");

    fireEvent.click(within(screen.getByRole("tabpanel")).getByText("Wallet"));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(14));
  });

  it("shows WSJF in the ART tab and sorts by it", async () => {
    const W = (bv: number, tc: number, e: number) => ({
      "Microsoft.VSTS.Common.BusinessValue": bv,
      "Microsoft.VSTS.Common.TimeCriticality": tc,
      "Microsoft.VSTS.Scheduling.Effort": e,
    });
    Object.assign(fake.workItems.get(11)!.fields, W(8, 2, 2));
    Object.assign(fake.workItems.get(12)!.fields, W(1, 1, 4));
    await renderBoard();
    fireEvent.click(screen.getByRole("tab", { name: "ART" }));
    const art = await screen.findByRole("tabpanel", { name: "ART backlog" });
    await within(art).findByText("Checkout UI");
    expect(within(card("Checkout UI")).getByText("WSJF 5")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "wsjf" } });
    const titles = Array.from(art.querySelectorAll(".card-title")).map((t) => t.textContent);
    expect(titles.slice(0, 2)).toEqual(["Checkout UI", "Fraud rules"]);
    fireEvent.click(screen.getByRole("tab", { name: "Team" }));
    expect(await screen.findByText("Nothing unplanned")).toBeInTheDocument();
  });

  it("shows backlog load errors in the sidebar", async () => {
    await renderBoard();
    fail(/wiql/, 500, "Backlog broken");
    fireEvent.click(screen.getByRole("tab", { name: "ART" }));
    const art = await screen.findByRole("tabpanel", { name: "ART backlog" });
    expect(await within(art).findByRole("alert")).toHaveTextContent("Backlog broken");
  });

  it("shows a load error instead of the board", async () => {
    fail(/workitemtypes$/, 500, "Types unavailable");
    await renderView(<TeamBoard />, { nodeId: "n-red" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Types unavailable");
    expect(screen.queryByText("Unplanned")).toBeNull();
  });

  it("refreshes, shows the empty state and a team without area path", async () => {
    for (const id of [100, 101]) fake.workItems.get(id)!.fields["System.IterationPath"] = PI1_S1;
    const config = makeConfig();
    await renderBoard({ config });
    expect(screen.getByText(/No stories of Team Red are planned in PI 2 yet/)).toBeInTheDocument();
    fake.workItems.get(101)!.fields["System.IterationPath"] = PI2_S2;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Refund card");
  });

  it("warns when the team has no area path", async () => {
    const config = makeConfig();
    config.root.children[0].children[0].areaPath = undefined;
    await renderBoard({ config });
    expect(screen.getByText(/Team Red has no area path/)).toBeInTheDocument();
    // Nothing is in scope
    expect(callsTo(/wiql/)[0].body.query).toContain("[System.Id] < 0");
  });

  it("works for a team without an ART parent", async () => {
    const config = makeConfig();
    config.root = { ...config.root.children[0].children[0], children: [] };
    await renderBoard({ config });
    expect(screen.getByText("Charge card")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Expand team/ })).toBeNull();
  });
});
