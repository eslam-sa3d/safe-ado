import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { WorkItem } from "../../src/api/types";
import { getProgramIncrements } from "../../src/api/wit";
import { RefreshContext } from "../../src/components/common";
import { TeamBoard } from "../../src/views/TeamBoard";
import { BLUE, callsTo, dataStore, fail, fake, P, PI1, PI2, PI2_S1, PI2_S2, RED } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { dataTransfer, renderView } from "../utils";

const SP = "Microsoft.VSTS.Scheduling.StoryPoints";
const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const CHILD = "System.LinkTypes.Hierarchy-Forward";
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
  // Azure DevOps keeps both ends of a link.
  for (const [rel, t] of rels) {
    const reverse = rel === PARENT ? CHILD : rel === CHILD ? PARENT : null;
    const target = fake.workItems.get(t);
    if (reverse && target) (target.relations ??= []).push({ rel: reverse, url: url(id), attributes: {} });
  }
  return item;
}

function seedCollection(name: string, docs: any[]) {
  dataStore.collections.set(`${name}-${fake.projectId}`, new Map(docs.map((d) => [d.id, { ...d, __etag: 1 }])));
}
const collection = (name: string) => Array.from(dataStore.collections.get(`${name}-${fake.projectId}`)?.values() ?? []);

async function renderBoard(opts: Parameters<typeof renderView>[1] = {}, ui = <TeamBoard />) {
  const r = await renderView(ui, { nodeId: "n-red", ...opts });
  await waitFor(() => expect(screen.queryByText("Loading team planning board…")).not.toBeInTheDocument());
  await waitFor(() => expect(screen.queryByText("Loading backlog…")).not.toBeInTheDocument());
  return r;
}

function drop(target: HTMLElement, payload: string) {
  fireEvent.dragOver(target, { dataTransfer: dataTransfer(payload) });
  fireEvent.drop(target, { dataTransfer: dataTransfer(payload) });
}

const patches = (id: number) => callsTo(new RegExp(`^_apis/wit/workitems/${id}$`), "PATCH").map((c) => c.body);
const parentsOf = (id: number) => (fake.workItems.get(id)!.relations ?? []).filter((r) => r.rel === PARENT).map((r) => r.url);

