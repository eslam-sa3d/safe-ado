import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Capabilities } from "../../src/api/permissions";
import { MAX_NAME_LENGTH, nameError, validateIteration, validatePi, validatePlan } from "../../src/api/piRules";
import { ProgramIncrement } from "../../src/api/types";
import { SafeContext, useSafe } from "../../src/components/context";
import { PiManagementView } from "../../src/views/PiManagementView";
import { callsTo, fail, fake, fetchMock, makeConfig } from "../fakeAdo";
import { renderView } from "../utils";

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const row = (n: number, part: "name" | "start" | "finish") => field(`Planned iteration ${n} ${part}`);
const createBtn = () => screen.getByRole("button", { name: "Create PI" });

/** Overrides the capabilities / cadence root the shell would provide. */
function Override({ can, piRoot, children }: { can?: Capabilities; piRoot?: string; children: ReactNode }) {
  const ctx = useSafe();
  return <SafeContext.Provider value={{ ...ctx, can: can ?? ctx.can, piRoot: piRoot ?? ctx.piRoot }}>{children}</SafeContext.Provider>;
}

async function renderPis(opts: Parameters<typeof renderView>[1] & { can?: Capabilities; piRoot?: string } = {}) {
  const r = await renderView(
    <Override can={opts.can} piRoot={opts.piRoot}>
      <PiManagementView />
    </Override>,
    opts
  );
  await screen.findByRole("heading", { name: "Create a PI" });
  return r;
}

const piRow = (name: string) => screen.getAllByText(name, { selector: "tr.pi-row strong" })[0].closest("tr") as HTMLElement;
async function manage(name: string, opts: Parameters<typeof renderPis>[0] = {}) {
  const r = await renderPis(opts);
  fireEvent.click(within(piRow(name)).getByRole("button", { name: /^(Manage|View)$/ }));
  return { ...r, panel: screen.getByRole("region", { name: `${name} details` }) };
}

