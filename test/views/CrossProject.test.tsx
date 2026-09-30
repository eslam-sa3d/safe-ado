import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { OrgNode, SafeConfig } from "../../src/api/types";
import { boardsUrl } from "../../src/components/shell";
import { OrganizationView } from "../../src/views/OrganizationView";
import { PiManagementView } from "../../src/views/PiManagementView";
import { ProgramBoard } from "../../src/views/ProgramBoard";
import { SetupView } from "../../src/views/SetupView";
import { TeamBoard } from "../../src/views/TeamBoard";
import { loadMembers, WorkItemList } from "../../src/views/WorkItemList";
import {
  ART_C,
  C_PI2_S1,
  C_PI2_S2,
  callsTo,
  fail,
  fake,
  makeConfig,
  makeCrossConfig,
  ORANGE,
  seedCrossProject,
} from "../fakeAdo";
import { dataTransfer, renderApp, renderView } from "../utils";
import { renderReports, widget } from "./reports/helpers";

const cell = (name: string) => screen.getByRole("group", { name });
const card = (title: string) => screen.getByText(title).closest(".card") as HTMLElement;

/** A Large Solution spanning ART A (host project) and ART C (project Contoso). */
function solutionConfig(): SafeConfig {
  const config = makeCrossConfig();
  const [artA, , artC] = config.root.children;
  const solution: OrgNode = { id: "n-sol", name: "Payments Solution", level: "solution", children: [artA, artC] };
  config.root.children = [solution, config.root.children[1]];
  return config;
}

beforeEach(() => {
  seedCrossProject();
});

describe("program board across projects", () => {
  async function renderBoard(opts: Parameters<typeof renderView>[1] = {}) {
    const r = await renderView(<ProgramBoard />, { config: solutionConfig(), nodeId: "n-sol", ...opts });
    await waitFor(() => expect(screen.queryByText("Loading program board…")).not.toBeInTheDocument());
    return r;
  }

  it("shows features of both projects in their ART rows (calculated from the children's sprints)", async () => {
    await renderBoard();
    expect(within(cell("ART A / PI 2 Sprint 2")).getByText("Payment API")).toBeInTheDocument();
    // Children of Partner API are planned in Contoso's "Iteration 1" and "PI 2 Sprint 2": the latest is Sprint 2.
    expect(within(cell("ART C / PI 2 Sprint 2")).getByText("Partner API")).toBeInTheDocument();
    expect(callsTo(/wiql/).every((c) => c.path === "_apis/wit/wiql")).toBe(true);
  });

  it("re-plans a foreign feature with its project's iteration and refuses moving it to another project", async () => {
    localStorage.setItem("safe-ado-artboard-placement", JSON.stringify("feature"));
    await renderBoard();
    expect(within(cell("ART C / PI 2 Sprint 1")).getByText("Partner API")).toBeInTheDocument();

    const drag = (target: string) => {
      const dt = dataTransfer();
      fireEvent.dragStart(card("Partner API"), { dataTransfer: dt });
      fireEvent.drop(cell(target), { dataTransfer: dataTransfer(dt.setData.mock.calls[0][1]) });
    };
    drag("ART C / PI 2 Sprint 2");
    await waitFor(() => expect(fake.workItems.get(300)!.fields["System.IterationPath"]).toBe(C_PI2_S2));
    expect(callsTo(/workitems\/300/, "PATCH")[0].body).toEqual([{ op: "add", path: "/fields/System.IterationPath", value: C_PI2_S2 }]);
    await waitFor(() => expect(within(cell("ART C / PI 2 Sprint 2")).getByText("Partner API")).toBeInTheDocument());

    drag("ART A / PI 2 Sprint 1");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      'Could not move #300: #300 belongs to project "Contoso" and can\'t be moved to "Fabrikam" here.'
    );
    expect(fake.workItems.get(300)!.fields["System.AreaPath"]).toBe(ORANGE);

    // No matching IP iteration in Contoso: a clear error instead of a failed write.
    drag("ART C / PI 2 IP");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent('Project "Contoso" has no iteration matching'));
  });
});

describe("work item list and reports across projects", () => {
  it("lists features of both projects", async () => {
    await renderView(<WorkItemList />, { config: solutionConfig(), nodeId: "n-sol" });
    // Titles are inline-editable inputs.
    expect(await screen.findByDisplayValue("Partner API")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Payment API")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Contoso backlog")).toBeInTheDocument();
    const partner = screen.getByDisplayValue("Partner API").closest("tr")!;
    expect(within(partner).getByText("Team Orange")).toBeInTheDocument();
    expect(within(partner).getByText("PI 2 Sprint 1")).toBeInTheDocument();
  });

  it("counts the foreign team's stories in the PI", async () => {
    await renderReports({ config: makeCrossConfig(), nodeId: "n-orange" });
    expect(within(widget("Story Points Burned")).getByText("5 of 8 SP done")).toBeInTheDocument();
  });

  it("aggregates both projects on a solution", async () => {
    await renderReports({ config: solutionConfig(), nodeId: "n-sol" });
    // Host ART A: 5 of 16 SP; Contoso: 5 of 8 SP.
    expect(within(widget("Story Points Burned")).getByText("10 of 24 SP done")).toBeInTheDocument();
  });

  it("loads assignee candidates from the foreign team's project", async () => {
    const people = await loadMembers(makeCrossConfig().root);
    expect(people.map((p) => p.displayName)).toContain("Linus Torvalds");
  });
});