describe("Team board: parent links follow the Feature lane only", () => {
  it("moving between sprints in the Independent lane keeps a non-Feature parent", async () => {
    addItem(106, "User Story", "Epic child", RED, PI2_S1, "New", {}, [[PARENT, 3]]);
    await renderBoard();
    expect(within(cell("Independent / PI 2 Sprint 1")).getByText("Epic child")).toBeInTheDocument();
    drop(cell("Independent / PI 2 Sprint 2"), "story:106");
    await waitFor(() => expect(within(cell("Independent / PI 2 Sprint 2")).getByText("Epic child")).toBeInTheDocument());
    expect(patches(106)).toEqual([[{ op: "add", path: "/fields/System.IterationPath", value: PI2_S2 }]]);
    expect(parentsOf(106)).toEqual([url(3)]);
  });

  it("moving within a feature lane never touches links", async () => {
    await renderBoard();
    drop(cell("Payment API / PI 2 Sprint 1"), "story:101");
    await waitFor(() => expect(within(cell("Payment API / PI 2 Sprint 1")).getByText("Refund card")).toBeInTheDocument());
    expect(patches(101)).toEqual([[{ op: "add", path: "/fields/System.IterationPath", value: PI2_S1 }]]);
    expect(fake.workItems.get(10)!.relations!.some((r) => r.rel === CHILD && r.url === url(101))).toBe(true);
  });

  it("dropping into a Feature lane replaces any parent in ONE request", async () => {
    addItem(106, "User Story", "Epic child", RED, PI2_S1, "New", {}, [[PARENT, 3]]);
    await renderBoard();
    drop(cell("Payment API / PI 2 Sprint 2"), "story:106");
    await waitFor(() => expect(within(cell("Payment API / PI 2 Sprint 2")).getByText("Epic child")).toBeInTheDocument());
    expect(patches(106)).toEqual([
      [
        { op: "add", path: "/fields/System.IterationPath", value: PI2_S2 },
        { op: "remove", path: "/relations/0" },
        { op: "add", path: "/relations/-", value: { rel: PARENT, url: url(10), attributes: {} } },
      ],
    ]);
    expect(parentsOf(106)).toEqual([url(10)]);
    expect(fake.workItems.get(3)!.relations!.some((r) => r.url === url(106))).toBe(false);
  });

  it("from the backlog: Independent removes only a Feature parent", async () => {
    addItem(106, "User Story", "Feature child", RED, P, "New", {}, [[PARENT, 12]]);
    addItem(107, "User Story", "Epic child", RED, P, "New", {}, [[PARENT, 3]]);
    addItem(108, "User Story", "Old feature child", RED, P, "New", {}, [[PARENT, 15]]);
    await renderBoard();
    drop(cell("Independent / PI 2 Sprint 1"), "story:106");
    await waitFor(() => expect(parentsOf(106)).toEqual([]));
    expect(patches(106)).toHaveLength(1);
    // Parent 15 is a Feature that is not on the board (closed, other PI): still a Feature parent.
    drop(cell("Independent / PI 2 Sprint 1"), "story:108");
    await waitFor(() => expect(parentsOf(108)).toEqual([]));
    drop(cell("Independent / PI 2 Sprint 2"), "story:107");
    await waitFor(() => expect(fake.workItems.get(107)!.fields["System.IterationPath"]).toBe(PI2_S2));
    expect(parentsOf(107)).toEqual([url(3)]);
  });

  it("a parent known only from the feature side is replaced add-first, rolled back if the removal fails", async () => {
    // #101's link to #10 exists only on the feature's side here.
    fake.workItems.get(101)!.relations = [];
    seedCollection("wimeta", [{ id: "12", workItemId: 12, assignedNodeIds: ["n-red"], assignedPiPaths: [PI2] }]);
    await renderBoard();
    const childOf = (feature: number) => fake.workItems.get(feature)!.relations!.some((r) => r.rel === CHILD && r.url === url(101));
    fail(/PATCH _apis\/wit\/workitems\/10$/, 409, "Feature locked", { once: true });
    drop(cell("Fraud rules / PI 2 Sprint 2"), "story:101");
    expect(await screen.findByText("Could not move #101: Feature locked")).toBeInTheDocument();
    // The new link was rolled back; the old one is untouched.
    expect(parentsOf(101)).toEqual([]);
    expect(childOf(10)).toBe(true);
    expect(childOf(12)).toBe(false);

    drop(cell("Fraud rules / PI 2 Sprint 2"), "story:101");
    await waitFor(() => expect(within(cell("Fraud rules / PI 2 Sprint 2")).getByText("Refund card")).toBeInTheDocument());
    expect(parentsOf(101)).toEqual([url(12)]);
    expect(childOf(10)).toBe(false);
  });
});

