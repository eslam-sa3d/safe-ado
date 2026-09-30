import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Risk } from "../../src/api/types";
import { RisksView } from "../../src/views/RisksView";
import { dataStore, docs, PI1, PI2, seedDocs } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { dataTransfer, renderView } from "../utils";

const risk = (id: string, nodeId: string, title: string, status: Risk["status"], impact: Risk["impact"], piPath = PI2, extra: Partial<Risk> = {}): Risk => ({
  id, nodeId, title, status, impact, piPath, description: "", owner: "", createdAt: "2026-09-01T00:00:00Z", ...extra,
});

const SEED = [
  risk("r1", "n-red", "Vendor API delay", "Unroamed", "High", PI2, { owner: "Sam", workItemId: 10 }),
  risk("r2", "n-blue", "Test env shortage", "Owned", "Medium"),
  risk("r3", "n-arta", "Old risk", "Resolved", "Low", PI1),
  risk("r4", "n-green", "ART B risk", "Accepted", "High"),
];

const column = (status: string) => screen.getByRole("group", { name: `${status} risks` });
const card = (title: string) => screen.getByText(title).closest(".card") as HTMLElement;

async function renderRisks(opts: Parameters<typeof renderView>[1] = {}) {
  seedDocs("risks", SEED);
  const r = await renderView(<RisksView />, opts);
  await screen.findByText(/\d+ risks/);
  return r;
}