describe("team board of a team in another project", () => {
  async function renderTeamBoard() {
    const r = await renderView(<TeamBoard />, { config: makeCrossConfig(), nodeId: "n-orange" });
    await waitFor(() => expect(screen.queryByText("Loading team planning board…")).not.toBeInTheDocument());
    return r;
  }

  it("places the stories in the cadence's sprints", async () => {
    await renderTeamBoard();
    expect(within(await screen.findByRole("group", { name: "Partner API / PI 2 Sprint 1" })).getByText("Partner auth")).toBeInTheDocument();
    expect(within(cell("Partner API / PI 2 Sprint 2")).getByText("Partner docs")).toBeInTheDocument();
  });

  it("creates an item in a cell in the team's project and iteration", async () => {
    await renderTeamBoard();
    fireEvent.click(await screen.findByRole("button", { name: "Create in Partner API / PI 2 Sprint 1" }));
    const dialog = screen.getByRole("dialog", { name: "Create work item" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Partner SDK" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(within(cell("Partner API / PI 2 Sprint 1")).getByText("Partner SDK")).toBeInTheDocument());
    const post = callsTo(/_apis\/wit\/workitems\/\$/, "POST")[0];
    expect(post.path).toBe("Contoso/_apis/wit/workitems/$User%20Story");
    expect(post.body).toContainEqual({ op: "add", path: "/fields/System.IterationPath", value: C_PI2_S1 });
    expect(post.body).toContainEqual({ op: "add", path: "/fields/System.AreaPath", value: ORANGE });
  });
});

describe("graceful degradation", () => {
  it("leaves foreign teams out of sprint mapping with a note", async () => {
    await renderView(<PiManagementView />, { config: makeCrossConfig(), nodeId: "n-root" });
    expect(screen.getByRole("note")).toHaveTextContent("Teams in other projects (Team Orange (Contoso)) can't be assigned these iterations");
    // ART A, Team Red, Team Blue and Team Green; not Team Orange.
    expect(screen.getByText(/4 mapped teams/)).toBeInTheDocument();
  });

  it("opens a foreign team's backlog in its own project", async () => {
    const config = makeCrossConfig();
    const orange = config.root.children[2].children[0];
    expect(await boardsUrl(config, orange)).toBe("https://dev.azure.com/org/Contoso/_backlogs/backlog/Team%20Orange");
    expect(await boardsUrl(config, config.root.children[0].children[0])).toBe("https://dev.azure.com/org/Fabrikam/_backlogs/backlog/Team%20Red");
  });
});

describe("hub shell", () => {
  it("shows notes about unmatched iterations and renders items of both projects", async () => {
    await renderApp({ config: makeCrossConfig(), nodeId: "n-artc", view: "board" });
    expect(await screen.findByText(/Project Contoso has no iteration matching PI 1, PI 2 IP/)).toBeInTheDocument();
    expect(await screen.findByText("Partner API")).toBeInTheDocument();
    // The cadence (PI picker) stays the host project's.
    expect(Array.from((screen.getByLabelText("PI") as HTMLSelectElement).options).map((o) => o.text.split(" (")[0])).toEqual(["PI 1", "PI 2"]);
  });

  it("still renders when another project's PIs can't be loaded", async () => {
    fail(/Contoso\/_apis\/wit\/classificationnodes/, 500, "Contoso down");
    await renderApp({ config: makeCrossConfig(), nodeId: "n-arta", view: "board" });
    expect(await screen.findByText(/the PI root "Contoso\\Cadence" was not found/)).toBeInTheDocument();
    expect(await screen.findByText("Payment API")).toBeInTheDocument();
  });

  it("keeps old configurations (no projectId) free of cross-project notes", async () => {
    await renderApp({ config: makeConfig(), nodeId: "n-arta", view: "board" });
    expect(await screen.findByText("Payment API")).toBeInTheDocument();
    expect(document.querySelector(".cross-project-note")).toBeNull();
    expect(callsTo(/wiql/).every((c) => c.path === "p1/_apis/wit/wiql")).toBe(true);
  });
});

describe("Setup and My Organization", () => {
  const nodeRow = (name: string) =>
    (screen.getAllByLabelText("Name") as HTMLInputElement[]).find((i) => i.value === name)!.closest(".node-row") as HTMLElement;

  it("picks another project, then its area, team and PI root", async () => {
    const { ctx } = await renderView(<SetupView firstRun={false} />, { nodeId: "n-root" });
    await screen.findByRole("heading", { name: "Work item types" });
    expect(screen.getByText(/A unit can live in another project of this collection/)).toBeInTheDocument();
    const row = nodeRow("ART B");
    const project = within(row).getByLabelText("Project") as HTMLSelectElement;
    expect(Array.from(project.options).map((o) => o.text)).toEqual(["Contoso", "Fabrikam"]);
    expect(project.value).toBe("p1");
    fireEvent.change(project, { target: { value: "p2" } });
    const area = within(nodeRow("ART B")).getByLabelText("Area path") as HTMLSelectElement;
    await waitFor(() => expect(Array.from(area.options).map((o) => o.value)).toContain(ORANGE));
    fireEvent.change(area, { target: { value: ART_C } });
    fireEvent.change(within(nodeRow("ART B")).getByLabelText("PI root in project"), { target: { value: "Contoso\\Cadence" } });
    fireEvent.change(within(nodeRow("ART B")).getByLabelText("Azure DevOps team"), { target: { value: "t-orange" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    const saved = ctx.saveConfig.mock.calls[0][0] as SafeConfig;
    const artB = saved.root.children.find((c) => c.id === "n-artb")!;
    expect(artB).toMatchObject({ projectId: "p2", projectName: "Contoso", areaPath: ART_C, teamId: "t-orange", piRootIteration: "Contoso\\Cadence" });
    // Moving back to the host project clears the foreign settings.
    fireEvent.change(within(nodeRow("ART B")).getByLabelText("Project"), { target: { value: "p1" } });
    await waitFor(() => expect(within(nodeRow("ART B")).queryByLabelText("PI root in project")).toBeNull());
    expect((within(nodeRow("ART B")).getByLabelText("Area path") as HTMLSelectElement).value).toBe("");
  });

  it("shows saved foreign units with their project and adds children in the same project", async () => {
    const { ctx } = await renderView(<SetupView firstRun={false} />, { config: makeCrossConfig(), nodeId: "n-root" });
    await screen.findByRole("heading", { name: "Work item types" });
    const row = nodeRow("Team Orange");
    expect((within(row).getByLabelText("Project") as HTMLSelectElement).value).toBe("p2");
    await waitFor(() => expect((within(row).getByLabelText("Azure DevOps team") as HTMLSelectElement).value).toBe("t-orange"));
    fireEvent.click(within(nodeRow("ART C")).getByRole("button", { name: /Add Team/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    const artC = (ctx.saveConfig.mock.calls[0][0] as SafeConfig).root.children.find((c) => c.id === "n-artc")!;
    expect(artC.children[1]).toMatchObject({ level: "team", areaPath: ART_C, projectId: "p2", projectName: "Contoso" });
  });

  it("shows a load error for a project it cannot read", async () => {
    fail(/p2\/_apis\/wit\/classificationnodes\/Iterations/, 500, "No access");
    await renderView(<SetupView firstRun={false} />, { config: makeCrossConfig(), nodeId: "n-root" });
    await screen.findByRole("heading", { name: "Work item types" });
    expect(await within(nodeRow("ART C")).findByText("Could not load Contoso: No access")).toBeInTheDocument();
  });

  it("adds a unit in another project from My Organization", async () => {
    const { ctx } = await renderView(<OrganizationView />);
    fireEvent.click(screen.getByRole("button", { name: "Add Agile Release Train" }));
    const dialog = screen.getByRole("dialog", { name: "Add Agile Release Train" });
    const project = (await within(dialog).findByLabelText("Project")) as HTMLSelectElement;
    fireEvent.change(project, { target: { value: "p2" } });
    await waitFor(() => expect(within(dialog).getByRole("option", { name: ART_C })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "ART C" } });
    fireEvent.change(within(dialog).getByLabelText("Area path"), { target: { value: ART_C } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    const root = (ctx.saveConfig.mock.calls[0][0] as SafeConfig).root;
    expect(root.children.find((c) => c.name === "ART C")).toMatchObject({ areaPath: ART_C, projectId: "p2", projectName: "Contoso" });
    expect(await screen.findByTitle("In project Contoso")).toHaveTextContent("Contoso");
    // Host-project units stay without a project id.
    fireEvent.click(screen.getByRole("button", { name: "Add Agile Release Train" }));
    const again = screen.getByRole("dialog", { name: "Add Agile Release Train" });
    await within(again).findByLabelText("Project");
    fireEvent.change(within(again).getByLabelText("Name"), { target: { value: "ART D" } });
    fireEvent.click(within(again).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalledTimes(2));
    const artD = (ctx.saveConfig.mock.calls[1][0] as SafeConfig).root.children.find((c) => c.name === "ART D")!;
    expect(artD.projectId).toBeUndefined();
  });
});
