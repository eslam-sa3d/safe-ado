import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../src/components/Sidebar";
import { makeConfig } from "../fakeAdo";

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
});
