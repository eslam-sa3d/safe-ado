import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { localToday } from "../../src/api/rules";
import { OrgNode, ProgramIncrement } from "../../src/api/types";
import { getProgramIncrements } from "../../src/api/wit";
import { PiManagementView } from "../../src/views/PiManagementView";
import { callsTo, fail, fake, makeConfig, PI2 } from "../fakeAdo";
import { renderView } from "../utils";

const DAY = 86_400_000;
/** Today ± offset days on the user's local calendar. */
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localToday(d);
};
const iso = (d: string) => `${d}T00:00:00Z`;

async function renderPis(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<PiManagementView />, opts);
  await screen.findByRole("heading", { name: "Create a PI" });
  return r;
}

const piRow = (name: string) => screen.getAllByText(name, { selector: "tr.pi-row strong" })[0].closest("tr") as HTMLElement;
const details = (name: string) => screen.getByRole("region", { name: `${name} details` });

async function manage(name: string, opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderPis(opts);
  fireEvent.click(within(piRow(name)).getByRole("button", { name: "Manage" }));
  return { ...r, panel: details(name) };
}

const input = (panel: HTMLElement, label: string) => within(panel).getByLabelText(label) as HTMLInputElement;

describe("PIs & Iterations — grouping", () => {
  it("groups PIs into Planned, Current and Completed", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    const future: ProgramIncrement = { name: "PI 3", path: "Fabrikam\\PIs\\PI 3", identifier: "p3", start: iso(day(60)), finish: iso(day(90)), sprints: [] };
    const undated: ProgramIncrement = { name: "Someday", path: "Fabrikam\\PIs\\Someday", identifier: "sd", sprints: [] };
    await renderPis({ pis: [undated, ...pis, future] });
    const group = (label: string) => screen.getByRole("rowgroup", { name: label });
    const names = (label: string) => Array.from(group(label).querySelectorAll("tr.pi-row strong")).map((s) => s.textContent);
    expect(names("Planned PIs")).toEqual(["PI 3", "Someday"]);
    expect(names("Current PIs")).toEqual(["PI 2"]);
    expect(names("Completed PIs")).toEqual(["PI 1"]);
    expect(within(group("Planned PIs")).getByText("(2)")).toBeInTheDocument();
  });

  it("omits empty groups and marks IP iterations", async () => {
    await renderPis();
    expect(screen.queryByRole("rowgroup", { name: "Planned PIs" })).toBeNull();
    const ip = within(piRow("PI 2")).getByText("IP");
    expect(ip).toHaveClass("ip-iteration");
    expect(within(piRow("PI 2")).getByText("Sprint 1")).not.toHaveClass("ip-iteration");
  });

  it("opens and closes the PI details panel", async () => {
    const { panel } = await manage("PI 2");
    expect(within(panel).getByText("Current")).toBeInTheDocument();
    expect(piRow("PI 2")).toHaveClass("selected");
    fireEvent.click(within(piRow("PI 2")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "PI 2 details" })).toBeNull();
  });
});

