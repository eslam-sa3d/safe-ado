import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Risk } from "../../src/api/types";
import { parseIds, riskWorkItemIds, RisksView } from "../../src/views/RisksView";
import { docs, PI2, seedDocs } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { dataTransfer, renderView } from "../utils";

const PI2_ID = "iteration-PIs-PI_2";
const risk = (id: string, title: string, extra: Partial<Risk> = {}): Risk => ({
  id, nodeId: "n-red", title, status: "Unroamed", impact: "High", piPath: PI2, description: "", owner: "", createdAt: "2026-09-01T00:00:00Z", ...extra,
});
const card = (title: string) => screen.getByText(title).closest(".card") as HTMLElement;
const linkField = () => screen.getByLabelText("Linked work item IDs (optional)") as HTMLInputElement;

describe("risks linked to several work items", () => {
  it("merges the list with the legacy single id and parses comma-separated input", () => {
    expect(riskWorkItemIds(risk("a", "A"))).toEqual([]);
    expect(riskWorkItemIds(risk("a", "A", { workItemId: 10 }))).toEqual([10]);
    expect(riskWorkItemIds(risk("a", "A", { workItemIds: [11, 10], workItemId: 10 }))).toEqual([11, 10]);
    expect(parseIds("10, 14 abc -3 1.5,,11;14")).toEqual([10, 14, 11]);
    expect(parseIds("")).toEqual([]);
  });

  it("shows every linked item on the card and opens each one", async () => {
    seedDocs("risks", [risk("r1", "Vendor delay", { workItemIds: [10, 14], workItemId: 12 })]);
    await renderView(<RisksView />);
    await screen.findByText("Vendor delay");
    const c = card("Vendor delay");
    expect(within(c).getAllByRole("button").map((b) => b.textContent)).toEqual(["#10", "#14", "#12"]);
    fireEvent.click(within(c).getByRole("button", { name: "#14" }));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(14));
    // Opening a link does not open the editor.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("edits links as a comma-separated list, keeping the legacy id as the first link", async () => {
    seedDocs("risks", [risk("r1", "Vendor delay", { workItemId: 10 })]);
    await renderView(<RisksView />);
    fireEvent.click(await screen.findByText("Vendor delay"));
    expect(linkField()).toHaveValue("10");
    fireEvent.change(linkField(), { target: { value: "14, 10 11" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(docs("risks")[0]).toMatchObject({ workItemIds: [14, 10, 11], workItemId: 14, piId: PI2_ID }));
    expect(within(card("Vendor delay")).getAllByRole("button").map((b) => b.textContent)).toEqual(["#14", "#10", "#11"]);

    fireEvent.click(screen.getByText("Vendor delay"));
    fireEvent.change(linkField(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(docs("risks")[0].workItemIds).toBeUndefined());
    expect(docs("risks")[0].workItemId).toBeUndefined();
  });

  it("saves the PI id with new risks and finds risks by it after a PI rename", async () => {
    seedDocs("risks", [risk("old", "Renamed PI risk", { piPath: "Fabrikam\\PIs\\Old", piId: PI2_ID })]);
    await renderView(<RisksView />);
    expect(await screen.findByText("Renamed PI risk")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New risk" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Fresh" } });
    fireEvent.change(linkField(), { target: { value: "100,101" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(docs("risks").find((r) => r.title === "Fresh")).toMatchObject({ piId: PI2_ID, piPath: PI2, workItemIds: [100, 101] }));
  });

  it("adds the PI id when an older risk of the current PI is moved", async () => {
    seedDocs("risks", [risk("r1", "Legacy risk")]);
    await renderView(<RisksView />);
    await screen.findByText("Legacy risk");
    fireEvent.drop(screen.getByRole("group", { name: "Owned risks" }), { dataTransfer: dataTransfer("r1") });
    await waitFor(() => expect(docs("risks")[0]).toMatchObject({ status: "Owned", piId: PI2_ID }));
  });

  it("does not stamp another PI's id on risks shown with All PIs", async () => {
    seedDocs("risks", [risk("r1", "Other PI risk", { piPath: "Fabrikam\\PIs\\PI 1" })]);
    await renderView(<RisksView />);
    await screen.findByText("0 risks");
    fireEvent.click(screen.getByLabelText("All PIs"));
    fireEvent.drop(screen.getByRole("group", { name: "Owned risks" }), { dataTransfer: dataTransfer("r1") });
    await waitFor(() => expect(docs("risks")[0].status).toBe("Owned"));
    expect(docs("risks")[0].piId).toBeUndefined();
  });
});
