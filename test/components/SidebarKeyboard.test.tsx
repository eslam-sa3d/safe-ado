import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../src/components/Sidebar";
import { dataStore, fake, makeConfig } from "../fakeAdo";

const item = (name: string) => screen.getByRole("treeitem", { name });
const tabbable = () => screen.getAllByRole("treeitem").filter((li) => li.tabIndex === 0).map((li) => li.getAttribute("aria-label"));
const key = (name: string, k: string) => fireEvent.keyDown(item(name), { key: k });

describe("Sidebar keyboard navigation", () => {
  const root = makeConfig().root;

  it("uses a roving tabindex on the selected row", () => {
    render(<Sidebar root={root} selectedId="n-blue" onSelect={() => {}} />);
    expect(tabbable()).toEqual(["Team Blue"]);
    expect(item("Team Blue")).toHaveAttribute("aria-level", "3");
    expect(screen.getByRole("tree", { name: "Organization units" })).toBeInTheDocument();
    // Twisties are reached with arrow keys, not Tab; stars stay in the tab order.
    expect(within(item("ART A")).getAllByRole("button", { name: "Collapse" })[0]).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Star ART A" })).not.toHaveAttribute("tabindex");
  });

  it("falls back to the root when the selection is hidden or unknown", () => {
    render(<Sidebar root={root} selectedId="missing" onSelect={() => {}} />);
    expect(tabbable()).toEqual(["Fabrikam"]);
  });

  it("moves focus with Up / Down / Home / End", () => {
    render(<Sidebar root={root} selectedId="n-root" onSelect={() => {}} />);
    item("Fabrikam").focus();
    key("Fabrikam", "ArrowDown");
    expect(item("ART A")).toHaveFocus();
    expect(tabbable()).toEqual(["ART A"]);
    key("ART A", "ArrowDown");
    expect(item("Team Red")).toHaveFocus();
    key("Team Red", "ArrowUp");
    expect(item("ART A")).toHaveFocus();
    key("ART A", "End");
    expect(item("Team Green")).toHaveFocus();
    key("Team Green", "ArrowDown"); // already last
    expect(item("Team Green")).toHaveFocus();
    key("Team Green", "Home");
    expect(item("Fabrikam")).toHaveFocus();
    key("Fabrikam", "ArrowUp"); // already first
    expect(item("Fabrikam")).toHaveFocus();
  });

  it("collapses / expands with Left / Right and moves to parent / first child", () => {
    render(<Sidebar root={root} selectedId="n-root" onSelect={() => {}} />);
    item("ART A").focus();
    key("ART A", "ArrowLeft");
    expect(item("ART A")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: "Team Red" })).toBeNull();
    key("ART A", "ArrowDown");
    expect(item("ART B")).toHaveFocus();
    key("ART B", "ArrowUp");
    key("ART A", "ArrowLeft"); // collapsed: go to parent
    expect(item("Fabrikam")).toHaveFocus();
    item("ART A").focus();
    key("ART A", "ArrowRight");
    expect(item("ART A")).toHaveAttribute("aria-expanded", "true");
    expect(item("ART A")).toHaveFocus();
    key("ART A", "ArrowRight"); // open: go to first child
    expect(item("Team Red")).toHaveFocus();
    key("Team Red", "ArrowRight"); // leaf: nothing happens
    expect(item("Team Red")).toHaveFocus();
    key("Team Red", "ArrowLeft");
    expect(item("ART A")).toHaveFocus();
    item("Fabrikam").focus();
    key("Fabrikam", "ArrowLeft");
    expect(item("Fabrikam")).toHaveAttribute("aria-expanded", "false");
    key("Fabrikam", "ArrowLeft"); // root without parent: stays
    expect(item("Fabrikam")).toHaveFocus();
  });

  it("expands deeper levels that start collapsed", () => {
    const deep = makeConfig().root;
    deep.children[0].children[0].children = [{ id: "deep", name: "Deep node", level: "team", children: [] }];
    render(<Sidebar root={deep} selectedId="n-root" onSelect={() => {}} />);
    expect(item("Team Red")).toHaveAttribute("aria-expanded", "false");
    key("Team Red", "ArrowRight");
    expect(item("Deep node")).toBeInTheDocument();
  });

  it("selects with Enter and Space, and ignores other keys and keys on inner buttons", () => {
    const onSelect = vi.fn();
    render(<Sidebar root={root} selectedId="n-root" onSelect={onSelect} />);
    key("Team Red", "Enter");
    expect(onSelect).toHaveBeenLastCalledWith("n-red");
    key("ART B", " ");
    expect(onSelect).toHaveBeenLastCalledWith("n-artb");
    key("ART B", "x");
    fireEvent.keyDown(screen.getByRole("button", { name: "Star Team Green" }), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("lets keyboard users open starred units", async () => {
    dataStore.values.set(`starred-${fake.projectId}`, ["n-green"]);
    const onSelect = vi.fn();
    render(<Sidebar root={root} selectedId="n-root" onSelect={onSelect} />);
    const list = await screen.findByRole("list", { name: "Starred units" });
    const row = within(list).getByRole("button", { name: "Team Green" });
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(row, { key: "a" });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith("n-green");
  });
});
