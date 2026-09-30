import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PiObjective } from "../../src/api/types";
import { ObjectivesView } from "../../src/views/ObjectivesView";
import { docs, makeConfig, PI1, PI2, seedDocs } from "../fakeAdo";
import { renderView } from "../utils";

const PI2_ID = "iteration-PIs-PI_2";
const obj = (id: string, nodeId: string, title: string, extra: Partial<PiObjective> = {}): PiObjective => ({
  id, nodeId, title, committed: true, plannedBV: 5, actualBV: null, piPath: PI2, featureIds: [], ...extra,
});
const panel = (name: string) => screen.getByRole("heading", { name }).closest(".panel") as HTMLElement;
const rowOf = (title: string) => {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input.cell-input")).filter((i) => i.value === title);
  expect(inputs).toHaveLength(1);
  return inputs[0].closest("tr") as HTMLElement;
};
const parentSelect = (title: string) => within(rowOf(title)).getByRole("combobox", { name: "Parent objective" }) as HTMLSelectElement;

describe("PI objective hierarchy", () => {
  it("links a team objective to an objective of its ART and counts children on the ART row", async () => {
    seedDocs("objectives", [
      obj("art1", "n-arta", "PCI compliance"),
      obj("art2", "n-arta", "Faster checkout"),
      obj("t1", "n-red", "Ship payments"),
      obj("t2", "n-blue", "Checkout UI live", { parentId: "art2" }),
      obj("other", "n-artb", "ART B goal"),
    ]);
    await renderView(<ObjectivesView />);
    await screen.findByRole("heading", { name: "Team Red" });

    const select = parentSelect("Ship payments");
    expect(select).toBeEnabled();
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["— None —", "PCI compliance", "Faster checkout"]);
    expect(select.value).toBe("");
    expect(parentSelect("Checkout UI live").value).toBe("art2");

    // ART objectives show how many team objectives roll up to them.
    expect(within(rowOf("PCI compliance")).getByText("0 child objectives")).toBeInTheDocument();
    expect(within(rowOf("Faster checkout")).getByText("1 child objective")).toBeInTheDocument();
    // Team objectives have no child count.
    expect(rowOf("Ship payments").querySelector(".child-count")).toBeNull();

    fireEvent.change(select, { target: { value: "art1" } });
    await waitFor(() => expect(docs("objectives").find((d) => d.id === "t1")).toMatchObject({ parentId: "art1", piId: PI2_ID, piPath: PI2 }));
    expect(within(rowOf("PCI compliance")).getByText("1 child objective")).toBeInTheDocument();

    fireEvent.change(parentSelect("Ship payments"), { target: { value: "" } });
    await waitFor(() => expect(docs("objectives").find((d) => d.id === "t1").parentId).toBeUndefined());
  });

  it("disables the parent select when the parent unit has no objectives and shows — for the top unit", async () => {
    seedDocs("objectives", [obj("art1", "n-arta", "PCI compliance"), obj("root1", "n-root", "Portfolio goal")]);
    const config = makeConfig();
    await renderView(<ObjectivesView />, { config, nodeId: "n-root" });
    await screen.findByRole("heading", { name: "Fabrikam" });
    // The portfolio is the top unit: no parent objective to pick.
    expect(within(rowOf("Portfolio goal")).queryByRole("combobox", { name: "Parent objective" })).toBeNull();
    expect(within(rowOf("Portfolio goal")).getByText("—")).toBeInTheDocument();
    // ART A's parent (the portfolio) has an objective to pick.
    expect(parentSelect("PCI compliance")).toBeEnabled();
  });

  it("keeps a parent from another PI visible and disables empty choices", async () => {
    seedDocs("objectives", [
      obj("old", "n-arta", "Last PI ART goal", { piPath: PI1 }),
      obj("t1", "n-red", "Ship payments", { parentId: "old" }),
      obj("t2", "n-blue", "Checkout UI live"),
    ]);
    await renderView(<ObjectivesView />, { nodeId: "n-arta" });
    await screen.findByRole("heading", { name: "Team Red" });
    const select = parentSelect("Ship payments");
    expect(select.value).toBe("old");
    expect(select).toBeEnabled();
    expect(within(select).getByRole("option", { name: "(objective not in this PI)" })).toBeInTheDocument();
    expect(parentSelect("Checkout UI live")).toBeDisabled();
  });

  it("counts child objectives on Solution and ART rows (plural) in a solution view", async () => {
    const config = makeConfig();
    config.root.children = [{ id: "n-sol", name: "Big Solution", level: "solution", areaPath: "Fabrikam", children: config.root.children }];
    seedDocs("objectives", [
      obj("s1", "n-sol", "Solution goal"),
      obj("a1", "n-arta", "ART A goal", { parentId: "s1" }),
      obj("b1", "n-artb", "ART B goal", { parentId: "s1" }),
    ]);
    await renderView(<ObjectivesView />, { config, nodeId: "n-sol" });
    await screen.findByRole("heading", { name: "Big Solution" });
    expect(within(rowOf("Solution goal")).getByText("2 child objectives")).toBeInTheDocument();
    expect(within(panel("ART A")).getByText("0 child objectives")).toBeInTheDocument();
    expect(parentSelect("ART A goal").value).toBe("s1");
  });

  it("finds objectives by the PI's stable id after a rename and saves the id with new objectives", async () => {
    seedDocs("objectives", [obj("renamed", "n-red", "Kept after rename", { piPath: "Fabrikam\\PIs\\Old name", piId: PI2_ID })]);
    await renderView(<ObjectivesView />, { nodeId: "n-red" });
    expect(await screen.findByDisplayValue("Kept after rename")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New objective" }));
    await screen.findByDisplayValue("New objective");
    expect(docs("objectives").find((d) => d.title === "New objective")).toMatchObject({ piId: PI2_ID, piPath: PI2 });
  });
});
