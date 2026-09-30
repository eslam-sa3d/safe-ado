import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { flatten } from "../../src/api/org";
import { WorkItem } from "../../src/api/types";
import { hierarchyHints, HierarchyView, idsQuery, owningUnit } from "../../src/views/HierarchyView";
import { BLUE, fake, makeConfig, P, RED } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { renderView } from "../utils";

const config = makeConfig();
const units = flatten(config.root);
const wi = (id: number, type: string, area: string): WorkItem => ({ id, fields: { "System.WorkItemType": type, "System.AreaPath": area } });
const row = (title: string) => screen.getByRole("button", { name: title }).closest("tr") as HTMLElement;

/** Adds a parent/child link on both ends, as Azure DevOps does. */
function link(parent: number, child: number) {
  const url = (id: number) => `${fake.baseUrl}/_apis/wit/workItems/${id}`;
  (fake.workItems.get(parent)!.relations ??= []).push({ rel: "System.LinkTypes.Hierarchy-Forward", url: url(child), attributes: {} });
  (fake.workItems.get(child)!.relations ??= []).push({ rel: "System.LinkTypes.Hierarchy-Reverse", url: url(parent), attributes: {} });
}

describe("hierarchy hints (H2)", () => {
  it("finds the owning unit by the longest area path", () => {
    expect(owningUnit(units, RED)?.id).toBe("n-red");
    expect(owningUnit(units, "Fabrikam\\ART A\\Team Red\\Sub")?.id).toBe("n-red");
    expect(owningUnit(units, P)?.id).toBe("n-root");
    expect(owningUnit(units, "Other")).toBeUndefined();
    expect(owningUnit(units, undefined)).toBeUndefined();
  });

  it("flags skipped levels and children outside the parent's unit", () => {
    expect(hierarchyHints(config, units, wi(1, "Epic", P), wi(2, "Feature", RED))).toEqual([]);
    expect(hierarchyHints(config, units, wi(1, "Epic", P), wi(2, "User Story", RED))).toEqual([
      "User Story is linked directly under a Epic; expected a Feature in between.",
    ]);
    expect(hierarchyHints(config, units, wi(1, "Feature", RED), wi(2, "User Story", BLUE))).toEqual([
      `Area ${BLUE} is outside Team Red, the unit of its parent #1.`,
    ]);
    // Unknown types / areas give no hints.
    expect(hierarchyHints(config, units, wi(1, "Bug", "Elsewhere"), wi(2, "User Story", BLUE))).toEqual([]);
    expect(hierarchyHints(config, units, wi(1, "Feature", RED), { id: 2, fields: { "System.WorkItemType": "User Story" } })).toEqual([]);
    // With a Capability level, Epic -> Feature skips a level.
    const withCap = makeConfig({ types: { epic: "Epic", capability: "Capability", feature: "Feature", story: "User Story" } });
    expect(hierarchyHints(withCap, units, wi(1, "Epic", P), wi(2, "Feature", P))[0]).toMatch(/expected a Capability/);
  });

  it("builds an id query", () => {
    expect(idsQuery([1, 2])).toMatch(/WHERE \[System\.Id\] IN \(1, 2\)$/);
  });
});

describe("Hierarchy view hints and actions", () => {
  beforeEach(() => sdk.hostNavigation.openNewWindow.mockClear());

  it("marks misplaced children with a warning", async () => {
    link(3, 101); // story directly under an Epic
    link(10, 102); // Team Blue story under a Team Red feature
    await renderView(<HierarchyView />, { nodeId: "n-root" });
    await screen.findByRole("button", { name: "Unsized idea" });
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    const story = within(row("Unsized idea")).queryByRole("img");
    expect(story).toBeNull();
    const refunds = screen.getAllByRole("button", { name: "Refund card" }).map((b) => b.closest("tr")!);
    const hints = refunds.map((r) => within(r).queryByRole("img")?.getAttribute("aria-label"));
    expect(hints).toContain("Hierarchy hint: User Story is linked directly under a Epic; expected a Feature in between.");
    const wallet = screen.getAllByRole("button", { name: "Add wallet" }).map((b) => b.closest("tr")!);
    expect(wallet.map((r) => within(r).queryByRole("img")?.getAttribute("title"))).toContain(`Area ${BLUE} is outside Team Red, the unit of its parent #10.`);
    expect(within(row("Charge card")).queryByRole("img")).toBeNull();
  });

  it("opens an item's children as an Azure Boards query", async () => {
    await renderView(<HierarchyView />);
    await screen.findByRole("button", { name: "Payment API" });
    expect(within(row("Fraud rules")).queryByRole("button", { name: /Open children/ })).toBeNull();
    fireEvent.click(within(row("Payment API")).getByRole("button", { name: "Open children of #10 in query" }));
    await waitFor(() => expect(sdk.hostNavigation.openNewWindow).toHaveBeenCalledTimes(1));
    const url = new URL(sdk.hostNavigation.openNewWindow.mock.calls[0][0]);
    expect(url.pathname).toBe("/org/Fabrikam/_queries/query/");
    expect(url.searchParams.get("wiql")).toMatch(/\[System\.Id\] IN \(100, 101\)$/);
  });

  it("ignores failures to open the query", async () => {
    sdk.hostNavigation.openNewWindow.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    await renderView(<HierarchyView />);
    await screen.findByRole("button", { name: "Payment API" });
    fireEvent.click(within(row("Payment API")).getByRole("button", { name: "Open children of #10 in query" }));
    await waitFor(() => expect(sdk.hostNavigation.openNewWindow).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
