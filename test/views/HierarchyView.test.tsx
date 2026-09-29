import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HierarchyView } from "../../src/views/HierarchyView";
import { callsTo, fail, PI2 } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { renderView } from "../utils";

const rowTitles = () =>
  Array.from(document.querySelectorAll("tbody tr .title-link")).map((b) => b.textContent);
const row = (title: string) => screen.getByRole("button", { name: title }).closest("tr") as HTMLElement;

async function renderTree(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<HierarchyView />, opts);
  await waitFor(() => expect(screen.queryByText("Loading hierarchy…")).not.toBeInTheDocument());
  return r;
}

describe("Work Item Hierarchy", () => {
  it("lists Features of the ART in the current PI with roll-up progress", async () => {
    await renderView(<HierarchyView />);
    expect(screen.getByText("Loading hierarchy…")).toBeInTheDocument();
    await screen.findByRole("button", { name: "Payment API" });
    expect(rowTitles()).toEqual(["Payment API", "Checkout UI", "Fraud rules", "Wallet"]);
    const payment = row("Payment API");
    expect(within(payment).getByText("#10")).toBeInTheDocument();
    expect(within(payment).getByText("Active")).toBeInTheDocument();
    expect(within(payment).getByText("PI 2 Sprint 1")).toBeInTheDocument();
    expect(within(payment).getByText("Grace Hopper")).toBeInTheDocument();
    expect(within(payment).getByText("5/8 pts")).toBeInTheDocument();
    // No points: falls back to item counts
    expect(within(row("Checkout UI")).getByText("1/1 items")).toBeInTheDocument();
    // Leaf features show no progress bar
    expect(row("Fraud rules").querySelector(".progress")).toBeNull();
    expect(callsTo(/wiql/)[0].body.query).toContain(`[Source].[System.IterationPath] UNDER '${PI2}'`);
  });

  it("expands and collapses rows individually and all at once", async () => {
    await renderTree();
    fireEvent.click(within(row("Payment API")).getByLabelText("Expand"));
    expect(rowTitles()).toEqual(["Payment API", "Charge card", "Refund card", "Checkout UI", "Fraud rules", "Wallet"]);
    expect(within(row("Charge card")).getByText("Closed")).toBeInTheDocument();
    fireEvent.click(within(row("Payment API")).getByLabelText("Collapse"));
    expect(rowTitles()).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(rowTitles()).toEqual(["Payment API", "Charge card", "Refund card", "Checkout UI", "Cart page", "Fraud rules", "Wallet", "Add wallet"]);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(rowTitles()).toHaveLength(4);
  });

  it("filters by title (keeping ancestors of matches) or exact id", async () => {
    await renderTree();
    const search = screen.getByPlaceholderText("Filter by title or ID");
    fireEvent.change(search, { target: { value: "wallet" } });
    expect(rowTitles()).toEqual(["Wallet"]);
    fireEvent.change(search, { target: { value: "refund" } });
    expect(rowTitles()).toEqual(["Payment API"]);
    fireEvent.change(search, { target: { value: "11" } });
    expect(rowTitles()).toEqual(["Checkout UI"]);
    fireEvent.change(search, { target: { value: "   " } });
    expect(rowTitles()).toHaveLength(4);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByRole("heading", { name: "No Features found" })).toBeInTheDocument();
  });

  it("can include every PI", async () => {
    await renderTree();
    fireEvent.click(screen.getByLabelText("PI 2 only"));
    await screen.findByRole("button", { name: "Old feature" });
    expect(callsTo(/wiql/).at(-1)!.body.query).not.toContain("IterationPath");
  });

  it("shows Epics at portfolio level without a PI filter", async () => {
    await renderTree({ nodeId: "n-root" });
    expect(rowTitles()).toEqual(["Checkout revamp", "Mobile app", "Unsized idea"]);
    expect(screen.queryByLabelText(/only/)).toBeNull();
    expect(within(row("Checkout revamp")).getByText("5/16 pts")).toBeInTheDocument();
  });

  it("labels the PI toggle generically when no PI is selected", async () => {
    await renderTree({ pi: null });
    expect(screen.getByLabelText("Current PI only")).toBeChecked();
    expect(callsTo(/wiql/)[0].body.query).not.toContain("IterationPath");
  });

  it("opens work items from the tree", async () => {
    await renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Wallet" }));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(14));
  });

  it("refreshes on demand", async () => {
    await renderTree({ nodeId: "n-artb" });
    await screen.findByRole("button", { name: "Reports" });
    const before = callsTo(/wiql/).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(callsTo(/wiql/).length).toBe(before + 1));
  });

  it("explains empty scopes including the PI", async () => {
    const { getProgramIncrements } = await import("../../src/api/wit");
    const pi1 = (await getProgramIncrements("Fabrikam\\PIs"))[0];
    await renderTree({ nodeId: "n-blue", pi: pi1 });
    expect(screen.getByRole("heading", { name: "No Features found" })).toBeInTheDocument();
    expect(screen.getByText("Fabrikam\\ART A\\Team Blue")).toBeInTheDocument();
    expect(screen.getByText("Fabrikam\\PIs\\PI 1")).toBeInTheDocument();
  });

  it("says when no area is configured", async () => {
    const { makeConfig } = await import("../fakeAdo");
    const config = makeConfig();
    config.root.children[1].areaPath = undefined;
    config.root.children[1].children[0].areaPath = undefined;
    await renderTree({ config, nodeId: "n-artb" });
    expect(screen.getByText("(no area configured)")).toBeInTheDocument();
  });

  it("shows load errors", async () => {
    fail(/wiql/, 400, "Bad query");
    await renderTree();
    expect(screen.getByText("Bad query")).toBeInTheDocument();
  });
});