describe("piRules — names and plans", () => {
  it("rejects Azure DevOps forbidden characters, edges and overlong names", () => {
    expect(nameError("PI 3")).toBeNull();
    expect(nameError("")).toBeNull();
    expect(nameError("PI/3")).toMatch(/^Names cannot contain \/ \(Azure DevOps does not allow \\ \/ \$ \? \* : " & > < # % \| \+\)\.$/);
    expect(nameError('A:B"C')).toMatch(/^Names cannot contain : "/);
    for (const c of ["\\", "$", "?", "*", "&", ">", "<", "#", "%", "|", "+"]) expect(nameError(`PI${c}3`)).toContain("cannot contain");
    expect(nameError(" PI")).toBe("Names cannot start or end with a space or a period.");
    expect(nameError("PI.")).toBe("Names cannot start or end with a space or a period.");
    expect(nameError(".PI")).toBe("Names cannot start or end with a space or a period.");
    expect(nameError("PI\u0007")).toBe("Names cannot contain control characters.");
    expect(nameError("x".repeat(MAX_NAME_LENGTH))).toBeNull();
    expect(nameError("x".repeat(MAX_NAME_LENGTH + 1))).toBe("Names can have at most 255 characters.");
  });

  it("applies the name rule to PIs and iterations", () => {
    const pi: ProgramIncrement = { name: "PI", path: "P\\PI", identifier: "x", sprints: [] };
    expect(validatePi({ name: "PI#1", start: "", finish: "" }, null, [])).toEqual([expect.stringContaining("cannot contain #")]);
    expect(validateIteration({ name: "S1.", start: "", finish: "" }, pi, null)).toEqual(["Names cannot start or end with a space or a period."]);
  });

  it("validates a plan: overlaps, bounds, duplicates and the iteration limit", () => {
    const range = { name: "PI", start: "2027-01-04", finish: "2027-02-14" };
    const ok = validatePlan(
      [
        { name: "S1", start: "2027-01-04", finish: "2027-01-17" },
        { name: "S2", start: "2027-01-18", finish: "2027-01-31" },
      ],
      range
    );
    expect(ok).toEqual({ rows: [[], []], errors: [] });
    const bad = validatePlan(
      [
        { name: "S1", start: "2027-01-04", finish: "2027-01-20" },
        { name: "s1", start: "2027-01-18", finish: "2027-03-31" },
        { name: "S3", start: "", finish: "" },
      ],
      range
    );
    expect(bad.rows[0]).toEqual(["An iteration with this name already exists.", "The dates overlap s1."]);
    expect(bad.rows[1]).toEqual([
      "An iteration with this name already exists.",
      "The iteration must be inside PI (2027-01-04 – 2027-02-14).",
      "The dates overlap S1.",
    ]);
    expect(bad.rows[2]).toEqual([]);
    const outside = validatePlan([{ name: "S1", start: "2027-01-01", finish: "2027-01-10" }], range);
    expect(outside.rows[0][0]).toMatch(/must be inside PI/);
    const many = validatePlan(Array.from({ length: 11 }, (_, i) => ({ name: `S${i}`, start: "", finish: "" })), range);
    expect(many.errors).toEqual(["A PI can have at most 10 iterations."]);
  });
});

describe("PIs & Iterations — editable plan", () => {
  it("creates the PI with adjusted iteration names and dates", async () => {
    await renderPis();
    fireEvent.change(field("Start date"), { target: { value: "2027-01-04" } });
    fireEvent.change(field("Development iterations"), { target: { value: "2" } });
    expect(row(1, "name").value).toBe("PI 3 Sprint 1");
    expect(row(3, "name").value).toBe("PI 3 IP");
    expect(screen.queryByRole("button", { name: "Reset plan" })).toBeNull();

    fireEvent.change(row(1, "name"), { target: { value: "Kickoff" } });
    fireEvent.change(row(2, "finish"), { target: { value: "2027-01-28" } });
    fireEvent.change(row(3, "start"), { target: { value: "2027-01-29" } });
    expect(row(1, "name").value).toBe("Kickoff");
    expect(createBtn()).toBeEnabled();
    fireEvent.click(createBtn());
    await screen.findByText(/Team Green: assigned 3\/3/);
    const posts = callsTo(/classificationnodes/, "POST");
    expect(posts.map((c) => c.body.name)).toEqual(["PI 3", "Kickoff", "PI 3 Sprint 2", "PI 3 IP"]);
    expect(posts[2].body.attributes).toEqual({ startDate: "2027-01-18T00:00:00Z", finishDate: "2027-01-28T00:00:00Z" });
    expect(posts[3].body.attributes).toEqual({ startDate: "2027-01-29T00:00:00Z", finishDate: "2027-02-14T00:00:00Z" });
    expect(screen.getByText("Created Kickoff (Jan 4 – Jan 17)")).toBeInTheDocument();
  });

  it("flags invalid rows, blocks creation and resets the plan", async () => {
    await renderPis();
    fireEvent.change(field("Start date"), { target: { value: "2027-01-04" } });
    fireEvent.change(row(2, "start"), { target: { value: "2027-01-10" } });
    const error = () => document.querySelector('[data-plan-error="2"]')?.textContent;
    expect(error()).toBe("The dates overlap PI 3 Sprint 1.");
    expect(createBtn()).toBeDisabled();
    fireEvent.change(row(2, "start"), { target: { value: "2026-12-01" } });
    expect(error()).toMatch(/must be inside PI 3/);
    fireEvent.change(row(2, "name"), { target: { value: "PI 3 Sprint 1" } });
    expect(error()).toMatch(/already exists/);
    fireEvent.change(row(2, "name"), { target: { value: "Sprint*2" } });
    expect(error()).toMatch(/cannot contain \*/);

    fireEvent.click(screen.getByRole("button", { name: "Reset plan" }));
    expect(row(2, "name").value).toBe("PI 3 Sprint 2");
    expect(document.querySelector("[data-plan-error]")).toBeNull();
    expect(createBtn()).toBeEnabled();

    // Changing the generator settings regenerates the plan.
    fireEvent.change(row(1, "name"), { target: { value: "Custom" } });
    fireEvent.change(field("Iteration length (weeks)"), { target: { value: "3" } });
    expect(row(1, "name").value).toBe("PI 3 Sprint 1");
  });

  it("creates undated iterations when a row's dates are cleared", async () => {
    await renderPis();
    fireEvent.change(field("Start date"), { target: { value: "2027-01-04" } });
    fireEvent.click(screen.getByLabelText(/Assign iterations to/));
    fireEvent.change(row(5, "start"), { target: { value: "" } });
    fireEvent.change(row(5, "finish"), { target: { value: "" } });
    fireEvent.click(createBtn());
    await screen.findByText("Created PI 3 IP");
    expect(callsTo(/classificationnodes/, "POST").at(-1)!.body).toEqual({ name: "PI 3 IP" });
  });

  it("validates the PI name against Azure DevOps rules", async () => {
    await renderPis();
    fireEvent.change(field("PI name"), { target: { value: "PI 3|b" } });
    expect(screen.getByText(/^Names cannot contain \|/, { selector: "p" })).toBeInTheDocument();
    expect(createBtn()).toBeDisabled();
    fireEvent.change(field("PI name"), { target: { value: "PI 3 " } });
    expect(screen.getAllByText("Names cannot start or end with a space or a period.").length).toBeGreaterThan(0);
    expect(createBtn()).toBeDisabled();
    fireEvent.change(field("PI name"), { target: { value: "pi 2" } });
    expect(screen.getByText("A PI with this name already exists.")).toBeInTheDocument();
  });
});

describe("PIs & Iterations — rollback", () => {
  /** Fails the n-th iteration POST under the new PI. */
  function failIterationPost(n: number) {
    const real = fetchMock.getMockImplementation()!;
    let count = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        if (init.method === "POST" && /Iterations\/PIs\/PI%203$/.test(String(input).split("?")[0]) && ++count === n) {
          return new Response(JSON.stringify({ message: "TF400898: quota" }), { status: 500 });
        }
        return real(input, init);
      })
    );
  }
  const pis = () => fake.iterationTree.children!.find((c) => c.name === "PIs")!;

  it("deletes the partially created PI when an iteration fails midway", async () => {
    const { ctx } = await renderPis();
    failIterationPost(3);
    fireEvent.change(field("Start date"), { target: { value: "2027-01-04" } });
    fireEvent.click(createBtn());
    expect(await screen.findByText(/Could not create the PI: TF400898: quota\. Nothing was left behind/)).toBeInTheDocument();
    expect(screen.getByText("Rolled back: removed the PI and 2 created iterations")).toBeInTheDocument();
    expect(fake.deletedIterations).toEqual([{ path: "\\Fabrikam\\Iteration\\PIs\\PI 3", reclassifyId: pis().id }]);
    expect(pis().children!.map((c) => c.name)).not.toContain("PI 3");
    expect(fake.teamIterations).toEqual({});
    expect(ctx.reloadPis).toHaveBeenCalled();
    expect(createBtn()).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText(/Could not create the PI/)).toBeNull();
  });

  it("reports a single rolled back iteration", async () => {
    await renderPis();
    failIterationPost(2);
    fireEvent.click(createBtn());
    expect(await screen.findByText("Rolled back: removed the PI and 1 created iteration")).toBeInTheDocument();
  });

  it("tells the user to clean up when the rollback fails", async () => {
    await renderPis();
    failIterationPost(1);
    fail(/DELETE .*classificationnodes/, 403, "No delete permission");
    fireEvent.click(createBtn());
    expect(
      await screen.findByText('Could not create the PI: TF400898: quota. Rolling back failed too (No delete permission); delete "Fabrikam\\PIs\\PI 3" manually.')
    ).toBeInTheDocument();
  });

  it("reports a missing PI root during rollback", async () => {
    await renderPis();
    failIterationPost(1);
    fail(/GET .*classificationnodes\/Iterations\/PIs$/, 200, "", { raw: "{}" });
    fireEvent.click(createBtn());
    expect(await screen.findByText(/Rolling back failed too \(Could not find the iteration Fabrikam\\PIs\.\)/)).toBeInTheDocument();
    expect(fake.deletedIterations).toHaveLength(0);
  });
});

