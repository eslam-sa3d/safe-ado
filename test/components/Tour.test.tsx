import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tour, TOUR_STEPS } from "../../src/components/Tour";
import { dataManager, dataStore, fake } from "../fakeAdo";

const KEY = () => `toursSeen-${fake.projectId}`;
const tour = () => screen.getByRole("region", { name: "Guided tour" });
const seen = () => dataStore.values.get(KEY());

describe("Onboarding tour", () => {
  it("has 2–4 steps for every view", () => {
    for (const steps of Object.values(TOUR_STEPS)) {
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(steps.length).toBeLessThanOrEqual(4);
    }
  });

  it("walks through the steps with Next / Back and remembers the view when done", async () => {
    render(<Tour view="objectives" />);
    expect(await screen.findByRole("region", { name: "Guided tour" })).toBeInTheDocument();
    const steps = TOUR_STEPS.objectives;
    expect(within(tour()).getByText(steps[0].title)).toBeInTheDocument();
    expect(within(tour()).getByText(`1 of ${steps.length}`)).toBeInTheDocument();
    expect(within(tour()).queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(within(tour()).getByRole("button", { name: "Next" }));
    expect(within(tour()).getByText(steps[1].text)).toBeInTheDocument();
    fireEvent.click(within(tour()).getByRole("button", { name: "Back" }));
    expect(within(tour()).getByText(steps[0].title)).toBeInTheDocument();
    fireEvent.click(within(tour()).getByRole("button", { name: "Next" }));
    fireEvent.click(within(tour()).getByRole("button", { name: "Next" }));
    expect(within(tour()).getByText(`3 of 3`)).toBeInTheDocument();
    fireEvent.click(within(tour()).getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("region", { name: "Guided tour" })).toBeNull();
    await waitFor(() => expect(seen()).toEqual(["objectives"]));
  });

  it("is not shown for views already seen, and skipping remembers the view", async () => {
    dataStore.values.set(KEY(), ["risks"]);
    const { rerender } = render(<Tour view="risks" />);
    await waitFor(() => expect(dataManager.getValue).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole("region", { name: "Guided tour" })).toBeNull();
    rerender(<Tour view="kanban" />);
    fireEvent.click(await screen.findByRole("button", { name: "Skip tour" }));
    await waitFor(() => expect(seen()).toEqual(["risks", "kanban"]));
    rerender(<Tour view="hierarchy" />);
    fireEvent.click(await screen.findByRole("button", { name: "Close tour" }));
    await waitFor(() => expect(seen()).toEqual(["risks", "kanban", "hierarchy"]));
  });

  it("starts at the first step when the view changes", async () => {
    const { rerender } = render(<Tour view="board" />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(within(tour()).getByText("3 of 3")).toBeInTheDocument();
    // teamboard has only two steps: it must start at its first, not at step 3
    rerender(<Tour view="teamboard" />);
    expect(within(tour()).getByText(TOUR_STEPS.teamboard[0].title)).toBeInTheDocument();
    expect(within(tour()).getByText("1 of 2")).toBeInTheDocument();
  });

  it("stays hidden while suppressed, for unknown views, and when the stored value is unreadable", async () => {
    const { rerender } = render(<Tour view="setup" suppressed />);
    await waitFor(() => expect(dataManager.getValue).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole("region", { name: "Guided tour" })).toBeNull();
    rerender(<Tour view="nope" />);
    expect(screen.queryByRole("region", { name: "Guided tour" })).toBeNull();
    rerender(<Tour view="setup" />);
    expect(tour()).toBeInTheDocument();
  });

  it("treats a non-array stored value as nothing seen", async () => {
    dataStore.values.set(KEY(), "garbage");
    render(<Tour view="pis" />);
    expect(await screen.findByRole("region", { name: "Guided tour" })).toBeInTheDocument();
  });

  it("does not nag when the seen list cannot be loaded, but a restart still shows it", async () => {
    dataStore.failures.push({ op: "getValue", error: new Error("offline") });
    const { rerender } = render(<Tour view="roadmap" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("region", { name: "Guided tour" })).toBeNull();
    dataStore.failures.push({ op: "setValue", error: new Error("offline") });
    rerender(<Tour view="roadmap" restartKey={1} />);
    expect(await screen.findByRole("region", { name: "Guided tour" })).toBeInTheDocument();
    // Dismissing still works locally when saving fails.
    dataStore.failures.push({ op: "setValue", error: new Error("offline") });
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(screen.queryByRole("region", { name: "Guided tour" })).toBeNull();
  });

  it("restarting clears every seen view", async () => {
    dataStore.values.set(KEY(), ["workitems", "reports"]);
    const { rerender } = render(<Tour view="workitems" />);
    await waitFor(() => expect(dataManager.getValue).toHaveBeenCalled());
    rerender(<Tour view="workitems" restartKey={2} />);
    expect(await screen.findByRole("region", { name: "Guided tour" })).toBeInTheDocument();
    await waitFor(() => expect(seen()).toEqual([]));
  });
});
