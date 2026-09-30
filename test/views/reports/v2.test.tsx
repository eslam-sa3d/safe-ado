import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { findNode } from "../../../src/api/org";
import { Capabilities } from "../../../src/api/permissions";
import { fmtDate } from "../../../src/components/common";
import { SafeContext } from "../../../src/components/context";
import { SafeConfig } from "../../../src/api/types";
import { getProgramIncrements } from "../../../src/api/wit";
import { ReportsView } from "../../../src/views/ReportsView";
import { initials, profileUrl } from "../../../src/views/reports/HeaderWidget";
import * as sdk from "../../sdkMock";
import { ART_A, dataStore, docs, fake, makeConfig, P, PI2, PI2_S1, PI2_S2, RED } from "../../fakeAdo";
import { renderReports, seed, widget } from "./helpers";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const CHILD = "System.LinkTypes.Hierarchy-Forward";
const link = (rel: string, id: number) => ({ rel, url: `${fake.baseUrl}/_apis/wit/workItems/${id}`, attributes: {} });

function addItem(id: number, type: string, title: string, area: string, iteration: string, state: string, relations: [string, number][] = [], extra: Record<string, unknown> = {}) {
  fake.workItems.set(id, {
    id,
    rev: 1,
    fields: { "System.Id": id, "System.Title": title, "System.WorkItemType": type, "System.State": state, "System.AreaPath": area, "System.IterationPath": iteration, "System.TeamProject": "Fabrikam", ...extra },
    relations: relations.map(([rel, target]) => link(rel, target)),
  });
}

/** Renders the dashboard with explicit capabilities (the shared helper always allows everything). */
async function renderWithCan(can: Capabilities, nodeId = "n-arta", config: SafeConfig = makeConfig()) {
  const pis = await getProgramIncrements(config.piRootIteration);
  render(
    <SafeContext.Provider
      value={{ config, saveConfig: vi.fn(), node: findNode(config.root, nodeId)!, selectNode: vi.fn(), pis, pi: pis[1], reloadPis: vi.fn(), can }}
    >
      <ReportsView />
    </SafeContext.Provider>
  );
  await waitFor(() => expect(document.querySelectorAll(".spinner")).toHaveLength(0));
  return pis;
}

const openedWiql = () => {
  const url = sdk.hostNavigation.openNewWindow.mock.calls.at(-1)![0] as string;
  expect(url.startsWith(`${fake.baseUrl}/Fabrikam/_queries/query/?wiql=`)).toBe(true);
  return decodeURIComponent(url.split("wiql=")[1]);
};

describe("Reports header members", () => {
  it("shows avatars or initials and links e-mail identities", async () => {
    const config = makeConfig();
    config.root.children[0].members = [
      { name: "Ada Lovelace", role: "RTE", uniqueName: "ada@fabrikam.com", imageUrl: "https://img/ada.png" },
      { name: "Grace", role: "", uniqueName: "FABRIKAM\\grace" },
      { name: "Paul Allen", role: "PO" },
    ];
    await renderReports({ config });
    const header = widget("Unit");
    const chips = Array.from(header.querySelectorAll(".member-chip"));
    expect(chips[0].querySelector("img.member-avatar")).toHaveAttribute("src", "https://img/ada.png");
    expect(within(header).getByRole("link", { name: "Ada Lovelace" })).toHaveAttribute("href", "mailto:ada@fabrikam.com");
    expect(chips[1].querySelector(".member-initials")).toHaveTextContent("GR");
    expect(within(header).getByText("Grace")).toHaveAttribute("title", "FABRIKAM\\grace");
    expect(within(header).queryByRole("link", { name: "Grace" })).toBeNull();
    expect(chips[2].querySelector(".member-initials")).toHaveTextContent("PA");
  });

  it("derives initials and profile links", () => {
    expect(initials("Ada Byron Lovelace")).toBe("AL");
    expect(initials("  cher ")).toBe("CH");
    expect(initials("")).toBe("?");
    expect(initials("Bob <bob@x.com>")).toBe("BO");
    expect(profileUrl("a@b.c")).toBe("mailto:a@b.c");
    expect(profileUrl("DOMAIN\\a")).toBeUndefined();
    expect(profileUrl(undefined)).toBeUndefined();
  });
});