describe("PIs & Iterations — delete an iteration", () => {
  it("deletes one iteration after confirmation, moving its items to the PI", async () => {
    const { panel, ctx } = await manage("PI 2");
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(within(panel).getByRole("button", { name: "Delete PI 2 IP" }));
    expect(window.confirm).toHaveBeenCalledWith("Delete PI 2 IP? Work items in it move to PI 2, and teams lose this sprint.");
    expect(callsTo(/classificationnodes/, "DELETE")).toHaveLength(0);

    fireEvent.click(within(panel).getByRole("button", { name: "Delete PI 2 IP" }));
    expect(await within(panel).findByText("Deleted PI 2 IP")).toBeInTheDocument();
    const pi2 = fake.iterationTree.children!.find((c) => c.name === "PIs")!.children!.find((c) => c.name === "PI 2")!;
    expect(fake.deletedIterations).toEqual([{ path: "\\Fabrikam\\Iteration\\PIs\\PI 2\\PI 2 IP", reclassifyId: pi2.id }]);
    expect(ctx.reloadPis).toHaveBeenCalled();
  });

  it("reports when the PI node cannot be found", async () => {
    const { panel } = await manage("PI 2");
    fail(/GET .*classificationnodes\/Iterations\/PIs\/PI 2$/, 200, "", { raw: "{}" });
    fireEvent.click(within(panel).getByRole("button", { name: "Delete PI 2 Sprint 1" }));
    expect(await within(panel).findByText("Could not find the iteration Fabrikam\\PIs\\PI 2.")).toBeInTheDocument();
    expect(fake.deletedIterations).toHaveLength(0);
  });
});

