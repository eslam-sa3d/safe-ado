import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { burnup, toDay } from "../../../src/api/reports";
import { localToday } from "../../../src/api/rules";
import { ProgramIncrement } from "../../../src/api/types";
import { getProgramIncrements, revisionPaging } from "../../../src/api/wit";
import { fmtDate } from "../../../src/components/common";
import * as sdk from "../../sdkMock";
import { callsTo, dataStore, docs, fake, localDate, makeConfig, PI2, PI2_S1, RED } from "../../fakeAdo";
import { isoDay, objective, renderReports, seed, widget } from "./helpers";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const CHILD = "System.LinkTypes.Hierarchy-Forward";
const SP = "Microsoft.VSTS.Scheduling.StoryPoints";
const link = (rel: string, id: number) => ({ rel, url: `${fake.baseUrl}/_apis/wit/workItems/${id}`, attributes: {} });
const SNAPSHOT_WIDGETS = ["Story Points Burned", "Velocity", "Load vs. Capacity", "Burnup"];
const TODAY_LABEL = () => `as recorded on ${fmtDate(localToday())}`;

function addItem(id: number, type: string, title: string, area: string, iteration: string, state: string, relations: [string, number][] = [], extra: Record<string, unknown> = {}) {
  fake.workItems.set(id, {
    id,
    rev: 1,
    fields: { "System.Id": id, "System.Title": title, "System.WorkItemType": type, "System.State": state, "System.AreaPath": area, "System.IterationPath": iteration, "System.TeamProject": "Fabrikam", ...extra },
    relations: relations.map(([rel, target]) => link(rel, target)),
  });
}

/** PI 1 as if it had ended `daysAgo` local days ago (the fixture's PI 1 ended 43 days ago). */
async function pi1EndedDaysAgo(daysAgo: number): Promise<ProgramIncrement> {
  const pis = await getProgramIncrements("Fabrikam\\PIs");
  return { ...pis[0], finish: `${isoDay(-daysAgo)}T00:00:00Z` };
}

const openedWiql = () => {
  const url = sdk.hostNavigation.openNewWindow.mock.calls.at(-1)![0] as string;
  return decodeURIComponent(url.split("wiql=")[1]);
};

afterEach(() => {
  revisionPaging.maxPages = 50;
});

