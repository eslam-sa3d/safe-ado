import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { findNode } from "../../src/api/org";
import { Capabilities } from "../../src/api/permissions";
import { OrgNode, SafeConfig } from "../../src/api/types";
import { SafeContext, useSafe } from "../../src/components/context";
import { OrganizationView, validParents } from "../../src/views/OrganizationView";
import { makeConfig } from "../fakeAdo";
import { dataTransfer, renderView } from "../utils";

const saved = (ctx: { saveConfig: ReturnType<typeof vi.fn> }) => ctx.saveConfig.mock.calls.at(-1)![0] as SafeConfig;
const unattached = () => screen.getByRole("region", { name: "Unattached units" });
const treeBox = (name: string) => screen.getByRole("button", { name }).closest(".org-node") as HTMLElement;
const looseBox = (name: string) => within(unattached()).getByText(name).closest(".org-node") as HTMLElement;
const openMenu = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  return screen.getByRole("menu", { name: `${name} actions` });
};

function Override({ can, children }: { can?: Capabilities; children: ReactNode }) {
  const ctx = useSafe();
  return <SafeContext.Provider value={{ ...ctx, can: can ?? ctx.can }}>{children}</SafeContext.Provider>;
}

const render = (opts: { config?: SafeConfig; nodeId?: string; can?: Capabilities } = {}) =>
  renderView(
    <Override can={opts.can}>
      <OrganizationView />
    </Override>,
    opts
  );

const teamX = (): OrgNode => ({ id: "n-x", name: "Team X", level: "team", children: [] });
function withDetached(...units: OrgNode[]): SafeConfig {
  return makeConfig({ detached: units });
}

describe("My Organization — detaching", () => {
  it("moves a unit with its sub-units to the unattached units", async () => {
    const { ctx } = await render();
    expect(within(unattached()).getByText("No unattached units")).toBeInTheDocument();
    fireEvent.click(within(openMenu("ART A")).getByRole("menuitem", { name: "Detach from parent" }));
    expect(window.confirm).toHaveBeenCalledWith(
      'Detach "ART A" and its 2 sub-units from its parent? It stays in the organization as an unattached unit until you attach it again.'
    );
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    const config = saved(ctx);
    expect(findNode(config.root, "n-arta")).toBeUndefined();
    expect(config.detached!.map((d) => [d.id, d.children.map((c) => c.id)])).toEqual([["n-arta", ["n-red", "n-blue"]]]);
    // The selected unit left the hierarchy: the selection moves to the root.
    expect(ctx.selectNode).toHaveBeenCalledWith("n-root");
    expect(screen.getByRole("status")).toHaveTextContent('Detached "ART A".');
    expect(within(unattached()).getByText("ART A")).toBeInTheDocument();
    expect(within(unattached()).getByText("+2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Team Red" })).toBeNull();
  });

  it("detaches a single team without moving the selection", async () => {
    const { ctx } = await render();
    fireEvent.click(within(openMenu("Team Green")).getByRole("menuitem", { name: "Detach from parent" }));
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringMatching(/^Detach "Team Green" from its parent\?/));
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    expect(ctx.selectNode).not.toHaveBeenCalled();
    expect(saved(ctx).detached!.map((d) => d.id)).toEqual(["n-green"]);
  });

  it("detaches a unit dropped on the unattached band", async () => {
    const { ctx } = await render();
    const dt = dataTransfer();
    fireEvent.dragStart(treeBox("Team Blue"), { dataTransfer: dt });
    fireEvent.dragOver(unattached(), { dataTransfer: dt });
    fireEvent.dragOver(unattached(), { dataTransfer: dt });
    expect(unattached()).toHaveClass("drop-over");
    fireEvent.dragLeave(unattached());
    expect(unattached()).not.toHaveClass("drop-over");
    fireEvent.drop(unattached(), { dataTransfer: dt });
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    expect(saved(ctx).detached!.map((d) => d.id)).toEqual(["n-blue"]);

    // The root, unknown ids and already unattached units are ignored.
    vi.mocked(window.confirm).mockClear();
    fireEvent.drop(unattached(), { dataTransfer: dataTransfer("n-root") });
    fireEvent.drop(unattached(), { dataTransfer: dataTransfer("nope") });
    fireEvent.drop(unattached(), { dataTransfer: dataTransfer("n-blue") });
    fireEvent.drop(unattached(), { dataTransfer: { getData: () => "" } });
    expect(window.confirm).not.toHaveBeenCalled();
    expect(ctx.saveConfig).toHaveBeenCalledTimes(1);
  });
});