describe("PIs & Iterations — read-only and cadence", () => {
  const readOnly: Capabilities = { admin: false, managePis: false, plan: true };

  it("is read-only without the manage PIs capability", async () => {
    const { panel } = await manage("PI 2", { can: readOnly });
    expect(screen.getByRole("note")).toHaveTextContent(/Read-only/);
    expect(createBtn()).toBeDisabled();
    expect(field("PI name")).toBeDisabled();
    expect(row(1, "name")).toBeDisabled();
    for (const b of screen.getAllByRole("button", { name: "Assign to teams" })) expect(b).toBeDisabled();

    expect(within(panel).queryByRole("button", { name: "Delete PI" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Save PI" })).toBeNull();
    expect(within(panel).getByLabelText("Name")).toBeDisabled();
    expect(within(panel).queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /^Delete PI 2/ })).toBeNull();
    expect(within(panel).queryByRole("heading", { name: "Add iteration" })).toBeNull();

    fireEvent.change(within(panel).getByLabelText("Team"), { target: { value: "t-red" } });
    const boxes = await within(panel).findAllByRole("checkbox");
    boxes.forEach((b) => expect(b).toBeDisabled());
  });

  it("says there are no PIs without suggesting to create one", async () => {
    await renderPis({ can: readOnly, pis: [], pi: null });
    expect(screen.getByText("No PIs yet.")).toBeInTheDocument();
  });

  it("names the project cadence by default", async () => {
    await renderPis();
    expect(document.querySelector(".pi-cadence")).toHaveTextContent("PIs of the project cadence · under Fabrikam\\PIs");
    expect(within(piRow("PI 2")).getByRole("button", { name: "Manage" })).toBeInTheDocument();
  });

  it("names the unit whose cadence is managed", async () => {
    const config = makeConfig();
    config.root.children[0].piRootIteration = "Fabrikam\\PIs";
    await renderPis({ config, nodeId: "n-red", piRoot: "Fabrikam\\PIs" });
    expect(document.querySelector(".pi-cadence")).toHaveTextContent("PIs of ART A's cadence · under Fabrikam\\PIs");
  });

  it("falls back to the project label when the shell's cadence differs from the unit's", async () => {
    const config = makeConfig();
    config.root.children[0].piRootIteration = "Fabrikam\\Other";
    await renderPis({ config, nodeId: "n-arta", piRoot: "Fabrikam\\PIs" });
    expect(document.querySelector(".pi-cadence")).toHaveTextContent("PIs of the project cadence");
  });
});

describe("PIs & Iterations — waiting", () => {
  it("disables iteration actions while another change runs", async () => {
    const { panel } = await manage("PI 2");
    fireEvent.click(within(panel).getByRole("button", { name: "Delete PI 2 IP" }));
    expect(within(panel).getByRole("button", { name: "Edit PI 2 Sprint 1" })).toBeDisabled();
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Edit PI 2 Sprint 1" })).toBeEnabled());
  });
});