describe("PI snapshots (v3)", () => {
  it("records a completed PI within 14 days after its end and labels it with the recording day", async () => {
    const pi = await pi1EndedDaysAgo(3);
    const r = await renderReports({ pi, nodeId: "n-red" });
    const saved = docs("snapshots");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      id: `n-red|${pi.identifier}`,
      points: { planned: 2, done: 2, pct: 100 },
      velocity: { value: 1, basis: "Ø all iterations of the PI" },
      load: { load: 2, capacity: 0 },
      burnup: { source: "history" },
    });
    for (const title of SNAPSHOT_WIDGETS) {
      const note = within(widget(title)).getByText(TODAY_LABEL());
      expect(note).toHaveAttribute("title", `Snapshot recorded ${fmtDate(localToday())}`);
    }
    expect(within(widget("Velocity")).getByRole("list", { name: "Velocity per iteration" })).toHaveTextContent("PI 1 Sprint 1 2PI 1 Sprint 2 0");
    // A recorded PI doesn't offer another recording.
    expect(within(widget("Burnup")).queryByRole("button", { name: /Record snapshot now/ })).toBeNull();
    r.unmount();

    // Later visits read the stored snapshot, don't write again and skip the history.
    const etag = saved[0].__etag;
    fake.calls = [];
    await renderReports({ pi, nodeId: "n-red" });
    expect(docs("snapshots")[0].__etag).toBe(etag);
    expect(callsTo(/workitemrevisions/)).toHaveLength(0);
  });

  it("still reads the history when the stored snapshot has no history-based burnup", async () => {
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
    expect(callsTo(/workitemrevisions/)).not.toHaveLength(0);
    expect(within(widget("Story Points Burned")).getByText("30 of 40 SP done")).toBeInTheDocument();
    expect(within(widget("Velocity")).getByText("30")).toBeInTheDocument();
    expect(within(widget("Velocity")).queryByRole("list")).toBeNull();
    const label = `as recorded on ${fmtDate(localDate(Date.now() - 40 * DAY))}`;
    expect(within(widget("Load vs. Capacity")).getByText(label)).toBeInTheDocument();
    // No stored burnup: the live chart without a label, and no "missing" note (a snapshot exists).
    expect(within(widget("Burnup")).getByRole("img", { name: "Burnup chart" })).toBeInTheDocument();
    expect(within(widget("Burnup")).queryByText(label)).toBeNull();
    expect(screen.queryByText(/No snapshot was recorded at PI end/)).toBeNull();
    expect(within(widget("Burnup")).queryByRole("button", { name: /Record snapshot now/ })).toBeNull();
  });

  it("shows a stored history burnup without reading the history", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    const chart = { ...burnup(pis[0], [], toDay(localToday()))!, source: "history" as const };
    seed("snapshots", [
      {
        id: `n-red|${pis[0].identifier}`,
        nodeId: "n-red",
        piPath: pis[0].path,
        piId: pis[0].identifier,
        piName: "PI 1",
        createdAt: ago(43),
        points: { planned: 9, done: 9, pct: 100, unestimated: 0, count: 3 },
        velocity: { value: 4.5, basis: "Ø all iterations of the PI", samples: 2 },
        sprintVelocity: [],
        load: { load: 9, capacity: 0, pct: null, unestimated: 0 },
        burnup: chart,
      },
    ]);
    await renderReports({ pi: pis[0], nodeId: "n-red" });
    expect(callsTo(/workitemrevisions/)).toHaveLength(0);
    expect(within(widget("Burnup")).getByText(`as recorded on ${fmtDate(localDate(Date.now() - 43 * DAY))}`)).toBeInTheDocument();
  });

  it("doesn't record a PI that ended more than 14 days ago; says so and records on demand", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    await renderReports({ pi: pis[0], nodeId: "n-red" });
    expect(docs("snapshots")).toHaveLength(0);
    for (const title of SNAPSHOT_WIDGETS) expect(within(widget(title)).getByText(/No snapshot was recorded at PI end/)).toBeInTheDocument();
    expect(within(widget("Story Points Burned")).getByText("2 of 2 SP done")).toBeInTheDocument();

    // A failed write explains itself and can be retried.
    dataStore.failures.push({ op: "setDocument", error: new Error("nope") });
    fireEvent.click(within(widget("Burnup")).getByRole("button", { name: /Record snapshot now/ }));
    expect(await within(widget("Burnup")).findByRole("alert")).toHaveTextContent("Could not record the snapshot: nope");

    fireEvent.click(within(widget("Burnup")).getByRole("button", { name: /Record snapshot now/ }));
    await waitFor(() => expect(docs("snapshots")).toHaveLength(1));
    expect(docs("snapshots")[0]).toMatchObject({ nodeId: "n-red", piId: pis[0].identifier, burnup: { source: "history" } });
    await waitFor(() => expect(within(widget("Velocity")).getByText(TODAY_LABEL())).toBeInTheDocument());
    expect(screen.queryByText(/No snapshot was recorded at PI end/)).toBeNull();
    expect(within(widget("Burnup")).queryByRole("button", { name: /Record snapshot now/ })).toBeNull();
  });

  it("gates recording on planning permission and records nothing automatically for viewers", async () => {
    const pi = await pi1EndedDaysAgo(2);
    await renderReports({ pi, nodeId: "n-red", can: { plan: false } });
    expect(docs("snapshots")).toHaveLength(0);
    // Within the window nothing is "missing" yet: live numbers without a note.
    expect(screen.queryByText(/No snapshot was recorded at PI end/)).toBeNull();
    const button = within(widget("Burnup")).getByRole("button", { name: /Record snapshot now/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "You don't have permission to plan in this unit");
  });

  it("keeps showing live numbers when the automatic write fails", async () => {
    const pi = await pi1EndedDaysAgo(1);
    dataStore.failures.push({ op: "setDocument", error: Object.assign(new Error("read only"), { status: 403 }) });
    await renderReports({ pi, nodeId: "n-red" });
    expect(screen.queryByText(/as recorded on/)).toBeNull();
    expect(within(widget("Velocity")).getByText("1")).toBeInTheDocument();
    expect(within(widget("Burnup")).getByRole("button", { name: /Record snapshot now/ })).toBeEnabled();
  });

  it("never records from a truncated history: current-state burnup with a note", async () => {
    revisionPaging.maxPages = 0;
    const pi = await pi1EndedDaysAgo(3);
    await renderReports({ pi, nodeId: "n-red" });
    expect(docs("snapshots")).toHaveLength(0);
    const w = widget("Burnup");
    expect(within(w).getByRole("note")).toHaveTextContent("History too large to load completely; showing current-state burnup.");
    const button = within(w).getByRole("button", { name: /Record snapshot now/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "History too large or unavailable; a snapshot needs the complete history");
  });

  it("uses the current state for a running PI's truncated history", async () => {
    revisionPaging.maxPages = 0;
    await renderReports();
    const w = widget("Burnup");
    expect(within(w).getByRole("note")).toHaveTextContent("History too large to load completely");
    // Charge card (5 SP) closed two days ago per its closed date.
    expect(w.querySelector(`rect[data-date="${isoDay(-3)}"] title`)!.textContent).toContain("Burned 0");
    expect(w.querySelector(`rect[data-date="${isoDay(-2)}"] title`)!.textContent).toContain("Burned 5");
    expect(within(w).queryByRole("button", { name: /Record snapshot now/ })).toBeNull();
    expect(docs("snapshots")).toHaveLength(0);
  });

  it("doesn't record from the current-state fallback when the history fails", async () => {
    fake.failures.push({ match: /workitemrevisions/, status: 500, message: "history down" });
    const pi = await pi1EndedDaysAgo(3);
    await renderReports({ pi, nodeId: "n-red" });
    expect(docs("snapshots")).toHaveLength(0);
    expect(within(widget("Burnup")).getByRole("button", { name: /Record snapshot now/ })).toBeDisabled();
  });
});