describe("Team board: swimlane assignments", () => {
  it("keeps Assigned PI ids in step and enforces the 5-PI cap", async () => {
    seedCollection("wimeta", [
      { id: "12", workItemId: 12, assignedNodeIds: ["n-blue"], assignedPiPaths: ["a", "b", "c", "d", "e"], assignedPiIds: ["1", "2", "3", "4", "5"] },
    ]);
    await renderBoard();
    drop(screen.getByRole("group", { name: "Add swimlane" }), "feature:12");
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not add swimlane for #12: A work item can be assigned to at most 5 PIs.");
    expect(collection("wimeta")[0].__etag).toBe(1);

    const pi2 = (await getProgramIncrements("Fabrikam\\PIs")).find((p) => p.name === "PI 2")!;
    seedCollection("wimeta", [{ id: "12", workItemId: 12, assignedNodeIds: ["n-blue"], assignedPiPaths: [PI1] }]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Fraud rules / PI 2 Sprint 1" })).toBeNull());
    drop(screen.getByRole("group", { name: "Add swimlane" }), "feature:12");
    await screen.findByRole("group", { name: "Fraud rules / PI 2 Sprint 1" });
    expect(collection("wimeta")[0]).toMatchObject({ assignedNodeIds: ["n-blue", "n-red"], assignedPiPaths: [PI1, PI2], assignedPiIds: ["", pi2.identifier] });
  });

  it("removing the last team drops the PI path and id together", async () => {
    const pi2 = (await getProgramIncrements("Fabrikam\\PIs")).find((p) => p.name === "PI 2")!;
    seedCollection("wimeta", [
      { id: "14", workItemId: 14, assignedNodeIds: ["n-red"], assignedPiPaths: [PI1, PI2], assignedPiIds: ["x", pi2.identifier] },
    ]);
    await renderBoard();
    fireEvent.click(screen.getByRole("button", { name: "Remove swimlane Wallet" }));
    await waitFor(() => expect(collection("wimeta")[0]).toMatchObject({ assignedNodeIds: [], assignedPiPaths: [PI1], assignedPiIds: ["x"] }));
  });
});

describe("Team board: cached side data", () => {
  function WithTick() {
    const [tick, setTick] = useState(0);
    return (
      <RefreshContext.Provider value={tick}>
        <button onClick={() => setTick((t) => t + 1)}>Global refresh</button>
        <TeamBoard />
      </RefreshContext.Provider>
    );
  }

  it("opening a card reloads only the main block; the global refresh and board changes reload the rest", async () => {
    const pi1 = (await getProgramIncrements("Fabrikam\\PIs")).find((p) => p.name === "PI 1")!;
    await renderBoard({ pi: pi1 }, <WithTick />);
    const revisions = () => callsTo(/workitemrevisions/).length;
    const blue = () => callsTo(/wiql/).filter((c) => c.body.query.includes(`UNDER '${BLUE}'`)).length;
    const red = () => callsTo(/wiql/).filter((c) => c.body.query.includes(`UNDER '${RED}'`) && c.body.query.includes(PI1)).length;
    await waitFor(() => expect(revisions()).toBe(1));
    await waitFor(() => expect(blue()).toBe(1));
    const before = red();

    fireEvent.click(card("Old story"));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(103));
    await waitFor(() => expect(red()).toBe(before + 1));
    await waitFor(() => expect(screen.getByText("Old story")).toBeInTheDocument());
    expect(revisions()).toBe(1);
    expect(blue()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Global refresh" }));
    await waitFor(() => expect(revisions()).toBe(2));
    await waitFor(() => expect(blue()).toBe(2));
  });

  it("a board change reloads sibling counts; a card open does not reload an expanded sibling", async () => {
    await renderBoard();
    const blue = () => callsTo(/wiql/).filter((c) => c.body.query.includes(`UNDER '${BLUE}'`)).length;
    await waitFor(() => expect(blue()).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Expand team Team Blue" }));
    await screen.findByText("Add wallet");
    expect(blue()).toBe(2);

    fireEvent.click(card("Charge card"));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(100));
    await new Promise((r) => setTimeout(r, 50));
    expect(blue()).toBe(2);

    drop(cell("Independent / PI 2 IP"), "story:101");
    // Summary + expanded block reload after the change.
    await waitFor(() => expect(blue()).toBe(4));
  });
});

describe("Team board: sidebar queries", () => {
  it("applies quick filter WIQL and excludes closed states server-side", async () => {
    addItem(106, "User Story", "Tagged", RED, P, "New", { "System.Tags": "MVP" });
    addItem(107, "User Story", "Untagged", RED, P, "New");
    seedCollection("quickfilters", [{ id: "q1", name: "MVP only", filter: { text: "", types: [], states: [], assignees: [], tags: [], wiql: "[System.Tags] CONTAINS 'MVP'" } }]);
    await renderBoard();
    const panel = () => screen.getByRole("tabpanel", { name: "Team backlog" });
    await within(panel()).findByText("Untagged");
    const teamQuery = callsTo(/wiql/).map((c) => c.body.query).find((q) => q.includes(`UNDER '${RED}'`) && !q.includes("IterationPath"))!;
    expect(teamQuery).toContain("([System.WorkItemType] = 'User Story' AND [System.State] NOT IN ('Closed', 'Removed'))");
    expect(teamQuery).toContain("[System.WorkItemType] = 'Bug'");

    const menu = within(panel()).getByRole("group", { name: "Quick filters" });
    fireEvent.click(await within(menu).findByLabelText("MVP only"));
    await waitFor(() => expect(within(panel()).queryByText("Untagged")).toBeNull());
    expect(within(panel()).getByText("Tagged")).toBeInTheDocument();
    expect(callsTo(/wiql/).some((c) => c.body.query.includes("AND ([System.Tags] CONTAINS 'MVP') ORDER BY") && !c.body.query.includes("IterationPath"))).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "ART" }));
    const art = await screen.findByRole("tabpanel", { name: "ART backlog" });
    await within(art).findByText("Fraud rules");
  });

  it("the ART tab applies quick filter WIQL too", async () => {
    seedCollection("quickfilters", [{ id: "q1", name: "Wallet only", filter: { text: "", types: [], states: [], assignees: [], tags: [], wiql: "[System.Title] = 'Wallet'" } }]);
    await renderBoard();
    fireEvent.click(screen.getByRole("tab", { name: "ART" }));
    const art = await screen.findByRole("tabpanel", { name: "ART backlog" });
    await within(art).findByText("Fraud rules");
    fireEvent.click(await within(within(art).getByRole("group", { name: "Quick filters" })).findByLabelText("Wallet only"));
    await waitFor(() => expect(within(art).queryByText("Fraud rules")).toBeNull());
    expect(within(art).getByText("Wallet")).toBeInTheDocument();
  });
});