describe("My Organization — attaching", () => {
  it("attaches an unattached unit by dragging it onto a valid parent", async () => {
    const { ctx } = await render({ config: withDetached(teamX(), { id: "n-y", name: "ART Y", level: "art", children: [] }) });
    expect(within(unattached()).getByText("2")).toHaveClass("count");
    const dt = dataTransfer();
    fireEvent.dragStart(looseBox("Team X"), { dataTransfer: dt });
    fireEvent.drop(treeBox("Fabrikam"), { dataTransfer: dt });
    expect(screen.getByRole("alert")).toHaveTextContent("A Team cannot be placed under a Portfolio.");
    expect(ctx.saveConfig).not.toHaveBeenCalled();

    fireEvent.dragStart(looseBox("Team X"), { dataTransfer: dt });
    fireEvent.dragEnd(looseBox("Team X"));
    fireEvent.drop(treeBox("ART B"), { dataTransfer: dataTransfer("n-x") });
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    expect(window.confirm).not.toHaveBeenCalled();
    const config = saved(ctx);
    expect(findNode(config.root, "n-artb")!.children.map((c) => c.id)).toEqual(["n-green", "n-x"]);
    expect(config.detached!.map((d) => d.id)).toEqual(["n-y"]);
    expect(screen.getByRole("status")).toHaveTextContent('Attached "Team X" under "ART B".');
    expect(screen.getByRole("button", { name: "Team X" })).toBeInTheDocument();
  });

  it("attaches from the menu and drops the empty unattached list", async () => {
    const { ctx } = await render({ config: withDetached(teamX()) });
    fireEvent.click(within(openMenu("Team X")).getByRole("menuitem", { name: "Attach to…" }));
    const dialog = screen.getByRole("dialog", { name: "Attach Team X" });
    const parent = within(dialog).getByLabelText("New parent") as HTMLSelectElement;
    expect(Array.from(parent.options).map((o) => o.text)).toEqual(["ART A (Agile Release Train)", "ART B (Agile Release Train)"]);
    fireEvent.change(parent, { target: { value: "n-artb" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const config = saved(ctx);
    expect(config).not.toHaveProperty("detached");
    expect(findNode(config.root, "n-x")).toBeDefined();
  });

  it("keeps the dialog open when saving fails and cancels", async () => {
    const { ctx } = await render({ config: withDetached(teamX()) });
    ctx.saveConfig.mockRejectedValueOnce(new Error("etag mismatch"));
    fireEvent.click(within(openMenu("Team X")).getByRole("menuitem", { name: "Attach to…" }));
    const dialog = screen.getByRole("dialog", { name: "Attach Team X" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Attach" }));
    expect(await screen.findByText("Could not save the organization: etag mismatch")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Toggle a menu open and closed.
    openMenu("Team X");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Team X" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("explains when no unit can take the unattached unit", async () => {
    const config = withDetached(teamX());
    config.root.children = [];
    await render({ config, nodeId: "n-root" });
    fireEvent.click(within(openMenu("Team X")).getByRole("menuitem", { name: "Attach to…" }));
    const dialog = screen.getByRole("dialog", { name: "Attach Team X" });
    expect(within(dialog).getByText("No unit can take a Team. Add an Agile Release Train first.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Attach" })).toBeDisabled();
  });

  it("removes an unattached unit after confirmation", async () => {
    const { ctx } = await render({ config: withDetached({ ...teamX(), children: [{ id: "n-sub", name: "Sub", level: "team", children: [] }] }) });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(within(openMenu("Team X")).getByRole("menuitem", { name: "Remove from organization" }));
    expect(window.confirm).toHaveBeenCalledWith('Remove "Team X" and its 1 sub-unit from the hierarchy? Work items are not changed.');
    expect(ctx.saveConfig).not.toHaveBeenCalled();
    fireEvent.click(within(openMenu("Team X")).getByRole("menuitem", { name: "Remove from organization" }));
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    expect(saved(ctx)).not.toHaveProperty("detached");
    expect(ctx.selectNode).not.toHaveBeenCalled();
    expect(within(unattached()).getByText("No unattached units")).toBeInTheDocument();
  });

  it("lists valid parents", () => {
    const root = makeConfig().root;
    expect(validParents(root, teamX()).map((n) => n.id)).toEqual(["n-arta", "n-artb"]);
    expect(validParents(root, { id: "a", name: "A", level: "art", children: [] }).map((n) => n.id)).toEqual(["n-root"]);
  });
});

describe("My Organization — read-only", () => {
  const can: Capabilities = { admin: false, managePis: true, plan: true };

  it("shows the organization without editing affordances", async () => {
    const { ctx } = await render({ can, config: withDetached(teamX()) });
    expect(screen.getByRole("note")).toHaveTextContent("Read-only: only project administrators can change the organization.");
    expect(screen.queryByRole("button", { name: /^Add / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Actions for / })).toBeNull();
    expect(treeBox("ART A")).toHaveAttribute("draggable", "false");
    expect(looseBox("Team X")).toHaveAttribute("draggable", "false");
    expect(unattached()).toHaveTextContent("Kept in the organization, outside the hierarchy.");

    fireEvent.dragOver(treeBox("ART B"), { dataTransfer: dataTransfer() });
    expect(treeBox("ART B")).not.toHaveClass("drop-over");
    fireEvent.dragOver(unattached(), { dataTransfer: dataTransfer() });
    expect(unattached()).not.toHaveClass("drop-over");
    fireEvent.drop(treeBox("ART B"), { dataTransfer: dataTransfer("n-red") });
    fireEvent.drop(treeBox("ART B"), { dataTransfer: dataTransfer("n-x") });
    fireEvent.drop(unattached(), { dataTransfer: dataTransfer("n-red") });
    expect(window.confirm).not.toHaveBeenCalled();
    expect(ctx.saveConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Team Red" }));
    expect(ctx.selectNode).toHaveBeenCalledWith("n-red");
  });

  it("hides the empty unattached band", async () => {
    await render({ can });
    expect(screen.queryByRole("region", { name: "Unattached units" })).toBeNull();
  });
});
