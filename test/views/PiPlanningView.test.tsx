import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { findNode } from "../../src/api/org";
import { ProgramIncrement, SafeConfig } from "../../src/api/types";
import { getProgramIncrements } from "../../src/api/wit";
import { SafeContext, SafeContextValue } from "../../src/components/context";
import { PiPlanningView } from "../../src/views/PiPlanningView";
import { ART_A, callsTo, dataStore, docs, fake, makeConfig, PI1, PI2, seedDocs } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { renderView } from "../utils";

type Json = any;

async function pi2(): Promise<ProgramIncrement> {
  return (await getProgramIncrements(makeConfig().piRootIteration)).find((p) => p.name === "PI 2")!;
}

const key = (c: string) => `${c}-${fake.projectId}`;
function seed(collection: "planreviews" | "improvements", list: Json[]) {
  dataStore.collections.set(key(collection), new Map(list.map((d) => [d.id, { ...d, __etag: 1 }])));
}
const stored = (collection: "planreviews" | "improvements"): Json[] => Array.from(dataStore.collections.get(key(collection))?.values() ?? []);

const section = (name: string) => screen.getByRole("region", { name });
const row = (label: string) => screen.getByRole("row", { name: label });

async function renderPlanning(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<PiPlanningView />, opts);
  await screen.findByRole("heading", { name: "PI summary" });
  return r;
}

/** Renders with explicit capabilities / openView (renderView has no knobs for those). */
async function renderWith(extra: Partial<SafeContextValue>, nodeId = "n-arta", config: SafeConfig = makeConfig()) {
  const pis = await getProgramIncrements(config.piRootIteration);
  const value: SafeContextValue = {
    config,
    saveConfig: vi.fn(),
    node: findNode(config.root, nodeId)!,
    selectNode: vi.fn(),
    pis,
    pi: pis.find((p) => p.name === "PI 2"),
    reloadPis: vi.fn(),
    ...extra,
  };
  render(
    <SafeContext.Provider value={value}>
      <PiPlanningView />
    </SafeContext.Provider>
  );
  await screen.findByRole("heading", { name: "PI summary" });
  return value;
}