describe("PI snapshots", () => {
  it("records a completed PI once and labels its numbers as recorded at PI end", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    const r = await renderReports({ pi: pis[0], nodeId: "n-red" });
    const saved = docs("snapshots");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      id: `n-red|${pis[0].identifier}`,
      nodeId: "n-red",
      piPath: pis[0].path,
      piName: "PI 1",
      points: { planned: 2, done: 2, pct: 100 },
      velocity: { value: 1, basis: "Ø all iterations of the PI" },
      sprintVelocity: [
        { name: "PI 1 Sprint 1", done: 2 },
        { name: "PI 1 Sprint 2", done: 0 },
      ],
      load: { load: 2, capacity: 0 },
    });
    expect(saved[0].burnup.days).toHaveLength(28);
    for (const title of ["Story Points Burned", "Velocity", "Load vs. Capacity", "Burnup"]) {
      expect(within(widget(title)).getByText("as recorded at PI end")).toBeInTheDocument();
    }
    expect(within(widget("Velocity")).getByRole("list", { name: "Velocity per iteration" })).toHaveTextContent("PI 1 Sprint 1 2PI 1 Sprint 2 0");
    r.unmount();

    // Later visits read the stored snapshot instead of writing a new one.
    const writes = dataStore.collections.get(`snapshots-${fake.projectId}`)!.get(`n-red|${pis[0].identifier}`).__etag;
    await renderReports({ pi: pis[0], nodeId: "n-red" });
    expect(dataStore.collections.get(`snapshots-${fake.projectId}`)!.get(`n-red|${pis[0].identifier}`).__etag).toBe(writes);
  });

  it("shows stored numbers even when the work items changed since", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    seed("snapshots", [
      {
        id: `n-arta|${pis[0].identifier}`,
        nodeId: "n-arta",
        piPath: pis[0].path,
        piId: pis[0].identifier,
        piName: "PI 1",
        createdAt: ago(40),
        points: { planned: 40, done: 30, pct: 75, unestimated: 0, count: 5 },
        velocity: { value: 30, basis: "PI total", samples: 1 },
        sprintVelocity: [{ name: "PI 1 Sprint 1", path: "x", done: 30 }],
        load: { load: 40, capacity: 50, pct: 80, unestimated: 0 },
        burnup: null,
      },
    ]);
    await renderReports({ pi: pis[0] });
    expect(within(widget("Story Points Burned")).getByText("30 of 40 SP done")).toBeInTheDocument();
    expect(within(widget("Velocity")).getByText("30")).toBeInTheDocument();
    // ARTs show the PI total without the per-iteration list.
    expect(within(widget("Velocity")).queryByRole("list")).toBeNull();
    expect(within(widget("Load vs. Capacity")).getByText("40 SP of 50 SP capacity")).toBeInTheDocument();
    expect(within(widget("Load vs. Capacity")).getByText("as recorded at PI end")).toHaveAttribute("title", `Recorded ${fmtDate(ago(40))}`);
    // No stored burnup: the live chart is shown without the label.
    expect(within(widget("Burnup")).getByRole("img", { name: "Burnup chart" })).toBeInTheDocument();
    expect(within(widget("Burnup")).queryByText("as recorded at PI end")).toBeNull();
  });

  it("doesn't record snapshots for users who can't plan, nor for running PIs", async () => {
    const config = makeConfig();
    const pis = await getProgramIncrements(config.piRootIteration);
    render(
      <SafeContext.Provider
        value={{ config, saveConfig: vi.fn(), node: findNode(config.root, "n-red")!, selectNode: vi.fn(), pis, pi: pis[0], reloadPis: vi.fn(), can: { admin: false, managePis: false, plan: false } }}
      >
        <ReportsView />
      </SafeContext.Provider>
    );
    await waitFor(() => expect(document.querySelectorAll(".spinner")).toHaveLength(0));
    expect(docs("snapshots")).toHaveLength(0);
    expect(screen.queryByText("as recorded at PI end")).toBeNull();
    expect(within(widget("Story Points Burned")).getByText("2 of 2 SP done")).toBeInTheDocument();
  });

  it("keeps showing live numbers when the snapshot can't be written", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    dataStore.failures.push({ op: "setDocument", error: Object.assign(new Error("read only"), { status: 403 }) });
    await renderReports({ pi: pis[0], nodeId: "n-red" });
    expect(screen.queryByText("as recorded at PI end")).toBeNull();
    expect(within(widget("Velocity")).getByText("1")).toBeInTheDocument();
  });

  it("takes nothing for the current PI", async () => {
    await renderReports();
    expect(docs("snapshots")).toHaveLength(0);
  });
});