describe("Objectives and risks match the PI by id first", () => {
  it("counts renamed PIs by id and ignores other PIs that reuse the path", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    const id = pis[1].identifier;
    seed("objectives", [
      { ...objective("Renamed", "n-arta", true, 10, 8, "Fabrikam\\PIs\\Old name"), piId: id },
      { ...objective("Other PI", "n-arta", true, 10, 0, PI2), piId: "some-other-pi" },
      objective("Legacy", "n-arta", true, 5, 5, PI2.toLowerCase()),
    ]);
    seed("risks", [
      { id: "r1", title: "Renamed risk", nodeId: "n-arta", piPath: "x", piId: id, status: "Owned", probability: "Likely", impactLevel: "Major", impact: "High" },
      { id: "r2", title: "Other risk", nodeId: "n-arta", piPath: PI2, piId: "some-other-pi", status: "Owned", probability: "Likely", impactLevel: "Major", impact: "High" },
      { id: "r3", title: "Legacy risk", nodeId: "n-arta", piPath: PI2.toUpperCase(), status: "Owned", probability: "Likely", impactLevel: "Major", impact: "High" },
    ]);
    await renderReports();
    expect(within(widget("Business Value")).getByText("13 of 15 BV (committed)")).toBeInTheDocument();
    const committed = within(widget("PI Objectives")).getByRole("table", { name: "Committed" });
    expect(within(committed).getByText("Renamed")).toBeInTheDocument();
    expect(within(committed).getByText("Legacy")).toBeInTheDocument();
    expect(within(committed).queryByText("Other PI")).toBeNull();
    const risks = widget("PI Risks");
    expect(within(risks).getByText("Renamed risk")).toBeInTheDocument();
    expect(within(risks).getByText("Legacy risk")).toBeInTheDocument();
    expect(within(risks).queryByText("Other risk")).toBeNull();
    const byPi = within(widget("PI Predictability")).getByTitle("PI 2").closest(".bar-row")!;
    expect(byPi).toHaveTextContent("13/15 BV");
  });
});