describe("PI Planning view", () => {
  it("shows a hint when no PI is selected", async () => {
    await renderView(<PiPlanningView />, { pi: null });
    expect(screen.getByRole("heading", { name: "PI Planning" })).toBeInTheDocument();
    expect(screen.getByText(/Select a Program Increment/)).toBeInTheDocument();
  });

  it("shows a spinner while loading, then the four sections", async () => {
    await renderView(<PiPlanningView />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await screen.findByRole("heading", { name: "PI summary" });
    for (const name of ["PI summary", "Plan review", "Confidence vote", "Inspect & Adapt"]) expect(section(name)).toBeInTheDocument();
    expect(within(section("Plan review")).getAllByRole("row").slice(1).map((r) => r.textContent)).toEqual([
      expect.stringContaining("ART A"),
      expect.stringContaining("Team Red"),
      expect.stringContaining("Team Blue"),
    ]);
    expect(screen.queryByText(/read-only|not change it/)).not.toBeInTheDocument();
  });

  it("shows load errors", async () => {
    dataStore.failures.push({ op: "getDocuments", error: Object.assign(new Error("denied"), { status: 403 }) });
    await renderPlanning();
    expect(await screen.findByText("denied")).toBeInTheDocument();
  });

  describe("PI summary", () => {
    it("counts objectives, committed BV and unresolved risks per unit for this PI", async () => {
      const pi = await pi2();
      seedDocs("objectives", [
        { id: "o1", nodeId: "n-red", piPath: PI2, title: "A", committed: true, plannedBV: 8, actualBV: 7, featureIds: [] },
        { id: "o2", nodeId: "n-red", piPath: PI2, title: "B", committed: false, plannedBV: 3, actualBV: 2, featureIds: [] },
        { id: "o3", nodeId: "n-blue", piPath: "renamed", piId: pi.identifier, title: "C", committed: true, plannedBV: 10, actualBV: 5, featureIds: [] },
        { id: "o4", nodeId: "n-arta", piPath: PI2, title: "D", committed: true, plannedBV: 6, actualBV: null, featureIds: [] },
        { id: "o5", nodeId: "n-red", piPath: PI1, title: "old", committed: true, plannedBV: 9, actualBV: 9, featureIds: [] },
        { id: "o6", nodeId: "n-green", piPath: PI2, title: "other ART", committed: true, plannedBV: 9, actualBV: 9, featureIds: [] },
      ]);
      const risk = (id: string, nodeId: string, status: string, piPath = PI2) => ({ id, nodeId, status, piPath, title: id, description: "", owner: "", impact: "Low", createdAt: "" });
      seedDocs("risks", [risk("r1", "n-red", "Unroamed"), risk("r2", "n-red", "Resolved"), risk("r3", "n-blue", "Owned"), risk("r4", "n-red", "Unroamed", PI1), risk("r5", "n-green", "Unroamed")]);
      await renderPlanning();
      const s = within(section("PI summary"));
      expect(s.getByText("Committed BV", { selector: ".stat-label" }).previousSibling).toHaveTextContent("24");
      expect(s.getByText("Objectives", { selector: ".stat-label" }).previousSibling).toHaveTextContent("4");
      const risks = s.getByText("Unresolved risks", { selector: ".stat-label" }).closest(".stat")!;
      expect(risks).toHaveTextContent("2");
      expect(risks).toHaveClass("warn");
      const cells = (label: string) => within(row(label)).getAllByRole("cell").slice(1).map((c) => c.textContent);
      expect(cells("ART A summary")).toEqual(["1 (1)", "6", "0", "0"]);
      expect(cells("Team Red summary")).toEqual(["2 (1)", "8", "1", "1"]);
      expect(cells("Team Blue summary")).toEqual(["1 (1)", "10", "1", "0"]);
    });

    it("has no warning tone without unroamed risks and hides links outside the shell", async () => {
      await renderPlanning();
      expect(screen.getByText("Unresolved risks", { selector: ".stat-label" }).closest(".stat")).not.toHaveClass("warn");
      expect(screen.queryByRole("button", { name: "PI Objectives" })).not.toBeInTheDocument();
    });

    it("links to the Objectives and Risks tabs", async () => {
      const openView = vi.fn();
      await renderWith({ openView });
      fireEvent.click(screen.getByRole("button", { name: "PI Objectives" }));
      expect(openView).toHaveBeenCalledWith("objectives");
      fireEvent.click(screen.getByRole("button", { name: "ROAM risks" }));
      expect(openView).toHaveBeenCalledWith("risks");
    });
  });

  describe("plan review", () => {
    it("records status and notes per unit and rolls them up", async () => {
      const pi = await pi2();
      await renderPlanning();
      const panel = within(section("Plan review"));
      expect(panel.getByText("Draft plan review: Not started")).toBeInTheDocument();

      fireEvent.change(panel.getByLabelText("Team Red Draft plan review status"), { target: { value: "Approved" } });
      await waitFor(() => expect(stored("planreviews")).toHaveLength(1));
      expect(stored("planreviews")[0]).toMatchObject({
        id: `n-red|${pi.identifier}`,
        nodeId: "n-red",
        piPath: PI2,
        piId: pi.identifier,
        draft: { status: "Approved", notes: "" },
        final: { status: "Not started", notes: "" },
      });
      expect(await panel.findByText("Draft plan review: In review")).toBeInTheDocument();

      // Second write to the same doc uses the fresh etag.
      const notes = panel.getByLabelText("Team Red Draft plan review notes");
      fireEvent.change(notes, { target: { value: "Dependencies on Blue" } });
      fireEvent.blur(notes);
      await waitFor(() => expect(stored("planreviews")[0].draft.notes).toBe("Dependencies on Blue"));
      expect(stored("planreviews")[0].draft.status).toBe("Approved");
      expect(stored("planreviews")[0].updatedAt).toBeTruthy();

      // Unchanged blur does not save.
      const etag = stored("planreviews")[0].__etag;
      fireEvent.blur(notes);
      await new Promise((r) => setTimeout(r, 20));
      expect(stored("planreviews")[0].__etag).toBe(etag);

      fireEvent.change(panel.getByLabelText("Team Blue Draft plan review status"), { target: { value: "Needs changes" } });
      expect(await panel.findByText("Draft plan review: Needs changes")).toBeInTheDocument();
      expect(panel.getByLabelText("Team Blue Draft plan review status")).toHaveClass("pp-needs-changes");
    });

    it("shows Approved when every unit approved (existing docs)", async () => {
      const pi = await pi2();
      const approved = (nodeId: string) => ({
        id: `${nodeId}|${pi.identifier}`,
        nodeId,
        piPath: PI2,
        piId: pi.identifier,
        draft: { status: "Approved", notes: "ok" },
        final: { status: "In review", notes: "" },
      });
      seed("planreviews", [approved("n-arta"), approved("n-red"), approved("n-blue")]);
      await renderPlanning();
      const panel = within(section("Plan review"));
      expect(panel.getByText("Draft plan review: Approved")).toBeInTheDocument();
      expect(panel.getByText("Final plan review: In review")).toBeInTheDocument();
      expect(panel.getAllByDisplayValue("ok")).toHaveLength(3);
    });

    it("reports save errors", async () => {
      await renderPlanning();
      dataStore.failures.push({ op: "setDocument", error: new Error("quota") });
      fireEvent.change(screen.getByLabelText("ART A Final plan review status"), { target: { value: "In review" } });
      expect(await screen.findByText("Could not save plan review: quota")).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText("Dismiss"));
      expect(screen.queryByText(/Could not save/)).not.toBeInTheDocument();
    });
  });

  describe("confidence vote", () => {
    it("adds anonymous votes (serialised) and shows average and distribution", async () => {
      const pi = await pi2();
      await renderPlanning();
      const panel = within(section("Confidence vote"));
      fireEvent.click(panel.getByLabelText("Vote 4 for Team Red"));
      fireEvent.click(panel.getByLabelText("Vote 4 for Team Red"));
      fireEvent.click(panel.getByLabelText("Vote 5 for Team Red"));
      await waitFor(() => expect(docs("votes")[0]?.counts).toEqual([0, 0, 0, 2, 1]));
      expect(docs("votes")[0]).toMatchObject({ id: `n-red|${pi.identifier}`, nodeId: "n-red", piPath: PI2, piId: pi.identifier });
      expect(docs("votes")[0].votedAt).toMatch(/^\d{4}-/);
      const red = within(row("Team Red vote"));
      await waitFor(() => expect(red.getByText("4.3")).toBeInTheDocument());
      expect(red.getByText("4.3")).toHaveClass("good");
      expect(red.getByText(/^Voted /)).toBeInTheDocument();
      expect(red.getByTitle("4: 2 (67%)")).toBeInTheDocument();
      expect(within(screen.getByRole("group", { name: "Combined distribution" })).getByTitle("5: 1 (33%)")).toBeInTheDocument();
      expect(screen.getByText("Teams combined").previousSibling).toHaveTextContent("4.3");
      expect(screen.getByText("ART A vote").previousSibling).toHaveTextContent("—");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("edits counts per value and warns when the average is below 3", async () => {
      await renderPlanning();
      const input = screen.getByLabelText("Team Blue people voting 2");
      fireEvent.change(input, { target: { value: "4" } });
      fireEvent.blur(input);
      await waitFor(() => expect(docs("votes")[0]?.counts).toEqual([0, 4, 0, 0, 0]));
      expect(await screen.findByRole("status")).toHaveTextContent("Average confidence below 3 (Team Blue)");
      expect(row("Team Blue vote")).toHaveClass("pp-low");

      // Unchanged or invalid values do not save; negative clamps to 0.
      fireEvent.blur(input);
      const other = screen.getByLabelText("Team Blue people voting 1");
      fireEvent.change(other, { target: { value: "abc" } });
      fireEvent.blur(other);
      expect(other).toHaveValue(0);
      await new Promise((r) => setTimeout(r, 20));
      expect(docs("votes")[0].__etag).toBe(1);
      fireEvent.change(input, { target: { value: "-3" } });
      fireEvent.blur(input);
      await waitFor(() => expect(docs("votes")[0].counts).toEqual([0, 0, 0, 0, 0]));
    });

    it("warns for a low ART-wide vote and shows the ART's own distribution without children", async () => {
      const pi = await pi2();
      seedDocs("votes", [{ id: `n-arta|${pi.identifier}`, nodeId: "n-arta", piPath: PI2, piId: pi.identifier, counts: [2, 1, 0, 0, 0] }]);
      await renderPlanning();
      expect(screen.getByRole("status")).toHaveTextContent("(ART A)");
      expect(screen.getByText("ART A vote").closest(".stat")).toHaveClass("bad");

      // A team (no children): the combined bars show the unit's own vote.
      const config = makeConfig();
      config.root.children[0].children = [];
      document.body.innerHTML = "";
      await renderPlanning({ config });
      expect(screen.queryByText("Teams combined")).not.toBeInTheDocument();
      expect(within(screen.getByRole("group", { name: "Combined distribution" })).getByTitle("1: 2 (67%)")).toBeInTheDocument();
    });

    it("warns when the combined team average is low even if each team row is fine", async () => {
      const pi = await pi2();
      seedDocs("votes", [
        { id: `n-red|${pi.identifier}`, nodeId: "n-red", piPath: PI2, piId: pi.identifier, counts: [0, 0, 1, 0, 0] },
        { id: `n-blue|${pi.identifier}`, nodeId: "n-blue", piPath: PI2, piId: pi.identifier, counts: [0, 1, 0, 0, 0] },
      ]);
      await renderPlanning();
      expect(screen.getByRole("status")).toHaveTextContent("Average confidence below 3 (Team Blue)");
      expect(screen.getByText("Teams combined").previousSibling).toHaveTextContent("2.5");
    });

    it("clears a vote after confirmation", async () => {
      const pi = await pi2();
      seedDocs("votes", [{ id: `n-red|${pi.identifier}`, nodeId: "n-red", piPath: PI2, piId: pi.identifier, counts: [0, 0, 3, 0, 0] }]);
      await renderPlanning();
      (window.confirm as any).mockReturnValueOnce(false);
      fireEvent.click(within(row("Team Red vote")).getByRole("button", { name: "Clear" }));
      expect(docs("votes")[0].counts).toEqual([0, 0, 3, 0, 0]);
      fireEvent.click(within(row("Team Red vote")).getByRole("button", { name: "Clear" }));
      await waitFor(() => expect(docs("votes")[0].counts).toEqual([0, 0, 0, 0, 0]));
      expect(within(row("Team Red vote")).queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    });
  });

  describe("Inspect & Adapt", () => {
    it("shows PI predictability per unit and in total", async () => {
      seedDocs("objectives", [
        { id: "o1", nodeId: "n-red", piPath: PI2, title: "A", committed: true, plannedBV: 10, actualBV: 9, featureIds: [] },
        { id: "o2", nodeId: "n-blue", piPath: PI2, title: "B", committed: true, plannedBV: 10, actualBV: 5, featureIds: [] },
        { id: "o3", nodeId: "n-blue", piPath: PI2, title: "C", committed: true, plannedBV: 10, actualBV: 7, featureIds: [] },
      ]);
      await renderPlanning();
      const cells = (label: string) => within(row(label)).getAllByRole("cell").slice(1);
      expect(cells("Team Red predictability").map((c) => c.textContent)).toEqual(["10", "9", "90%"]);
      expect(cells("Team Red predictability")[2]).toHaveClass("good");
      expect(cells("Team Blue predictability")[2]).toHaveClass("warn");
      expect(cells("ART A predictability").map((c) => c.textContent)).toEqual(["0", "0", "—"]);
      expect(cells("Total predictability").map((c) => c.textContent)).toEqual(["30", "21", "70%"]);
    });

    it("marks bad predictability and dashes an empty total", async () => {
      seedDocs("objectives", [{ id: "o1", nodeId: "n-red", piPath: PI2, title: "A", committed: true, plannedBV: 10, actualBV: 1, featureIds: [] }]);
      await renderPlanning();
      expect(within(row("Team Red predictability")).getAllByRole("cell")[3]).toHaveClass("bad");
      document.body.innerHTML = "";
      seedDocs("objectives", []);
      await renderPlanning();
      expect(within(row("Total predictability")).getAllByRole("cell")[3]).toHaveTextContent("—");
    });

    it("runs the problem-solving workshop: add, edit, status, delete", async () => {
      const pi = await pi2();
      await renderPlanning();
      const panel = within(section("Inspect & Adapt"));
      expect(panel.getByText("No improvement items for this PI yet.")).toBeInTheDocument();
      fireEvent.click(panel.getByRole("button", { name: "New improvement" }));
      await panel.findByLabelText("Problem");
      expect(stored("improvements")[0]).toMatchObject({ nodeId: "n-arta", piPath: PI2, piId: pi.identifier, status: "Proposed", problem: "" });
      expect(panel.getByRole("button", { name: "Create backlog item" })).toBeDisabled();

      const problem = panel.getByLabelText("Problem");
      fireEvent.change(problem, { target: { value: "Late integration" } });
      fireEvent.blur(problem);
      await waitFor(() => expect(stored("improvements")[0].problem).toBe("Late integration"));
      const cause = panel.getByLabelText("Root cause");
      fireEvent.change(cause, { target: { value: "No shared env" } });
      fireEvent.blur(cause);
      await waitFor(() => expect(stored("improvements")[0].rootCause).toBe("No shared env"));
      fireEvent.change(panel.getByLabelText("Status"), { target: { value: "Accepted" } });
      await waitFor(() => expect(stored("improvements")[0].status).toBe("Accepted"));
      expect(panel.getByText("0 proposed · 1 accepted · 0 done")).toBeInTheDocument();
      expect(panel.getByRole("button", { name: "Create backlog item" })).toBeEnabled();

      (window.confirm as any).mockReturnValueOnce(false);
      fireEvent.click(panel.getByRole("button", { name: "Delete improvement" }));
      expect(stored("improvements")).toHaveLength(1);
      fireEvent.click(panel.getByRole("button", { name: "Delete improvement" }));
      expect(await panel.findByText("No improvement items for this PI yet.")).toBeInTheDocument();
      expect(stored("improvements")).toHaveLength(0);
    });

    it("lists only this PI's items in the subtree, oldest first", async () => {
      const pi = await pi2();
      const item = (id: string, nodeId: string, problem: string, createdAt: string, piPath = PI2) => ({
        id, nodeId, piPath, problem, rootCause: "", improvement: "", owner: "", status: "Done", createdAt,
      });
      seed("improvements", [
        item("i2", "n-arta", "Second", "2026-02-01"),
        { ...item("i1", "n-red", "First", "2026-01-01", "renamed"), piId: pi.identifier },
        item("i3", "n-arta", "Old PI", "2026-01-01", PI1),
        item("i4", "n-green", "Other ART", "2026-01-01"),
      ]);
      await renderPlanning();
      expect(screen.getAllByLabelText("Problem").map((i) => (i as HTMLInputElement).value)).toEqual(["First", "Second"]);
    });

    it("creates a backlog item from an improvement and links it", async () => {
      seed("improvements", [
        { id: "i1", nodeId: "n-arta", piPath: PI2, problem: "Flaky builds", rootCause: "", improvement: "Stabilise CI", owner: "Ada", status: "Accepted", createdAt: "2026-01-01" },
      ]);
      await renderPlanning();
      fireEvent.click(screen.getByRole("button", { name: "Create backlog item" }));
      const link = await screen.findByRole("button", { name: /^#\d+$/ });
      const id = Number(link.textContent!.slice(1));
      expect(fake.workItems.get(id)!.fields).toMatchObject({
        "System.WorkItemType": "User Story",
        "System.Title": "Stabilise CI",
        "System.AreaPath": ART_A,
        "System.Tags": "Improvement; I&A",
      });
      await waitFor(() => expect(stored("improvements")[0].workItemId).toBe(id));
      fireEvent.click(link);
      await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(id));
    });

    it("falls back to feature type, problem title and child areas", async () => {
      const config = makeConfig({ types: { epic: "Epic", capability: "", feature: "Feature", story: "" } });
      config.root.children[0].areaPath = undefined;
      seed("improvements", [
        { id: "i1", nodeId: "n-arta", piPath: PI2, problem: "Too much WIP", rootCause: "", improvement: " ", owner: "", status: "Proposed", createdAt: "2026-01-01" },
      ]);
      await renderPlanning({ config });
      fireEvent.click(screen.getByRole("button", { name: "Create backlog item" }));
      await screen.findByRole("button", { name: /^#\d+$/ });
      const body = callsTo(/workitems\/\$Feature/, "POST")[0].body;
      expect(body).toEqual([
        { op: "add", path: "/fields/System.Title", value: "Too much WIP" },
        { op: "add", path: "/fields/System.AreaPath", value: "Fabrikam\\ART A\\Team Red" },
        { op: "add", path: "/fields/System.Tags", value: "Improvement; I&A" },
      ]);
    });

    it("omits the area when the unit has none", async () => {
      const config = makeConfig();
      const art = config.root.children[0];
      art.areaPath = undefined;
      art.children = [];
      seed("improvements", [
        { id: "i1", nodeId: "n-arta", piPath: PI2, problem: "P", rootCause: "", improvement: "I", owner: "", status: "Proposed", createdAt: "2026-01-01" },
      ]);
      await renderPlanning({ config });
      fireEvent.click(screen.getByRole("button", { name: "Create backlog item" }));
      await screen.findByRole("button", { name: /^#\d+$/ });
      expect(callsTo(/workitems\/\$User/, "POST")[0].body.map((op: Json) => op.path)).toEqual(["/fields/System.Title", "/fields/System.Tags"]);
    });

    it("reports backlog item creation and delete errors", async () => {
      seed("improvements", [
        { id: "i1", nodeId: "n-arta", piPath: PI2, problem: "P", rootCause: "", improvement: "I", owner: "", status: "Proposed", createdAt: "2026-01-01" },
      ]);
      fake.types = fake.types.filter((t) => t.name !== "User Story");
      await renderPlanning();
      fireEvent.click(screen.getByRole("button", { name: "Create backlog item" }));
      expect(await screen.findByText(/Could not create backlog item: .*Invalid work item type/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create backlog item" })).toBeEnabled();
      fireEvent.click(screen.getByLabelText("Dismiss"));

      dataStore.failures.push({ op: "deleteDocument", error: new Error("locked") });
      fireEvent.click(screen.getByRole("button", { name: "Delete improvement" }));
      expect(await screen.findByText("Could not delete improvement: locked")).toBeInTheDocument();
      expect(stored("improvements")).toHaveLength(1);
    });
  });

  it("is read-only without plan permission", async () => {
    const pi = await pi2();
    seedDocs("votes", [{ id: `n-red|${pi.identifier}`, nodeId: "n-red", piPath: PI2, piId: pi.identifier, counts: [0, 0, 3, 0, 0] }]);
    seed("improvements", [
      { id: "i1", nodeId: "n-arta", piPath: PI2, problem: "P", rootCause: "", improvement: "I", owner: "", status: "Proposed", createdAt: "2026-01-01" },
      { id: "i2", nodeId: "n-arta", piPath: PI2, problem: "Q", rootCause: "", improvement: "", owner: "", status: "Done", createdAt: "2026-01-02", workItemId: 42 },
    ]);
    await renderWith({ can: { admin: false, managePis: false, plan: false } });
    expect(screen.getByText(/not change it/)).toBeInTheDocument();
    expect(screen.getByLabelText("Team Red Draft plan review status")).toBeDisabled();
    expect(screen.getByLabelText("Team Red Draft plan review notes")).toBeDisabled();
    expect(screen.getByLabelText("Vote 3 for Team Red")).toBeDisabled();
    expect(screen.getByLabelText("Team Red people voting 3")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New improvement" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create backlog item" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete improvement" })).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Problem")[0]).toBeDisabled();
    expect(screen.getAllByLabelText("Status")[0]).toBeDisabled();
    expect(screen.getByRole("button", { name: "#42" })).toBeEnabled();
  });

  it("works at Solution level with ARTs as units", async () => {
    const config = makeConfig();
    config.root.children = [{ id: "n-sol", name: "Big Solution", level: "solution", areaPath: "Fabrikam", children: config.root.children }];
    await renderPlanning({ config, nodeId: "n-sol" });
    expect(within(section("Confidence vote")).getAllByRole("row").slice(1).map((r) => r.getAttribute("aria-label"))).toEqual([
      "Big Solution vote",
      "ART A vote",
      "ART B vote",
    ]);
  });
});
