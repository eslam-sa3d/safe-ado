import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { dayIso, toDay } from "../../../src/api/reports";
import { localToday } from "../../../src/api/rules";
import { getProgramIncrements } from "../../../src/api/wit";
import { fail, fake, GREEN, PI1_S1 } from "../../fakeAdo";
import { isoDay, renderReports, widget } from "./helpers";

/** Noon on a calendar date in the local time zone, as an ISO timestamp (stays on that date in every zone). */
const localNoon = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 12).toISOString();
};

const points = (w: HTMLElement, series: string) => w.querySelector(`polyline[data-series="${series}"]`)!.getAttribute("points")!.split(" ").filter(Boolean);
const tooltip = (w: HTMLElement, offset: number) => w.querySelector(`rect[data-date="${isoDay(offset)}"] title`)!.textContent;

/** The dashboard's "today": the user's local calendar date as a day number. */
const TODAY = () => toDay(localToday());
/** Tooltip of the day `offset` days from the local today. */
const localTip = (w: HTMLElement, offset: number) => w.querySelector(`rect[data-date="${dayIso(TODAY() + offset)}"] title`)!.textContent;

/** A revision of a seeded item: its current fields with `patch`, changed `daysAgo` local days ago. */
function rev(id: number, n: number, daysAgo: number, patch: Record<string, unknown> = {}) {
  return { rev: n, fields: { ...fake.workItems.get(id)!.fields, ...patch, "System.ChangedDate": localNoon(dayIso(TODAY() - daysAgo)), "System.Rev": n } };
}

describe("Burnup", () => {
  it("draws scope, burned, ideal and forecast over the PI's days with iteration bands and today", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    // Index of today in PI 2 (7 when the local date equals the UTC date the fixture is built from).
    const idx = TODAY() - toDay(pis[1].start!);
    // Charge card was active until it closed two days ago.
    fake.revisions.set(100, [rev(100, 1, 60, { "System.State": "Active" }), rev(100, 2, 2)]);
    await renderReports();
    const w = widget("Burnup");
    expect(within(w).getByRole("img", { name: "Burnup chart" })).toBeInTheDocument();
    expect(points(w, "scope")).toHaveLength(35);
    expect(points(w, "ideal")).toHaveLength(35);
    expect(points(w, "burned")).toHaveLength(idx + 1);
    expect(points(w, "forecast")).toHaveLength(35 - idx);
    expect(w.querySelectorAll("rect.burnup-hover")).toHaveLength(35);

    // Charge card (5 SP) closed two days ago; Cart page has no points.
    expect(localTip(w, -3)).toContain("Burned 0");
    expect(localTip(w, -2)).toContain("Burned 5");
    // 28 non-IP days: day idx + 1 of the ideal is 16 × (idx + 1) / 28
    const ideal = Math.round((16 * (idx + 1) * 10) / 28) / 10;
    expect(localTip(w, 0)).toMatch(new RegExp(`Scope 16 · Burned 5 · Ideal ${ideal} · Forecast 5$`));
    // No completed iteration of PI 2 yet: the historic rate of PI 1 (2 SP over its 28 sprint days)
    const rate = 2 / 28;
    expect(within(w).getByText(`Forecast at ${Math.round(rate * 10) / 10} SP/day`)).toBeInTheDocument();
    expect(localTip(w, 1)).not.toContain("Burned");
    expect(localTip(w, 1)).toContain(`Forecast ${Math.round((5 + rate) * 10) / 10}`);
    expect(localTip(w, -1)).not.toContain("Forecast");

    const bands = Array.from(w.querySelectorAll(".burnup-band"));
    expect(bands.map((b) => b.textContent)).toEqual(["PI 2 Sprint 1", "PI 2 Sprint 2", "PI 2 IP"]);
    expect(bands[2]).toHaveClass("ip");
    expect(bands[1]).toHaveClass("odd");
    expect(within(w).getByText("Today")).toBeInTheDocument();
    for (const label of ["Total scope", "Burned", "Ideal", "Forecast"]) expect(within(w).getByText(label)).toBeInTheDocument();
  });

  it("reconstructs the scope per day from history: stories moved in or out of the PI or the unit", async () => {
    // Refund card (3 SP) was in PI 1 until 3 days ago; Add wallet (8 SP, Team Blue) moved to ART B 1 day ago.
    fake.revisions.set(101, [rev(101, 1, 60, { "System.IterationPath": PI1_S1 }), rev(101, 2, 3)]);
    fake.revisions.set(102, [rev(102, 1, 60), rev(102, 2, 1, { "System.AreaPath": GREEN })]);
    await renderReports();
    const w = widget("Burnup");
    expect(localTip(w, -4)).toMatch(/Scope 13 · Burned 5/);
    expect(localTip(w, -3)).toMatch(/Scope 16 · Burned 5/);
    expect(localTip(w, 0)).toMatch(/Scope 8 · Burned 5 · Ideal [\d.]+ · Forecast 5$/);
    // Future days keep today's scope.
    expect(localTip(w, 5)).toContain("Scope 8");
    expect(within(w).queryByRole("note")).toBeNull();
  });

  it("falls back to the current state with a note when the history can't be read", async () => {
    fail(/workitemrevisions/, 500, "history down");
    await renderReports();
    const w = widget("Burnup");
    expect(within(w).getByRole("note")).toHaveTextContent("History unavailable (history down); scope and burned points use the stories' current state.");
    expect(tooltip(w, -3)).toContain("Burned 0");
    expect(tooltip(w, -2)).toContain("Burned 5");
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
    const start = `${localToday()}T00:00:00Z`;
    await renderReports({ pi: { ...pis[1], start, finish: start, sprints: [] }, nodeId: "n-green" });
    const w = widget("Burnup");
    expect(points(w, "scope")).toHaveLength(1);
    expect(localTip(w, 0)).toMatch(/Scope 0 · Burned 0 · Ideal 0 · Forecast 0$/);
  });
});
