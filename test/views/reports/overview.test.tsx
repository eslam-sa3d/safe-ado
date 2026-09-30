import { fireEvent, waitFor, within } from "@testing-library/react";
import * as sdk from "../../sdkMock";
import { describe, expect, it } from "vitest";
import { epicInOverview } from "../../../src/views/reports/OverviewWidget";
import { getProgramIncrements } from "../../../src/api/wit";
import { RItem, toDay } from "../../../src/api/reports";
import { fake, PI2_S1, PI2_S2, RED } from "../../fakeAdo";
import { renderReports, seed, widget } from "./helpers";

const PARENT = "System.LinkTypes.Hierarchy-Reverse";

function addStory(id: number, title: string, iteration: string, sp: number | undefined, parent?: number, state = "New") {
  fake.workItems.set(id, {
    id,
    rev: 1,
    fields: {
      "System.Id": id,
      "System.Title": title,
      "System.WorkItemType": "User Story",
      "System.State": state,
      "System.AreaPath": RED,
      "System.IterationPath": iteration,
      "System.TeamProject": "Fabrikam",
      ...(sp === undefined ? {} : { "Microsoft.VSTS.Scheduling.StoryPoints": sp }),
    },
    relations: parent ? [{ rel: PARENT, url: `${fake.baseUrl}/_apis/wit/workItems/${parent}`, attributes: {} }] : [],
  });
}

/** Visible rows as [title, WSJF, job size, assignee, progress, teams]. */
function rows(title: string) {
  return Array.from(widget(title).querySelectorAll("tbody tr")).map((tr) => {
    const td = Array.from(tr.querySelectorAll("td"));
    const name = td[0].querySelector(".title-link, strong")!.textContent;
    return [name, td[1].textContent, td[2].textContent, td[3].textContent, td[4].textContent, td[6].textContent];
  });
}

describe("PI Overview", () => {
  it("lists features with work in the PI: progress, status split, teams, drill-down", async () => {
    const { ctx } = await renderReports();
    expect(rows("PI Overview")).toEqual([
      ["Payment API", "—", "—", "Grace Hopper", "63%", "Team Red 8"],
      ["Checkout UI", "—", "—", "", "—", "Team Blue 0"],
      ["Wallet", "—", "—", "", "0%", "Team Blue 8"],
    ]);
    const w = widget("PI Overview");
    expect(w.querySelector("tbody tr .split-bar")).toHaveAttribute("title", "To Do 0 · In Progress 3 · Done 5 SP");

    fireEvent.click(within(w).getByRole("button", { name: "Expand Payment API" }));
    expect(rows("PI Overview").slice(0, 3).map((r) => r[0])).toEqual(["Payment API", "Charge card", "Refund card"]);
    expect(within(w).getByRole("button", { name: "Refund card" }).closest("tr")).toHaveClass("overview-child");
    fireEvent.click(within(w).getByRole("button", { name: "Collapse Payment API" }));
    expect(rows("PI Overview")).toHaveLength(3);

    fireEvent.click(within(w).getAllByRole("button", { name: /Team Red/ })[0]);
    expect(ctx.selectNode).toHaveBeenCalledWith("n-red");
    fireEvent.click(within(w).getByRole("button", { name: "Wallet" }));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(14));
  });

  it("walks up to parents outside the PI and groups stories without a parent", async () => {
    addStory(106, "Stray", PI2_S1, 2);
    addStory(107, "Late follow-up", PI2_S2, 1, 15);
    await renderReports();
    expect(rows("PI Overview").map((r) => [r[0], r[5]])).toEqual([
      ["Payment API", "Team Red 8"],
      ["Checkout UI", "Team Blue 0"],
      ["Wallet", "Team Blue 8"],
      ["Old feature", "Team Red 1"],
      ["Without parent", "Team Red 2"],
    ]);
    fireEvent.click(within(widget("PI Overview")).getByRole("button", { name: "Expand Without parent" }));
    expect(rows("PI Overview").slice(-1)[0][0]).toBe("Stray");
  });

  it("explains when no feature has work in the PI", async () => {
    await renderReports({ nodeId: "n-artb" });
    expect(within(widget("PI Overview")).getByText("No Features with work planned in PI 2.")).toBeInTheDocument();
  });
});