describe("Creating objectives and risks from the dashboard", () => {
  it("adds a PI objective for the selected unit", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    await renderReports();
    const w = widget("PI Objectives");
    fireEvent.click(within(w).getByRole("button", { name: "Add PI objective" }));
    const dialog = screen.getByRole("dialog", { name: "New PI objective · PI 2" });
    const create = within(dialog).getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: " Ship wallet " } });
    expect(create).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Planned business value"), { target: { value: "8" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Committed" }));
    fireEvent.click(create);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(docs("objectives")).toEqual([
      expect.objectContaining({ title: "Ship wallet", committed: false, plannedBV: 8, actualBV: null, piPath: PI2, piId: pis[1].identifier, nodeId: "n-arta", featureIds: [] }),
    ]);
    expect(within(within(w).getByRole("table", { name: "Uncommitted" })).getByText("Ship wallet")).toBeInTheDocument();
  });

  it("reports save errors and can be cancelled", async () => {
    await renderReports();
    fireEvent.click(within(widget("PI Objectives")).getByRole("button", { name: "Add PI objective" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "X" } });
    fireEvent.change(within(dialog).getByLabelText("Planned business value"), { target: { value: "3" } });
    dataStore.failures.push({ op: "setDocument", error: new Error("nope") });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("Could not save objective: nope")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("adds a risk to the PI with its assessment", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    await renderReports({ nodeId: "n-red" });
    const w = widget("PI Risks");
    fireEvent.click(within(w).getByRole("button", { name: "Add risk" }));
    const dialog = screen.getByRole("dialog", { name: "New risk · PI 2" });
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Vendor late" } });
    fireEvent.change(within(dialog).getByLabelText("Owner"), { target: { value: " Rita " } });
    fireEvent.change(within(dialog).getByLabelText("Probability"), { target: { value: "Likely" } });
    fireEvent.change(within(dialog).getByLabelText("Impact"), { target: { value: "Major" } });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "API contract" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(docs("risks")).toEqual([
      expect.objectContaining({
        title: "Vendor late",
        owner: "Rita",
        description: "API contract",
        probability: "Likely",
        impactLevel: "Major",
        status: "Unroamed",
        impact: "Medium",
        piPath: PI2,
        piId: pis[1].identifier,
        nodeId: "n-red",
      }),
    ]);
    expect(within(w).getByText("Vendor late").closest("tr")).toHaveTextContent("Vendor lateUnroamedHIGHINTERMEDIATE");
  });

  it("reports risk save errors", async () => {
    await renderReports();
    fireEvent.click(within(widget("PI Risks")).getByRole("button", { name: "Add risk" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "X" } });
    dataStore.failures.push({ op: "setDocument", error: new Error("nope") });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("Could not save risk: nope")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables creation with a reason when the user can't plan", async () => {
    await renderWithCan({ admin: false, managePis: false, plan: false });
    for (const [title, name] of [
      ["PI Objectives", "Add PI objective"],
      ["PI Risks", "Add risk"],
    ]) {
      const button = within(widget(title)).getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "You don't have permission to plan in this unit");
    }
  });
});

