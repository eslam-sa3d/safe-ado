import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { findNode, parentOf } from "../../src/api/org";
import { OrgNode, SafeConfig } from "../../src/api/types";
import { canDetach, moveError, moveNode, OrganizationView, parentLevels } from "../../src/views/OrganizationView";
import { fail, makeConfig } from "../fakeAdo";
import { dataTransfer, renderView } from "../utils";

const box = (name: string) => screen.getByRole("button", { name }).closest(".org-node") as HTMLElement;
const band = (label: string) => screen.getByRole("region", { name: `${label} layer` });
const edges = () => Array.from(document.querySelectorAll("line.org-line"));
const edge = (key: string) => document.querySelector(`line[data-edge="${key}"]`) as SVGLineElement;
const savedRoot = (ctx: { saveConfig: ReturnType<typeof vi.fn> }) => (ctx.saveConfig.mock.calls.at(-1)![0] as SafeConfig).root;

/** Portfolio > Solution > ART S > Team S, plus the default ARTs directly under the portfolio. */
function solutionConfig(): SafeConfig {
  const config = makeConfig();
  const team: OrgNode = { id: "n-ts", name: "Team S", level: "team", children: [] };
  const art: OrgNode = { id: "n-arts", name: "ART S", level: "art", children: [team] };
  config.root.children.push({ id: "n-sol", name: "Solution X", level: "solution", areaPath: "Fabrikam", children: [art] });
  return config;
}

function openMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  return screen.getByRole("menu", { name: `${name} actions` });
}

