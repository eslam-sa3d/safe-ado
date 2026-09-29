import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { dataStore, fail, makeConfig } from "../fakeAdo";
import { renderApp } from "../utils";
import { renderReports, widget, widgetTitles } from "./reports/helpers";

const PI_WIDGETS = [
  "PI Progress",
  "Story Points Burned",
  "Business Value",
  "Load vs. Capacity",
  "Velocity",
  "Critical Dependencies",
  "Burnup",
  "Dependency Overview",
  "PI Objectives",
  "PI Risks",
  "Milestone Overview",
];

describe("Reports dashboard", () => {
  it("shows every widget except the Iteration Overview on an ART", async () => {
    await renderReports();
    expect(widgetTitles()).toEqual(["Unit", ...PI_WIDGETS, "PI Overview", "PI Predictability"]);
  });

  it("shows every widget except the PI Overview on a team", async () => {
    await renderReports({ nodeId: "n-red" });
    expect(widgetTitles()).toEqual(["Unit", ...PI_WIDGETS, "Iteration Overview", "PI Predictability"]);
  });

  it("shows the ART widgets on a Large Solution", async () => {
    const config = makeConfig();
    config.root.children = [{ id: "n-sol", name: "Big Solution", level: "solution", areaPath: "Fabrikam", children: config.root.children }];
    await renderReports({ config, nodeId: "n-sol" });
    expect(widgetTitles()).toEqual(["Unit", ...PI_WIDGETS, "PI Overview", "PI Predictability"]);
  });

  it("shows header, dependencies, milestones and the Epic Overview on the portfolio", async () => {
    await renderReports({ nodeId: "n-root" });
    expect(widgetTitles()).toEqual(["Unit", "Dependency Overview", "Milestone Overview", "Epic Overview"]);
  });

  it("asks for a PI in every PI widget when none is selected", async () => {
    await renderReports({ pi: null, pis: [] });
    for (const title of [...PI_WIDGETS, "PI Overview"]) {
      expect(within(widget(title)).getByText("Select a PI to see this report.")).toBeInTheDocument();
    }
    expect(within(widget("PI Predictability")).getByText("No data.")).toBeInTheDocument();
    expect(within(widget("Unit")).getAllByText("None running")).toHaveLength(2);
  });

  it("asks for a PI in the Iteration Overview of a team", async () => {
    await renderReports({ nodeId: "n-red", pi: null });
    expect(within(widget("Iteration Overview")).getByText("Select a PI to see this report.")).toBeInTheDocument();
  });

  it("shows a load error with a retry", async () => {
    fail(/wiql/, 500, "wiql down", { once: true });
    await renderReports();
    expect(screen.getByText("wiql down")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Burnup" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Burnup" })).toBeInTheDocument());
  });

  it("shows extension data errors", async () => {
    dataStore.failures.push({ op: "getDocuments", error: Object.assign(new Error("objectives down"), { status: 500 }) });
    await renderReports();
    expect(screen.getByText("objectives down")).toBeInTheDocument();
  });

  it("is the landing tab of the hub", async () => {
    await renderApp({ nodeId: "n-arta", view: "reports" });
    await waitFor(() => expect(screen.getByRole("region", { name: "Burnup" })).toBeInTheDocument());
  });
});

describe("Reports header", () => {
  it("shows the unit, its layer and the PI and iteration running today", async () => {
    await renderReports();
    const header = widget("Unit");
    expect(within(header).getByRole("heading", { name: "ART A" })).toBeInTheDocument();
    expect(within(header).getByText("Agile Release Train")).toBeInTheDocument();
    expect(within(header).getByText(/^PI 2 \(/)).toBeInTheDocument();
    expect(within(header).getByText(/^PI 2 Sprint 1 \(/)).toBeInTheDocument();
  });

  it("lists members with their roles", async () => {
    const config = makeConfig();
    config.root.children[0].members = [
      { name: "Rita", role: "RTE" },
      { name: "Paul", role: "" },
    ];
    await renderReports({ config });
    const header = widget("Unit");
    expect(within(header).getByText("Rita")).toBeInTheDocument();
    expect(within(header).getByText("RTE")).toBeInTheDocument();
    expect(within(header).getByText("Paul").closest(".member-chip")!.querySelector(".member-role")).toBeNull();
    expect(within(header).queryByText(/No members/)).toBeNull();
  });

  it("links to Setup when the unit has no members", async () => {
    await renderApp({ nodeId: "n-arta", view: "reports" });
    const header = await screen.findByRole("region", { name: "Unit" });
    expect(within(header).getByText(/No members/)).toBeInTheDocument();
    fireEvent.click(within(header).getByRole("button", { name: "Add members in Setup" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true"));
  });

  it("hides the Setup link outside the hub shell", async () => {
    await renderReports();
    expect(within(widget("Unit")).getByText(/No members/)).toBeInTheDocument();
    expect(within(widget("Unit")).queryByRole("button", { name: "Add members in Setup" })).toBeNull();
  });
});