describe("PIs & Iterations — edit and delete PI", () => {
  it("renames a PI and changes its dates", async () => {
    const { panel, ctx } = await manage("PI 2");
    const pi2 = ctx.pis.find((p) => p.name === "PI 2")!;
    expect(input(panel, "Name").value).toBe("PI 2");
    expect(input(panel, "Start").value).toBe(pi2.start!.slice(0, 10));
    const save = within(panel).getByRole("button", { name: "Save PI" });
    expect(save).toBeDisabled();
    fireEvent.change(input(panel, "Name"), { target: { value: "PI Two" } });
    const newFinish = new Date(new Date(pi2.finish!).getTime() + 3 * DAY).toISOString().slice(0, 10);
    fireEvent.change(input(panel, "Finish"), { target: { value: newFinish } });
    fireEvent.click(save);
    await waitFor(() => expect(callsTo(/classificationnodes\/Iterations\/PIs\/PI%202$/, "PATCH")).toHaveLength(1));
    expect(callsTo(/classificationnodes/, "PATCH")[0].body).toEqual({
      name: "PI Two",
      attributes: { startDate: iso(pi2.start!.slice(0, 10)), finishDate: iso(newFinish) },
    });
    await waitFor(() => expect(ctx.reloadPis).toHaveBeenCalled());
    // The PI moved to its new path; the panel follows it once PIs reload.
    expect(screen.queryByRole("region", { name: "PI 2 details" })).toBeNull();
  });

  it("changes only the dates when the name is unchanged", async () => {
    const { panel, ctx } = await manage("PI 2");
    const pi2 = ctx.pis.find((p) => p.name === "PI 2")!;
    const earlier = new Date(new Date(pi2.start!).getTime() - 2 * DAY).toISOString().slice(0, 10);
    fireEvent.change(input(panel, "Start"), { target: { value: earlier } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save PI" }));
    expect(await within(panel).findByText("Updated PI 2")).toBeInTheDocument();
    expect(callsTo(/classificationnodes/, "PATCH")[0].body).toEqual({
      attributes: { startDate: iso(earlier), finishDate: iso(pi2.finish!.slice(0, 10)) },
    });
  });

  it("validates PI names and dates", async () => {
    const { panel, ctx } = await manage("PI 2");
    const pi1 = ctx.pis.find((p) => p.name === "PI 1")!;
    const pi2 = ctx.pis.find((p) => p.name === "PI 2")!;
    const save = within(panel).getByRole("button", { name: "Save PI" });

    fireEvent.change(input(panel, "Name"), { target: { value: " " } });
    expect(within(panel).getByText("Enter a name.")).toBeInTheDocument();
    fireEvent.change(input(panel, "Name"), { target: { value: "pi 1" } });
    expect(within(panel).getByText("A PI with this name already exists.")).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(input(panel, "Name"), { target: { value: "PI 2" } });

    fireEvent.change(input(panel, "Finish"), { target: { value: "" } });
    expect(within(panel).getByText("Enter both a start and a finish date.")).toBeInTheDocument();
    fireEvent.change(input(panel, "Finish"), { target: { value: "2000-01-01" } });
    expect(within(panel).getByText("The finish date must not be before the start date.")).toBeInTheDocument();

    // Shrinking the PI would leave iterations outside it
    const shorter = new Date(new Date(pi2.finish!).getTime() - 3 * DAY).toISOString().slice(0, 10);
    fireEvent.change(input(panel, "Finish"), { target: { value: shorter } });
    expect(within(panel).getByText('Iteration "PI 2 IP" would fall outside the PI.')).toBeInTheDocument();

    // Overlapping the previous PI
    fireEvent.change(input(panel, "Finish"), { target: { value: pi2.finish!.slice(0, 10) } });
    fireEvent.change(input(panel, "Start"), { target: { value: pi1.finish!.slice(0, 10) } });
    expect(within(panel).getByText("The dates overlap PI 1.")).toBeInTheDocument();
    expect(save).toBeDisabled();
  });

  it("reports failures while saving a PI", async () => {
    fail(/classificationnodes/, 403, "Not allowed", { method: "PATCH" });
    const { panel } = await manage("PI 2");
    fireEvent.change(input(panel, "Name"), { target: { value: "PI X" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save PI" }));
    expect(await within(panel).findByText("Not allowed")).toBeInTheDocument();
    fireEvent.click(within(panel).getByLabelText("Dismiss"));
    expect(within(panel).queryByText("Not allowed")).toBeNull();
  });

  it("deletes a PI after confirmation, reclassifying work items to the PI root", async () => {
    const { panel, ctx } = await manage("PI 1");
    (window.confirm as any).mockReturnValueOnce(false);
    fireEvent.click(within(panel).getByRole("button", { name: "Delete PI" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Delete PI 1 and its 2 iterations? Work items in them move to Fabrikam\\PIs, and teams lose these sprints"));
    expect(callsTo(/classificationnodes/, "DELETE")).toHaveLength(0);

    fireEvent.click(within(panel).getByRole("button", { name: "Delete PI" }));
    await waitFor(() => expect(fake.deletedIterations).toHaveLength(1));
    const root = fake.iterationTree.children!.find((c) => c.name === "PIs")!;
    expect(fake.deletedIterations[0]).toEqual({ path: "\\Fabrikam\\Iteration\\PIs\\PI 1", reclassifyId: root.id });
    await waitFor(() => expect(screen.queryByRole("region", { name: "PI 1 details" })).toBeNull());
    expect(ctx.reloadPis).toHaveBeenCalled();
  });

  it("reports delete failures, including a missing PI root", async () => {
    fail(/GET .*classificationnodes\/Iterations\/PIs$/, 404, "Root not found", { once: true });
    const { panel } = await manage("PI 1");
    fireEvent.click(within(panel).getByRole("button", { name: "Delete PI" }));
    expect(await within(panel).findByText("Root not found")).toBeInTheDocument();

    fail(/GET .*classificationnodes\/Iterations\/PIs$/, 200, "", { raw: "{}", once: true });
    fireEvent.click(within(panel).getByRole("button", { name: "Delete PI" }));
    expect(await within(panel).findByText("Could not find the iteration Fabrikam\\PIs.")).toBeInTheDocument();
    expect(fake.deletedIterations).toHaveLength(0);
  });
});

describe("PIs & Iterations — iterations", () => {
  it("edits an iteration's name and dates", async () => {
    const { panel, ctx } = await manage("PI 2");
    const s1 = ctx.pis.find((p) => p.name === "PI 2")!.sprints[0];
    fireEvent.click(within(panel).getByRole("button", { name: "Edit PI 2 Sprint 1" }));
    expect(input(panel, "Iteration name").value).toBe("PI 2 Sprint 1");
    fireEvent.change(input(panel, "Iteration name"), { target: { value: "Kickoff" } });
    const finish = new Date(new Date(s1.finish!).getTime() - DAY).toISOString().slice(0, 10);
    fireEvent.change(input(panel, "Iteration finish"), { target: { value: finish } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByText("Updated Kickoff")).toBeInTheDocument();
    const patch = callsTo(/classificationnodes/, "PATCH")[0];
    expect(patch.path).toBe("p1/_apis/wit/classificationnodes/Iterations/PIs/PI%202/PI%202%20Sprint%201");
    expect(patch.body).toEqual({ name: "Kickoff", attributes: { startDate: iso(s1.start!.slice(0, 10)), finishDate: iso(finish) } });
    expect(ctx.reloadPis).toHaveBeenCalled();
    expect(within(panel).queryByLabelText("Iteration name")).toBeNull();
  });

  it("keeps the name when only dates change and cancels edits", async () => {
    const { panel, ctx } = await manage("PI 2");
    const ip = ctx.pis.find((p) => p.name === "PI 2")!.sprints[2];
    fireEvent.click(within(panel).getByRole("button", { name: "Edit PI 2 IP" }));
    const start = new Date(new Date(ip.start!).getTime() + DAY).toISOString().slice(0, 10);
    fireEvent.change(input(panel, "Iteration start"), { target: { value: start } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await within(panel).findByText("Updated PI 2 IP");
    expect(callsTo(/classificationnodes/, "PATCH")[0].body.name).toBeUndefined();

    fireEvent.click(within(panel).getByRole("button", { name: "Edit PI 2 Sprint 2" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(within(panel).queryByLabelText("Iteration name")).toBeNull();
    expect(callsTo(/classificationnodes/, "PATCH")).toHaveLength(1);
  });

  it("validates iteration edits: name, dates, PI bounds and overlaps", async () => {
    const { panel, ctx } = await manage("PI 2");
    const pi2 = ctx.pis.find((p) => p.name === "PI 2")!;
    fireEvent.click(within(panel).getByRole("button", { name: "Edit PI 2 Sprint 1" }));
    const save = within(panel).getByRole("button", { name: "Save" });
    const errorText = () => within(panel).getByText((_, el) => el?.tagName === "TD" && el.classList.contains("danger")).textContent;

    fireEvent.change(input(panel, "Iteration name"), { target: { value: "" } });
    expect(errorText()).toContain("Enter a name.");
    fireEvent.change(input(panel, "Iteration name"), { target: { value: "PI 2 Sprint 2" } });
    expect(errorText()).toContain("An iteration with this name already exists.");
    expect(save).toBeDisabled();
    fireEvent.change(input(panel, "Iteration name"), { target: { value: "PI 2 Sprint 1" } });

    fireEvent.change(input(panel, "Iteration start"), { target: { value: "2000-01-01" } });
    expect(errorText()).toContain("The iteration must be inside PI 2");
    fireEvent.change(input(panel, "Iteration start"), { target: { value: pi2.start!.slice(0, 10) } });
    fireEvent.change(input(panel, "Iteration finish"), { target: { value: pi2.sprints[1].start!.slice(0, 10) } });
    expect(errorText()).toContain("The dates overlap PI 2 Sprint 2.");
  });

  it("adds an iteration to an existing PI", async () => {
    const [real] = (await getProgramIncrements("Fabrikam\\PIs")).filter((p) => p.name === "PI 2");
    // A PI with room left after its first sprint
    const pi: ProgramIncrement = { ...real, sprints: [real.sprints[0]] };
    const { panel, ctx } = await manage("PI 2", { pis: [pi], pi });
    expect(input(panel, "New iteration name").value).toBe("PI 2 Sprint 2");
    const suggested = new Date(new Date(real.sprints[0].finish!).getTime() + DAY).toISOString().slice(0, 10);
    expect(input(panel, "New iteration start").value).toBe(suggested);
    expect(input(panel, "New iteration finish").value).toBe(new Date(new Date(suggested).getTime() + 13 * DAY).toISOString().slice(0, 10));

    // The fake already has "PI 2 Sprint 2": the server error is shown
    fireEvent.click(within(panel).getByRole("button", { name: "Add iteration" }));
    expect(await within(panel).findByText(/already exists/)).toBeInTheDocument();

    fireEvent.change(input(panel, "New iteration name"), { target: { value: "Hardening" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Add iteration" }));
    expect(await within(panel).findByText("Added Hardening")).toBeInTheDocument();
    const post = callsTo(/classificationnodes/, "POST").at(-1)!;
    expect(post.path).toBe("p1/_apis/wit/classificationnodes/Iterations/PIs/PI%202");
    expect(post.body).toEqual({ name: "Hardening", attributes: { startDate: iso(suggested), finishDate: expect.any(String) } });
    expect(ctx.reloadPis).toHaveBeenCalled();
  });

  it("adds undated iterations to undated PIs and flags invalid input", async () => {
    const pi: ProgramIncrement = { name: "Loose", path: PI2, identifier: "x", sprints: [] };
    const { panel } = await manage("Loose", { pis: [pi], pi });
    expect(input(panel, "New iteration start").value).toBe("");
    fireEvent.change(input(panel, "New iteration name"), { target: { value: "Loose S1" } });
    fireEvent.change(input(panel, "New iteration start"), { target: { value: "2027-01-10" } });
    expect(within(panel).getByText("Enter both a start and a finish date.")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Add iteration" })).toBeDisabled();
    fireEvent.change(input(panel, "New iteration finish"), { target: { value: "2027-01-01" } });
    expect(within(panel).getByText("The finish date must not be before the start date.")).toBeInTheDocument();
    fireEvent.change(input(panel, "New iteration finish"), { target: { value: "" } });
    fireEvent.change(input(panel, "New iteration start"), { target: { value: "" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Add iteration" }));
    await within(panel).findByText("Added Loose S1");
    expect(callsTo(/classificationnodes/, "POST").at(-1)!.body).toEqual({ name: "Loose S1" });
  });

  it("allows at most 10 iterations per PI", async () => {
    const sprints = Array.from({ length: 10 }, (_, i) => ({ name: `S${i + 1}`, path: `${PI2}\\S${i + 1}`, identifier: `s${i}` }));
    const pi: ProgramIncrement = { name: "Full", path: PI2, identifier: "x", sprints };
    const { panel } = await manage("Full", { pis: [pi], pi });
    expect(within(panel).getByText("A PI can have at most 10 iterations.")).toBeInTheDocument();
    expect(input(panel, "New iteration name")).toBeDisabled();
    expect(within(panel).getByRole("button", { name: "Add iteration" })).toBeDisabled();
    // Undated iterations show dashes
    expect(within(panel).getAllByText("—").length).toBeGreaterThan(0);
  });
});

describe("PIs & Iterations — creation rules", () => {
  it("blocks PIs with more than 10 iterations", async () => {
    await renderPis();
    fireEvent.change(screen.getByLabelText("Development iterations"), { target: { value: "10" } });
    expect(screen.getByText("A PI can have at most 10 iterations.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PI" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Innovation & Planning/));
    expect(screen.queryByText("A PI can have at most 10 iterations.")).toBeNull();
    expect(screen.getByRole("button", { name: "Create PI" })).toBeEnabled();
  });

  it("blocks PIs that overlap an existing PI", async () => {
    await renderPis();
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: day(0) } });
    expect(screen.getByText("The dates overlap PI 2.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PI" })).toBeDisabled();
  });
});

describe("PIs & Iterations — sprint mapping", () => {
  it("shows and toggles a team's subscribed iterations", async () => {
    const { panel, ctx } = await manage("PI 2");
    const [s1, s2] = ctx.pis.find((p) => p.name === "PI 2")!.sprints;
    fake.teamIterations["t-red"] = [s1.identifier];
    const team = within(panel).getByLabelText("Team") as HTMLSelectElement;
    expect(Array.from(team.options).map((o) => o.textContent)).toEqual(["(choose a team)", "ART A", "Team Red", "Team Blue", "Team Green"]);
    fireEvent.change(team, { target: { value: "t-red" } });
    const box = (name: string) => within(panel).getByRole("checkbox", { name: new RegExp(`^${name}`) }) as HTMLInputElement;
    await waitFor(() => expect(box("PI 2 Sprint 1")).toBeChecked());
    expect(box("PI 2 Sprint 2")).not.toBeChecked();
    expect(within(box("PI 2 IP").closest("label")!).getByText("IP")).toHaveClass("ip-badge");

    fireEvent.click(box("PI 2 Sprint 2"));
    await waitFor(() => expect(box("PI 2 Sprint 2")).toBeChecked());
    expect(fake.teamIterations["t-red"]).toEqual([s1.identifier, s2.identifier]);

    fireEvent.click(box("PI 2 Sprint 1"));
    await waitFor(() => expect(box("PI 2 Sprint 1")).not.toBeChecked());
    expect(fake.teamIterations["t-red"]).toEqual([s2.identifier]);
    expect(callsTo(/teamsettings\/iterations\//, "DELETE")[0].path).toBe(`p1/t-red/_apis/work/teamsettings/iterations/${s1.identifier}`);

    fireEvent.change(team, { target: { value: "" } });
    expect(within(panel).queryByRole("checkbox")).toBeNull();
  });

  it("matches subscriptions by path when identifiers differ", async () => {
    const [real] = (await getProgramIncrements("Fabrikam\\PIs")).filter((p) => p.name === "PI 2");
    fake.teamIterations["t-blue"] = [real.sprints[0].identifier];
    // The team settings API reports another id format for the same iteration path
    const pi: ProgramIncrement = { ...real, sprints: real.sprints.map((s) => ({ ...s, identifier: `guid-${s.name}` })) };
    const { panel } = await manage("PI 2", { pis: [pi], pi });
    fireEvent.change(within(panel).getByLabelText("Team"), { target: { value: "t-blue" } });
    await waitFor(() => expect(within(panel).getByRole("checkbox", { name: /^PI 2 Sprint 1/ })).toBeChecked());
    expect(within(panel).getByRole("checkbox", { name: /^PI 2 Sprint 2/ })).not.toBeChecked();
  });

  it("reports subscription and loading errors", async () => {
    const { panel } = await manage("PI 2");
    fail(/POST .*teamsettings\/iterations$/, 400, "Outside backlog iteration");
    fireEvent.change(within(panel).getByLabelText("Team"), { target: { value: "t-green" } });
    const box = await within(panel).findByRole("checkbox", { name: /^PI 2 Sprint 1/ });
    fireEvent.click(box);
    expect(await within(panel).findByText("Could not subscribe to PI 2 Sprint 1: Outside backlog iteration")).toBeInTheDocument();
    fireEvent.click(within(panel).getByLabelText("Dismiss"));

    fail(/DELETE .*teamsettings\/iterations\//, 500, "Nope");
    fake.teamIterations["t-red"] = [(await getProgramIncrements("Fabrikam\\PIs")).find((p) => p.name === "PI 2")!.sprints[1].identifier];
    fireEvent.change(within(panel).getByLabelText("Team"), { target: { value: "t-red" } });
    await waitFor(() => expect(within(panel).getByRole("checkbox", { name: /^PI 2 Sprint 2/ })).toBeChecked());
    fireEvent.click(within(panel).getByRole("checkbox", { name: /^PI 2 Sprint 2/ }));
    expect(await within(panel).findByText("Could not unsubscribe from PI 2 Sprint 2: Nope")).toBeInTheDocument();

    fail(/GET .*t-blue\/_apis\/work\/teamsettings\/iterations$/, 500, "Team settings unavailable");
    fireEvent.change(within(panel).getByLabelText("Team"), { target: { value: "t-blue" } });
    expect(await within(panel).findByText("Team settings unavailable")).toBeInTheDocument();
  });

  it("shows a loading indicator while team iterations load", async () => {
    const { panel } = await manage("PI 2");
    fireEvent.change(within(panel).getByLabelText("Team"), { target: { value: "t-red" } });
    expect(within(panel).getByText("Loading team iterations…")).toBeInTheDocument();
    await within(panel).findAllByRole("checkbox");
  });

  it("explains how to map teams when none are linked", async () => {
    const config = makeConfig();
    const strip = (n: OrgNode) => {
      n.teamId = undefined;
      n.children.forEach(strip);
    };
    strip(config.root);
    const { panel } = await manage("PI 2", { config });
    expect(within(panel).getByText(/Link hierarchy nodes to Azure DevOps teams/)).toBeInTheDocument();
  });

  it("says when the PI has no iterations to map", async () => {
    const pi: ProgramIncrement = { name: "Empty", path: PI2, identifier: "x", sprints: [] };
    const { panel } = await manage("Empty", { pis: [pi], pi });
    fireEvent.change(within(panel).getByLabelText("Team"), { target: { value: "t-red" } });
    expect(await within(panel).findByText("This PI has no iterations.")).toBeInTheDocument();
  });
});
