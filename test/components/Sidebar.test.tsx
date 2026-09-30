import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../src/components/Sidebar";
import { dataManager, dataStore, fake, makeConfig } from "../fakeAdo";

const STAR_KEY = () => `starred-${fake.projectId}`;

describe("Sidebar", () => {
  const root = makeConfig().root;

  it("shows the hierarchy with level legend and marks the selection", () => {
    render(<Sidebar root={root} selectedId="n-red" onSelect={() => {}} />);
    expect(screen.getByRole("navigation", { name: "SAFe hierarchy" })).toBeInTheDocument();
    expect(screen.getByText("My Organization")).toBeInTheDocument();
    for (const name of ["Fabrikam", "ART A", "Team Red", "Team Blue", "ART B", "Team Green"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    const legend = document.querySelector(".legend") as HTMLElement;
    for (const label of ["Portfolio", "Large Solution", "Agile Release Train", "Team"]) {
      expect(within(legend).getByText(label)).toBeInTheDocument();
    }
    const selected = screen.getAllByRole("treeitem").find((li) => li.getAttribute("aria-selected") === "true")!;
    expect(within(selected).getByText("Team Red")).toBeInTheDocument();
    expect(screen.getByText("Team Red").closest(".tree-row")).toHaveAttribute("title", "Team · Fabrikam\\ART A\\Team Red");
  });

  it("selects nodes on click", () => {
    const onSelect = vi.fn();
    render(<Sidebar root={root} selectedId="n-root" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("ART B"));
    expect(onSelect).toHaveBeenCalledWith("n-artb");
  });

  it("collapses and expands without changing the selection", () => {
    const onSelect = vi.fn();
    render(<Sidebar root={root} selectedId="n-root" onSelect={onSelect} />);
    const artA = screen.getByText("ART A").closest("li")!;
    fireEvent.click(within(artA).getAllByLabelText("Collapse")[0]);
    expect(screen.queryByText("Team Red")).not.toBeInTheDocument();
    expect(artA).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(artA).getByLabelText("Expand"));
    expect(screen.getByText("Team Red")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("starts deeper levels collapsed and hides twisties on leaves", () => {
    const deep = makeConfig().root;
    deep.children[0].children[0].children = [{ id: "deep", name: "Deep node", level: "team", children: [] }];
    render(<Sidebar root={deep} selectedId="n-root" onSelect={() => {}} />);
    expect(screen.queryByText("Deep node")).not.toBeInTheDocument();
    const leaf = screen.getByText("Team Blue").closest(".tree-row")!;
    expect((leaf.querySelector(".twisty") as HTMLElement).style.visibility).toBe("hidden");
    expect(screen.getByText("Team Blue").closest("li")).not.toHaveAttribute("aria-expanded");
  });

  describe("starred units", () => {
    it("stars a unit per user, lists it above the tree and selects it from there", async () => {
      const onSelect = vi.fn();
      render(<Sidebar root={root} selectedId="n-root" onSelect={onSelect} />);
      await waitFor(() => expect(dataManager.getValue).toHaveBeenCalled());
      expect(screen.queryByText("Starred")).not.toBeInTheDocument();

      const star = screen.getByRole("button", { name: "Star Team Blue" });
      expect(star).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(star);
      // Starring does not select the row.
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Unstar Team Blue" })).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(dataStore.values.get(STAR_KEY())).toEqual(["n-blue"]));
      expect(dataManager.setValue).toHaveBeenCalledWith(STAR_KEY(), ["n-blue"], { scopeType: "User" });

      const list = screen.getByRole("list", { name: "Starred units" });
      expect(screen.getByText("Starred")).toBeInTheDocument();
      fireEvent.click(within(list).getByText("Team Blue"));
      expect(onSelect).toHaveBeenCalledWith("n-blue");

      fireEvent.click(screen.getByRole("button", { name: "Star ART B" }));
      expect(within(list).getAllByText(/Team Blue|ART B/).map((e) => e.textContent)).toEqual(["Team Blue", "ART B"]);

      fireEvent.click(screen.getByRole("button", { name: "Unstar Team Blue" }));
      await waitFor(() => expect(dataStore.values.get(STAR_KEY())).toEqual(["n-artb"]));
      fireEvent.click(screen.getByRole("button", { name: "Unstar ART B" }));
      expect(screen.queryByRole("list", { name: "Starred units" })).not.toBeInTheDocument();
    });

    it("loads saved stars on mount, marks the selection and skips units no longer in the hierarchy", async () => {
      dataStore.values.set(STAR_KEY(), ["gone", "n-green", "n-root"]);
      render(<Sidebar root={root} selectedId="n-green" onSelect={() => {}} />);
      const list = await screen.findByRole("list", { name: "Starred units" });
      expect(list.querySelectorAll("li")).toHaveLength(2);
      expect(within(list).getByText("Team Green").closest(".tree-row")).toHaveClass("selected");
      expect(within(list).getByText("Fabrikam").closest(".tree-row")).not.toHaveClass("selected");
      expect(screen.getByRole("button", { name: "Unstar Team Green" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Unstar Fabrikam" })).toBeInTheDocument();
    });

    it("ignores load and save failures and malformed values", async () => {
      dataStore.failures.push({ op: "getValue", error: new Error("offline") });
      const { unmount } = render(<Sidebar root={root} selectedId="n-root" onSelect={() => {}} />);
      await waitFor(() => expect(dataManager.getValue).toHaveBeenCalled());
      dataStore.failures.push({ op: "setValue", error: new Error("offline") });
      fireEvent.click(screen.getByRole("button", { name: "Star ART A" }));
      await waitFor(() => expect(dataManager.setValue).toHaveBeenCalled());
      // The star stays on for this session even though it could not be saved.
      expect(screen.getByRole("button", { name: "Unstar ART A" })).toBeInTheDocument();
      unmount();

      dataStore.values.set(STAR_KEY(), "not-a-list");
      render(<Sidebar root={root} selectedId="n-root" onSelect={() => {}} />);
      await waitFor(() => expect(dataManager.getValue).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("list", { name: "Starred units" })).not.toBeInTheDocument();
    });

    it("does not update state after unmount", async () => {
      dataStore.values.set(STAR_KEY(), ["n-red"]);
      const { unmount } = render(<Sidebar root={root} selectedId="n-root" onSelect={() => {}} />);
      unmount();
      await waitFor(() => expect(dataManager.getValue).toHaveBeenCalled());
    });
  });
});

describe("Sidebar — unattached units", () => {
  it("lists detached units (and their children) and selects them by click or keyboard", async () => {
    const { render, screen, fireEvent, within } = await import("@testing-library/react");
    const { Sidebar } = await import("../../src/components/Sidebar");
    const { makeConfig } = await import("../fakeAdo");
    const onSelect = vi.fn();
    const detached = [{ id: "d1", name: "Loose ART", level: "art" as const, children: [{ id: "d2", name: "Loose team", level: "team" as const, children: [] }] }];
    render(<Sidebar root={makeConfig().root} detached={detached} selectedId="d2" onSelect={onSelect} />);
    const list = screen.getByRole("list", { name: "Unattached units" });
    expect(within(list).getByText("Loose team").closest(".tree-row")).toHaveClass("selected");
    fireEvent.click(within(list).getByText("Loose ART"));
    expect(onSelect).toHaveBeenCalledWith("d1");
    fireEvent.keyDown(within(list).getByText("Loose team").closest(".tree-row")!, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("d2");
    fireEvent.keyDown(within(list).getByText("Loose team").closest(".tree-row")!, { key: "x" });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("hides the section when nothing is detached", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { Sidebar } = await import("../../src/components/Sidebar");
    const { makeConfig } = await import("../fakeAdo");
    render(<Sidebar root={makeConfig().root} selectedId="n-root" onSelect={() => {}} />);
    expect(screen.queryByRole("list", { name: "Unattached units" })).toBeNull();
  });
});