describe("Creating from the dashboard (v3)", () => {
  it("disables adding milestones without planning permission", async () => {
    await renderReports({ can: { plan: false } });
    const button = within(widget("Milestone Overview")).getByRole("button", { name: "Add milestone" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "You don't have permission to plan in this unit");
  });

  it("allows adding milestones with planning permission", async () => {
    await renderReports();
    fireEvent.click(within(widget("Milestone Overview")).getByRole("button", { name: "Add milestone" }));
    expect(screen.getByRole("dialog", { name: "New milestone" })).toBeInTheDocument();
  });

  it("validates the planned business value range 0–10", async () => {
    await renderReports();
    fireEvent.click(within(widget("PI Objectives")).getByRole("button", { name: "Add PI objective" }));
    const dialog = screen.getByRole("dialog");
    const create = within(dialog).getByRole("button", { name: "Create" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Goal" } });
    const bv = within(dialog).getByLabelText("Planned business value");
    for (const bad of ["11", "-1"]) {
      fireEvent.change(bv, { target: { value: bad } });
      expect(within(dialog).getByRole("alert")).toHaveTextContent("Planned business value must be between 0 and 10.");
      expect(bv).toHaveAttribute("aria-invalid", "true");
      expect(create).toBeDisabled();
    }
    fireEvent.change(bv, { target: { value: "10" } });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(create).toBeEnabled();
    fireEvent.change(bv, { target: { value: "0" } });
    expect(create).toBeEnabled();
  });
});

describe("PI Overview enablers", () => {
  it("shows Enablers as rows with a pill so their stories aren't orphans", async () => {
    const config = makeConfig({ types: { epic: "Epic", capability: "", feature: "Feature", story: "User Story", enabler: "Enabler" } });
    fake.states.Enabler = fake.states.Feature;
    fake.types.push({ name: "Enabler", referenceName: "Custom.Enabler" });
    addItem(40, "Enabler", "Platform upgrade", RED, PI2_S1, "Active", [[PARENT, 1], [CHILD, 112]]);
    fake.workItems.get(1)!.relations!.push(link(CHILD, 40));
    addItem(112, "User Story", "Upgrade runtime", RED, PI2_S1, "New", [[PARENT, 40]], { [SP]: 5 });
    await renderReports({ config });
    const w = widget("PI Overview");
    const row = within(w).getByRole("button", { name: "Platform upgrade" }).closest("tr")!;
    expect(within(row).getByText("Enabler")).toHaveClass("pill");
    expect(within(w).queryByText("Without parent")).toBeNull();
    // Features have no pill.
    expect(within(within(w).getByRole("button", { name: "Payment API" }).closest("tr")!).queryByText("Enabler")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Expand Platform upgrade" }));
    expect(within(w).getByRole("button", { name: "Upgrade runtime" })).toBeInTheDocument();
  });
});

describe("Critical Dependencies follow the Dependency Overview's source", () => {
  it("counts by the chosen source", async () => {
    seed("wimeta", [
      { id: "11", workItemId: 11, assignedNodeIds: [], assignedPiPaths: [], plannedStart: "2026-01-01", plannedEnd: "2026-01-10" },
      { id: "14", workItemId: 14, assignedNodeIds: [], assignedPiPaths: [], plannedStart: "2026-01-11", plannedEnd: "2026-01-20" },
    ]);
    await renderReports();
    const critical = widget("Critical Dependencies");
    // Combined: team planning decides (Checkout UI in Sprint 2 → Wallet in Sprint 1).
    expect(critical.querySelector(".kpi-value")).toHaveTextContent("1");
    expect(within(critical).getByText("by combined")).toBeInTheDocument();
    fireEvent.change(within(widget("Dependency Overview")).getByRole("combobox", { name: "Dependency source" }), { target: { value: "roadmap" } });
    expect(critical.querySelector(".kpi-value")).toHaveTextContent("0");
    expect(within(critical).getByText("by roadmap")).toBeInTheDocument();
  });

  it("reads the saved source on load", async () => {
    dataStore.values.set(`depSource-${fake.projectId}`, "roadmap");
    await renderReports();
    await waitFor(() => expect(within(widget("Critical Dependencies")).getByText("by roadmap")).toBeInTheDocument());
  });

  it("uses team planning on a team", async () => {
    await renderReports({ nodeId: "n-blue" });
    expect(within(widget("Critical Dependencies")).getByText("by team planning")).toBeInTheDocument();
  });
});

describe("Flow metrics (v3)", () => {
  const tile = (name: string) => within(widget("Flow metrics")).getByRole("group", { name });

  it("ART: features and enablers only, load of the selected PI", async () => {
    // Wallet (feature) closed a day ago after 19 days.
    Object.assign(fake.workItems.get(14)!.fields, { "System.State": "Closed", "Microsoft.VSTS.Common.ClosedDate": ago(1), "Microsoft.VSTS.Common.ActivatedDate": ago(20) });
    // Old feature in PI 1 is still active: not load of PI 2.
    fake.workItems.get(15)!.fields["System.State"] = "Active";
    await renderReports();
    expect(tile("Flow velocity")).toHaveTextContent("1features and enablers completed in PI 2");
    expect(tile("Flow time")).toHaveTextContent("19 dmedian · average 19 d · 1 item");
    // Payment API (active, PI 2); the closed stories don't count at this level.
    expect(tile("Flow load")).toHaveTextContent("1features and enablers of PI 2 in progress now");
    expect(tile("Flow distribution")).toHaveTextContent("Feature 100% (1)");
  });

  it("ART: distinguishes Feature, Enabler and Debt work", async () => {
    const config = makeConfig({ types: { epic: "Epic", capability: "", feature: "Feature", story: "User Story", enabler: "Enabler" } });
    fake.states.Enabler = fake.states.Feature;
    addItem(41, "Enabler", "Infra", RED, PI2_S1, "Closed", [], { "Microsoft.VSTS.Common.ClosedDate": ago(1) });
    addItem(42, "Feature", "Refactor", RED, PI2_S1, "Closed", [], { "Microsoft.VSTS.Common.ClosedDate": ago(1), "System.Tags": "Tech Debt; backend" });
    Object.assign(fake.workItems.get(14)!.fields, { "System.State": "Closed", "Microsoft.VSTS.Common.ClosedDate": ago(1) });
    await renderReports({ config });
    expect(tile("Flow distribution")).toHaveTextContent("Debt 33% (1)Enabler 33% (1)Feature 33% (1)");
    expect(within(tile("Flow distribution")).getByRole("img")).toHaveAttribute("aria-label", "Debt 33%, Enabler 33%, Feature 33%");
  });

  it("Team: works without a Bug type", async () => {
    fake.types = fake.types.filter((t) => t.name !== "Bug");
    await renderReports({ nodeId: "n-red" });
    expect(tile("Flow distribution")).toHaveTextContent("Feature 100% (1)");
    expect(callsTo(/_apis\/wit\/wiql/).some((c) => JSON.stringify(c.body).includes("'Bug'"))).toBe(false);
  });

  it("Team: survives a failing type list", async () => {
    fake.failures.push({ match: /_apis\/wit\/workitemtypes$/, status: 500, message: "types down" });
    await renderReports({ nodeId: "n-red" });
    expect(tile("Flow distribution")).toHaveTextContent("Feature 100% (1)");
  });
});

describe("Open in query for large sets", () => {
  it("opens the iteration's scope instead of more than 200 ids", async () => {
    for (let i = 0; i < 201; i++) addItem(2000 + i, "User Story", `Bulk ${i}`, RED, PI2_S1, "New", [], { [SP]: 1 });
    await renderReports({ nodeId: "n-red" });
    const button = within(widget("Iteration Overview")).getByRole("button", { name: "Open in query" });
    expect(button).toHaveAttribute("title", expect.stringContaining("Too many items to list one by one"));
    fireEvent.click(button);
    await waitFor(() => expect(sdk.hostNavigation.openNewWindow).toHaveBeenCalled());
    const wiql = openedWiql();
    expect(wiql).toContain("[System.WorkItemType] IN ('User Story')");
    expect(wiql).toContain(`[System.AreaPath] UNDER '${RED}'`);
    expect(wiql).toContain(`[System.IterationPath] UNDER '${PI2_S1}'`);
    expect(wiql).not.toContain("[System.Id] IN");
  });
});
