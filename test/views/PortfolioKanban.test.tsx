import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PortfolioKanban } from "../../src/views/PortfolioKanban";
import { callsTo, fail, fake, makeConfig } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { dataTransfer, renderView } from "../utils";

const column = (state: string) => screen.getByRole("group", { name: `${state} column` });
const card = (title: string) => screen.getByText(title).closest(".card") as HTMLElement;
const titlesIn = (state: string) => Array.from(column(state).querySelectorAll(".card-title")).map((t) => t.textContent);

async function renderKanban(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<PortfolioKanban />, { nodeId: "n-root", ...opts });
  await screen.findByText(/\d+ Epics/);
  return r;
}

describe("Portfolio Kanban", () => {
  it("shows a spinner, then one column per non-removed Epic state", async () => {
    await renderView(<PortfolioKanban />, { nodeId: "n-root" });
    expect(screen.getByText("Loading portfolio…")).toBeInTheDocument();
    await screen.findByText("3 Epics");
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual([
      "New column",
      "Active column",
      "Resolved column",
      "Closed column",
    ]);
    expect(titlesIn("New")).toEqual(["Mobile app", "Unsized idea"]);
    expect(titlesIn("Active")).toEqual(["Checkout revamp"]);
    expect(screen.queryByText("Dropped")).not.toBeInTheDocument();
    expect(column("Active").querySelector(".kanban-header")).toHaveStyle({ borderTopColor: "#007acc" });
  });

  it("shows WSJF and assignee on cards", async () => {
    await renderKanban();
    expect(within(card("Checkout revamp")).getByText("WSJF 1")).toBeInTheDocument();
    expect(within(card("Checkout revamp")).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(card("Mobile app")).getByText("WSJF 0.3")).toBeInTheDocument();
    expect(within(card("Unsized idea")).queryByText(/WSJF/)).toBeNull();
  });

  it("includes RR/OE in cost of delay when the custom field exists, and sorts by WSJF", async () => {
    fake.fields.push({ name: "RR/OE", referenceName: "Custom.RROEValue", type: "integer" });
    Object.assign(fake.workItems.get(3)!.fields, { "Custom.RROEValue": 10, "Microsoft.VSTS.Scheduling.Effort": 5 });
    await renderKanban();
    expect(within(card("Unsized idea")).getByText("WSJF 2")).toBeInTheDocument();
    expect(titlesIn("New")).toEqual(["Mobile app", "Unsized idea"]);
    fireEvent.click(screen.getByLabelText("Sort by WSJF"));
    expect(titlesIn("New")).toEqual(["Unsized idea", "Mobile app"]);
  });

  it("treats a zero cost of delay as unscored", async () => {
    Object.assign(fake.workItems.get(2)!.fields, { "Microsoft.VSTS.Common.BusinessValue": 0, "Microsoft.VSTS.Common.TimeCriticality": 0 });
    await renderKanban();
    expect(within(card("Mobile app")).queryByText(/WSJF/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Sort by WSJF"));
    expect(titlesIn("New")).toEqual(["Mobile app", "Unsized idea"]);
  });

  it("only requests WSJF fields that exist in the process", async () => {
    fake.fields = fake.fields.filter((f) => !/BusinessValue|TimeCriticality|Effort/.test(f.referenceName));
    await renderKanban();
    const fields = callsTo(/workitemsbatch/)[0].body.fields;
    expect(fields).not.toContain("Microsoft.VSTS.Common.BusinessValue");
    expect(fields).not.toContain("Custom.RROEValue");
    expect(screen.queryByText(/WSJF \d/)).not.toBeInTheDocument();
  });

  it("changes state by drag and drop", async () => {
    await renderKanban();
    const dt = dataTransfer();
    fireEvent.dragStart(card("Mobile app"), { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith("text/plain", "2");
    fireEvent.dragOver(column("Active"));
    expect(column("Active")).toHaveClass("drop-over");
    fireEvent.drop(column("Active"), { dataTransfer: dataTransfer("2") });
    expect(titlesIn("Active")).toContain("Mobile app");
    await waitFor(() => expect(callsTo(/workitems\/2$/, "PATCH")).toHaveLength(1));
    expect(callsTo(/workitems\/2$/, "PATCH")[0].body).toEqual([{ op: "add", path: "/fields/System.State", value: "Active" }]);
    expect(fake.workItems.get(2)!.fields["System.State"]).toBe("Active");
  });

  it("ignores drops onto the same state or with unknown ids", async () => {
    await renderKanban();
    fireEvent.dragOver(column("New"));
    fireEvent.dragLeave(column("New"));
    expect(column("New")).not.toHaveClass("drop-over");
    fireEvent.drop(column("New"), { dataTransfer: dataTransfer("2") });
    fireEvent.drop(column("New"), { dataTransfer: dataTransfer("999") });
    await new Promise((r) => setTimeout(r, 20));
    expect(callsTo(/workitems/, "PATCH")).toHaveLength(0);
  });

  it("reports failed moves", async () => {
    fail(/workitems\/2$/, 400, "Transition not allowed", { method: "PATCH" });
    await renderKanban();
    fireEvent.drop(column("Closed"), { dataTransfer: dataTransfer("2") });
    expect(await screen.findByText("Could not move #2: Transition not allowed")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText(/Could not move/)).not.toBeInTheDocument();
  });

  it("opens epics, creates new ones in the portfolio area, and refreshes", async () => {
    await renderKanban();
    fireEvent.click(card("Checkout revamp"));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(1));

    fireEvent.click(screen.getByRole("button", { name: "+ New Epic" }));
    await waitFor(() => expect(sdk.workItemForm.openNewWorkItem).toHaveBeenCalledWith("Epic", { "System.AreaPath": "Fabrikam" }));

    const before = callsTo(/wiql/).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(callsTo(/wiql/).length).toBe(before + 1));
  });

  it("explains when no Epic type is mapped", async () => {
    const config = makeConfig();
    config.types.epic = "";
    await renderView(<PortfolioKanban />, { nodeId: "n-root", config });
    expect(await screen.findByRole("heading", { name: "No Epic type mapped" })).toBeInTheDocument();
  });

  it("shows load errors", async () => {
    fail(/wiql/, 500, "Query failed");
    await renderView(<PortfolioKanban />, { nodeId: "n-root" });
    expect(await screen.findByText("Query failed")).toBeInTheDocument();
    expect(screen.getByText("0 Epics")).toBeInTheDocument();
  });
});
