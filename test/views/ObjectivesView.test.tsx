import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PiObjective } from "../../src/api/types";
import { ObjectivesView, predictability } from "../../src/views/ObjectivesView";
import { dataStore, docs, makeConfig, PI1, PI2, seedDocs } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { renderView } from "../utils";

const obj = (id: string, nodeId: string, title: string, committed: boolean, plannedBV: number, actualBV: number | null, piPath = PI2, featureIds: number[] = []): PiObjective => ({
  id, nodeId, title, committed, plannedBV, actualBV, piPath, featureIds,
});

const SEED = [
  obj("o1", "n-red", "Ship payments", true, 8, 7, PI2, [10]),
  obj("o2", "n-red", "Stretch: wallet", false, 3, 2),
  obj("o3", "n-blue", "Checkout UI live", true, 10, 5),
  obj("o4", "n-arta", "PCI compliance", true, 6, 4),
  obj("o5", "n-red", "Last PI goal", true, 5, 5, PI1),
  obj("o6", "n-green", "ART B goal", true, 4, 4),
];

const panel = (name: string) => screen.getByRole("heading", { name }).closest(".panel") as HTMLElement;
const stat = (label: string) => screen.getByText(label, { selector: ".stat-label" }).closest(".stat") as HTMLElement;

async function renderObjectives(opts: Parameters<typeof renderView>[1] = {}) {
  seedDocs("objectives", SEED);
  const r = await renderView(<ObjectivesView />, opts);
  await screen.findAllByRole("heading", { level: 3 });
  return r;
}

describe("predictability()", () => {
  it("divides all actual BV by committed planned BV", () => {
    expect(predictability(SEED.slice(0, 2))).toEqual({ planned: 8, actual: 9, pct: 113 });
    expect(predictability([])).toEqual({ planned: 0, actual: 0, pct: null });
    expect(predictability([obj("x", "n", "t", false, 5, 5)])).toEqual({ planned: 0, actual: 5, pct: null });
    expect(predictability([obj("x", "n", "t", true, 0, null)]).pct).toBeNull();
  });
});

