import { createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { addDays, dateToX, todayIso, toDay, ZOOM_PX } from "../../src/api/roadmap";
import { WorkItemMeta } from "../../src/api/types";
import { RoadmapView } from "../../src/views/RoadmapView";
import { ART_A, callsTo, dataStore, fail, fake, PI1, PI2 } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { dataTransfer, renderView } from "../utils";

const START = "Microsoft.VSTS.Scheduling.StartDate";
const TARGET = "Microsoft.VSTS.Scheduling.TargetDate";
const SUCC = "System.LinkTypes.Dependency-Forward";
const LANE_H = 40;
const PPD = ZOOM_PX.months;

/** Date relative to today (UTC), like the fake's PI dates. */
const D = (n: number) => addDays(todayIso(), n);

const metaColl = () => `wimeta-${fake.projectId}`;
const msColl = () => `milestones-${fake.projectId}`;

function meta(id: number, start: string, end: string, lane?: number, extra: Partial<WorkItemMeta> = {}): WorkItemMeta {
  return { id: String(id), workItemId: id, assignedNodeIds: [], assignedPiPaths: [], plannedStart: start, plannedEnd: end, lane, ...extra };
}

function seed(collection: string, docs: { id: string }[]) {
  dataStore.collections.set(collection, new Map(docs.map((d) => [d.id, { ...JSON.parse(JSON.stringify(d)), __etag: 1 }])));
}

const savedMeta = (id: number) => dataStore.collections.get(metaColl())?.get(String(id));

/**
 * Default plan (ART A): 10 [0..9] lane 0, 11 from Start/Target Date fields [20..29],
 * 14 [25..40] lane 2, 12 [5..15] lane 3; 15 (Closed) unplanned.
 * Dependencies: 10→11 healthy, 11→14 at risk, 12→10 critical, 10→20 (other ART) hidden.
 */
function seedPlan() {
  seed(metaColl(), [meta(10, D(0), D(9), 0), meta(14, D(25), D(40), 2), meta(12, D(5), D(15), 3)]);
  Object.assign(fake.workItems.get(11)!.fields, { [START]: D(20) + "T00:00:00Z", [TARGET]: D(29) + "T00:00:00Z" });
}

const mainBar = () => screen.getAllByRole("search")[0];
const card = (id: number) => screen.getByRole("button", { name: new RegExp(`^#${id} `) });
const px = (el: HTMLElement, prop: "left" | "width" | "top") => parseFloat(el.style[prop]);

async function renderRoadmap(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<RoadmapView />, opts);
  await waitFor(() => expect(screen.queryByText("Loading roadmap…")).not.toBeInTheDocument());
  return r;
}

function dragCard(el: HTMLElement, dx: number, dy = 0) {
  fireEvent.mouseDown(el, { clientX: 100, clientY: 100, button: 0 });
  fireEvent.mouseMove(window, { clientX: 100 + dx / 2, clientY: 100 + dy / 2 });
  fireEvent.mouseMove(window, { clientX: 100 + dx, clientY: 100 + dy });
  fireEvent.mouseUp(window, { clientX: 100 + dx, clientY: 100 + dy });
}

/** jsdom's drag events ignore clientX/clientY in the init dict, so set them explicitly. */
function dropAt(target: HTMLElement, payload: string, clientX: number, clientY: number) {
  const ev = createEvent.drop(target, { dataTransfer: dataTransfer(payload) });
  Object.defineProperties(ev, { clientX: { value: clientX }, clientY: { value: clientY } });
  fireEvent(target, ev);
}

/** The timeline's first day, derived from a rendered card's position. */
function originOf(id: number) {
  const el = card(id);
  return addDays(el.dataset.start!, -px(el, "left") / PPD);
}

