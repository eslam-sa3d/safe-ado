import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SafeConfig } from "../../src/api/types";
import { SetupView } from "../../src/views/SetupView";
import { fail, fake, makeConfig, P, RED } from "../fakeAdo";
import { renderView } from "../utils";

const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
const nameInputs = (name: string) => screen.queryAllByLabelText("Name").filter((i) => (i as HTMLInputElement).value === name);
const nodeRow = (name: string) => {
  const [input, ...rest] = nameInputs(name);
  if (!input || rest.length) throw new Error(`Expected exactly one node named ${name}, found ${rest.length + (input ? 1 : 0)}`);
  return input.closest(".node-row") as HTMLElement;
};
const lastSaved = (ctx: { saveConfig: any }) => ctx.saveConfig.mock.calls.at(-1)[0] as SafeConfig;

async function renderSetup(opts: Parameters<typeof renderView>[1] & { firstRun?: boolean } = {}) {
  const r = await renderView(<SetupView firstRun={opts.firstRun ?? false} />, { nodeId: "n-root", ...opts });
  await screen.findByRole("heading", { name: "Work item types" });
  return r;
}

describe("Setup", () => {
  it("shows a spinner while loading project metadata", async () => {
    await renderView(<SetupView firstRun={false} />, { nodeId: "n-root" });
    expect(screen.getByText("Loading project metadata…")).toBeInTheDocument();
    await screen.findByRole("heading", { name: "Work item types" });
  });

  it("maps work item types from the process", async () => {
    await renderSetup();
    const epic = select("Portfolio level (Epic)");
    expect(epic.value).toBe("Epic");
    expect(Array.from(epic.options).map((o) => o.textContent)).toEqual(["(select)", "Bug", "Epic", "Feature", "Task", "User Story"]);
    expect(select("Large Solution level (Capability) — optional").options[0].textContent).toBe(
      "(none — Features link directly to Epics)"
    );
    expect(select("Team level (Story)").value).toBe("User Story");
  });

  it("offers only numeric fields for story size", async () => {
    await renderSetup();
    const size = select("Story size field");
    expect(Array.from(size.options).map((o) => o.value)).toEqual([
      "Microsoft.VSTS.Common.BusinessValue",
      "Microsoft.VSTS.Scheduling.Effort",
      "Microsoft.VSTS.Common.Priority",
      "Microsoft.VSTS.Common.StackRank",
      "Microsoft.VSTS.Scheduling.StoryPoints",
      "Microsoft.VSTS.Common.TimeCriticality",
    ]);
    expect(size.value).toBe("Microsoft.VSTS.Scheduling.StoryPoints");
  });

  it("tracks unsaved changes, saves, and discards", async () => {
    const { ctx } = await renderSetup();
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeDisabled();

    fireEvent.change(select("Large Solution level (Capability) — optional"), { target: { value: "Task" } });
    fireEvent.change(select("Story size field"), { target: { value: "Microsoft.VSTS.Scheduling.Effort" } });
    fireEvent.change(select("PI root iteration"), { target: { value: "Fabrikam" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByText("Fabrikam\\PI 1\\PI 1 Sprint 1", { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(select("Story size field").value).toBe("Microsoft.VSTS.Scheduling.StoryPoints");

    fireEvent.change(select("Story size field"), { target: { value: "Microsoft.VSTS.Scheduling.Effort" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await screen.findByText("Saved ✓");
    expect(lastSaved(ctx).storyPointsField).toBe("Microsoft.VSTS.Scheduling.Effort");
  });

  it("clears the saved indicator after a moment", async () => {
    await renderSetup();
    const timeouts = vi.spyOn(window, "setTimeout");
    fireEvent.change(select("Story size field"), { target: { value: "Microsoft.VSTS.Scheduling.Effort" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await screen.findByText("Saved ✓");
    const call = timeouts.mock.calls.find(([, ms]) => ms === 2500)!;
    timeouts.mockRestore();
    act(() => (call[0] as () => void)());
    expect(screen.queryByText("Saved ✓")).not.toBeInTheDocument();
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });

  it("allows saving immediately on first run and shows the welcome banner", async () => {
    await renderSetup({ firstRun: true });
    expect(screen.getByText(/Welcome to ScaleLane/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save configuration" })).toBeEnabled();
  });

  it("reports save errors", async () => {
    const { ctx } = await renderSetup({ firstRun: true });
    (ctx.saveConfig as any).mockRejectedValueOnce(new Error("Quota"));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(await screen.findByText("Could not save: Quota")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText(/Could not save/)).not.toBeInTheDocument();
  });

  it("renders the hierarchy editor with areas and teams", async () => {
    await renderSetup();
    const art = nodeRow("ART A");
    expect(within(art).getByText("Agile Release Train")).toBeInTheDocument();
    expect((within(art).getByLabelText("Area path") as HTMLSelectElement).value).toBe("Fabrikam\\ART A");
    expect((within(art).getByLabelText("Azure DevOps team") as HTMLSelectElement).value).toBe("t-arta");
    expect(within(art).getByRole("button", { name: "Add Team" })).toBeInTheDocument();
    const root = nodeRow("Fabrikam");
    expect(within(root).queryByLabelText("Azure DevOps team")).toBeNull();
    expect(within(root).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(root).getByRole("button", { name: "Add Large Solution" })).toBeInTheDocument();
    expect(within(nodeRow("Team Red")).queryByRole("button", { name: /^Add / })).toBeNull();
  });

  it("adds, renames and removes nodes", async () => {
    const { ctx } = await renderSetup();
    fireEvent.click(within(nodeRow("ART B")).getByRole("button", { name: "Add Team" }));
    const added = nodeRow("New Team");
    expect((within(added).getByLabelText("Area path") as HTMLSelectElement).value).toBe("Fabrikam\\ART B");
    fireEvent.change(within(added).getByLabelText("Name"), { target: { value: "Team Yellow" } });
    fireEvent.click(within(nodeRow("Fabrikam")).getByRole("button", { name: "Add Large Solution" }));
    expect(nameInputs("New Large Solution")).toHaveLength(1);

    // Leaf removal needs no confirmation
    fireEvent.click(within(nodeRow("Team Yellow")).getByRole("button", { name: "Remove" }));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(nameInputs("Team Yellow")).toHaveLength(0);

    // Removing a subtree asks first
    (window.confirm as any).mockReturnValueOnce(false);
    fireEvent.click(within(nodeRow("ART A")).getByRole("button", { name: "Remove" }));
    expect(nameInputs("ART A")).toHaveLength(1);
    fireEvent.click(within(nodeRow("ART A")).getByRole("button", { name: "Remove" }));
    expect(window.confirm).toHaveBeenLastCalledWith('Remove "ART A" and everything under it?');
    expect(nameInputs("Team Red")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    expect(lastSaved(ctx).root.children.map((c) => c.name)).toEqual(["ART B", "New Large Solution"]);
  });

  it("clears area paths and fills them from the team's default area", async () => {
    const { ctx } = await renderSetup();
    const red = nodeRow("Team Red");
    fireEvent.change(within(red).getByLabelText("Area path"), { target: { value: "" } });
    fireEvent.change(within(red).getByLabelText("Azure DevOps team"), { target: { value: "" } });
    fireEvent.change(within(red).getByLabelText("Azure DevOps team"), { target: { value: "t-red" } });
    await waitFor(() => expect((within(red).getByLabelText("Area path") as HTMLSelectElement).value).toBe(RED));

    // A team without an area default leaves the area empty
    const blue = nodeRow("Team Blue");
    fireEvent.change(within(blue).getByLabelText("Area path"), { target: { value: "" } });
    fireEvent.change(within(blue).getByLabelText("Azure DevOps team"), { target: { value: "t-fab" } });
    await new Promise((r) => setTimeout(r, 20));
    expect((within(blue).getByLabelText("Area path") as HTMLSelectElement).value).toBe("");

    // Lookup failures are ignored
    fail(/t-green\/_apis\/work\/teamsettings\/teamfieldvalues/, 500, "x");
    const green = nodeRow("Team Green");
    fireEvent.change(within(green).getByLabelText("Area path"), { target: { value: "" } });
    fireEvent.change(within(green).getByLabelText("Azure DevOps team"), { target: { value: "t-green" } });
    await new Promise((r) => setTimeout(r, 20));
    expect((within(green).getByLabelText("Area path") as HTMLSelectElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    const saved = lastSaved(ctx).root.children[0].children;
    expect(saved[0]).toMatchObject({ teamId: "t-red", areaPath: RED });
    expect(saved[1]).toMatchObject({ teamId: "t-fab", areaPath: undefined });
  });

  it("does not overwrite an existing area when picking a team", async () => {
    await renderSetup();
    const red = nodeRow("Team Red");
    fireEvent.change(within(red).getByLabelText("Azure DevOps team"), { target: { value: "t-blue" } });
    await new Promise((r) => setTimeout(r, 20));
    expect((within(red).getByLabelText("Area path") as HTMLSelectElement).value).toBe(RED);
  });

  it("generates ARTs and teams from area paths and links teams by default area", async () => {
    const { ctx } = await renderSetup();
    fireEvent.click(screen.getByRole("button", { name: "Generate from area paths" }));
    expect(window.confirm).toHaveBeenCalledWith("Replace the current hierarchy with one generated from area paths?");
    await waitFor(() => expect(nameInputs("Team Red")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    const root = lastSaved(ctx).root;
    expect(root).toMatchObject({ name: "Fabrikam", level: "portfolio", areaPath: P });
    expect(root.children.map((c) => [c.name, c.level, c.areaPath, c.teamId])).toEqual([
      ["ART A", "art", "Fabrikam\\ART A", "t-arta"],
      ["ART B", "art", "Fabrikam\\ART B", undefined],
    ]);
    expect(root.children[0].children.map((c) => [c.name, c.level, c.teamId])).toEqual([
      ["Team Red", "team", "t-red"],
      ["Team Blue", "team", "t-blue"],
    ]);
  });

  it("generates Large Solutions when chosen", async () => {
    const { ctx } = await renderSetup();
    fireEvent.change(screen.getByDisplayValue("ARTs (Essential / Portfolio SAFe)"), { target: { value: "solution" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate from area paths" }));
    await waitFor(() => expect(nodeRow("ART A")).toHaveTextContent("Large Solution"));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    const sol = lastSaved(ctx).root.children[0];
    expect(sol.level).toBe("solution");
    expect(sol.children.map((c) => c.level)).toEqual(["art", "art"]);
  });

  it("does not ask for confirmation when the hierarchy is only the root, and respects cancel", async () => {
    const config = makeConfig();
    config.root.children = [];
    await renderSetup({ config });
    fireEvent.click(screen.getByRole("button", { name: "Generate from area paths" }));
    await waitFor(() => expect(nameInputs("ART A")).toHaveLength(1));
    expect(window.confirm).not.toHaveBeenCalled();

    (window.confirm as any).mockReturnValueOnce(false);
    fireEvent.change(nameInputs("ART A")[0], { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate from area paths" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(nameInputs("Renamed")).toHaveLength(1);
  });

  it("tolerates team lookup failures and duplicate default areas while generating", async () => {
    fake.teamAreas["t-fab"] = RED; // two teams share an area: the first by name ("Fabrikam Team") wins
    fail(/t-blue\/_apis\/work\/teamsettings\/teamfieldvalues/, 500, "x");
    const { ctx } = await renderSetup();
    fireEvent.click(screen.getByRole("button", { name: "Generate from area paths" }));
    await waitFor(() => expect(nameInputs("Team Red")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(ctx.saveConfig).toHaveBeenCalled());
    const teams = lastSaved(ctx).root.children[0].children;
    expect(teams[0].teamId).toBe("t-fab");
    expect(teams[1].teamId).toBeUndefined();
  });

  it("reports generation and metadata errors", async () => {
    await renderSetup();
    fail(/classificationnodes\/Areas/, 500, "areas unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Generate from area paths" }));
    expect(await screen.findByText("Could not generate hierarchy: areas unavailable")).toBeInTheDocument();
  });

  it("shows metadata load errors", async () => {
    fail(/wit\/fields/, 500, "fields unavailable");
    await renderView(<SetupView firstRun={false} />, { nodeId: "n-root" });
    expect(await screen.findByText("fields unavailable")).toBeInTheDocument();
  });
});