describe("PI Objectives view", () => {
  it("summarises the selected subtree for the PI and colours the result", async () => {
    await renderObjectives();
    expect(within(stat("Planned BV (committed)")).getByText("24")).toBeInTheDocument();
    expect(within(stat("Actual BV")).getByText("18")).toBeInTheDocument();
    expect(within(stat("Predictability")).getByText("75%")).toBeInTheDocument();
    expect(stat("Predictability")).toHaveClass("warn");
  });

  it("shows a section for the node and each child with its own predictability", async () => {
    await renderObjectives();
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["ART A", "Team Red", "Team Blue"]);
    expect(within(panel("ART A")).getByText("67% predictability")).toBeInTheDocument();
    expect(within(panel("Team Red")).getByText("113% predictability")).toBeInTheDocument();
    expect(within(panel("Team Blue")).getByText("50% predictability")).toBeInTheDocument();
    // Other PI and other ART objectives are excluded
    expect(screen.queryByDisplayValue("Last PI goal")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("ART B goal")).not.toBeInTheDocument();
  });

  it("sorts committed objectives first, then by planned BV", async () => {
    await renderObjectives({ nodeId: "n-red" });
    const titles = within(panel("Team Red"))
      .getAllByRole("row")
      .slice(1)
      .map((r) => (within(r).getAllByRole("textbox")[0] as HTMLInputElement).value);
    expect(titles).toEqual(["Ship payments", "Stretch: wallet"]);
    expect(within(panel("Team Red")).getAllByRole("row")[2]).toHaveClass("uncommitted");
  });

  it("marks tone good at ≥ 80%", async () => {
    await renderObjectives({ nodeId: "n-red" });
    expect(stat("Predictability")).toHaveClass("good");
  });

  it("shows bad tone and placeholders when there is nothing committed", async () => {
    seedDocs("objectives", [obj("b", "n-blue", "x", true, 10, 1)]);
    await renderView(<ObjectivesView />, { nodeId: "n-blue" });
    await screen.findByRole("heading", { name: "Team Blue" });
    expect(stat("Predictability")).toHaveClass("bad");
  });

  it("shows empty sections and '—' when a PI has no objectives", async () => {
    await renderView(<ObjectivesView />, { nodeId: "n-green" });
    await screen.findByRole("heading", { name: "Team Green" });
    expect(within(stat("Predictability")).getByText("—")).toBeInTheDocument();
    expect(stat("Predictability")).not.toHaveClass("good");
    expect(screen.getByText("No objectives for this PI yet.")).toBeInTheDocument();
    expect(screen.getByText("No committed BV")).toBeInTheDocument();
  });

  it("lets each child edit its own objectives in the parent's view", async () => {
    await renderObjectives();
    expect(within(panel("Team Red")).getByDisplayValue("Ship payments")).toBeEnabled();
    expect(within(panel("ART A")).getByDisplayValue("PCI compliance")).toBeEnabled();
  });

  it("shows grandchildren's objectives read-only (solution view rolls up teams under each ART)", async () => {
    const config = makeConfig();
    config.root.children = [{ id: "n-sol", name: "Big Solution", level: "solution", areaPath: "Fabrikam", children: config.root.children }];
    await renderObjectives({ config, nodeId: "n-sol" });
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Big Solution", "ART A", "ART B"]);
    const artA = within(panel("ART A"));
    expect(artA.getByDisplayValue("Ship payments")).toBeDisabled();
    expect(artA.getByDisplayValue("PCI compliance")).toBeEnabled();
    expect(artA.getAllByRole("button", { name: "Delete objective" })).toHaveLength(1);
    expect(within(panel("ART B")).getByDisplayValue("ART B goal")).toBeDisabled();
  });

  it("adds an objective to the right node and PI", async () => {
    await renderObjectives({ nodeId: "n-red" });
    fireEvent.click(within(panel("Team Red")).getByRole("button", { name: "New objective" }));
    expect(await screen.findByDisplayValue("New objective")).toBeInTheDocument();
    const created = docs("objectives").find((d) => d.title === "New objective");
    expect(created).toMatchObject({ nodeId: "n-red", piPath: PI2, committed: true, plannedBV: 5, actualBV: null, featureIds: [] });
  });

  it("edits fields on blur and supports consecutive saves (etag refresh)", async () => {
    await renderObjectives({ nodeId: "n-red" });
    const title = screen.getByDisplayValue("Ship payments");
    fireEvent.change(title, { target: { value: "Ship payments v2" } });
    fireEvent.blur(title);
    await waitFor(() => expect(docs("objectives").find((d) => d.id === "o1").title).toBe("Ship payments v2"));

    // A second edit must use the new etag rather than conflicting.
    fireEvent.change(title, { target: { value: "Ship payments v3" } });
    fireEvent.blur(title);
    await waitFor(() => expect(docs("objectives").find((d) => d.id === "o1").title).toBe("Ship payments v3"));
    expect(screen.queryByText(/Could not save objective/)).not.toBeInTheDocument();
  });

  it("does not save when nothing changed", async () => {
    await renderObjectives({ nodeId: "n-red" });
    fireEvent.blur(screen.getByDisplayValue("Ship payments"));
    await new Promise((r) => setTimeout(r, 20));
    expect(docs("objectives").find((d) => d.id === "o1").__etag).toBe(1);
  });

  it("toggles committed/uncommitted", async () => {
    await renderObjectives({ nodeId: "n-red" });
    const row = screen.getByDisplayValue("Ship payments").closest("tr")!;
    fireEvent.change(within(row).getByRole("combobox", { name: "Type" }), { target: { value: "u" } });
    await waitFor(() => expect(docs("objectives").find((d) => d.id === "o1").committed).toBe(false));
    fireEvent.change(within(row).getByRole("combobox", { name: "Type" }), { target: { value: "c" } });
    await waitFor(() => expect(docs("objectives").find((d) => d.id === "o1").committed).toBe(true));
  });

  it("clamps business values to 0–10 and allows clearing actual BV", async () => {
    await renderObjectives({ nodeId: "n-red" });
    const row = screen.getByDisplayValue("Ship payments").closest("tr")!;
    const [planned, actual] = within(row).getAllByRole("spinbutton");
    fireEvent.change(planned, { target: { value: "42" } });
    fireEvent.blur(planned);
    await waitFor(() => expect(docs("objectives").find((d) => d.id === "o1").plannedBV).toBe(10));
    fireEvent.change(planned, { target: { value: "" } });
    fireEvent.blur(planned);
    await waitFor(() => expect(docs("objectives").find((d) => d.id === "o1").plannedBV).toBe(0));
    fireEvent.change(actual, { target: { value: "-3" } });
    fireEvent.blur(actual);
    await waitFor(() => expect(docs("objectives").find((d) => d.id === "o1").actualBV).toBe(0));
    fireEvent.change(actual, { target: { value: "" } });
    fireEvent.blur(actual);
    await waitFor(() => expect(docs("objectives").find((d) => d.id === "o1").actualBV).toBeNull());
  });

  it("parses linked feature ids and opens them", async () => {
    await renderObjectives({ nodeId: "n-red" });
    const input = screen.getByDisplayValue("10");
    fireEvent.change(input, { target: { value: "10, 14 abc -3 1.5,,11" } });
    fireEvent.blur(input);
    await waitFor(() => expect(docs("objectives").find((d) => d.id === "o1").featureIds).toEqual([10, 14, 11]));
    fireEvent.click(screen.getByRole("button", { name: "#14" }));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(14));
  });

  it("deletes after confirmation, and keeps it when cancelled", async () => {
    await renderObjectives({ nodeId: "n-red" });
    const row = () => screen.getByDisplayValue("Stretch: wallet").closest("tr")!;
    (window.confirm as any).mockReturnValueOnce(false);
    fireEvent.click(within(row()).getByRole("button", { name: "Delete objective" }));
    expect(docs("objectives").some((d) => d.id === "o2")).toBe(true);

    fireEvent.click(within(row()).getByRole("button", { name: "Delete objective" }));
    expect(window.confirm).toHaveBeenLastCalledWith('Delete objective "Stretch: wallet"?');
    await waitFor(() => expect(screen.queryByDisplayValue("Stretch: wallet")).not.toBeInTheDocument());
    expect(docs("objectives").some((d) => d.id === "o2")).toBe(false);
  });

  it("reports save and delete errors", async () => {
    await renderObjectives({ nodeId: "n-red" });
    dataStore.failures.push({ op: "setDocument", error: new Error("quota exceeded") });
    fireEvent.click(screen.getByRole("button", { name: "New objective" }));
    expect(await screen.findByText("Could not save objective: quota exceeded")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dismiss"));

    dataStore.failures.push({ op: "deleteDocument", error: new Error("locked") });
    fireEvent.click(screen.getAllByRole("button", { name: "Delete objective" })[0]);
    expect(await screen.findByText("Could not delete objective: locked")).toBeInTheDocument();
  });

  it("shows load errors and renders nothing without a PI", async () => {
    dataStore.failures.push({ op: "getDocuments", error: Object.assign(new Error("denied"), { status: 403 }) });
    await renderView(<ObjectivesView />);
    expect(await screen.findByText("denied")).toBeInTheDocument();

    const { container } = await renderView(<ObjectivesView />, { pi: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a spinner while loading", async () => {
    await renderView(<ObjectivesView />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await screen.findByRole("heading", { name: "ART A" });
  });
});
