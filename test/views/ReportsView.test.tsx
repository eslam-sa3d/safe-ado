import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import * as sdk from "../sdkMock";
import { describe, expect, it } from "vitest";
import { ReportsView } from "../../src/views/ReportsView";
import { dataStore, fail, makeConfig, PI1, PI2, seedDocs } from "../fakeAdo";
import { renderView } from "../utils";

const section = (heading: RegExp | string) => screen.getByRole("heading", { name: heading }).closest(".panel") as HTMLElement;
const barRow = (container: HTMLElement, label: string) =>
  within(container).getByTitle(label).closest(".bar-row") as HTMLElement;

function seedObjectives() {
  const o = (id: string, nodeId: string, committed: boolean, plannedBV: number, actualBV: number | null, piPath = PI2) => ({
    id, nodeId, committed, plannedBV, actualBV, piPath, title: id, featureIds: [],
  });
  seedDocs("objectives", [
    o("a", "n-red", true, 10, 9),
    o("b", "n-blue", true, 10, 6),
    o("c", "n-blue", false, 2, 1),
    o("d", "n-red", true, 10, 5, PI1),
    o("e", "n-green", true, 10, 10),
  ]);
}

async function renderReports(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<ReportsView />, opts);
  await waitFor(() => expect(document.querySelectorAll(".spinner")).toHaveLength(0));
  return r;
}

describe("Reports", () => {
  it("shows PI predictability per PI and per team with tones and the target band", async () => {
    seedObjectives();
    await renderReports();
    const panel = section("PI Predictability");
    const byPi = within(panel).getByRole("heading", { name: "By PI — ART A" }).parentElement!;
    expect(within(barRow(byPi, "PI 1")).getByText("50%")).toBeInTheDocument();
    expect(barRow(byPi, "PI 1").querySelector(".bar-fill")).toHaveClass("bad");
    // PI 2: (9 + 6 + 1) / 20 = 80%
    expect(within(barRow(byPi, "PI 2")).getByText("80%")).toBeInTheDocument();
    expect(within(barRow(byPi, "PI 2")).getByText("16/20 BV")).toBeInTheDocument();
    expect(barRow(byPi, "PI 2").querySelector(".bar-fill")).toHaveClass("good");
    expect(byPi.querySelector(".bar-band")).toBeInTheDocument();

    const byTeam = within(panel).getByRole("heading", { name: "By team — PI 2" }).parentElement!;
    expect(within(barRow(byTeam, "Team Red")).getByText("90%")).toBeInTheDocument();
    expect(within(barRow(byTeam, "Team Blue")).getByText("70%")).toBeInTheDocument();
    expect(barRow(byTeam, "Team Blue").querySelector(".bar-fill")).toHaveClass("warn");
  });

  it("shows '—' for PIs without committed objectives and 'No data' without PIs", async () => {
    await renderReports({ nodeId: "n-red" });
    const panel = section("PI Predictability");
    expect(within(barRow(panel, "PI 2")).getByText("—")).toBeInTheDocument();
    expect(barRow(panel, "PI 2").querySelector(".bar-fill")).toBeNull();
    // Teams have no children, so there is no per-child chart
    expect(within(panel).queryByText(/By team/)).toBeNull();
  });

  it("says 'No data.' when there are no PIs and hides velocity without a PI", async () => {
    await renderReports({ pis: [], pi: null });
    expect(screen.getByText("No data.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Velocity/ })).toBeNull();
    // Without a PI the progress report is unfiltered
    expect(screen.getByRole("heading", { name: "Feature progress" })).toBeInTheDocument();
  });

  it("labels per-child charts generically above ART level", async () => {
    const config = makeConfig();
    config.root.children = [{ id: "n-sol", name: "Big Solution", level: "solution", areaPath: "Fabrikam", children: config.root.children }];
    seedObjectives();
    await renderReports({ config, nodeId: "n-sol" });
    const byChild = screen.getByRole("heading", { name: "By child — PI 2" }).parentElement!;
    expect(within(barRow(byChild, "ART A")).getByText("80%")).toBeInTheDocument();
    expect(within(barRow(byChild, "ART B")).getByText("100%")).toBeInTheDocument();
  });

  it("reports feature progress for the PI, most remaining work first", async () => {
    await renderReports();
    const panel = section("Feature progress — PI 2");
    expect(within(panel).getByText("Overall 5/16 pts")).toBeInTheDocument();
    const titles = Array.from(panel.querySelectorAll("tbody .title-link")).map((b) => b.textContent);
    expect(titles).toEqual(["Wallet", "Payment API", "Checkout UI", "Fraud rules"]);
    const payment = within(panel).getByRole("button", { name: "Payment API" }).closest("tr")!;
    expect(within(payment).getByText("1/2")).toBeInTheDocument();
    expect(within(payment).getByText("5/8")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Payment API" }));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(10));
  });

  it("reports Epic progress at portfolio level without velocity", async () => {
    await renderReports({ nodeId: "n-root" });
    expect(screen.getByRole("heading", { name: "Epic progress" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Velocity/ })).toBeNull();
  });

  it("shows an empty progress state", async () => {
    const { getProgramIncrements } = await import("../../src/api/wit");
    const pi1 = (await getProgramIncrements("Fabrikam\\PIs"))[0];
    await renderReports({ nodeId: "n-blue", pi: pi1 });
    expect(screen.getByRole("heading", { name: "No Features in scope" })).toBeInTheDocument();
  });

  it("computes velocity per team and iteration, excluding removed stories", async () => {
    await renderReports();
    const table = section("Velocity — PI 2").querySelector("table.velocity") as HTMLElement;
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Team",
      "PI 2 Sprint 1",
      "PI 2 Sprint 2",
      "PI 2 IP",
      "PI total",
    ]);
    const cells = (team: string) =>
      within(within(table).getByText(team).closest("tr")!)
        .getAllByRole("cell")
        .slice(1)
        .map((c) => c.textContent);
    expect(cells("Team Red")).toEqual(["5/5", "0/3", "0/0", "5/8"]);
    expect(cells("Team Blue")).toEqual(["0/8", "0/0", "0/0", "0/8"]);
  });

  it("asks for area mapping when no rows have area paths", async () => {
    const config = makeConfig();
    config.root.children[1].children[0].areaPath = undefined;
    await renderReports({ config, nodeId: "n-artb" });
    expect(screen.getByText("Map teams to area paths in Setup to see velocity.")).toBeInTheDocument();
  });

  it("shows errors from each report", async () => {
    dataStore.failures.push({ op: "getDocuments", error: Object.assign(new Error("objectives down"), { status: 500 }) });
    fail(/wiql/, 500, "wiql down");
    await renderReports();
    expect(screen.getByText("objectives down")).toBeInTheDocument();
    expect(screen.getAllByText("wiql down")).toHaveLength(2);
  });
});