describe("Epic Overview", () => {
  it("lists epics in progress with WSJF, job size and the teams contributing", async () => {
    await renderReports({ nodeId: "n-root" });
    expect(rows("Epic Overview")).toEqual([["Checkout revamp", "1", "13", "Ada Lovelace", "31%", "Team Blue 8Team Red 8"]]);
    const w = widget("Epic Overview");
    fireEvent.click(within(w).getByRole("button", { name: "Expand Checkout revamp" }));
    expect(rows("Epic Overview").map((r) => r[0])).toEqual(["Checkout revamp", "Payment API", "Checkout UI", "Wallet"]);
    fireEvent.click(within(w).getByRole("button", { name: "Expand Payment API" }));
    expect(rows("Epic Overview").map((r) => r[0])).toContain("Charge card");
  });

  it("includes epics closed in the last 30 days", async () => {
    Object.assign(fake.workItems.get(3)!.fields, { "System.State": "Closed", "Microsoft.VSTS.Common.ClosedDate": new Date(Date.now() - 10 * 86_400_000).toISOString() });
    Object.assign(fake.workItems.get(2)!.fields, { "System.State": "Closed", "Microsoft.VSTS.Common.ClosedDate": new Date(Date.now() - 40 * 86_400_000).toISOString() });
    await renderReports({ nodeId: "n-root" });
    expect(rows("Epic Overview").map((r) => r[0])).toEqual(["Checkout revamp", "Unsized idea"]);
  });

  it("explains an empty portfolio", async () => {
    fake.workItems.get(1)!.fields["System.State"] = "New";
    await renderReports({ nodeId: "n-root" });
    expect(within(widget("Epic Overview")).getByText("No epics in progress or recently closed.")).toBeInTheDocument();
  });

  it("decides epic inclusion by state category and closed date", () => {
    const today = toDay(new Date("2026-03-31T00:00:00Z"));
    const e = (category: string, closedDate?: string) => ({ category, closedDate }) as RItem;
    expect(epicInOverview(e("InProgress"), today)).toBe(true);
    expect(epicInOverview(e("Resolved"), today)).toBe(true);
    expect(epicInOverview(e("Proposed"), today)).toBe(false);
    // Closed dates are timestamps counted on the local calendar (local noon stays on its date).
    expect(epicInOverview(e("Completed", new Date(2026, 2, 1, 12).toISOString()), today)).toBe(true);
    expect(epicInOverview(e("Completed", new Date(2026, 1, 28, 12).toISOString()), today)).toBe(false);
    expect(epicInOverview(e("Completed"), today)).toBe(false);
  });
});

describe("Iteration Overview", () => {
  const pager = () => widget("Iteration Overview").querySelector(".pager-label")!.textContent;
  const items = () => Array.from(widget("Iteration Overview").querySelectorAll(".iteration-items li")).map((li) => li.textContent);

  it("pages through the PI's iterations, starting at the current one", async () => {
    await renderReports({ nodeId: "n-red" });
    const w = widget("Iteration Overview");
    expect(pager()).toMatch(/^PI 2 Sprint 1 /);
    expect(within(w).getByRole("button", { name: "Previous iteration" })).toBeDisabled();
    expect(w.querySelector(".iteration-stats")).toHaveTextContent("1Items—Capacity (SP)5 / 5 SP burned");
    expect(within(w).getByRole("heading", { level: 4 })).toHaveTextContent("Payment API");
    expect(items()).toEqual(["Charge card#100Closed5 SP"]);
    expect(w.querySelector(".iteration-items li")).toHaveAttribute("data-category", "Completed");

    fireEvent.click(within(w).getByRole("button", { name: "Next iteration" }));
    expect(pager()).toMatch(/^PI 2 Sprint 2 /);
    expect(items()).toEqual(["Refund card#101Active3 SP"]);
    fireEvent.click(within(w).getByRole("button", { name: "Next iteration" }));
    expect(pager()).toMatch(/^PI 2 IP /);
    expect(within(w).getByText("No items planned in PI 2 IP.")).toBeInTheDocument();
    expect(within(w).getByRole("button", { name: "Next iteration" })).toBeDisabled();
    fireEvent.click(within(w).getByRole("button", { name: "Previous iteration" }));
    expect(pager()).toMatch(/^PI 2 Sprint 2 /);
  });

  it("shows capacity, overload, unestimated items and parent-less groups", async () => {
    seed("capacity", [{ id: `n-red|${PI2_S1}`, nodeId: "n-red", iterationPath: PI2_S1, capacity: 4 }]);
    addStory(106, "Stray", PI2_S1, undefined);
    addStory(108, "Orphaned link", PI2_S1, 1, 999);
    await renderReports({ nodeId: "n-red" });
    const w = widget("Iteration Overview");
    expect(w.querySelector(".iteration-stats")).toHaveTextContent("3Items4Capacity (SP)5 / 6 SP burned");
    expect(within(w).getByText("Overloaded by 2 SP")).toBeInTheDocument();
    expect(Array.from(w.querySelectorAll(".iteration-group h4")).map((h) => h.textContent)).toEqual(["Payment API#10", "#999", "No parent feature"]);
    expect(items()).toContain("Stray#106New– SP");
  });

  it("handles PIs without iterations or dates", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    const a = await renderReports({ nodeId: "n-red", pi: { ...pis[1], sprints: [] } });
    expect(within(widget("Iteration Overview")).getByText("PI 2 has no iterations.")).toBeInTheDocument();
    a.unmount();
    const undated = { ...pis[1], sprints: pis[1].sprints.map((s) => ({ ...s, start: undefined, finish: undefined })) };
    await renderReports({ nodeId: "n-red", pi: undated });
    expect(pager()).toBe("PI 2 Sprint 1");
  });
});
