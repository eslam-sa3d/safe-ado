import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { findNode } from "../../src/api/org";
import { Capabilities } from "../../src/api/permissions";
import { addDays, todayIso, ZOOM_PX } from "../../src/api/roadmap";
import { SafeConfig, WorkItemMeta } from "../../src/api/types";
import { getProgramIncrements } from "../../src/api/wit";
import { SafeContext } from "../../src/components/context";
import { RoadmapView } from "../../src/views/RoadmapView";
import { callsTo, dataStore, fail, fake, makeConfig, P, PI2, seedDocs } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { dataTransfer } from "../utils";

const START = "Microsoft.VSTS.Scheduling.StartDate";
const TARGET = "Microsoft.VSTS.Scheduling.TargetDate";
const PPD = ZOOM_PX.months;
/** Date relative to the local calendar day (the roadmap's "today"). */
const D = (n: number) => addDays(todayIso(), n);
const metaColl = () => `wimeta-${fake.projectId}`;
const savedMeta = (id: number) => dataStore.collections.get(metaColl())?.get(String(id));

function meta(id: number, start: string, end: string, lane?: number, extra: Partial<WorkItemMeta> = {}): WorkItemMeta {
  return { id: String(id), workItemId: id, assignedNodeIds: [], assignedPiPaths: [], plannedStart: start, plannedEnd: end, lane, ...extra };
}

function seedPlan() {
  seedDocs("wimeta", [meta(10, D(0), D(9), 0), meta(14, D(25), D(40), 2), meta(12, D(5), D(15), 3)]);
  Object.assign(fake.workItems.get(11)!.fields, { [START]: D(20) + "T00:00:00Z", [TARGET]: D(29) + "T00:00:00Z" });
}

const READ_ONLY: Capabilities = { admin: false, managePis: false, plan: false };

async function renderRoadmap(opts: { can?: Capabilities; config?: SafeConfig; nodeId?: string; piRoot?: string } = {}) {
  const config = opts.config ?? makeConfig();
  const nodeId = opts.nodeId ?? "n-arta";
  const pis = await getProgramIncrements(opts.piRoot ?? config.piRootIteration);
  const result = render(
    <SafeContext.Provider
      value={{
        config,
        saveConfig: vi.fn(async () => undefined),
        node: findNode(config.root, nodeId)!,
        selectNode: vi.fn(),
        pis,
        pi: pis[0],
        reloadPis: vi.fn(),
        piRoot: opts.piRoot,
        can: opts.can,
      }}
    >
      <RoadmapView />
    </SafeContext.Provider>
  );
  await waitFor(() => expect(screen.queryByText("Loading roadmap…")).not.toBeInTheDocument());
  return result;
}

const card = (id: number) => screen.getByRole("button", { name: new RegExp(`^#${id} `) });
const px = (el: HTMLElement, prop: "left" | "width" | "top") => parseFloat(el.style[prop]);
const mainBar = () => screen.getAllByRole("search")[0];
const sidebar = () => screen.getByRole("complementary", { name: "Unplanned items" });

