import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getProgramIncrements } from "../../../src/api/wit";
import { isoDay, renderReports, widget } from "./helpers";

const points = (w: HTMLElement, series: string) => w.querySelector(`polyline[data-series="${series}"]`)!.getAttribute("points")!.split(" ").filter(Boolean);
const tooltip = (w: HTMLElement, offset: number) => w.querySelector(`rect[data-date="${isoDay(offset)}"] title`)!.textContent;

describe("Burnup", () => {
  it("draws scope, burned, ideal and forecast over the PI's days with iteration bands and today", async () => {
    await renderReports();
    const w = widget("Burnup");
    expect(within(w).getByRole("img", { name: "Burnup chart" })).toBeInTheDocument();
    // 35 days in PI 2; today is day 8
    expect(points(w, "scope")).toHaveLength(35);
    expect(points(w, "ideal")).toHaveLength(35);
    expect(points(w, "burned")).toHaveLength(8);
    expect(points(w, "forecast")).toHaveLength(28);
    expect(w.querySelectorAll("rect.burnup-hover")).toHaveLength(35);

    // Charge card (5 SP) closed two days ago; Cart page has no points.
    expect(tooltip(w, -3)).toContain("Burned 0");
    expect(tooltip(w, -2)).toContain("Burned 5");
    // 28 non-IP days: day 8 of the ideal is 16 × 8 / 28
    expect(tooltip(w, 0)).toMatch(/Scope 16 · Burned 5 · Ideal 4\.6 · Forecast 5$/);
    // No completed iteration yet: 5 SP over 8 days -> 0.6 SP/day
    expect(within(w).getByText("Forecast at 0.6 SP/day")).toBeInTheDocument();
    expect(tooltip(w, 1)).not.toContain("Burned");
    expect(tooltip(w, 1)).toContain("Forecast 5.6");
    expect(tooltip(w, -1)).not.toContain("Forecast");

    const bands = Array.from(w.querySelectorAll(".burnup-band"));
    expect(bands.map((b) => b.textContent)).toEqual(["PI 2 Sprint 1", "PI 2 Sprint 2", "PI 2 IP"]);
    expect(bands[2]).toHaveClass("ip");
    expect(bands[1]).toHaveClass("odd");
    expect(within(w).getByText("Today")).toBeInTheDocument();
    for (const label of ["Total scope", "Burned", "Ideal", "Forecast"]) expect(within(w).getByText(label)).toBeInTheDocument();
  });

  it("has no today marker or forecast for a past PI", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    await renderReports({ pi: pis[0], nodeId: "n-red" });
    const w = widget("Burnup");
    expect(within(w).queryByText("Today")).toBeNull();
    expect(points(w, "forecast")).toHaveLength(0);
    expect(points(w, "burned")).toHaveLength(28);
  });

  it("explains PIs without dates", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    await renderReports({ pi: { ...pis[1], finish: undefined } });
    expect(within(widget("Burnup")).getByText("PI 2 has no start and finish dates.")).toBeInTheDocument();
  });

  it("draws a one-day PI", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    const start = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
    await renderReports({ pi: { ...pis[1], start, finish: start, sprints: [] }, nodeId: "n-green" });
    const w = widget("Burnup");
    expect(points(w, "scope")).toHaveLength(1);
    expect(tooltip(w, 0)).toMatch(/Scope 0 · Burned 0 · Ideal 0 · Forecast 0$/);
  });
});
