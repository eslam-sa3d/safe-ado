import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getProgramIncrements } from "../../../src/api/wit";
import { dataStore, fake, localDate } from "../../fakeAdo";
import { isoDay, renderReports, seed, userValue, widget } from "./helpers";

const m = (id: string, nodeId: string, offset: number, title = id, description?: string) => ({ id, nodeId, date: isoDay(offset), title, description });
const titles = () => Array.from(widget("Milestone Overview").querySelectorAll(".milestone-title")).map((e) => e.textContent);
const stored = () => Array.from(dataStore.collections.get(`milestones-${fake.projectId}`)?.values() ?? []);

describe("Milestone Overview", () => {
  it("lists the unit's milestones in the PI with relative dates", async () => {
    seed("milestones", [
      m("demo", "n-arta", 3, "System demo", "Show it"),
      m("kickoff", "n-arta", -2, "Kickoff"),
      m("now", "n-arta", 0, "Checkpoint"),
      m("later", "n-arta", 60, "Next PI"),
      m("parent", "n-root", 1, "Portfolio sync"),
      m("child", "n-red", 1, "Team thing"),
    ]);
    await renderReports();
    const w = widget("Milestone Overview");
    expect(titles()).toEqual(["Kickoff", "Checkpoint", "System demo"]);
    expect(within(w).getByText("Kickoff").closest("li")).toHaveClass("past");
    expect(within(w).getByText("2 days ago")).toBeInTheDocument();
    expect(within(w).getByText("today")).toBeInTheDocument();
    expect(within(w).getByText("in 3 days")).toBeInTheDocument();
    expect(within(w).getByText("System demo")).toHaveAttribute("title", "Show it");
  });

  it("includes parent levels on request and remembers the choice", async () => {
    seed("milestones", [m("own", "n-red", 2, "Team demo"), m("art", "n-arta", 1, "ART sync"), m("root", "n-root", 3, "Portfolio review")]);
    await renderReports({ nodeId: "n-red" });
    expect(titles()).toEqual(["Team demo"]);
    fireEvent.click(within(widget("Milestone Overview")).getByRole("checkbox", { name: "Include parent levels" }));
    expect(titles()).toEqual(["ART sync", "Team demo", "Portfolio review"]);
    expect(within(widget("Milestone Overview")).getByText("ART A", { selector: ".pill" })).toBeInTheDocument();
    await waitFor(() => expect(userValue("milestonesIncludeParents")).toBe(true));
  });

  it("restores the saved preference and survives preference errors", async () => {
    seed("milestones", [m("art", "n-arta", 1, "ART sync")]);
    dataStore.values.set(`milestonesIncludeParents-${fake.projectId}`, true);
    const { unmount } = await renderReports({ nodeId: "n-red" });
    await waitFor(() => expect(titles()).toEqual(["ART sync"]));
    unmount();

    dataStore.failures.push({ op: "getValue", error: new Error("prefs down") });
    await renderReports({ nodeId: "n-red" });
    dataStore.failures.push({ op: "setValue", error: new Error("prefs down") });
    fireEvent.click(within(widget("Milestone Overview")).getByRole("checkbox", { name: "Include parent levels" }));
    expect(titles()).toEqual(["ART sync"]);
  });

  it("shows 30 days back to 5 years ahead on the portfolio", async () => {
    seed("milestones", [m("old", "n-root", -31), m("recent", "n-root", -30), m("far", "n-root", 5 * 365), m("too-far", "n-root", 5 * 365 + 1)]);
    await renderReports({ nodeId: "n-root" });
    expect(titles()).toEqual(["recent", "far"]);
  });

  it("explains empty lists and undated PIs", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    const a = await renderReports();
    expect(within(widget("Milestone Overview")).getByText("No milestones in PI 2.")).toBeInTheDocument();
    a.unmount();
    const b = await renderReports({ nodeId: "n-root" });
    expect(within(widget("Milestone Overview")).getByText("No milestones in this period.")).toBeInTheDocument();
    b.unmount();
    await renderReports({ pi: { ...pis[1], start: undefined } });
    expect(within(widget("Milestone Overview")).getByText("PI 2 has no start and finish dates.")).toBeInTheDocument();
  });

  it("creates a milestone for the unit", async () => {
    await renderReports();
    fireEvent.click(within(widget("Milestone Overview")).getByRole("button", { name: "Add milestone" }));
    const dialog = screen.getByRole("dialog", { name: "New milestone" });
    const create = within(dialog).getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    expect(within(dialog).getByLabelText("Date")).toHaveValue(isoDay(0));
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "  Release  " } });
    fireEvent.change(within(dialog).getByLabelText("Date"), { target: { value: isoDay(5) } });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "Go live" } });
    fireEvent.click(create);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(titles()).toEqual(["Release"]);
    expect(within(widget("Milestone Overview")).getByText("in 5 days")).toBeInTheDocument();
    expect(stored()).toEqual([expect.objectContaining({ nodeId: "n-arta", title: "Release", date: isoDay(5), description: "Go live" })]);
  });

  it("defaults new milestones to the start of a planned PI and reports save errors", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    const start = localDate(Date.now() + 20 * 86_400_000);
    await renderReports({ pi: { ...pis[1], start: `${start}T00:00:00Z`, finish: `${isoDay(50)}T00:00:00Z` } });
    fireEvent.click(within(widget("Milestone Overview")).getByRole("button", { name: "Add milestone" }));
    const dialog = screen.getByRole("dialog", { name: "New milestone" });
    expect(within(dialog).getByLabelText("Date")).toHaveValue(start);
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Gate" } });
    dataStore.failures.push({ op: "setDocument", error: new Error("store down") });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("Could not save milestone: store down")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stored()[0]).not.toHaveProperty("description");
  });

  it("closes the dialog on cancel", async () => {
    await renderReports();
    fireEvent.click(within(widget("Milestone Overview")).getByRole("button", { name: "Add milestone" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stored()).toEqual([]);
  });
});