function dragCard(el: HTMLElement, dx: number, dy = 0) {
  fireEvent.mouseDown(el, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.mouseMove(window, { clientX: 100 + dx, clientY: 100 + dy });
  fireEvent.mouseUp(window, { clientX: 100 + dx, clientY: 100 + dy });
}

function setViewport(el: HTMLElement, left: number, width: number) {
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  el.scrollLeft = left;
}

describe("Roadmap — virtualization (R1)", () => {
  it("renders only cards and ticks near the viewport, keeping lanes stable", async () => {
    seedPlan();
    await renderRoadmap();
    const ticksBefore = document.querySelectorAll(".rm-tick").length;
    const lane12 = card(12).dataset.lane;
    const left10 = px(card(10), "left");
    const scroll = screen.getByTestId("roadmap-scroll");
    // Window = viewport (60px) ± one viewport: [left10 - 60, left10 + 120].
    setViewport(scroll, left10, 12 * PPD);
    fireEvent.scroll(scroll);
    expect(screen.getByRole("button", { name: /^#10 / })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^#11 / })).toBeInTheDocument(); // D20 = +100px, in the buffer
    expect(screen.queryByRole("button", { name: /^#14 / })).not.toBeInTheDocument(); // D25 = +125px
    expect(card(12).dataset.lane).toBe(lane12);
    expect(document.querySelectorAll(".rm-tick").length).toBeLessThan(ticksBefore);
    // Stats still count every planned item.
    expect(screen.getByText(/4 planned/)).toBeInTheDocument();

    // A wider viewport (window resize) brings #14 back.
    Object.defineProperty(scroll, "clientWidth", { value: 40 * PPD, configurable: true });
    fireEvent(window, new Event("resize"));
    expect(await screen.findByRole("button", { name: /^#14 / })).toBeInTheDocument();
  });

  it("keeps rendering a card while it is dragged out of the window", async () => {
    seedPlan();
    await renderRoadmap();
    const scroll = screen.getByTestId("roadmap-scroll");
    setViewport(scroll, px(card(10), "left"), 12 * PPD);
    fireEvent.scroll(scroll);
    fireEvent.mouseDown(card(10), { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 100 + 60 * PPD, clientY: 100 });
    expect(card(10).dataset.start).toBe(D(60));
    fireEvent.mouseUp(window, { clientX: 100 + 60 * PPD, clientY: 100 });
    await waitFor(() => expect(savedMeta(10).plannedStart).toBe(D(60)));
  });
});

describe("Roadmap — PI bands per cadence (R2)", () => {
  function trainConfig() {
    const pi = (name: string, start: number, end: number) => ({
      id: fake.nextId++,
      identifier: `train-${name}`,
      name,
      path: `\\Fabrikam\\Iteration\\Train PIs\\${name}`,
      attributes: { startDate: D(start) + "T00:00:00Z", finishDate: D(end) + "T00:00:00Z" },
    });
    fake.iterationTree.children!.push({
      id: fake.nextId++,
      identifier: "train-root",
      name: "Train PIs",
      path: "\\Fabrikam\\Iteration\\Train PIs",
      hasChildren: true,
      children: [pi("ART PI 7", -3, 60)],
    });
    const config = makeConfig();
    const artA = config.root.children[0];
    artA.piRootIteration = "Fabrikam\\Train PIs";
    config.root.children[0] = { id: "n-sol", name: "Big Solution", level: "solution", areaPath: P, children: [artA] };
    return config;
  }

  it("shows the unit's own PIs (ART red) and the Solution Train's PIs (blue)", async () => {
    const config = trainConfig();
    await renderRoadmap({ config, piRoot: "Fabrikam\\Train PIs" });
    const own = screen.getByRole("group", { name: "Program increments" });
    expect(own).toHaveAttribute("data-level", "art");
    expect(own.style.getPropertyValue("--pi-color")).toBe("#c62828");
    expect(within(own).getByText("ART PI 7")).toHaveClass("rm-pi", "current");
    const solution = await screen.findByRole("group", { name: "Program increments of Big Solution" });
    expect(solution).toHaveAttribute("data-level", "solution");
    expect(solution.style.getPropertyValue("--pi-color")).toBe("#1565c0");
    expect(within(solution).getByText("Big Solution PIs")).toBeInTheDocument();
    expect(await within(solution).findByText("PI 2")).toHaveClass("current");
    expect(within(solution).getByText("PI 1")).toBeInTheDocument();
  });

  it("derives the own cadence without a piRoot in context and tolerates a failing ancestor cadence", async () => {
    const config = trainConfig();
    const pis = await getProgramIncrements("Fabrikam\\Train PIs");
    fail(/classificationnodes\/Iterations/);
    render(
      <SafeContext.Provider
        value={{ config, saveConfig: vi.fn(), node: findNode(config.root, "n-arta")!, selectNode: vi.fn(), pis, pi: pis[0], reloadPis: vi.fn() }}
      >
        <RoadmapView />
      </SafeContext.Provider>
    );
    const solution = await screen.findByRole("group", { name: "Program increments of Big Solution" });
    await waitFor(() => expect(callsTo(/classificationnodes\/Iterations/).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(solution.querySelectorAll(".rm-pi")).toHaveLength(0);
    expect(screen.getByRole("group", { name: "Program increments" })).toHaveAttribute("data-level", "art");
  });

  it("shows a single band when the whole chain shares one cadence", async () => {
    await renderRoadmap();
    const own = screen.getByRole("group", { name: "Program increments" });
    // No unit sets a PI root: the band belongs to the unit itself.
    expect(own).toHaveAttribute("data-level", "art");
    expect(screen.queryByRole("group", { name: /Program increments of/ })).not.toBeInTheDocument();
  });
});

describe("Roadmap — filters and unplanned sidebar (R5/R9)", () => {
  it("offers quick filters in the main bar and a compact filter bar in the sidebar", async () => {
    seedDocs("quickfilters", [
      { id: "q1", name: "Blue only", filter: { text: "", types: [], states: [], assignees: [], tags: [], wiql: "[System.AreaPath] UNDER 'Fabrikam\\ART A\\Team Blue'" } },
    ]);
    await renderRoadmap();
    const quick = within(mainBar()).getByRole("group", { name: "Quick filters" });
    fireEvent.click(await within(quick).findByRole("checkbox", { name: "Blue only" }));
    await waitFor(() => expect(callsTo(/wiql/).at(-1)!.body.query).toContain("AND ([System.AreaPath] UNDER 'Fabrikam\\ART A\\Team Blue')"));
    await waitFor(() => expect(within(sidebar()).queryByText("Payment API")).not.toBeInTheDocument());

    const side = within(sidebar()).getByRole("search");
    expect(within(side).queryByLabelText("WIQL clause")).not.toBeInTheDocument();
    expect(within(side).queryByRole("group", { name: "Quick filters" })).not.toBeInTheDocument();
    expect(within(side).queryByRole("group", { name: "Priority filter" })).not.toBeInTheDocument();
  });

  it("filters the sidebar by facets and excludes completed and removed items", async () => {
    fake.workItems.get(12)!.fields["System.State"] = "Resolved";
    await renderRoadmap();
    const items = () => within(sidebar()).getAllByRole("listitem").map((li) => li.textContent!.match(/#(\d+)/)![1]);
    // #15 (Closed) is excluded; Resolved is still open.
    expect(items()).toEqual(["10", "11", "12", "14"]);
    const side = within(sidebar()).getByRole("search");
    // The sidebar filter is compact: facets open with the Filters toggle.
    expect(within(side).queryByRole("group", { name: "State filter" })).toBeNull();
    fireEvent.click(within(side).getByRole("button", { name: "Filters" }));
    fireEvent.click(within(within(side).getByRole("group", { name: "State filter" })).getByRole("checkbox", { name: "Resolved" }));
    expect(items()).toEqual(["12"]);
    expect(within(side).getByRole("button", { name: "Filters (1)" })).toHaveAttribute("aria-expanded", "true");
    // The main filter still applies on top.
    fireEvent.change(within(mainBar()).getByLabelText("Filter text"), { target: { value: "nothing matches" } });
    expect(within(sidebar()).getByText("Nothing to plan.")).toBeInTheDocument();
  });
});

describe("Roadmap — planned dates source of truth", () => {
  it("prefers the Start/Target Date fields over the metadata", async () => {
    seedPlan();
    seedDocs("wimeta", [meta(10, D(0), D(9), 0), meta(11, D(1), D(3), 1)]);
    await renderRoadmap();
    expect(card(11).dataset.start).toBe(D(20));
    expect(card(11).dataset.end).toBe(D(29));
  });

  it("writes both and keeps assignedPiIds in sync with assignedPiPaths", async () => {
    seedPlan();
    await renderRoadmap();
    dragCard(card(10), 2 * PPD);
    await waitFor(() => expect(savedMeta(10).plannedStart).toBe(D(2)));
    const pi2 = (await getProgramIncrements("Fabrikam\\PIs")).find((p) => p.path === PI2)!;
    expect(savedMeta(10)).toMatchObject({ assignedPiPaths: [PI2], assignedPiIds: [pi2.identifier] });
    await waitFor(() => expect(fake.workItems.get(10)!.fields[START]).toBe(`${D(2)}T00:00:00Z`));
  });

  it("rolls a new plan back (deletes the metadata) when the date fields are rejected", async () => {
    await renderRoadmap();
    fail(/PATCH _apis\/wit\/workitems\/12/, 400, "TF: StartDate is read-only");
    fireEvent.click(within(sidebar()).getByRole("button", { name: "Plan #12 from today" }));
    expect(await screen.findByText("Could not plan #12: TF: StartDate is read-only. The planned dates were not changed.")).toBeInTheDocument();
    await waitFor(() => expect(savedMeta(12)).toBeUndefined());
    await waitFor(() => expect(within(sidebar()).getByText("Fraud rules")).toBeInTheDocument());
  });

  it("still reports the error when the rollback itself fails", async () => {
    await renderRoadmap();
    fail(/PATCH _apis\/wit\/workitems\/12/, 400, "Rejected");
    dataStore.failures.push({ op: "deleteDocument", error: new Error("offline") });
    fireEvent.click(within(sidebar()).getByRole("button", { name: "Plan #12 from today" }));
    expect(await screen.findByText(/Could not plan #12: Rejected/)).toBeInTheDocument();
  });
});

describe("Roadmap — parent lozenge (H6)", () => {
  it("shows the parent's title on the card and opens the parent on click", async () => {
    seedPlan();
    const f12 = fake.workItems.get(12)!;
    f12.relations = f12.relations!.filter((r) => !r.rel.includes("Hierarchy"));
    await renderRoadmap();
    // A short compact bar keeps its own title; the parent moves to the tooltip.
    if (parseFloat(card(10).style.width) < 260) {
      expect(within(card(10)).queryByRole("button", { name: /Open parent/ })).not.toBeInTheDocument();
      expect(card(10).getAttribute("title")).toContain("Parent: #1 Checkout revamp");
    }
    // The extended layout always shows it.
    fireEvent.change(screen.getByLabelText("Card layout"), { target: { value: "extended" } });
    const lozenge = within(card(10)).getByRole("button", { name: "Open parent #1 Checkout revamp" });
    expect(lozenge).toHaveTextContent("Checkout revamp");
    expect(lozenge).toHaveAttribute("title", "Epic #1: Checkout revamp");
    fireEvent.mouseDown(lozenge);
    fireEvent.click(lozenge);
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(1));
    expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(lozenge, { key: "Enter" });
    expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledTimes(1);
    // #12 has no parent.
    expect(within(card(12)).queryByRole("button", { name: /Open parent/ })).not.toBeInTheDocument();
    // Parents are fetched once, with a small field list.
    expect(callsTo(/workitemsbatch/).some((c) => c.body.fields?.includes("System.Title") && c.body.ids.includes(1))).toBe(true);
  });
});

describe("Roadmap — read-only (no plan permission)", () => {
  it("disables moving, resizing, sidebar planning and milestone editing but still opens items", async () => {
    seedPlan();
    seedDocs("milestones", [{ id: "m1", nodeId: "n-arta", title: "Beta", date: D(3) }]);
    await renderRoadmap({ can: READ_ONLY });
    expect(screen.getByText(/read-only access to this area/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New milestone" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resize start of #10")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resize end of #10")).not.toBeInTheDocument();
    expect(screen.getByText("Read-only: click a card to open it.")).toBeInTheDocument();

    // Drag: no preview, no save.
    fireEvent.mouseDown(card(10), { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 100 + 5 * PPD, clientY: 140 });
    expect(card(10).dataset.start).toBe(D(0));
    fireEvent.mouseUp(window, { clientX: 100 + 5 * PPD, clientY: 140 });
    await new Promise((r) => setTimeout(r, 20));
    expect(savedMeta(10).__etag).toBe(1);
    expect(sdk.workItemForm.openWorkItem).not.toHaveBeenCalled();
    // Click still opens.
    dragCard(card(10), 0);
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(10));

    // Sidebar: nothing to drag, no Plan buttons; drops are ignored.
    fake.workItems.get(15)!.fields["System.State"] = "Active";
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const item = (await within(sidebar()).findByText("Old feature")).closest("li")!;
    expect(item).toHaveAttribute("draggable", "false");
    expect(within(sidebar()).queryByRole("button", { name: /^Plan / })).not.toBeInTheDocument();
    fireEvent.drop(screen.getByRole("region", { name: "Roadmap timeline" }), { dataTransfer: dataTransfer("15") });
    await new Promise((r) => setTimeout(r, 20));
    expect(savedMeta(15)).toBeUndefined();

    // Milestones can't be edited.
    const ms = screen.getByRole("button", { name: "Milestone Beta" });
    expect(ms).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(ms);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("hides the filtered-lanes hint in read-only mode", async () => {
    await renderRoadmap({ can: READ_ONLY });
    fireEvent.change(within(mainBar()).getByLabelText("Filter text"), { target: { value: "Pay" } });
    expect(screen.queryByText(/but not between lanes/)).not.toBeInTheDocument();
  });
});
