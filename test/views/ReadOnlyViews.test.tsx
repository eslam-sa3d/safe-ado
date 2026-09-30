import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { SafeContext, useSafe } from "../../src/components/context";
import { HierarchyView } from "../../src/views/HierarchyView";
import { ObjectivesView } from "../../src/views/ObjectivesView";
import { PortfolioKanban } from "../../src/views/PortfolioKanban";
import { RisksView } from "../../src/views/RisksView";
import { callsTo, docs, PI2, seedDocs } from "../fakeAdo";
import { dataTransfer, renderView } from "../utils";

/** Re-provides the harness context without planning rights. */
function ReadOnly({ children }: { children: ReactNode }) {
  const ctx = useSafe();
  return <SafeContext.Provider value={{ ...ctx, can: { admin: false, managePis: false, plan: false } }}>{children}</SafeContext.Provider>;
}

describe("read-only mode (no planning rights)", () => {
  it("PI Objectives: info bar, no add / delete, disabled inputs", async () => {
    seedDocs("objectives", [
      { id: "o1", nodeId: "n-red", title: "Ship payments", committed: true, plannedBV: 8, actualBV: 7, piPath: PI2, featureIds: [] },
    ]);
    await renderView(
      <ReadOnly>
        <ObjectivesView />
      </ReadOnly>
    );
    expect(await screen.findByText(/read-only access: objectives/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New objective" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete objective" })).toBeNull();
    expect(screen.getByDisplayValue("Ship payments")).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Type" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Parent objective" })).toBeDisabled();
  });

  it("Risks: info bar, no New risk, no drag, dialog is view-only", async () => {
    seedDocs("risks", [
      { id: "r1", nodeId: "n-red", title: "Vendor API delay", status: "Unroamed", impact: "High", piPath: PI2, description: "", owner: "", createdAt: "2026-09-01T00:00:00Z" },
    ]);
    await renderView(
      <ReadOnly>
        <RisksView />
      </ReadOnly>
    );
    expect(await screen.findByText(/read-only access: risks/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New risk" })).toBeNull();
    const card = screen.getByText("Vendor API delay").closest(".card") as HTMLElement;
    expect(card).toHaveAttribute("draggable", "false");

    const owned = screen.getByRole("group", { name: "Owned risks" });
    fireEvent.dragOver(owned, { dataTransfer: dataTransfer("r1") });
    expect(owned).not.toHaveClass("drop-over");
    fireEvent.drop(owned, { dataTransfer: dataTransfer("r1") });
    await new Promise((r) => setTimeout(r, 20));
    expect(docs("risks")[0].status).toBe("Unroamed");

    fireEvent.click(card);
    const dialog = screen.getByRole("dialog", { name: "Risk details" });
    expect(within(dialog).getByLabelText("Title")).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(within(dialog.querySelector(".modal-footer") as HTMLElement).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Portfolio Kanban: info bar, no New Epic, no drag", async () => {
    await renderView(
      <ReadOnly>
        <PortfolioKanban />
      </ReadOnly>,
      { nodeId: "n-root" }
    );
    expect(await screen.findByText("3 Epics")).toBeInTheDocument();
    expect(screen.getByText(/read-only access: Epics can be viewed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Epic" })).toBeNull();
    const card = screen.getByText("Mobile app").closest(".card") as HTMLElement;
    expect(card).toHaveAttribute("draggable", "false");
    const active = screen.getByRole("group", { name: "Implementing column" });
    fireEvent.dragOver(active, { dataTransfer: dataTransfer("2") });
    expect(active).not.toHaveClass("drop-over");
    fireEvent.drop(active, { dataTransfer: dataTransfer("2") });
    await new Promise((r) => setTimeout(r, 20));
    expect(callsTo(/workitems\/2/, "PATCH")).toHaveLength(0);
  });

  it("Hierarchy: info bar", async () => {
    await renderView(
      <ReadOnly>
        <HierarchyView />
      </ReadOnly>
    );
    await waitFor(() => expect(screen.getByText(/read-only access to this project's planning data/)).toBeInTheDocument());
  });
});