describe("My Organization", () => {
  it("draws the layers with their units and parent lines", async () => {
    await renderView(<OrganizationView />);
    expect(within(band("Portfolio")).getByRole("button", { name: "Fabrikam" })).toBeInTheDocument();
    expect(within(band("Large Solution")).getByText("No Large Solution units")).toBeInTheDocument();
    expect(within(band("Agile Release Train")).getAllByRole("button", { name: /^ART [AB]$/ })).toHaveLength(2);
    expect(within(band("Team")).getAllByRole("button", { name: /^Team / })).toHaveLength(3);
    expect(edges().map((e) => e.getAttribute("data-edge"))).toEqual([
      "n-root>n-arta",
      "n-root>n-artb",
      "n-arta>n-red",
      "n-arta>n-blue",
      "n-artb>n-green",
    ]);
    expect(screen.getByRole("button", { name: "Add Portfolio" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Large Solution" })).toBeEnabled();
    // The current unit is selected; the root cannot be dragged.
    expect(box("ART A")).toHaveClass("selected");
    expect(box("Fabrikam")).toHaveAttribute("draggable", "false");
    expect(box("ART A")).toHaveAttribute("draggable", "true");
    // Lines are re-measured when the window resizes.
    fireEvent(window, new Event("resize"));
    expect(edges()).toHaveLength(5);
  });

  it("highlights the whole vertical chain of a hovered unit", async () => {
    await renderView(<OrganizationView />);
    fireEvent.mouseEnter(box("ART A"));
    for (const n of ["Fabrikam", "ART A", "Team Red", "Team Blue"]) expect(box(n)).toHaveClass("hot");
    for (const n of ["ART B", "Team Green"]) expect(box(n)).toHaveClass("dim");
    expect(edge("n-arta>n-red")).toHaveClass("hot");
    expect(edge("n-root>n-arta")).toHaveClass("hot");
    expect(edge("n-artb>n-green")).toHaveClass("dim");

    fireEvent.mouseLeave(box("ART A"));
    fireEvent.mouseEnter(box("Team Green"));
    expect(box("Team Red")).toHaveClass("dim");
    expect(box("ART B")).toHaveClass("hot");
    fireEvent.mouseLeave(box("Team Green"));
    expect(box("Team Red")).not.toHaveClass("dim");
    expect(edge("n-artb>n-green")).not.toHaveClass("hot");
  });

  it("selects a unit on click", async () => {
    const { ctx } = await renderView(<OrganizationView />);
    fireEvent.click(screen.getByRole("button", { name: "Team Blue" }));
    expect(ctx.selectNode).toHaveBeenCalledWith("n-blue");
  });

  describe("adding units", () => {
    it("adds a unit to a layer under a valid parent with an area path", async () => {
      const { ctx } = await renderView(<OrganizationView />);
      fireEvent.click(screen.getByRole("button", { name: "Add Team" }));
      const dialog = screen.getByRole("dialog", { name: "Add Team" });
      const add = within(dialog).getByRole("button", { name: "Add" });
      expect(add).toBeDisabled();
      const [area, parent] = await waitFor(() => {
        const selects = within(dialog).getAllByRole("combobox");
        expect(selects).toHaveLength(2);
        return selects as HTMLSelectElement[];
      });
      expect(Array.from(parent.options).map((o) => o.text)).toEqual(["ART A (Agile Release Train)", "ART B (Agile Release Train)"]);
      expect(Array.from(area.options).map((o) => o.value)).toContain("Fabrikam\\ART B\\Team Green");
      fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: " Team Yellow " } });
      fireEvent.change(area, { target: { value: "Fabrikam\\ART B" } });
      fireEvent.change(parent, { target: { value: "n-artb" } });
      fireEvent.click(add);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      const artB = findNode(savedRoot(ctx), "n-artb")!;
      expect(artB.children.map((c) => c.name)).toEqual(["Team Green", "Team Yellow"]);
      expect(artB.children[1]).toMatchObject({ level: "team", areaPath: "Fabrikam\\ART B", children: [] });
      expect(screen.getByRole("status")).toHaveTextContent('Added "Team Yellow".');
      expect(within(band("Team")).getByRole("button", { name: "Team Yellow" })).toBeInTheDocument();
    });

    it("adds from a unit's menu with the parent preselected and no area path", async () => {
      const { ctx } = await renderView(<OrganizationView />);
      const menu = openMenu("Fabrikam");
      expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
        "Add Large Solution here",
        "Add Agile Release Train here",
      ]);
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Add Large Solution here" }));
      const dialog = screen.getByRole("dialog", { name: "Add Large Solution" });
      await waitFor(() => expect(within(dialog).queryByText("Loading area paths…")).not.toBeInTheDocument());
      fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Big Solution" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
      await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
      const sol = savedRoot(ctx).children.find((c) => c.name === "Big Solution")!;
      expect(sol).toMatchObject({ level: "solution", areaPath: undefined });
    });

    it("keeps the dialog open when saving fails, shows area path errors, and cancels", async () => {
      fail(/classificationnodes\/Areas/, 500, "Areas down");
      const { ctx } = await renderView(<OrganizationView />);
      ctx.saveConfig.mockRejectedValueOnce(new Error("Quota exceeded"));
      fireEvent.click(screen.getByRole("button", { name: "Add Agile Release Train" }));
      const dialog = screen.getByRole("dialog", { name: "Add Agile Release Train" });
      expect(await within(dialog).findByText("Could not load area paths: Areas down")).toBeInTheDocument();
      fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "ART C" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
      await waitFor(() => expect(screen.getByText("Could not save the organization: Quota exceeded")).toBeInTheDocument());
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("disables adding to a layer without possible parents", async () => {
      const config = makeConfig();
      config.root.children = [];
      await renderView(<OrganizationView />, { config, nodeId: "n-root" });
      const add = screen.getByRole("button", { name: "Add Team" });
      expect(add).toBeDisabled();
      expect(add).toHaveAttribute("title", "Needs a parent unit first (Agile Release Train)");
      expect(screen.getByRole("button", { name: "Add Portfolio" })).toHaveAttribute("title", "The organization has a single portfolio");
      expect(edges()).toHaveLength(0);
    });
  });

  describe("re-linking by drag and drop", () => {
    it("moves a unit under a valid new parent after confirmation", async () => {
      const { ctx } = await renderView(<OrganizationView />);
      const dt = dataTransfer();
      fireEvent.dragStart(box("Team Blue"), { dataTransfer: dt });
      fireEvent.dragOver(box("ART B"), { dataTransfer: dt });
      fireEvent.dragOver(box("ART B"), { dataTransfer: dt });
      expect(box("ART B")).toHaveClass("drop-over");
      fireEvent.drop(box("ART B"), { dataTransfer: dt });
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("may invalidate existing work item hierarchy and PI assignments"));
      await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
      expect(parentOf(savedRoot(ctx), "n-blue")!.id).toBe("n-artb");
      expect(screen.getByRole("status")).toHaveTextContent('Moved "Team Blue" under "ART B".');
      expect(box("ART B")).not.toHaveClass("drop-over");
    });

    it("rejects invalid adjacency and moves into the unit's own subtree", async () => {
      const { ctx } = await renderView(<OrganizationView />);
      fireEvent.dragStart(box("Team Red"), { dataTransfer: dataTransfer() });
      fireEvent.drop(box("Fabrikam"), { dataTransfer: dataTransfer("n-red") });
      expect(screen.getByRole("alert")).toHaveTextContent("A Team cannot be placed under a Portfolio.");

      fireEvent.drop(box("Team Red"), { dataTransfer: dataTransfer("n-arta") });
      expect(screen.getByRole("alert")).toHaveTextContent('"ART A" cannot be moved under itself or one of its sub-units.');
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

      // Dropping on the current parent is a no-op.
      fireEvent.drop(box("ART A"), { dataTransfer: dataTransfer("n-red") });
      // Unknown ids are ignored.
      fireEvent.drop(box("ART A"), { dataTransfer: dataTransfer("nope") });
      expect(ctx.saveConfig).not.toHaveBeenCalled();
      expect(window.confirm).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("falls back to the dragged unit when the drop carries no data, and respects cancel", async () => {
      vi.mocked(window.confirm).mockReturnValueOnce(false);
      const { ctx } = await renderView(<OrganizationView />);
      fireEvent.dragStart(box("Team Green"), { dataTransfer: dataTransfer() });
      fireEvent.drop(box("ART A"), { dataTransfer: { getData: () => "" } });
      expect(window.confirm).toHaveBeenCalled();
      expect(ctx.saveConfig).not.toHaveBeenCalled();

      fireEvent.dragStart(box("Team Green"), { dataTransfer: dataTransfer() });
      fireEvent.dragOver(box("ART A"), { dataTransfer: dataTransfer() });
      fireEvent.dragLeave(box("ART A"));
      expect(box("ART A")).not.toHaveClass("drop-over");
      fireEvent.dragOver(box("ART A"), { dataTransfer: dataTransfer() });
      fireEvent.dragEnd(box("Team Green"));
      expect(box("ART A")).not.toHaveClass("drop-over");
      // After the drag ended, a data-less drop has nothing to move.
      fireEvent.drop(box("ART A"), { dataTransfer: { getData: () => "" } });
      expect(ctx.saveConfig).not.toHaveBeenCalled();
    });

    it("reports save failures", async () => {
      const { ctx } = await renderView(<OrganizationView />);
      ctx.saveConfig.mockRejectedValueOnce(new Error("etag mismatch"));
      fireEvent.drop(box("ART B"), { dataTransfer: dataTransfer("n-red") });
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not save the organization: etag mismatch");
    });
  });

  describe("unit menu", () => {
    it("detaches a unit onto the portfolio root where the level allows it", async () => {
      const { ctx } = await renderView(<OrganizationView />, { config: solutionConfig() });
      const menu = openMenu("ART S");
      const detach = within(menu).getByRole("menuitem", { name: "Detach from parent" });
      expect(detach).toBeEnabled();
      expect(detach).toHaveAttribute("title", "Attach directly to Fabrikam");
      fireEvent.click(detach);
      await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
      expect(parentOf(savedRoot(ctx), "n-arts")!.id).toBe("n-root");
      expect(findNode(savedRoot(ctx), "n-arts")!.children.map((c) => c.id)).toEqual(["n-ts"]);
      expect(screen.getByRole("status")).toHaveTextContent('Detached "ART S".');
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("disables detach for units that cannot attach to the root or already do", async () => {
      await renderView(<OrganizationView />, { config: solutionConfig() });
      const teamMenu = openMenu("Team S");
      const detach = within(teamMenu).getByRole("menuitem", { name: "Detach from parent" });
      expect(detach).toBeDisabled();
      expect(detach).toHaveAttribute("title", "A Team can only be detached when it can attach to the portfolio root");
      expect(within(teamMenu).queryByText(/here$/)).not.toBeInTheDocument();
      // Toggle closed.
      fireEvent.click(screen.getByRole("button", { name: "Actions for Team S" }));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();

      const artDetach = within(openMenu("ART A")).getByRole("menuitem", { name: "Detach from parent" });
      expect(artDetach).toBeDisabled();
      expect(artDetach).toHaveAttribute("title", "An Agile Release Train can only be detached when it can attach to the portfolio root");
    });

    it("does not detach when cancelled", async () => {
      vi.mocked(window.confirm).mockReturnValueOnce(false);
      const { ctx } = await renderView(<OrganizationView />, { config: solutionConfig() });
      fireEvent.click(within(openMenu("ART S")).getByRole("menuitem", { name: "Detach from parent" }));
      expect(ctx.saveConfig).not.toHaveBeenCalled();
    });

    it("removes a unit with its children and moves the selection to the root", async () => {
      const { ctx } = await renderView(<OrganizationView />, { nodeId: "n-red" });
      fireEvent.click(within(openMenu("ART A")).getByRole("menuitem", { name: "Remove from hierarchy" }));
      expect(window.confirm).toHaveBeenCalledWith('Remove "ART A" and its 2 sub-units from the hierarchy? Work items are not changed.');
      await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
      expect(ctx.selectNode).toHaveBeenCalledWith("n-root");
      expect(findNode(savedRoot(ctx), "n-arta")).toBeUndefined();
      expect(findNode(savedRoot(ctx), "n-red")).toBeUndefined();
      expect(edges()).toHaveLength(2);
    });

    it("removes a single unit without touching the selection, or not at all when cancelled", async () => {
      const { ctx } = await renderView(<OrganizationView />);
      vi.mocked(window.confirm).mockReturnValueOnce(false);
      fireEvent.click(within(openMenu("ART B")).getByRole("menuitem", { name: "Remove from hierarchy" }));
      expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('"ART B" and its 1 sub-unit from'));
      expect(ctx.saveConfig).not.toHaveBeenCalled();

      fireEvent.click(within(openMenu("Team Green")).getByRole("menuitem", { name: "Remove from hierarchy" }));
      expect(window.confirm).toHaveBeenLastCalledWith('Remove "Team Green" from the hierarchy? Work items are not changed.');
      await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
      expect(ctx.selectNode).not.toHaveBeenCalled();
    });
  });
});

describe("organization helpers", () => {
  const root = solutionConfig().root;

  it("knows valid parent levels", () => {
    expect(parentLevels("portfolio")).toEqual([]);
    expect(parentLevels("solution")).toEqual(["portfolio"]);
    expect(parentLevels("art")).toEqual(["portfolio", "solution"]);
    expect(parentLevels("team")).toEqual(["art"]);
  });

  it("validates moves", () => {
    expect(moveError(root, root, findNode(root, "n-arta")!)).toBe("The portfolio root cannot be moved.");
    expect(moveError(root, findNode(root, "n-arta")!, findNode(root, "n-sol")!)).toBeNull();
    expect(moveError(root, findNode(root, "n-sol")!, findNode(root, "n-arta")!)).toBe(
      "A Large Solution cannot be placed under an Agile Release Train."
    );
  });

  it("moves subtrees and ignores unknown ids", () => {
    expect(moveNode(root, "missing", "n-root")).toBe(root);
    const moved = moveNode(root, "n-ts", "n-arta");
    expect(parentOf(moved, "n-ts")!.id).toBe("n-arta");
  });

  it("detaches only below the root where the level may attach to it", () => {
    expect(canDetach(root, root)).toBe(false);
    expect(canDetach(root, findNode(root, "n-arts")!)).toBe(true);
    expect(canDetach(root, findNode(root, "n-ts")!)).toBe(false);
    expect(canDetach(root, findNode(root, "n-arta")!)).toBe(false);
  });
});
