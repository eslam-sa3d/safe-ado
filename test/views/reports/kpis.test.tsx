import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getProgramIncrements } from "../../../src/api/wit";
import { fake, makeConfig, PI1, PI2, PI2_IP, PI2_S1, PI2_S2 } from "../../fakeAdo";
import { objective, renderReports, seed, widget } from "./helpers";

const pis = () => getProgramIncrements("Fabrikam\\PIs");

describe("PI Progress", () => {
  it("shows the share of the PI elapsed and the days remaining", async () => {
    await renderReports();
    const w = widget("PI Progress");
    expect(within(w).getByRole("img", { name: "20% elapsed" })).toBeInTheDocument();
    expect(within(w).getByText("28 days remaining · 35 days total")).toBeInTheDocument();
  });

  it("shows the start date of a planned PI and a hint for undated PIs", async () => {
    const all = await pis();
    const future = { ...all[1], name: "PI 3", start: new Date(Date.now() + 10 * 86_400_000).toISOString(), finish: new Date(Date.now() + 40 * 86_400_000).toISOString() };
    const { unmount } = await renderReports({ pi: future, pis: [...all, future] });
    expect(within(widget("PI Progress")).getByText(/^Starts /)).toBeInTheDocument();
    expect(within(widget("PI Progress")).getByRole("img", { name: "0% elapsed" })).toBeInTheDocument();
    unmount();
    await renderReports({ pi: { ...all[1], start: undefined } });
    expect(within(widget("PI Progress")).getByText("PI 2 has no start and finish dates.")).toBeInTheDocument();
  });
});

describe("Story Points Burned", () => {
  it("relates done to planned points of the PI's team stories, ignoring removed ones", async () => {
    await renderReports();
    const w = widget("Story Points Burned");
    expect(within(w).getByText("31%")).toBeInTheDocument();
    expect(within(w).getByText("5 of 16 SP done")).toBeInTheDocument();
    expect(within(w).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "31");
  });

  it("aggregates only the selected team", async () => {
    await renderReports({ nodeId: "n-blue" });
    expect(within(widget("Story Points Burned")).getByText("0 of 8 SP done")).toBeInTheDocument();
  });

  it("shows '—' without planned points", async () => {
    await renderReports({ nodeId: "n-green" });
    expect(within(widget("Story Points Burned")).getByText("—")).toBeInTheDocument();
  });
});

describe("Business Value", () => {
  it("relates actual to committed planned BV of the subtree's PI objectives and warns about missing actuals", async () => {
    seed("objectives", [
      objective("a", "n-red", true, 10, 9, PI2),
      objective("b", "n-blue", true, 10, null, PI2),
      objective("c", "n-arta", false, 5, 3, PI2),
      objective("d", "n-green", true, 10, 10, PI2),
      objective("e", "n-red", true, 10, 10, PI1),
    ]);
    await renderReports();
    const w = widget("Business Value");
    expect(within(w).getByText("60%")).toBeInTheDocument();
    expect(within(w).getByText("12 of 20 BV (committed)")).toBeInTheDocument();
    expect(within(w).getByRole("note")).toHaveTextContent("1 objective without actual BV");
    expect(w.querySelector(".ratio-value")).toHaveClass("warn");
  });

  it("colours good and bad results and hides the warning when complete", async () => {
    seed("objectives", [objective("a", "n-red", true, 10, 9, PI2), objective("b", "n-blue", true, 10, 2, PI2)]);
    const { unmount } = await renderReports({ nodeId: "n-red" });
    expect(widget("Business Value").querySelector(".ratio-value")).toHaveClass("good");
    expect(within(widget("Business Value")).queryByRole("note")).toBeNull();
    unmount();
    await renderReports({ nodeId: "n-blue" });
    expect(widget("Business Value").querySelector(".ratio-value")).toHaveClass("bad");
  });

  it("shows '—' without committed objectives", async () => {
    seed("objectives", [objective("a", "n-red", false, 10, 2, PI2), objective("b", "n-red", false, 10, null, PI2)]);
    await renderReports();
    const w = widget("Business Value");
    expect(within(w).getByText("—")).toBeInTheDocument();
    expect(within(w).getByRole("note")).toHaveTextContent("1 objective without actual BV");
    expect(w.querySelector(".ratio-value")!.className).toBe("ratio-value");
  });
});

