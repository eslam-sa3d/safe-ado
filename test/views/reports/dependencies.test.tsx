import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import * as sdk from "../../sdkMock";
import { describe, expect, it } from "vitest";
import { dataStore, fake } from "../../fakeAdo";
import { renderReports, seed, userValue, widget } from "./helpers";

const SUCC = "System.LinkTypes.Dependency-Forward";
const link = (from: number, to: number) =>
  fake.workItems.get(from)!.relations!.push({ rel: SUCC, url: `${fake.baseUrl}/_apis/wit/workItems/${to}`, attributes: {} });

/** [provider, consumer, criticality chip text] per row of a group. */
function groupRows(group: "Internal" | "External") {
  const w = widget("Dependency Overview");
  const header = within(w).getByText(group, { selector: "th" }).closest("tbody")!;
  return Array.from(header.querySelectorAll("tr"))
    .slice(1)
    .filter((tr) => tr.querySelector(".title-link"))
    .map((tr) => {
      const titles = Array.from(tr.querySelectorAll(".title-link")).map((b) => b.textContent);
      const chips = Array.from(tr.querySelectorAll(".crit-chip")).map((c) => c.textContent);
      return [titles[0], titles[1], ...chips];
    });
}

describe("Dependency Overview", () => {
  it("lists internal and external dependencies with team-planning and roadmap criticality (combined by default)", async () => {
    await renderReports();
    const w = widget("Dependency Overview");
    expect(within(w).getByRole("combobox", { name: "Dependency source" })).toHaveValue("combined");
    expect(within(w).getByText("Criticality (combined)")).toBeInTheDocument();
    expect(groupRows("Internal")).toEqual([
      ["Checkout UI", "Wallet", "Critical", "Roadmap: At risk"],
      ["Payment API", "Checkout UI", "At risk", "Roadmap: At risk"],
      ["Fraud rules", "Payment API", "At risk", "Roadmap: At risk"],
    ]);
    expect(groupRows("External")).toEqual([["Payment API", "Reports", "Healthy", "Roadmap: At risk"]]);
    expect(within(w).getByText("Reports").closest(".dep-side")).toHaveTextContent("Team Green · PI 2 IP");
    fireEvent.click(within(w).getAllByRole("button", { name: "Wallet" })[0]);
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(14));
  });

  it("filters by criticality and greys out resolved dependencies", async () => {
    fake.workItems.get(11)!.fields["System.State"] = "Closed";
    await renderReports();
    const w = widget("Dependency Overview");
    const resolvedRow = within(w).getAllByText("Resolved", { selector: ".crit-chip" })[0].closest("tr")!;
    expect(resolvedRow).toHaveClass("dep-resolved");
    expect(within(resolvedRow).getAllByRole("button").map((b) => b.textContent)).toEqual(["Checkout UI", "Wallet"]);

    fireEvent.click(within(w).getByRole("checkbox", { name: "Resolved" }));
    expect(within(w).queryByText("Resolved", { selector: ".crit-chip" })).toBeNull();
    fireEvent.click(within(w).getByRole("checkbox", { name: "At risk" }));
    fireEvent.click(within(w).getByRole("checkbox", { name: "Critical" }));
    expect(within(w).getByText("No internal dependencies.")).toBeInTheDocument();
    expect(groupRows("External")).toHaveLength(1);
    fireEvent.click(within(w).getByRole("checkbox", { name: "Healthy" }));
    expect(within(w).getByText("No external dependencies.")).toBeInTheDocument();
    fireEvent.click(within(w).getByRole("checkbox", { name: "Critical" }));
    expect(groupRows("Internal")).toEqual([]);
  });

  it("switches to roadmap dates and remembers the choice per user", async () => {
    seed("wimeta", [
      { id: "11", workItemId: 11, assignedNodeIds: [], assignedPiPaths: [], plannedStart: "2026-01-01", plannedEnd: "2026-01-10" },
      { id: "14", workItemId: 14, assignedNodeIds: [], assignedPiPaths: [], plannedStart: "2026-01-11", plannedEnd: "2026-01-20" },
    ]);
    await renderReports();
    const w = widget("Dependency Overview");
    fireEvent.change(within(w).getByRole("combobox", { name: "Dependency source" }), { target: { value: "roadmap" } });
    expect(within(w).getByText("Criticality (roadmap)")).toBeInTheDocument();
    expect(groupRows("Internal")[0]).toEqual(["Payment API", "Checkout UI", "At risk"]);
    expect(groupRows("Internal")).toContainEqual(["Checkout UI", "Wallet", "Healthy"]);
    await waitFor(() => expect(userValue("depSource")).toBe("roadmap"));
  });

  it("restores the saved source", async () => {
    dataStore.values.set(`depSource-${fake.projectId}`, "team");
    await renderReports();
    const w = widget("Dependency Overview");
    await waitFor(() => expect(within(w).getByRole("combobox", { name: "Dependency source" })).toHaveValue("team"));
    expect(within(w).getByText("Criticality (team planning)")).toBeInTheDocument();
    expect(w.querySelector(".dep-secondary")).toBeNull();
  });

  it("ignores unknown saved sources and preference errors", async () => {
    dataStore.values.set(`depSource-${fake.projectId}`, "bogus");
    const { unmount } = await renderReports();
    await waitFor(() => expect(within(widget("Dependency Overview")).getByRole("combobox", { name: "Dependency source" })).toHaveValue("combined"));
    unmount();

    dataStore.failures.push({ op: "getValue", error: new Error("prefs down") });
    await renderReports();
    const w = widget("Dependency Overview");
    dataStore.failures.push({ op: "setValue", error: new Error("prefs down") });
    fireEvent.change(within(w).getByRole("combobox", { name: "Dependency source" }), { target: { value: "team" } });
    expect(within(w).getByRole("combobox", { name: "Dependency source" })).toHaveValue("team");
    expect(screen.queryByText("prefs down")).toBeNull();
  });

  it("uses team planning without a source choice on a team", async () => {
    await renderReports({ nodeId: "n-blue" });
    const w = widget("Dependency Overview");
    expect(within(w).queryByRole("combobox")).toBeNull();
    expect(within(w).getByText("Criticality (team planning)")).toBeInTheDocument();
    expect(groupRows("Internal")).toEqual([["Checkout UI", "Wallet", "Critical"]]);
    // Team Red's Payment API (Sprint 1) is needed by Checkout UI (Sprint 2): healthy, external to Team Blue.
    expect(groupRows("External")).toEqual([["Payment API", "Checkout UI", "Healthy"]]);
  });

  it("rates portfolio items by roadmap dates", async () => {
    link(1, 2);
    link(2, 3);
    seed("wimeta", [
      { id: "1", workItemId: 1, assignedNodeIds: [], assignedPiPaths: [], plannedStart: "2026-01-01", plannedEnd: "2026-06-30" },
      { id: "2", workItemId: 2, assignedNodeIds: [], assignedPiPaths: [], plannedStart: "2026-02-01", plannedEnd: "2026-03-31" },
    ]);
    await renderReports({ nodeId: "n-root" });
    const w = widget("Dependency Overview");
    expect(within(w).queryByRole("combobox")).toBeNull();
    expect(within(w).getByText("Criticality (roadmap dates)")).toBeInTheDocument();
    expect(groupRows("Internal")).toEqual([
      ["Checkout revamp", "Mobile app", "Critical"],
      ["Mobile app", "Unsized idea", "At risk"],
    ]);
    expect(within(w).getAllByText("Fabrikam · Fabrikam")).toHaveLength(4);
  });

  it("marks unplanned items", async () => {
    fake.workItems.get(20)!.fields["System.IterationPath"] = "";
    await renderReports();
    expect(within(widget("Dependency Overview")).getByText("Reports").closest(".dep-side")).toHaveTextContent("Team Green · Unplanned");
  });
});