describe("ROAM board", () => {
  it("shows the five ROAM columns with hints and counts", async () => {
    await renderRisks();
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual([
      "Unroamed risks",
      "Resolved risks",
      "Owned risks",
      "Accepted risks",
      "Mitigated risks",
    ]);
    expect(within(column("Owned")).getByText("Someone owns follow-up")).toBeInTheDocument();
    expect(within(column("Unroamed")).getByText("1", { selector: ".count" })).toBeInTheDocument();
    expect(screen.getByText("2 risks")).toBeInTheDocument();
  });

  it("scopes risks to the node's subtree and the selected PI, with an All PIs toggle", async () => {
    await renderRisks();
    expect(within(column("Unroamed")).getByText("Vendor API delay")).toBeInTheDocument();
    expect(within(column("Owned")).getByText("Test env shortage")).toBeInTheDocument();
    expect(screen.queryByText("Old risk")).not.toBeInTheDocument();
    expect(screen.queryByText("ART B risk")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("All PIs"));
    expect(within(column("Resolved")).getByText("Old risk")).toBeInTheDocument();
    expect(screen.getByText("3 risks")).toBeInTheDocument();
  });

  it("renders card details and opens the linked work item without opening the editor", async () => {
    await renderRisks();
    const c = card("Vendor API delay");
    expect(c).toHaveClass("impact-high");
    expect(within(c).getByText("Priority: High")).toBeInTheDocument();
    expect(within(c).getByText("Team Red")).toBeInTheDocument();
    expect(within(c).getByText("· Sam")).toBeInTheDocument();
    fireEvent.click(within(c).getByRole("button", { name: "#10" }));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(10));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(card("Test env shortage")).queryByRole("button")).toBeNull();
  });

  it("moves risks between ROAM columns by drag and drop", async () => {
    await renderRisks();
    const dt = dataTransfer();
    fireEvent.dragStart(card("Vendor API delay"), { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith("text/plain", "r1");
    fireEvent.dragOver(column("Mitigated"));
    expect(column("Mitigated")).toHaveClass("drop-over");
    fireEvent.drop(column("Mitigated"), { dataTransfer: dataTransfer("r1") });
    await waitFor(() => expect(within(column("Mitigated")).getByText("Vendor API delay")).toBeInTheDocument());
    expect(docs("risks").find((r) => r.id === "r1").status).toBe("Mitigated");
    expect(column("Mitigated")).not.toHaveClass("drop-over");
  });

  it("ignores drops onto the same column or with unknown ids", async () => {
    await renderRisks();
    fireEvent.dragOver(column("Owned"));
    fireEvent.dragLeave(column("Owned"));
    expect(column("Owned")).not.toHaveClass("drop-over");
    fireEvent.drop(column("Owned"), { dataTransfer: dataTransfer("r2") });
    fireEvent.drop(column("Owned"), { dataTransfer: dataTransfer("nope") });
    await new Promise((r) => setTimeout(r, 20));
    expect(docs("risks").find((r) => r.id === "r2").__etag).toBe(1);
  });

  it("creates a risk through the dialog", async () => {
    await renderRisks();
    fireEvent.click(screen.getByRole("button", { name: "New risk" }));
    const dialog = screen.getByRole("dialog", { name: "New risk" });
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();

    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Key engineer leaving" } });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "Knowledge silo" } });
    fireEvent.change(within(dialog).getByLabelText("ROAM status"), { target: { value: "Owned" } });
    fireEvent.change(within(dialog).getByLabelText("Priority"), { target: { value: "Low" } });
    expect(within(dialog).getByTestId("exposure")).toHaveTextContent("Exposure: Intermediate");
    fireEvent.change(within(dialog).getByLabelText("Probability"), { target: { value: "Almost Certain" } });
    expect(within(dialog).getByTestId("exposure")).toHaveTextContent("Exposure: Intermediate");
    fireEvent.change(within(dialog).getByLabelText("Impact"), { target: { value: "Catastrophic" } });
    expect(within(dialog).getByTestId("exposure")).toHaveTextContent("Exposure: Extreme");
    fireEvent.change(within(dialog).getByLabelText("Residual probability"), { target: { value: "Very Unlikely" } });
    fireEvent.change(within(dialog).getByLabelText("Residual impact"), { target: { value: "Insignificant" } });
    expect(within(dialog).getByTestId("residual-exposure")).toHaveTextContent("Residual: Low");
    const owner = within(dialog).getByLabelText("Raised by / belongs to") as HTMLSelectElement;
    expect(Array.from(owner.options).map((o) => o.textContent)).toEqual([
      "ART A (Agile Release Train)",
      "Team Red (Team)",
      "Team Blue (Team)",
    ]);
    fireEvent.change(owner, { target: { value: "n-blue" } });
    fireEvent.change(within(dialog).getByLabelText("Owner"), { target: { value: "Priya" } });
    fireEvent.change(within(dialog).getByLabelText("Linked work item IDs (optional)"), { target: { value: "14" } });
    fireEvent.click(save);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(column("Owned")).getByText("Key engineer leaving")).toBeInTheDocument();
    expect(docs("risks").find((r) => r.title === "Key engineer leaving")).toMatchObject({
      nodeId: "n-blue",
      piPath: PI2,
      description: "Knowledge silo",
      status: "Owned",
      impact: "Low",
      owner: "Priya",
      workItemId: 14,
      probability: "Almost Certain",
      impactLevel: "Catastrophic",
      residualProbability: "Very Unlikely",
      residualImpact: "Insignificant",
    });
    const created = card("Key engineer leaving");
    expect(within(created).getByTitle("Exposure: EXTREME")).toHaveStyle({ background: "#8b0000" });
    expect(within(created).getByTitle("Residual exposure: LOW")).toHaveTextContent("Residual: Low");
  });

  it("shows exposure chips on cards, defaulting to INTERMEDIATE when unassessed", async () => {
    await renderRisks();
    const c = card("Test env shortage");
    expect(within(c).getByTitle("Exposure: INTERMEDIATE")).toBeInTheDocument();
    expect(within(c).getByTitle("Residual exposure: INTERMEDIATE")).toBeInTheDocument();
    expect(within(c).getByTitle("Priority")).toHaveTextContent("Medium");
  });

  it("loads existing assessment values into the dialog", async () => {
    seedDocs("risks", [risk("r9", "n-red", "Assessed", "Owned", "Low", PI2, { probability: "Likely", impactLevel: "Minor", residualProbability: "Unlikely", residualImpact: "Major" })]);
    await renderView(<RisksView />);
    fireEvent.click(await screen.findByText("Assessed"));
    const dialog = screen.getByRole("dialog", { name: "Edit risk" });
    expect(within(dialog).getByLabelText("Probability")).toHaveValue("Likely");
    expect(within(dialog).getByLabelText("Impact")).toHaveValue("Minor");
    expect(within(dialog).getByTestId("exposure")).toHaveTextContent("Exposure: Medium");
    expect(within(dialog).getByTestId("residual-exposure")).toHaveTextContent("Residual: High");
  });

  it("sorts risks within columns by exposure when asked", async () => {
    seedDocs("risks", [
      risk("a", "n-red", "Alpha", "Owned", "Low"),
      risk("b", "n-red", "Bravo", "Owned", "Low", PI2, { probability: "Very Unlikely", impactLevel: "Insignificant" }),
      risk("c", "n-red", "Charlie", "Owned", "Low", PI2, { probability: "Almost Certain", impactLevel: "Catastrophic" }),
      risk("d", "n-red", "Delta", "Owned", "Low", PI2, { probability: "Likely", impactLevel: "Major", residualProbability: "Likely", residualImpact: "Major" }),
      risk("e", "n-red", "Echo", "Owned", "Low", PI2, { probability: "Likely", impactLevel: "Major" }),
      risk("f", "n-red", "Foxtrot", "Owned", "Low", PI2, { probability: "Likely", impactLevel: "Major" }),
    ]);
    await renderView(<RisksView />);
    await screen.findByText("Alpha");
    const titles = () => Array.from(column("Owned").querySelectorAll(".card-title")).map((t) => t.textContent);
    expect(titles()).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]);
    fireEvent.click(screen.getByLabelText("Sort by exposure"));
    expect(titles()).toEqual(["Charlie", "Delta", "Echo", "Foxtrot", "Alpha", "Bravo"]);
  });

  it("edits an existing risk and clears the linked work item", async () => {
    await renderRisks();
    fireEvent.click(card("Vendor API delay"));
    const dialog = screen.getByRole("dialog", { name: "Edit risk" });
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Vendor API delay");
    fireEvent.change(within(dialog).getByLabelText("Linked work item IDs (optional)"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(docs("risks").find((r) => r.id === "r1").workItemId).toBeUndefined();
  });

  it("cancels editing without saving", async () => {
    await renderRisks();
    fireEvent.click(card("Test env shortage"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(docs("risks").find((r) => r.id === "r2").title).toBe("Test env shortage");
  });

  it("deletes a risk after confirmation", async () => {
    await renderRisks();
    fireEvent.click(card("Test env shortage"));
    (window.confirm as any).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(docs("risks").some((r) => r.id === "r2")).toBe(false);
    expect(screen.queryByText("Test env shortage")).not.toBeInTheDocument();
  });

  it("reports save and delete errors", async () => {
    await renderRisks();
    dataStore.failures.push({ op: "setDocument", error: new Error("offline") });
    fireEvent.drop(column("Accepted"), { dataTransfer: dataTransfer("r1") });
    expect(await screen.findByText("Could not save risk: offline")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dismiss"));

    fireEvent.click(card("Test env shortage"));
    dataStore.failures.push({ op: "deleteDocument", error: new Error("locked") });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Could not delete risk: locked")).toBeInTheDocument();
  });

  it("disables New risk without a PI and shows load errors", async () => {
    await renderView(<RisksView />, { pi: null });
    expect(await screen.findByRole("button", { name: "New risk" })).toBeDisabled();
  });

  it("shows load errors", async () => {
    dataStore.failures.push({ op: "getDocuments", error: Object.assign(new Error("denied"), { status: 403 }) });
    await renderView(<RisksView />);
    expect(await screen.findByText("denied")).toBeInTheDocument();
  });
});