describe("Open in query", () => {
  it("opens the PI Overview's items (all levels) as an Azure Boards query", async () => {
    await renderReports();
    fireEvent.click(within(widget("PI Overview")).getByRole("button", { name: "Open in query" }));
    await waitFor(() => expect(sdk.hostNavigation.openNewWindow).toHaveBeenCalled());
    expect(openedWiql()).toBe(
      "SELECT [System.Id], [System.WorkItemType], [System.Title], [System.State], [System.AreaPath], [System.IterationPath] FROM WorkItems " +
        "WHERE [System.TeamProject] = @project AND [System.Id] IN (10, 11, 14, 100, 101, 102, 105) ORDER BY [System.Id] ASC"
    );
  });

  it("opens the visible dependencies", async () => {
    await renderReports({ nodeId: "n-red" });
    fireEvent.click(within(widget("Dependency Overview")).getByRole("button", { name: "Open in query" }));
    await waitFor(() => expect(sdk.hostNavigation.openNewWindow).toHaveBeenCalled());
    expect(openedWiql()).toContain("[System.Id] IN (10, 11, 12, 20)");
  });

  it("opens the iteration's items and is disabled for an empty iteration", async () => {
    await renderReports({ nodeId: "n-red" });
    const w = widget("Iteration Overview");
    fireEvent.click(within(w).getByRole("button", { name: "Open in query" }));
    await waitFor(() => expect(sdk.hostNavigation.openNewWindow).toHaveBeenCalled());
    expect(openedWiql()).toContain("[System.Id] IN (100)");
    fireEvent.click(within(w).getByRole("button", { name: "Next iteration" }));
    fireEvent.click(within(w).getByRole("button", { name: "Next iteration" }));
    expect(within(w).getByRole("button", { name: "Open in query" })).toBeDisabled();
    expect(within(w).getByRole("button", { name: "Open in query" })).toHaveAttribute("title", "No work items to open");
  });
});

describe("PI Overview estimated completion and solution lane", () => {
  const cells = (title: string) =>
    Array.from(widget(title).querySelectorAll("tbody tr:not(.overview-lane-header)")).map((tr) => {
      const td = Array.from(tr.querySelectorAll("td"));
      return [td[0].querySelector(".title-link, strong")!.textContent, td[7].textContent];
    });

  it("shows the finish of the latest iteration any child is planned in", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    const [s1, s2] = [pis[1].sprints[0], pis[1].sprints[1]];
    // A feature whose only story is planned on the PI itself, not in an iteration.
    addItem(16, "Feature", "Loose planning", RED, PI2_S1, "New", [[CHILD, 109]]);
    addItem(109, "User Story", "PI-level story", RED, PI2, "New", [[PARENT, 16]], { "Microsoft.VSTS.Scheduling.StoryPoints": 1 });
    addItem(110, "User Story", "Stray", RED, PI2_S2, "New");
    await renderReports();
    expect(cells("PI Overview")).toEqual([
      ["Payment API", fmtDate(s2.finish)],
      ["Checkout UI", fmtDate(s2.finish)],
      ["Wallet", fmtDate(s1.finish)],
      ["Loose planning", "—"],
      ["Without parent", fmtDate(s2.finish)],
    ]);
    fireEvent.click(within(widget("PI Overview")).getByRole("button", { name: "Expand Payment API" }));
    expect(cells("PI Overview").slice(1, 3)).toEqual([
      ["Charge card", fmtDate(s1.finish)],
      ["Refund card", fmtDate(s2.finish)],
    ]);
  });

  it("puts Features linked straight to an Epic into their own lane on a Large Solution", async () => {
    const config = makeConfig({ types: { epic: "Epic", capability: "Capability", feature: "Feature", story: "User Story" } });
    config.root.children = [{ id: "n-sol", name: "Big Solution", level: "solution", areaPath: P, children: config.root.children }];
    fake.states.Capability = fake.states.Feature;
    addItem(30, "Capability", "Checkout platform", ART_A, PI2, "Active", [[PARENT, 1], [CHILD, 31]]);
    fake.workItems.get(1)!.relations!.push(link(CHILD, 30));
    addItem(31, "Feature", "Tokenization", RED, PI2_S1, "New", [[PARENT, 30], [CHILD, 111]]);
    addItem(111, "User Story", "Token vault", RED, PI2_S1, "New", [[PARENT, 31]], { "Microsoft.VSTS.Scheduling.StoryPoints": 2 });
    await renderReports({ config, nodeId: "n-sol" });
    const w = widget("PI Overview");
    expect(w.querySelector("thead th")).toHaveTextContent("Capability");
    const lane = within(w).getByRole("rowgroup", { name: "ART items linked directly to Portfolio" });
    expect(within(lane).getByText("ART items linked directly to Portfolio")).toHaveTextContent("(3)");
    expect(Array.from(lane.querySelectorAll(".title-link")).map((e) => e.textContent)).toEqual(["Payment API", "Checkout UI", "Wallet"]);
    // The lane's stories are not repeated as "Without parent".
    expect(cells("PI Overview").map((c) => c[0])).toEqual(["Checkout platform", "Payment API", "Checkout UI", "Wallet"]);
    fireEvent.click(within(w).getByRole("button", { name: "Open in query" }));
    await waitFor(() => expect(sdk.hostNavigation.openNewWindow).toHaveBeenCalled());
    expect(openedWiql()).toContain("IN (10, 11, 14, 30, 31, 100, 101, 102, 105, 111)");
  });

  it("shows only the lane when no Capability has work in the PI", async () => {
    const config = makeConfig({ types: { epic: "Epic", capability: "Capability", feature: "Feature", story: "User Story" } });
    config.root.children = [{ id: "n-sol", name: "Big Solution", level: "solution", areaPath: P, children: config.root.children }];
    await renderReports({ config, nodeId: "n-sol" });
    expect(cells("PI Overview").map((c) => c[0])).toEqual(["Payment API", "Checkout UI", "Wallet"]);
  });
});