describe("Roadmap", () => {
  it("shows a spinner, then planned cards placed by date and lane and an unplanned sidebar", async () => {
    seedPlan();
    await renderView(<RoadmapView />);
    expect(screen.getByText("Loading roadmap…")).toBeInTheDocument();
    await screen.findByRole("button", { name: "#10 Payment API" });

    const c10 = card(10);
    expect(c10.dataset.start).toBe(D(0));
    expect(c10.dataset.end).toBe(D(9));
    expect(px(c10, "width")).toBe(10 * PPD);
    expect(c10.dataset.lane).toBe("0");
    // Falls back to the ADO Start/Target Date fields.
    expect(card(11).dataset.start).toBe(D(20));
    expect(card(11).dataset.end).toBe(D(29));
    // Packed into the first free lane (lane 1 is free for its dates).
    expect(card(11).dataset.lane).toBe("0");
    expect(card(12).dataset.lane).toBe("3");
    expect(px(card(12), "top")).toBe(3 * LANE_H + 4);
    expect(px(card(12), "left") - px(c10, "left")).toBe(5 * PPD);

    const sidebar = screen.getByRole("complementary", { name: "Unplanned items" });
    // Completed (#15 Closed) and Removed items are never offered for planning.
    expect(within(sidebar).getByText("Unplanned (0)")).toBeInTheDocument();
    expect(within(sidebar).queryByText("Old feature")).not.toBeInTheDocument();
    // Removed and other-ART items are excluded.
    expect(screen.queryByText("Legacy cleanup")).not.toBeInTheDocument();
    expect(screen.queryByText("Reports")).not.toBeInTheDocument();
    expect(screen.getByText(/4 planned · 0 unplanned · 4 dependencies/)).toBeInTheDocument();

    const wiql = callsTo(/wiql/)[0].body.query;
    expect(wiql).toContain(`[System.AreaPath] UNDER '${ART_A}'`);
    expect(wiql).toContain(`[System.WorkItemType] IN ('Feature')`);
    expect(wiql).not.toContain("IterationPath");
    // Relations are fetched for dependencies.
    expect(callsTo(/workitemsbatch/)[0].body.$expand).toBe("Relations");
  });

  it("is not available for teams", async () => {
    await renderView(<RoadmapView />, { nodeId: "n-red" });
    expect(screen.getByText(/available for portfolios, solutions and ARTs/)).toBeInTheDocument();
  });

  it("shows the PI band, iterations at ART level and the today line", async () => {
    seedPlan();
    await renderRoadmap();
    const band = screen.getByRole("group", { name: "Program increments" });
    const pi2 = within(band).getByText("PI 2");
    expect(pi2).toHaveClass("rm-pi", "current");
    expect(within(band).getByText("PI 1")).not.toHaveClass("current");
    // PI 2 starts 7 days ago and lasts 35 days.
    expect(px(pi2, "left")).toBe(px(card(10), "left") - 7 * PPD);
    expect(px(pi2, "width")).toBe(35 * PPD);
    const iterations = screen.getByRole("group", { name: "Iterations" });
    expect(within(iterations).getByText("PI 2 Sprint 1")).toBeInTheDocument();
    expect(within(iterations).getByText("PI 1 Sprint 2")).toBeInTheDocument();
    expect(px(screen.getByLabelText("Today line"), "left")).toBe(px(card(10), "left") + PPD / 2);
    // Timeline covers PI 1 (70 days ago) with padding.
    expect(toDay(originOf(10))).toBeLessThan(toDay(D(-70)));
  });

  it("uses Epics at portfolio level without an iterations row", async () => {
    await renderRoadmap({ nodeId: "n-root" });
    const sidebar = screen.getByRole("complementary", { name: "Unplanned items" });
    expect(within(sidebar).getByText("Checkout revamp")).toBeInTheDocument();
    expect(within(sidebar).getByText("Mobile app")).toBeInTheDocument();
    expect(within(sidebar).queryByText("Dropped")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Iterations" })).not.toBeInTheDocument();
    expect(screen.getByText("Roadmap · Epics")).toBeInTheDocument();
  });

  it("zooms between weeks, months and quarters and remembers the choice", async () => {
    seedPlan();
    await renderRoadmap();
    const zoom = screen.getByRole("group", { name: "Zoom" });
    expect(within(zoom).getByRole("button", { name: "Months" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(zoom).getByRole("button", { name: "Weeks" }));
    expect(px(card(10), "width")).toBe(10 * ZOOM_PX.weeks);
    expect(within(zoom).getByRole("button", { name: "Weeks" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".rm-tick")!.textContent).toMatch(/^[A-Z][a-z]{2} \d+$/);
    fireEvent.click(within(zoom).getByRole("button", { name: "Quarters" }));
    expect(px(card(10), "width")).toBe(10 * ZOOM_PX.quarters);
    expect(document.querySelector(".rm-tick")!.textContent).toMatch(/^Q\d \d{4}$/);
    expect(JSON.parse(localStorage.getItem("safe-ado-roadmap-prefs")!).zoom).toBe("quarters");
  });

  it("scrolls to today on load and with the Today button", async () => {
    seedPlan();
    await renderRoadmap();
    const scroll = screen.getByTestId("roadmap-scroll");
    const todayX = px(card(10), "left");
    expect(scroll.scrollLeft).toBe(todayX);
    Object.defineProperty(scroll, "clientWidth", { value: 400, configurable: true });
    scroll.scrollLeft = 0;
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(scroll.scrollLeft).toBe(todayX - 200);
  });

  it("moves a card horizontally, saving the planned dates, ADO dates and PIs", async () => {
    seedPlan();
    await renderRoadmap();
    dragCard(card(10), 7 * PPD);
    await waitFor(() => expect(savedMeta(10).plannedStart).toBe(D(7)));
    expect(savedMeta(10)).toMatchObject({ plannedEnd: D(16), lane: 0, assignedPiPaths: [PI2] });
    await waitFor(() => expect(callsTo(/workitems\/10$/, "PATCH")).toHaveLength(1));
    const ops = callsTo(/workitems\/10$/, "PATCH")[0].body;
    expect(ops).toEqual([
      { op: "add", path: `/fields/${START}`, value: `${D(7)}T00:00:00Z` },
      { op: "add", path: `/fields/${TARGET}`, value: `${D(16)}T00:00:00Z` },
    ]);
    expect(card(10).dataset.start).toBe(D(7));
    // A second move works with the refreshed etag; field names were only fetched once.
    dragCard(card(10), -2 * PPD);
    await waitFor(() => expect(savedMeta(10).plannedStart).toBe(D(5)));
    expect(callsTo(/_apis\/wit\/fields$/)).toHaveLength(1);
    expect(sdk.workItemForm.openWorkItem).not.toHaveBeenCalled();
  });

  it("previews the drag, and ignores drags that end where they started or non-primary buttons", async () => {
    seedPlan();
    await renderRoadmap();
    const el = card(10);
    fireEvent.mouseDown(el, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 100 + 3 * PPD, clientY: 100 });
    expect(card(10).dataset.start).toBe(D(3));
    expect(card(10)).toHaveClass("dragging");
    fireEvent.mouseUp(window, { clientX: 100, clientY: 100 });
    expect(card(10)).not.toHaveClass("dragging");
    fireEvent.mouseDown(el, { clientX: 100, clientY: 100, button: 2 });
    fireEvent.mouseMove(window, { clientX: 200, clientY: 100 });
    fireEvent.mouseUp(window, { clientX: 200, clientY: 100 });
    await new Promise((r) => setTimeout(r, 20));
    expect(savedMeta(10).__etag).toBe(1);
    expect(sdk.workItemForm.openWorkItem).not.toHaveBeenCalled();
  });

  it("auto-assigns current/future PIs but keeps past PIs already assigned", async () => {
    seed(metaColl(), [meta(10, D(0), D(9), 0, { assignedPiPaths: [PI1, "Fabrikam\\PIs\\PI 9"] })]);
    fake.iterationTree.children![0].children!.push({
      id: 999,
      identifier: "pi3",
      name: "PI 3",
      path: "\\Fabrikam\\Iteration\\PIs\\PI 3",
      attributes: { startDate: D(28) + "T00:00:00Z", finishDate: D(90) + "T00:00:00Z" },
    });
    await renderRoadmap();
    dragCard(card(10), 20 * PPD);
    await waitFor(() => expect(savedMeta(10).plannedStart).toBe(D(20)));
    expect(savedMeta(10).assignedPiPaths).toEqual([PI1, "Fabrikam\\PIs\\PI 9", PI2, "Fabrikam\\PIs\\PI 3"]);
  });

  it("resizes from either edge", async () => {
    seedPlan();
    await renderRoadmap();
    dragCard(screen.getByLabelText("Resize start of #10"), -4 * PPD);
    await waitFor(() => expect(savedMeta(10)).toMatchObject({ plannedStart: D(-4), plannedEnd: D(9) }));
    dragCard(screen.getByLabelText("Resize end of #10"), 6 * PPD);
    await waitFor(() => expect(savedMeta(10)).toMatchObject({ plannedStart: D(-4), plannedEnd: D(15) }));
    // Cannot shrink below one day.
    dragCard(screen.getByLabelText("Resize end of #10"), -100 * PPD);
    await waitFor(() => expect(savedMeta(10)).toMatchObject({ plannedStart: D(-4), plannedEnd: D(-4) }));
    expect(px(card(10), "width")).toBe(PPD);
  });

  it("moves a card between lanes, skipping occupied slots", async () => {
    seedPlan();
    await renderRoadmap();
    dragCard(card(10), 0, 1 * LANE_H);
    await waitFor(() => expect(savedMeta(10)?.lane).toBe(1));
    expect(savedMeta(10).plannedStart).toBe(D(0));
    // Lane 3 is taken by #12 on overlapping dates, so the card lands in lane 4.
    dragCard(card(10), 0, 2 * LANE_H);
    await waitFor(() => expect(savedMeta(10)?.lane).toBe(4));
    expect(card(10).dataset.lane).toBe("4");
    // Dragging above the top clamps to lane 0.
    dragCard(card(10), 0, -10 * LANE_H);
    await waitFor(() => expect(savedMeta(10)?.lane).toBe(0));
  });

  it("allows only resizing while a filter is active (like Agile Hive)", async () => {
    seedPlan();
    await renderRoadmap();
    fireEvent.change(within(mainBar()).getByLabelText("Filter text"), { target: { value: "Payment" } });
    expect(screen.getByText(/cards can be resized but not moved/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^#11 / })).not.toBeInTheDocument();
    const etag = savedMeta(10).__etag;
    dragCard(card(10), 2 * PPD, 3 * LANE_H);
    await new Promise((r) => setTimeout(r, 30));
    expect(savedMeta(10).__etag).toBe(etag); // the move was ignored
    dragCard(screen.getByLabelText("Resize end of #10"), 6 * PPD);
    await waitFor(() => expect(savedMeta(10).plannedEnd).toBe(D(15)));
    expect(savedMeta(10).lane).toBe(0);
  });

  it("opens a card on click (no drag) or Enter, then refreshes", async () => {
    seedPlan();
    await renderRoadmap();
    const wiqlBefore = callsTo(/wiql/).length;
    fireEvent.mouseDown(card(12), { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 102, clientY: 101 });
    fireEvent.mouseUp(window, { clientX: 102, clientY: 101 });
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(12));
    await waitFor(() => expect(callsTo(/wiql/).length).toBe(wiqlBefore + 1));
    fireEvent.keyDown(card(14), { key: "Enter" });
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(14));
    fireEvent.keyDown(card(14), { key: "a" });
    expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledTimes(2);
    expect(savedMeta(12).__etag).toBe(1);
  });

  it("plans an unplanned item dropped onto the timeline at the drop date", async () => {
    seedPlan();
    fake.workItems.get(15)!.fields["System.State"] = "Active";
    await renderRoadmap();
    const origin = originOf(10);
    const lanes = screen.getByRole("region", { name: "Roadmap timeline" });
    lanes.getBoundingClientRect = () => ({ left: -300, top: 200, right: 0, bottom: 0, width: 0, height: 0, x: -300, y: 200, toJSON: () => ({}) });
    const item = within(screen.getByRole("complementary", { name: "Unplanned items" })).getByText("Old feature").closest("li")!;
    const dt = dataTransfer();
    fireEvent.dragStart(item, { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith("text/plain", "15");
    fireEvent.dragOver(lanes, { dataTransfer: dt });
    // x = 700 - (-300) = 1000px → day 200; y = 290 - 200 → lane 2 (free at those dates).
    dropAt(lanes, "15", 700 + 2, 290);
    const start = addDays(origin, 1000 / PPD);
    await waitFor(() => expect(savedMeta(15)).toMatchObject({ plannedStart: start, plannedEnd: addDays(start, 20), lane: 2 }));
    await screen.findByRole("button", { name: "#15 Old feature" });
    expect(screen.getByText("Unplanned (0)")).toBeInTheDocument();
    expect(screen.getByText("Nothing to plan.")).toBeInTheDocument();
    // Unknown or empty payloads are ignored.
    fireEvent.drop(lanes, { dataTransfer: dataTransfer("") });
    fireEvent.drop(lanes, { dataTransfer: dataTransfer("999") });
    expect(savedMeta(999)).toBeUndefined();
  });

  it("drops into lane 0 while filtered and uses the portfolio default duration", async () => {
    await renderRoadmap({ nodeId: "n-root" });
    fireEvent.change(within(mainBar()).getByLabelText("Filter text"), { target: { value: "Mobile" } });
    const lanes = screen.getByRole("region", { name: "Roadmap timeline" });
    lanes.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
    dropAt(lanes, "2", 0, 500);
    await waitFor(() => expect(savedMeta(2)).toBeDefined());
    expect(savedMeta(2).lane).toBe(0);
    expect(toDay(savedMeta(2).plannedEnd) - toDay(savedMeta(2).plannedStart)).toBe(59);
    // No PI auto-assignment outside ART level.
    expect(savedMeta(2).assignedPiPaths).toEqual([]);
  });

  it("plans from today with the sidebar Plan button, and searches / sorts the sidebar by stack rank", async () => {
    Object.assign(fake.workItems.get(12)!.fields, { "Microsoft.VSTS.Common.StackRank": 5 });
    Object.assign(fake.workItems.get(14)!.fields, { "Microsoft.VSTS.Common.StackRank": 1 });
    await renderRoadmap();
    const sidebar = screen.getByRole("complementary", { name: "Unplanned items" });
    expect(within(sidebar).getAllByRole("listitem").map((li) => li.textContent!.match(/#(\d+)/)![1])).toEqual(["14", "12", "10", "11"]);
    fireEvent.change(within(sidebar).getByLabelText("Filter text"), { target: { value: "wall" } });
    expect(within(sidebar).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(within(sidebar).getByLabelText("Filter text"), { target: { value: "11" } });
    expect(within(sidebar).getByText("Checkout UI")).toBeInTheDocument();
    fireEvent.click(within(sidebar).getByRole("button", { name: "Plan #11 from today" }));
    await waitFor(() => expect(savedMeta(11)).toMatchObject({ plannedStart: D(0), plannedEnd: D(20), lane: 0, assignedPiPaths: [PI2] }));
    await screen.findByRole("button", { name: "#11 Checkout UI" });
  });

  it("creates, edits and deletes milestones; shows ancestors' milestones only", async () => {
    seedPlan();
    seed(msColl(), [
      { id: "m-root", nodeId: "n-root", title: "Portfolio review", date: D(3), description: "Board meeting" } as any,
      { id: "m-artb", nodeId: "n-artb", title: "ART B demo", date: D(4) } as any,
    ]);
    await renderRoadmap();
    const row = screen.getByRole("group", { name: "Milestones" });
    const inherited = within(row).getByRole("button", { name: "Milestone Portfolio review" });
    expect(inherited).toHaveClass("inherited");
    expect(inherited.getAttribute("title")).toBe(`Portfolio review · ${new Date(D(3)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}\nBoard meeting`);
    expect(px(inherited, "left")).toBe(px(card(10), "left") + 3 * PPD);
    expect(within(row).queryByText("ART B demo")).not.toBeInTheDocument();

    // Create
    fireEvent.click(screen.getByRole("button", { name: "New milestone" }));
    const dialog = screen.getByRole("dialog", { name: "New milestone" });
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "  Release 1 " } });
    fireEvent.change(within(dialog).getByLabelText("Date"), { target: { value: D(12) } });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "Go live" } });
    fireEvent.click(save);
    const created = await within(row).findByRole("button", { name: "Milestone Release 1" });
    expect(created).not.toHaveClass("inherited");
    const stored = Array.from(dataStore.collections.get(msColl())!.values()).find((m: any) => m.title === "Release 1");
    expect(stored).toMatchObject({ nodeId: "n-arta", date: D(12), description: "Go live" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Edit
    fireEvent.click(created);
    const edit = screen.getByRole("dialog", { name: "Edit milestone" });
    expect(within(edit).getByLabelText("Title")).toHaveValue("Release 1");
    fireEvent.change(within(edit).getByLabelText("Title"), { target: { value: "Release 1.0" } });
    fireEvent.click(within(edit).getByRole("button", { name: "Save" }));
    await within(row).findByRole("button", { name: "Milestone Release 1.0" });
    expect(dataStore.collections.get(msColl())!.get(stored.id).title).toBe("Release 1.0");

    // Delete — cancelled, then confirmed
    (window.confirm as any).mockReturnValueOnce(false);
    fireEvent.click(within(row).getByRole("button", { name: "Milestone Release 1.0" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(dataStore.collections.get(msColl())!.has(stored.id)).toBe(true);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(row).queryByRole("button", { name: "Milestone Release 1.0" })).not.toBeInTheDocument());
    expect(dataStore.collections.get(msColl())!.has(stored.id)).toBe(false);

    // Cancel closes without saving
    fireEvent.click(screen.getByRole("button", { name: "New milestone" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports milestone save and delete failures", async () => {
    seed(msColl(), [{ id: "m1", nodeId: "n-arta", title: "PI planning", date: D(1) } as any]);
    await renderRoadmap();
    dataStore.failures.push({ op: "setDocument", error: new Error("quota") });
    fireEvent.click(screen.getByRole("button", { name: "Milestone PI planning" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not save milestone: quota")).toBeInTheDocument();
    dataStore.failures.push({ op: "deleteDocument", error: new Error("locked") });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Could not delete milestone: locked")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Could not delete/)).not.toBeInTheDocument();
  });

  it("draws dependency lines coloured by date criticality and filters them", async () => {
    seedPlan();
    await renderRoadmap();
    const lines = () => Object.fromEntries(Array.from(document.querySelectorAll("path.rm-dep")).map((p) => [p.getAttribute("data-dep"), p.getAttribute("class")]));
    expect(lines()).toEqual({ "10-11": "rm-dep healthy", "11-14": "rm-dep atRisk", "12-10": "rm-dep critical" });
    expect(document.querySelector('[data-dep="12-10"] title')!.textContent).toBe("#12 → #10: Critical");
    const menu = screen.getByRole("group", { name: "Dependency criticality" });
    expect(within(menu).getByText(/Critical \(1\)/)).toBeInTheDocument();
    expect(within(menu).getByText(/At risk \(2\)/)).toBeInTheDocument();
    expect(within(menu).getByText(/Healthy \(1\)/)).toBeInTheDocument();
    expect(within(menu).getByText(/Resolved \(0\)/)).toBeInTheDocument();
    expect(screen.getByText("Dependencies (4)")).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("checkbox", { name: /Critical/ }));
    expect(lines()).toEqual({ "10-11": "rm-dep healthy", "11-14": "rm-dep atRisk" });
    expect(screen.getByText("Dependencies (3)")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("safe-ado-roadmap-prefs")!).crits).not.toContain("critical");
    fireEvent.click(within(menu).getByRole("checkbox", { name: /Critical/ }));
    expect(Object.keys(lines())).toHaveLength(3);

    // Moving the provider past the consumer's end makes the dependency critical (live during drag).
    fireEvent.mouseDown(card(10), { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 100 + 25 * PPD, clientY: 100 });
    expect(lines()["10-11"]).toBe("rm-dep critical");
    fireEvent.mouseUp(window, { clientX: 100 + 25 * PPD, clientY: 100 });
    await waitFor(() => expect(savedMeta(10).plannedStart).toBe(D(25)));
    expect(lines()["10-11"]).toBe("rm-dep critical");
  });

  it("marks done providers as resolved", async () => {
    seedPlan();
    seed(metaColl(), [meta(10, D(0), D(9), 0), meta(14, D(25), D(40), 2), meta(12, D(5), D(15), 3), meta(15, D(50), D(60), 1)]);
    fake.workItems.get(15)!.relations!.push({ rel: SUCC, url: `${fake.baseUrl}/_apis/wit/workItems/14`, attributes: {} });
    await renderRoadmap();
    expect(document.querySelector('[data-dep="15-14"]')).toHaveClass("resolved");
  });

  it("shows edge indicators for dependencies on items that are not on the timeline", async () => {
    seedPlan();
    await renderRoadmap();
    // #20 is on another ART.
    const out = screen.getByLabelText("Hidden consumers of #10");
    expect(out).toHaveClass("right");
    expect(out.getAttribute("title")).toBe("Hidden consumers of #10\nAt risk: #20");
    expect(screen.queryByLabelText("Hidden providers of #10")).not.toBeInTheDocument();

    // Filtering #11 out turns its lines into indicators on both neighbours.
    fireEvent.change(within(mainBar()).getByLabelText("Filter text"), { target: { value: "a" } });
    fireEvent.click(within(within(mainBar()).getByRole("group", { name: "Type filter" })).getByRole("checkbox", { name: "Feature" }));
    fireEvent.change(within(mainBar()).getByLabelText("Filter text"), { target: { value: "" } });
    fireEvent.click(within(within(mainBar()).getByRole("group", { name: "State filter" })).getByRole("checkbox", { name: "Active" }));
    // Only #10 (Active) is left.
    expect(screen.queryByRole("button", { name: /^#11 / })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Hidden consumers of #10").getAttribute("title")).toBe("Hidden consumers of #10\nAt risk: #20\nHealthy: #11");
    const providers = screen.getByLabelText("Hidden providers of #10");
    expect(providers).toHaveClass("left");
    expect(providers.getAttribute("title")).toBe("Hidden providers of #10\nCritical: #12");
    expect(providers.style.background).toBe("rgb(205, 74, 69)");
    expect(document.querySelectorAll("path.rm-dep")).toHaveLength(0);

    // Indicators respect the criticality filter too.
    fireEvent.click(within(screen.getByRole("group", { name: "Dependency criticality" })).getByRole("checkbox", { name: /Critical/ }));
    expect(screen.queryByLabelText("Hidden providers of #10")).not.toBeInTheDocument();
  });

  it("treats cards scrolled out of view as hidden", async () => {
    seedPlan();
    await renderRoadmap();
    const scroll = screen.getByTestId("roadmap-scroll");
    const left10 = px(card(10), "left");
    Object.defineProperty(scroll, "clientWidth", { value: 12 * PPD, configurable: true });
    scroll.scrollLeft = left10;
    fireEvent.scroll(scroll);
    // Only #10 [0..9] and #12 [5..15] are in the viewport.
    expect(Array.from(document.querySelectorAll("path.rm-dep")).map((p) => p.getAttribute("data-dep"))).toEqual(["12-10"]);
    expect(screen.getByLabelText("Hidden consumers of #10").getAttribute("title")).toContain("Healthy: #11");
    // Both ends of 11 → 14 are off-screen: no line, no indicator.
    expect(screen.queryByLabelText("Hidden providers of #14")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Hidden providers of #10")).not.toBeInTheDocument();
  });

  it("shows state, assignee and dates in the extended layout", async () => {
    seedPlan();
    await renderRoadmap();
    expect(within(card(10)).queryByText("Grace Hopper")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Card layout"), { target: { value: "extended" } });
    const c = card(10);
    expect(c).toHaveClass("extended");
    expect(within(c).getByText("Active")).toBeInTheDocument();
    expect(within(c).getByText("Grace Hopper")).toBeInTheDocument();
    expect(within(card(11)).getByText("Unassigned")).toBeInTheDocument();
    expect(px(card(12), "top")).toBe(3 * 76 + 4);
    expect(JSON.parse(localStorage.getItem("safe-ado-roadmap-prefs")!).layout).toBe("extended");
  });

  it("applies the WIQL clause server-side and refreshes on demand", async () => {
    await renderRoadmap();
    const input = screen.getByLabelText("WIQL clause");
    fireEvent.change(input, { target: { value: "[System.Tags] CONTAINS 'MVP'" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(callsTo(/wiql/).at(-1)!.body.query).toContain("AND ([System.Tags] CONTAINS 'MVP') ORDER BY"));
    const n = callsTo(/wiql/).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(callsTo(/wiql/).length).toBe(n + 1));
  });

  it("shows an empty state when nothing is in scope", async () => {
    fake.wiqlOverride = () => ({ workItems: [] });
    await renderRoadmap();
    expect(screen.getByText("No Features in scope")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Roadmap timeline" })).toBeInTheDocument();
  });

  it("shows load errors", async () => {
    fail(/wiql/);
    await renderView(<RoadmapView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Boom");
  });

  it("reports save failures and reloads", async () => {
    seedPlan();
    await renderRoadmap();
    dataStore.failures.push({ op: "setDocument", error: new Error("etag conflict") });
    dragCard(card(10), 3 * PPD);
    expect(await screen.findByText("Could not plan #10: etag conflict")).toBeInTheDocument();
    await waitFor(() => expect(card(10).dataset.start).toBe(D(0)));
    fail(/PATCH _apis\/wit\/workitems\/10/, 400, "TF: read-only");
    dragCard(card(10), 3 * PPD);
    expect(await screen.findByText("Could not plan #10: TF: read-only. The planned dates were not changed.")).toBeInTheDocument();
    // No partial state: the metadata write is rolled back.
    await waitFor(() => expect(savedMeta(10).plannedStart).toBe(D(0)));
    await waitFor(() => expect(card(10).dataset.start).toBe(D(0)));
  });

  it("skips the ADO date fields when the process lacks them or the field list fails", async () => {
    seedPlan();
    fake.fields = fake.fields.filter((f) => f.referenceName !== TARGET);
    const { unmount } = await renderRoadmap();
    dragCard(card(10), 1 * PPD);
    await waitFor(() => expect(savedMeta(10).plannedStart).toBe(D(1)));
    unmount();
    fail(/_apis\/wit\/fields/);
    await renderRoadmap();
    dragCard(card(10), 1 * PPD);
    await waitFor(() => expect(savedMeta(10).plannedStart).toBe(D(2)));
    expect(callsTo(/workitems\/10$/, "PATCH")).toHaveLength(0);
  });

  it("places positions consistently with the date/x helpers", async () => {
    seedPlan();
    await renderRoadmap();
    const origin = originOf(10);
    expect(px(card(14), "left")).toBe(dateToX(D(25), origin, PPD));
  });
});