describe("Load vs. Capacity", () => {
  it("relates planned PI points to the capacity of the subtree's teams over the PI's iterations", async () => {
    seed("capacity", [
      { id: `n-red|${PI2_S1}`, nodeId: "n-red", iterationPath: PI2_S1, capacity: 5 },
      { id: `n-red|${PI2_S2}`, nodeId: "n-red", iterationPath: PI2_S2, capacity: 5 },
      { id: `n-blue|${PI2_S1}`, nodeId: "n-blue", iterationPath: PI2_S1, capacity: 6 },
      { id: `n-blue|${PI2_IP}`, nodeId: "n-blue", iterationPath: PI2_IP, capacity: 4 },
      { id: `n-green|${PI2_S1}`, nodeId: "n-green", iterationPath: PI2_S1, capacity: 50 },
      { id: `n-arta|${PI2_S1}`, nodeId: "n-arta", iterationPath: PI2_S1, capacity: 50 },
    ]);
    await renderReports();
    const w = widget("Load vs. Capacity");
    expect(within(w).getByText("80%")).toBeInTheDocument();
    expect(within(w).getByText("16 SP of 20 SP capacity")).toBeInTheDocument();
    expect(within(w).getByRole("note")).toHaveTextContent("1 unestimated story");
    expect(w.querySelector(".ratio-value")).toHaveClass("good");
  });

  it("flags overload and under-load", async () => {
    seed("capacity", [
      { id: "1", nodeId: "n-red", iterationPath: PI2_S1, capacity: 4 },
      { id: "2", nodeId: "n-blue", iterationPath: PI2_S1, capacity: 40 },
    ]);
    const { unmount } = await renderReports({ nodeId: "n-red" });
    expect(within(widget("Load vs. Capacity")).getByText("200%")).toBeInTheDocument();
    expect(widget("Load vs. Capacity").querySelector(".ratio-value")).toHaveClass("bad");
    unmount();
    await renderReports({ nodeId: "n-blue" });
    expect(widget("Load vs. Capacity").querySelector(".ratio-value")).toHaveClass("warn");
  });

  it("explains missing capacity and pluralizes unestimated stories", async () => {
    fake.workItems.get(102)!.fields["Microsoft.VSTS.Scheduling.StoryPoints"] = undefined;
    await renderReports();
    const w = widget("Load vs. Capacity");
    expect(within(w).getByText("—")).toBeInTheDocument();
    expect(within(w).getByText("8 SP · no capacity set")).toBeInTheDocument();
    expect(within(w).getByRole("note")).toHaveTextContent("2 unestimated stories");
  });
});

describe("Velocity", () => {
  it("shows velocity to date for the current PI of an ART", async () => {
    await renderReports();
    const w = widget("Velocity");
    expect(within(w).getByText("5")).toBeInTheDocument();
    expect(within(w).getByText("SP per PI · Velocity to date")).toBeInTheDocument();
  });

  it("shows the PI total of a completed PI of an ART", async () => {
    const all = await pis();
    await renderReports({ pi: all[0] });
    expect(within(widget("Velocity")).getByText("2")).toBeInTheDocument();
    expect(within(widget("Velocity")).getByText("SP per PI · PI total")).toBeInTheDocument();
  });

  it("averages the last completed PIs for a planned PI of an ART", async () => {
    const all = await pis();
    const future = { ...all[1], name: "PI 3", path: "Fabrikam\\PIs\\PI 3", start: new Date(Date.now() + 40 * 86_400_000).toISOString(), finish: new Date(Date.now() + 70 * 86_400_000).toISOString(), sprints: [] };
    await renderReports({ pi: future, pis: [...all, future] });
    expect(within(widget("Velocity")).getByText("2")).toBeInTheDocument();
    expect(within(widget("Velocity")).getByText("SP per PI · Ø last 5 completed PIs")).toBeInTheDocument();
  });

  it("averages iterations for a team", async () => {
    const all = await pis();
    const { unmount } = await renderReports({ nodeId: "n-red" });
    expect(within(widget("Velocity")).getByText("—")).toBeInTheDocument();
    expect(within(widget("Velocity")).getByText("SP per iteration · Ø completed iterations of the PI")).toBeInTheDocument();
    unmount();
    await renderReports({ nodeId: "n-red", pi: all[0] });
    // PI 1: 2 SP in Sprint 1, 0 in Sprint 2
    expect(within(widget("Velocity")).getByText("1")).toBeInTheDocument();
    expect(within(widget("Velocity")).getByText("SP per iteration · Ø all iterations of the PI")).toBeInTheDocument();
  });
});

describe("Critical Dependencies", () => {
  it("counts unresolved dependencies whose provider is planned after its consumer", async () => {
    await renderReports();
    const w = widget("Critical Dependencies");
    // Checkout UI (Sprint 2) -> Wallet (Sprint 1) is critical
    expect(within(w).getByText("1")).toHaveClass("bad");
    expect(within(w).getByText("of 4 unresolved in PI 2")).toBeInTheDocument();
  });

  it("shows zero in green when nothing is critical", async () => {
    await renderReports({ nodeId: "n-red" });
    expect(within(widget("Critical Dependencies")).getByText("0")).toHaveClass("good");
    // Payment API -> Checkout UI (same sprint) and -> Reports (later); the fake has no reverse links, so Fraud rules is not seen
    expect(within(widget("Critical Dependencies")).getByText("of 2 unresolved in PI 2")).toBeInTheDocument();
  });

  it("works for a Large Solution with an unconfigured sibling", async () => {
    const config = makeConfig();
    config.root.children = [{ id: "n-sol", name: "Big Solution", level: "solution", children: config.root.children }];
    await renderReports({ config, nodeId: "n-sol" });
    expect(within(widget("Critical Dependencies")).getByText("1")).toBeInTheDocument();
  });
});
