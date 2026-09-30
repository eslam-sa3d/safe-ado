import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CapacitySource, SafeConfig } from "../../src/api/types";
import { SetupView } from "../../src/views/SetupView";
import { TeamBoard } from "../../src/views/TeamBoard";
import { callsTo, dataStore, fake, makeConfig, PI2_S1 } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { renderView } from "../utils";
import { renderReports, seed, widget } from "./reports/helpers";

const S1 = "iteration-PIs-PI_2-PI_2_Sprint_1";
const EVERY_DAY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const member = (name: string, perDay = 6) => ({ teamMember: { displayName: name }, activities: [{ name: "Development", capacityPerDay: perDay }], daysOff: [] });
const config = (source: CapacitySource, pointsPerPersonDay?: number) => makeConfig({ capacity: { source, pointsPerPersonDay } });
const origins = (root: ParentNode = document) => Array.from(root.querySelectorAll(".cap-src")).map((b) => b.getAttribute("data-origin"));
const collection = (name: string) => Array.from(dataStore.collections.get(`${name}-${fake.projectId}`)?.values() ?? []);

/** Team Red: two full-time members in PI 2 Sprint 1; every day is a working day, so 2 × 14 × 0.8 = 22.4 SP. */
function seedRedCapacity() {
  fake.teamWorkingDays["t-red"] = EVERY_DAY;
  fake.teamCapacity[`t-red|${S1}`] = [member("Ada Lovelace"), member("Grace Hopper")];
  fake.teamCapacity[`t-red|iteration-PIs-PI_2-PI_2_IP`] = [];
}

async function renderBoard(cfg: SafeConfig) {
  const r = await renderView(<TeamBoard />, { nodeId: "n-red", config: cfg });
  await waitFor(() => expect(screen.queryByText("Loading team planning board…")).not.toBeInTheDocument());
  return r;
}

