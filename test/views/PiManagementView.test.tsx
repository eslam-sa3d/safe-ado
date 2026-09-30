import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { localToday } from "../../src/api/rules";
import { OrgNode } from "../../src/api/types";
import { PiManagementView, planSprints } from "../../src/views/PiManagementView";
import { callsTo, fail, fake, makeConfig } from "../fakeAdo";
import { renderView } from "../utils";

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

async function renderPis(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<PiManagementView />, opts);
  await screen.findByRole("heading", { name: "Create a PI" });
  return r;
}

describe("planSprints", () => {
  it("builds consecutive iterations plus an IP iteration", () => {
    expect(planSprints("PI 7", "2026-01-05", 2, 2, true)).toEqual([
      { name: "PI 7 Sprint 1", start: "2026-01-05T00:00:00Z", finish: "2026-01-18T00:00:00Z" },
      { name: "PI 7 Sprint 2", start: "2026-01-19T00:00:00Z", finish: "2026-02-01T00:00:00Z" },
      { name: "PI 7 IP", start: "2026-02-02T00:00:00Z", finish: "2026-02-15T00:00:00Z" },
    ]);
  });

  it("supports other lengths and no IP iteration", () => {
    const plan = planSprints("PI", "2026-03-02", 3, 3, false);
    expect(plan.map((s) => s.name)).toEqual(["PI Sprint 1", "PI Sprint 2", "PI Sprint 3"]);
    expect(plan[2].finish).toBe("2026-05-03T00:00:00Z");
  });
});