describe("Team board: filters", () => {
  it("computes the load from all stories, whatever the filter shows", async () => {
    await renderBoard();
    expect(screen.getByRole("button", { name: "Load 5 of capacity not set for PI 2 Sprint 1" })).toBeInTheDocument();
    fireEvent.change(mainBar().getByRole("textbox", { name: "Filter text" }), { target: { value: "refund" } });
    expect(screen.getByRole("button", { name: "Load 5 of capacity not set for PI 2 Sprint 1" })).toBeInTheDocument();

    const wiql = screen.getByRole("textbox", { name: "WIQL clause" });
    fireEvent.change(wiql, { target: { value: "[System.Tags] CONTAINS 'MVP'" } });
    fireEvent.keyDown(wiql, { key: "Enter" });
    await waitFor(() => expect(screen.queryByText("Refund card")).toBeNull());
    expect(screen.getByRole("button", { name: "Load 5 of capacity not set for PI 2 Sprint 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load 3 of capacity not set for PI 2 Sprint 2" })).toBeInTheDocument();
  });

  it("hides the team's empty feature lanes while filtering", async () => {
    seedCollection("wimeta", [{ id: "14", workItemId: 14, assignedNodeIds: ["n-red"], assignedPiPaths: [PI2] }]);
    await renderBoard();
    expect(cell("Wallet / PI 2 Sprint 1")).toBeInTheDocument();
    fireEvent.change(mainBar().getByRole("textbox", { name: "Filter text" }), { target: { value: "refund" } });
    expect(screen.queryByRole("group", { name: "Wallet / PI 2 Sprint 1" })).toBeNull();
    expect(cell("Payment API / PI 2 Sprint 1")).toBeInTheDocument();
    expect(cell("Independent / PI 2 IP")).toBeInTheDocument();
    fireEvent.change(mainBar().getByRole("textbox", { name: "Filter text" }), { target: { value: "" } });
    expect(cell("Wallet / PI 2 Sprint 1")).toBeInTheDocument();
  });

  it("lists sibling features in the swimlane filter once loaded", async () => {
    await renderBoard();
    const options = () =>
      within(screen.getByRole("group", { name: "Swimlane filter" }))
        .getAllByRole("checkbox")
        .map((c) => c.parentElement!.textContent!.trim());
    expect(options()).toEqual(["#10 Payment API", "Independent"]);
    fireEvent.click(screen.getByRole("button", { name: "Expand team Team Blue" }));
    await screen.findByText("Add wallet");
    await waitFor(() => expect(options()).toEqual(["#10 Payment API", "#11 Checkout UI", "#14 Wallet", "Independent"]));
    fireEvent.click(within(screen.getByRole("group", { name: "Swimlane filter" })).getByRole("checkbox", { name: /Wallet/ }));
    expect(screen.queryByRole("group", { name: "Payment API / PI 2 Sprint 1" })).toBeNull();
    expect(screen.getByText("Add wallet")).toBeInTheDocument();
    expect(screen.queryByText("Cart page")).toBeNull();
  });
});