describe("Capacity on the Team Planning Board", () => {
  it("manual (default): no source marker and no Azure DevOps capacity requests", async () => {
    seedRedCapacity();
    await renderBoard(makeConfig());
    expect(screen.getByRole("button", { name: "Load 5 of capacity not set for PI 2 Sprint 1" })).toBeInTheDocument();
    expect(origins()).toEqual([]);
    expect(callsTo(/capacities|teamdaysoff|teamsettings$/)).toHaveLength(0);
    expect(screen.getByText(/Load \/ Capacity in story points \(manual story points\)/)).toHaveTextContent("Click a capacity to edit it.");
  });

  it("derived: shows the Azure DevOps value read-only with its source, and a setup link when not set", async () => {
    seedRedCapacity();
    // A manual value is ignored in derived mode.
    seed("capacity", [{ id: `n-red|${PI2_S1}`, nodeId: "n-red", iterationPath: PI2_S1, capacity: 4 }]);
    await renderBoard(config("derived"));
    const headers = Array.from(document.querySelectorAll(".tb-col-header"));
    expect(headers[0].querySelector(".tb-capacity.locked")).toHaveTextContent("5 / 22.4");
    expect(headers[0].querySelector(".tb-capacity.locked")).toHaveAttribute("title", expect.stringContaining("derived from Azure DevOps"));
    expect(screen.queryByRole("button", { name: /of capacity/ })).toBeNull();
    expect(origins()).toEqual(["derived", "none", "none"]);
    const badge = headers[0].querySelector(".cap-src")!;
    expect(badge).toHaveTextContent("derived");
    expect(badge.getAttribute("title")).toContain("28 available person-days × 0.8 SP = 22.4 SP");
    expect(badge.getAttribute("title")).toContain("• Ada Lovelace: 14 days → 11.2 SP");
    expect(headers[1].querySelector(".cap-src")!.getAttribute("title")).toBe("Not set: PI 2 Sprint 2 is not selected as a team iteration in Azure DevOps.");
    expect(headers[2].querySelector(".cap-src")!.getAttribute("title")).toBe("Not set: No capacity is set up for the team in Azure DevOps.");
    expect(headers[1].querySelector(".tb-capacity")).toHaveTextContent("3 / –");

    const links = screen.getAllByRole("button", { name: "Set up capacity in Azure DevOps" });
    expect(links).toHaveLength(2);
    fireEvent.click(links[0]);
    await waitFor(() =>
      expect(sdk.hostNavigation.openNewWindow).toHaveBeenCalledWith(`${fake.baseUrl}/Fabrikam/_sprints/capacity/Team%20Red/Fabrikam/PIs/PI%202/PI%202%20Sprint%202`, "")
    );
    expect(screen.getByText(/Load \/ Capacity in story points \(derived from azure devops team capacity\)/)).not.toHaveTextContent("Click");
  });

  it("derived with a custom factor and the { value } response shape", async () => {
    seedRedCapacity();
    fake.capacityShape = "value";
    await renderBoard(config("derived", 1));
    expect(document.querySelector(".tb-col-header .tb-capacity")).toHaveTextContent("5 / 28");
  });

  it("hybrid: a manual override wins, clearing it restores the derived value", async () => {
    seedRedCapacity();
    seed("capacity", [{ id: `n-red|${PI2_S1}`, nodeId: "n-red", iterationPath: PI2_S1, capacity: 4 }]);
    await renderBoard(config("hybrid"));
    expect(origins()).toEqual(["override", "none", "none"]);
    const s1 = screen.getByRole("button", { name: "Load 5 of capacity 4 for PI 2 Sprint 1" });
    expect(s1).toHaveAttribute("title", "Load / Capacity (story points) — click to override the capacity");
    expect(document.querySelector(".cap-src")!.getAttribute("title")).toBe(
      "Manual override: 4 SP (derived from Azure DevOps: 22.4 SP). Clear it to use the derived value."
    );
    expect(screen.getByText(/clear the value to use the derived one/)).toBeInTheDocument();

    // Clearing the override removes the manual document.
    fireEvent.click(s1);
    const input = screen.getByRole("spinbutton", { name: "Capacity for PI 2 Sprint 1" });
    expect(input).toHaveValue(4);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("button", { name: "Load 5 of capacity 22.4 for PI 2 Sprint 1" });
    expect(collection("capacity")).toHaveLength(0);
    expect(origins()[0]).toBe("derived");

    // The editor starts empty when there is no override; an empty value changes nothing.
    fireEvent.click(screen.getByRole("button", { name: "Load 5 of capacity 22.4 for PI 2 Sprint 1" }));
    expect(screen.getByRole("spinbutton")).toHaveValue(null);
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" });
    expect(screen.queryByRole("alert")).toBeNull();

    // Entering a value where Azure DevOps has none sets an override.
    fireEvent.click(screen.getByRole("button", { name: "Load 3 of capacity not set for PI 2 Sprint 2" }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "10" } });
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" });
    await screen.findByRole("button", { name: "Load 3 of capacity 10 for PI 2 Sprint 2" });
    expect(origins()).toEqual(["derived", "override", "none"]);
  });

  it("hybrid: reports a failure to clear the override", async () => {
    seedRedCapacity();
    seed("capacity", [{ id: `n-red|${PI2_S1}`, nodeId: "n-red", iterationPath: PI2_S1, capacity: 4 }]);
    await renderBoard(config("hybrid"));
    dataStore.failures.push({ op: "deleteDocument", error: new Error("Offline") });
    fireEvent.click(screen.getByRole("button", { name: "Load 5 of capacity 4 for PI 2 Sprint 1" }));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
    fireEvent.blur(screen.getByRole("spinbutton"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not clear the capacity override: Offline");
    expect(screen.getByRole("button", { name: "Load 5 of capacity 4 for PI 2 Sprint 1" })).toBeInTheDocument();
  });
});

describe("Capacity in the reports", () => {
  it("Load vs. Capacity sums effective values of the ART's teams and marks mixed sources", async () => {
    seedRedCapacity();
    seed("capacity", [{ id: "b1", nodeId: "n-blue", iterationPath: PI2_S1, capacity: 6 }]);
    await renderReports({ nodeId: "n-arta", config: config("hybrid") });
    const w = widget("Load vs. Capacity");
    expect(within(w).getByText("16 SP of 28.4 SP capacity")).toBeInTheDocument();
    const badge = w.querySelector(".cap-src")!;
    expect(badge).toHaveTextContent("mixed");
    expect(badge.getAttribute("title")).toBe("28.4 SP from 2 of 6 team iterations: 1 derived (22.4 SP), 1 override (6 SP). 4 not set.");
    expect(w.querySelector(".cap-summary")).toHaveTextContent("4 of 6 team iterations not set");
  });

  it("Load vs. Capacity shows a single source and no marker in manual mode", async () => {
    seedRedCapacity();
    const { unmount } = await renderReports({ nodeId: "n-red", config: config("derived") });
    expect(within(widget("Load vs. Capacity")).getByText("8 SP of 22.4 SP capacity")).toBeInTheDocument();
    expect(origins(widget("Load vs. Capacity"))).toEqual(["derived"]);
    unmount();
    await renderReports({ nodeId: "n-red" });
    expect(origins(widget("Load vs. Capacity"))).toEqual([]);
    // One request per iteration, all from the derived render.
    expect(callsTo(/capacities/)).toHaveLength(3);
  });

  it("Iteration Overview shows the effective value, its source and a setup link when not set", async () => {
    seedRedCapacity();
    await renderReports({ nodeId: "n-red", config: config("derived") });
    const w = widget("Iteration Overview");
    expect(w.querySelector(".iteration-stats")).toHaveTextContent("22.4Capacity (SP)derived");
    expect(within(w).getByText("derived")).toHaveAttribute("title", expect.stringContaining("= 22.4 SP"));
    expect(within(w).queryByRole("button", { name: "Set up capacity in Azure DevOps" })).toBeNull();
    fireEvent.click(within(w).getByRole("button", { name: "Next iteration" }));
    expect(w.querySelector(".iteration-stats")).toHaveTextContent("—Capacity (SP)not set");
    expect(within(w).getByRole("button", { name: "Set up capacity in Azure DevOps" })).toBeInTheDocument();
  });

  it("Iteration Overview reports overload against a fractional derived capacity", async () => {
    fake.teamWorkingDays["t-red"] = EVERY_DAY;
    fake.teamCapacity[`t-red|${S1}`] = [member("Ada", 1)];
    await renderReports({ nodeId: "n-red", config: config("derived", 0.3) });
    // 14 days × 0.3 = 4.2 SP against 5 SP planned.
    expect(within(widget("Iteration Overview")).getByText("Overloaded by 0.8 SP")).toBeInTheDocument();
  });
});

describe("Capacity setting in Setup", () => {
  async function renderSetup(cfg?: SafeConfig) {
    const r = await renderView(<SetupView firstRun={false} />, { nodeId: "n-root", config: cfg });
    await screen.findByRole("heading", { name: "Capacity" });
    return r;
  }
  const source = () => screen.getByLabelText("Capacity source") as HTMLSelectElement;
  const factor = () => screen.getByLabelText("Story points per person-day") as HTMLInputElement;
  const save = async (ctx: { saveConfig: any }) => {
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await screen.findByText("Saved ✓");
    return ctx.saveConfig.mock.calls.at(-1)[0] as SafeConfig;
  };

  it("defaults existing configs to manual story points and saves the derived source with a factor", async () => {
    const { ctx } = await renderSetup();
    expect(source().value).toBe("manual");
    expect(factor()).toBeDisabled();
    expect(factor().value).toBe("0.8");
    expect(screen.getByText(/Teams enter their capacity in story points/)).toBeInTheDocument();

    // Switching away and back to manual leaves the config unchanged.
    fireEvent.change(source(), { target: { value: "derived" } });
    fireEvent.change(source(), { target: { value: "manual" } });
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeDisabled();

    fireEvent.change(source(), { target: { value: "derived" } });
    expect(factor()).not.toBeDisabled();
    expect(screen.getByText(/a full-time member in a 2-week iteration yields 8 SP/)).toBeInTheDocument();
    fireEvent.change(factor(), { target: { value: "1" } });
    expect(screen.getByText(/yields 10 SP/)).toBeInTheDocument();
    expect((await save(ctx)).capacity).toEqual({ source: "derived", pointsPerPersonDay: 1 });
  });

  it("hybrid: explains overrides; an invalid factor falls back to the default", async () => {
    const { ctx } = await renderSetup(config("hybrid", 0.5));
    expect(source().value).toBe("hybrid");
    expect(factor().value).toBe("0.5");
    expect(screen.getByText(/overrides the derived one/)).toBeInTheDocument();
    fireEvent.change(factor(), { target: { value: "0" } });
    expect(factor().value).toBe("0");
    fireEvent.blur(factor());
    expect(factor().value).toBe("0.8");
    expect((await save(ctx)).capacity).toEqual({ source: "hybrid", pointsPerPersonDay: undefined });
    // Back to manual without a factor removes the setting.
    fireEvent.change(source(), { target: { value: "manual" } });
    expect((await save(ctx)).capacity).toBeUndefined();
  });
});
