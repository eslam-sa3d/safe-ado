import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { findNode } from "../../src/api/org";
import { SafeConfig } from "../../src/api/types";
import { SetupView } from "../../src/views/SetupView";
import { makeConfig } from "../fakeAdo";
import { renderView } from "../utils";

const lastSaved = (ctx: { saveConfig: any }) => ctx.saveConfig.mock.calls.at(-1)[0] as SafeConfig;

async function renderSetup(config?: SafeConfig) {
  const r = await renderView(<SetupView firstRun={false} />, { nodeId: "n-root", config });
  await screen.findByRole("heading", { name: "Work item types" });
  return r;
}

const openMembers = (node: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Members of ${node}` }));
  return screen.getByRole("group", { name: `${node} members` });
};
const field = (group: HTMLElement, label: string) => within(group).getByLabelText(label) as HTMLInputElement;

describe("Setup — hierarchy members", () => {
  it("adds, edits and saves members of a node", async () => {
    const { ctx } = await renderSetup();
    const toggle = screen.getByRole("button", { name: "Members of ART A" });
    expect(toggle).toHaveTextContent("Members (0)");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const group = openMembers("ART A");
    expect(within(group).getByText("No members yet.")).toBeInTheDocument();

    fireEvent.click(within(group).getByRole("button", { name: "Add member" }));
    fireEvent.change(field(group, "Member 1 name"), { target: { value: "Rita" } });
    fireEvent.change(field(group, "Member 1 role"), { target: { value: "RTE" } });
    fireEvent.click(within(group).getByRole("button", { name: "Add member" }));
    fireEvent.change(field(group, "Member 2 name"), { target: { value: "Paul" } });
    fireEvent.change(field(group, "Member 2 role"), { target: { value: "Product Manager" } });
    expect(screen.getByRole("button", { name: "Members of ART A" })).toHaveTextContent("Members (2)");

    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await screen.findByText("Saved ✓");
    expect(findNode(lastSaved(ctx).root, "n-arta")!.members).toEqual([
      { name: "Rita", role: "RTE" },
      { name: "Paul", role: "Product Manager" },
    ]);
    // collapse again
    fireEvent.click(screen.getByRole("button", { name: "Members of ART A" }));
    expect(screen.queryByRole("group", { name: "ART A members" })).toBeNull();
  });

  it("reorders and removes members", async () => {
    const config = makeConfig();
    config.root.children[0].children[0].members = [
      { name: "Ann", role: "PO" },
      { name: "Ben", role: "SM" },
      { name: "Cy", role: "Dev" },
    ];
    const { ctx } = await renderSetup(config);
    const group = openMembers("Team Red");
    const names = () => within(group).getAllByLabelText(/Member \d name/).map((i) => (i as HTMLInputElement).value);
    expect(within(group).getByRole("button", { name: "Move member 1 up" })).toBeDisabled();
    expect(within(group).getByRole("button", { name: "Move member 3 down" })).toBeDisabled();

    fireEvent.click(within(group).getByRole("button", { name: "Move member 3 up" }));
    expect(names()).toEqual(["Ann", "Cy", "Ben"]);
    fireEvent.click(within(group).getByRole("button", { name: "Move member 1 down" }));
    expect(names()).toEqual(["Cy", "Ann", "Ben"]);
    fireEvent.click(within(group).getByRole("button", { name: "Remove member 2" }));
    expect(names()).toEqual(["Cy", "Ben"]);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await screen.findByText("Saved ✓");
    expect(findNode(lastSaved(ctx).root, "n-red")!.members).toEqual([
      { name: "Cy", role: "Dev" },
      { name: "Ben", role: "SM" },
    ]);
  });

  it("stores no member list once the last member is removed", async () => {
    await renderSetup();
    const group = openMembers("Team Blue");
    fireEvent.click(within(group).getByRole("button", { name: "Add member" }));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "Remove member 1" }));
    // Back to the saved config: nothing to save
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });

  it("limits roles to 100 characters and nodes to 25 members", async () => {
    const config = makeConfig();
    config.root.members = Array.from({ length: 24 }, (_, i) => ({ name: `P${i}`, role: "Dev" }));
    await renderSetup(config);
    const group = openMembers("Fabrikam");
    const add = within(group).getByRole("button", { name: "Add member" });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(add).toBeDisabled();
    expect(within(group).getByText(/at most 25 members/)).toBeInTheDocument();

    const role = field(group, "Member 25 role");
    expect(role).toHaveAttribute("maxLength", "100");
    fireEvent.change(role, { target: { value: "x".repeat(150) } });
    expect(field(group, "Member 25 role").value).toHaveLength(100);
  });
});