describe("Flow metrics", () => {
  it("shows flow velocity per iteration, flow time, flow load and flow distribution", async () => {
    // Charge card: activated 10 days ago, closed 2 days ago -> 8 d.
    fake.workItems.get(100)!.fields["Microsoft.VSTS.Common.ActivatedDate"] = ago(10);
    // Cart page: first active 5 days ago (history), closed 1 day ago -> 4 d.
    const f105 = fake.workItems.get(105)!.fields;
    fake.revisions.set(105, [
      { rev: 1, fields: { ...f105, "System.State": "New", "System.ChangedDate": ago(60) } },
      { rev: 2, fields: { ...f105, "System.State": "Active", "System.ChangedDate": ago(5) } },
      { rev: 3, fields: { ...f105, "System.State": "Active", "System.ChangedDate": ago(3) } },
      { rev: 4, fields: { ...f105, "System.ChangedDate": ago(1) } },
    ]);
    // Wallet (feature) closed a day ago after 19 days.
    Object.assign(fake.workItems.get(14)!.fields, { "System.State": "Closed", "Microsoft.VSTS.Common.ClosedDate": ago(1), "Microsoft.VSTS.Common.ActivatedDate": ago(20) });
    await renderReports();
    const w = widget("Flow metrics");
    const tile = (name: string) => within(w).getByRole("group", { name });

    expect(tile("Flow velocity")).toHaveTextContent("3items completed in PI 2");
    const bars = Array.from(tile("Flow velocity").querySelectorAll("li"));
    expect(bars.map((b) => b.textContent)).toEqual(["PI 2 Sprint 13", "PI 2 Sprint 20", "PI 2 IP0"]);
    expect(bars[2]).toHaveClass("ip");
    expect(bars[0]).toHaveAttribute("title", "PI 2 Sprint 1: 3 items");

    expect(tile("Flow time")).toHaveTextContent("8 dmedian · average 10.3 d · 3 items");
    expect(tile("Flow load")).toHaveTextContent("2items in progress now");
    expect(tile("Flow distribution")).toHaveTextContent("User Story 67% (2)Feature 33% (1)");
    expect(within(tile("Flow distribution")).getByRole("img")).toHaveAttribute("aria-label", "User Story 67%, Feature 33%");
  });

  it("explains missing data", async () => {
    await renderReports({ nodeId: "n-green" });
    const w = widget("Flow metrics");
    expect(within(w).getByRole("group", { name: "Flow time" })).toHaveTextContent("—no completed items with a start date");
    expect(within(w).getByText("No completed items.")).toBeInTheDocument();
  });

  it("counts completed items without a start date", async () => {
    await renderReports({ nodeId: "n-red" });
    expect(within(widget("Flow metrics")).getByRole("group", { name: "Flow time" })).toHaveTextContent("1 without a start date");
  });

  it("handles PIs without iterations", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    await renderReports({ pi: { ...pis[1], sprints: [] } });
    expect(within(widget("Flow metrics")).getByRole("group", { name: "Flow velocity" }).querySelector("ul")).toBeNull();
  });
});