describe("PIs & Iterations view", () => {
  it("lists PIs newest first with dates and short iteration names", async () => {
    await renderPis();
    const table = screen.getByRole("heading", { name: "Program Increments" }).closest(".panel")!;
    const rows = Array.from(table.querySelectorAll("tr.pi-row")) as HTMLElement[];
    expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["PI 2", "PI 1"]);
    expect(within(rows[0]).getAllByRole("cell")[2].textContent).toBe("Sprint 1, Sprint 2, IP");
    expect(within(rows[0]).getAllByRole("cell")[1].textContent).toMatch(/ – /);
  });

  it("shows undated PIs and PIs without iterations", async () => {
    const pis = [{ name: "Loose", path: "Fabrikam\\Loose", identifier: "x", sprints: [] }];
    await renderPis({ pis, pi: null });
    expect(screen.getByText("No dates")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("explains when there are no PIs and suggests PI 1 starting today", async () => {
    await renderPis({ pis: [], pi: null });
    expect(screen.getByText("No PIs yet. Create one on the right.")).toBeInTheDocument();
    expect(field("PI name").value).toBe("PI 1");
    expect(field("Start date").value).toBe(localToday());
  });

  it("suggests the next PI name and a start date right after the last PI", async () => {
    const { ctx } = await renderPis();
    expect(field("PI name").value).toBe("PI 3");
    const lastFinish = new Date(ctx.pis[1].finish!).getTime();
    expect(field("Start date").value).toBe(new Date(lastFinish + 86_400_000).toISOString().slice(0, 10));
    expect(screen.getByLabelText(/Assign iterations to 4 mapped teams/)).toBeChecked();
  });

  it("keeps suggestions in step with PIs that load later, unless the user has edited them", async () => {
    const { getProgramIncrements } = await import("../../src/api/wit");
    const loaded = await getProgramIncrements("Fabrikam\\PIs");
    const { rerender } = await renderPis({ pis: [], pi: null });
    expect(field("PI name").value).toBe("PI 1");
    // Simulate the App passing freshly loaded PIs
    const { SafeContext } = await import("../../src/components/context");
    const value = (pis: typeof loaded) => ({
      config: makeConfig(), saveConfig: async () => {}, node: makeConfig().root, selectNode: () => {}, pis, pi: undefined, reloadPis: () => {},
    });
    rerender(<SafeContext.Provider value={value(loaded)}><PiManagementView /></SafeContext.Provider>);
    expect(field("PI name").value).toBe("PI 3");

    fireEvent.change(field("PI name"), { target: { value: "PI 2026.4" } });
    fireEvent.change(field("Start date"), { target: { value: "2027-01-04" } });
    rerender(<SafeContext.Provider value={value([...loaded])}><PiManagementView /></SafeContext.Provider>);
    expect(field("PI name").value).toBe("PI 2026.4");
    expect(field("Start date").value).toBe("2027-01-04");
  });

  it("previews the schedule and reacts to form changes", async () => {
    await renderPis();
    fireEvent.change(field("Start date"), { target: { value: "2027-01-04" } });
    const preview = () => screen.queryAllByLabelText(/^Planned iteration \d+ name$/).map((i) => (i as HTMLInputElement).value);
    expect(preview()).toEqual(["PI 3 Sprint 1", "PI 3 Sprint 2", "PI 3 Sprint 3", "PI 3 Sprint 4", "PI 3 IP"]);
    fireEvent.change(field("Development iterations"), { target: { value: "2" } });
    fireEvent.click(screen.getByLabelText(/Innovation & Planning/));
    expect(preview()).toEqual(["PI 3 Sprint 1", "PI 3 Sprint 2"]);
    fireEvent.change(field("Iteration length (weeks)"), { target: { value: "" } });
    fireEvent.change(field("Development iterations"), { target: { value: "" } });
    expect(field("Iteration length (weeks)").value).toBe("2");
    expect(preview()).toHaveLength(4);
    fireEvent.change(field("PI name"), { target: { value: "" } });
    expect(document.querySelector(".grid.compact")).toBeNull();
    expect(screen.getByRole("button", { name: "Create PI" })).toBeDisabled();
  });

  it("creates the PI, its iterations, assigns teams and reloads PIs", async () => {
    const { ctx } = await renderPis();
    fireEvent.change(field("Start date"), { target: { value: "2027-01-04" } });
    fireEvent.click(screen.getByRole("button", { name: "Create PI" }));
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    await screen.findByText("Team Green: assigned 5/5 iterations");

    const posts = callsTo(/classificationnodes/, "POST");
    expect(posts.map((c) => [c.path.replace("p1/_apis/wit/classificationnodes/Iterations", ""), c.body.name])).toEqual([
      ["/PIs", "PI 3"],
      ["/PIs/PI%203", "PI 3 Sprint 1"],
      ["/PIs/PI%203", "PI 3 Sprint 2"],
      ["/PIs/PI%203", "PI 3 Sprint 3"],
      ["/PIs/PI%203", "PI 3 Sprint 4"],
      ["/PIs/PI%203", "PI 3 IP"],
    ]);
    expect(posts[0].body.attributes).toEqual({ startDate: "2027-01-04T00:00:00Z", finishDate: "2027-03-14T00:00:00Z" });
    expect(screen.getByText('Created PI iteration "PI 3"')).toBeInTheDocument();
    expect(screen.getByText(/Created PI 3 IP \(/)).toBeInTheDocument();
    // Only sprints are assigned to teams, not the PI node itself
    expect(fake.teamIterations["t-red"]).toHaveLength(5);
    expect(Object.keys(fake.teamIterations).sort()).toEqual(["t-arta", "t-blue", "t-green", "t-red"]);
    expect(ctx.reloadPis).toHaveBeenCalled();
    expect(field("PI name").value).toBe("PI 4");
  });

  it("can skip team assignment", async () => {
    await renderPis();
    fireEvent.click(screen.getByLabelText(/Assign iterations to/));
    fireEvent.click(screen.getByRole("button", { name: "Create PI" }));
    await screen.findByText(/Created PI 3 IP/);
    expect(callsTo(/teamsettings/)).toHaveLength(0);
  });

  it("blocks duplicate PI names", async () => {
    await renderPis();
    fireEvent.change(field("PI name"), { target: { value: "PI 2" } });
    expect(screen.getByText("A PI with this name already exists.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PI" })).toBeDisabled();
  });

  it("reports creation errors", async () => {
    fail(/classificationnodes/, 403, "No permission to create iterations", { method: "POST" });
    await renderPis();
    fireEvent.click(screen.getByRole("button", { name: "Create PI" }));
    expect(await screen.findByText("No permission to create iterations")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PI" })).toBeEnabled();
  });

  it("assigns an existing PI to teams and reports partial failures", async () => {
    await renderPis();
    const pi2Row = screen.getByText("PI 2").closest("tr")!;
    fireEvent.click(within(pi2Row).getByRole("button", { name: "Assign to teams" }));
    await screen.findByText("Team Green: assigned 3/3 iterations");
    expect(screen.getByText("ART A: assigned 3/3 iterations")).toBeInTheDocument();

    fireEvent.click(within(pi2Row).getByRole("button", { name: "Assign to teams" }));
    await screen.findByText("Team Green: assigned 0/3 iterations (Iteration already assigned)");
  });

  it("handles a single mapped team and none", async () => {
    const config = makeConfig();
    const strip = (n: OrgNode) => {
      if (n.id !== "n-red") n.teamId = undefined;
      n.children.forEach(strip);
    };
    strip(config.root);
    await renderPis({ config });
    expect(screen.getByLabelText(/Assign iterations to 1 mapped team$/)).toBeInTheDocument();
  });

  it("disables team assignment when no teams are mapped", async () => {
    const config = makeConfig();
    const strip = (n: OrgNode) => {
      n.teamId = undefined;
      n.children.forEach(strip);
    };
    strip(config.root);
    await renderPis({ config });
    expect(screen.getAllByRole("button", { name: "Assign to teams" })[0]).toBeDisabled();
    expect(screen.getByLabelText(/Assign iterations to 0 mapped teams/)).toBeInTheDocument();
  });

  it("surfaces unexpected errors while assigning", async () => {
    await renderPis();
    const pi2Row = screen.getByText("PI 2").closest("tr")!;
    const addSpy = await import("../../src/api/wit");
    fail(/teamsettings\/iterations/, 500, "server exploded", { method: "POST" });
    fireEvent.click(within(pi2Row).getByRole("button", { name: "Assign to teams" }));
    await screen.findByText("Team Red: assigned 0/3 iterations (server exploded)");
    expect(addSpy).toBeTruthy();
  });

  it("waits until PI creation completes before re-enabling", async () => {
    await renderPis();
    fireEvent.click(screen.getByRole("button", { name: "Create PI" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PI" })).toBeInTheDocument());
  });
});
