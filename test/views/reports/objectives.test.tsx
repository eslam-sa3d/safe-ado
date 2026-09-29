import { fireEvent, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeConfig, PI1, PI2 } from "../../fakeAdo";
import { objective, renderReports, seed, widget } from "./helpers";

const cells = (table: HTMLElement) => Array.from(table.querySelectorAll("tbody tr, tfoot tr")).map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent));
const barRow = (container: HTMLElement, label: string) => within(container).getByTitle(label).closest(".bar-row") as HTMLElement;

function seedObjectives() {
  seed("objectives", [
    objective("Launch wallet", "n-arta", true, 10, 8, PI2),
    objective("Cut latency", "n-arta", true, 5, null, PI2),
    objective("Stretch goal", "n-arta", false, 3, 2, PI2),
    objective("red", "n-red", true, 10, 9, PI2),
    objective("blue", "n-blue", true, 10, 6, PI2),
    objective("blue-2", "n-blue", false, 2, 1, PI2),
    objective("old", "n-arta", true, 10, 5, PI1),
    objective("red-old", "n-red", true, 10, 5, PI1),
    objective("green", "n-green", true, 10, 10, PI2),
  ]);
}

describe("PI Objectives widget", () => {
  it("groups the unit's objectives into committed and uncommitted with totals", async () => {
    seedObjectives();
    await renderReports();
    const w = widget("PI Objectives");
    expect(within(w).getByText("ART A: 10 of 15 committed BV (67%)")).toBeInTheDocument();
    expect(cells(within(w).getByRole("table", { name: "Committed" }))).toEqual([
      ["Launch wallet", "10", "8"],
      ["Cut latency", "5", "—"],
      ["Total", "15", "8"],
    ]);
    expect(cells(within(w).getByRole("table", { name: "Uncommitted" }))).toEqual([
      ["Stretch goal", "3", "2"],
      ["Total", "3", "2"],
    ]);
  });

  it("shows team progress with the ART average and selects a team on click", async () => {
    seedObjectives();
    const { ctx } = await renderReports();
    const w = widget("PI Objectives");
    expect(within(w).getByText("· average 80%")).toBeInTheDocument();
    const red = within(w).getByRole("button", { name: "Team Red" }).closest(".team-progress-row")!;
    expect(red).toHaveTextContent("90% · 9/10 BV");
    const blue = within(w).getByRole("button", { name: "Team Blue" }).closest(".team-progress-row")!;
    expect(blue).toHaveTextContent("70% · 7/10 BV");
    expect(blue.querySelector(".tone-warn")).toBeInTheDocument();
    fireEvent.click(within(w).getByRole("button", { name: "Team Blue" }));
    expect(ctx.selectNode).toHaveBeenCalledWith("n-blue");
  });

  it("handles units without objectives or children", async () => {
    const config = makeConfig();
    config.root.children[1].children = [];
    const a = await renderReports({ config, nodeId: "n-artb" });
    const w = widget("PI Objectives");
    expect(within(w).getByText("ART B: 0 of 0 committed BV")).toBeInTheDocument();
    expect(within(w).getAllByText("None")).toHaveLength(2);
    expect(within(w).getByText("No child units.")).toBeInTheDocument();
    a.unmount();
    await renderReports();
    const art = widget("PI Objectives");
    expect(within(art).getByRole("button", { name: "Team Red" }).closest(".team-progress-row")).toHaveTextContent("No committed BV");
    expect(within(art).queryByText(/average/)).toBeNull();
  });

  it("has no team progress on a team", async () => {
    seedObjectives();
    await renderReports({ nodeId: "n-red" });
    expect(widget("PI Objectives").querySelector(".team-progress")).toBeNull();
  });
});

describe("PI Risks widget", () => {
  it("lists the subtree's PI risks with ROAM status, exposure and residual exposure by rank", async () => {
    seed("risks", [
      { id: "r2", nodeId: "n-arta", piPath: PI2, title: "Scope creep", status: "Unroamed", probability: "Likely", impactLevel: "Moderate" },
      { id: "r1", nodeId: "n-red", piPath: PI2, title: "Vendor late", status: "Owned", probability: "Almost Certain", impactLevel: "Catastrophic", residualProbability: "Unlikely", residualImpact: "Minor" },
      { id: "r3", nodeId: "n-green", piPath: PI2, title: "Elsewhere", status: "Owned" },
      { id: "r4", nodeId: "n-red", piPath: PI1, title: "Old", status: "Owned" },
    ]);
    await renderReports();
    const w = widget("PI Risks");
    const rows = Array.from(w.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent));
    expect(rows).toEqual([
      ["Vendor late · Team Red", "Owned", "EXTREME", "MEDIUM"],
      ["Scope creep", "Unroamed", "HIGH", "INTERMEDIATE"],
    ]);
    expect(within(w).getByText("Owned")).toHaveClass("roam-owned");
    expect(within(w).getByText("EXTREME")).toHaveStyle({ background: "#8b0000" });
  });

  it("says when there are no risks", async () => {
    await renderReports();
    expect(within(widget("PI Risks")).getByText("No risks in PI 2.")).toBeInTheDocument();
  });
});

describe("PI Predictability widget", () => {
  it("shows predictability per PI and per team with tones and the target band", async () => {
    seedObjectives();
    await renderReports();
    const panel = widget("PI Predictability");
    const byPi = within(panel).getByRole("heading", { name: "By PI — ART A" }).parentElement!;
    // PI 1: 10 / 20
    expect(within(barRow(byPi, "PI 1")).getByText("50%")).toBeInTheDocument();
    expect(barRow(byPi, "PI 1").querySelector(".bar-fill")).toHaveClass("bad");
    // PI 2: (8 + 2 + 9 + 6 + 1) / 35
    expect(within(barRow(byPi, "PI 2")).getByText("74%")).toBeInTheDocument();
    expect(within(barRow(byPi, "PI 2")).getByText("26/35 BV")).toBeInTheDocument();
    expect(barRow(byPi, "PI 2").querySelector(".bar-fill")).toHaveClass("warn");
    expect(byPi.querySelector(".bar-band")).toBeInTheDocument();

    const byTeam = within(panel).getByRole("heading", { name: "By team — PI 2" }).parentElement!;
    expect(within(barRow(byTeam, "Team Red")).getByText("90%")).toBeInTheDocument();
    expect(barRow(byTeam, "Team Red").querySelector(".bar-fill")).toHaveClass("good");
    expect(within(barRow(byTeam, "Team Blue")).getByText("70%")).toBeInTheDocument();
  });

  it("shows '—' for PIs without committed objectives and no per-child chart for teams", async () => {
    await renderReports({ nodeId: "n-red" });
    const panel = widget("PI Predictability");
    expect(within(barRow(panel, "PI 2")).getByText("—")).toBeInTheDocument();
    expect(barRow(panel, "PI 2").querySelector(".bar-fill")).toBeNull();
    expect(within(panel).queryByText(/By team/)).toBeNull();
  });

  it("labels per-child charts generically above ART level", async () => {
    const config = makeConfig();
    config.root.children = [{ id: "n-sol", name: "Big Solution", level: "solution", areaPath: "Fabrikam", children: config.root.children }];
    seedObjectives();
    await renderReports({ config, nodeId: "n-sol" });
    const chart = within(widget("PI Predictability")).getByRole("heading", { name: "By child — PI 2" }).parentElement!;
    expect(within(barRow(chart, "ART A")).getByText("74%")).toBeInTheDocument();
    expect(within(barRow(chart, "ART B")).getByText("100%")).toBeInTheDocument();
  });
});
