import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_ALLOWED } from "../../src/api/permissions";
import { SafeContext } from "../../src/components/context";
import { FormPanel, WORK_ITEM_FORM_SERVICE } from "../../src/form/FormPanel";
import { dataManager, dataStore, fake, makeConfig, P, RED, seedConfig } from "../fakeAdo";
import * as sdk from "../sdkMock";

const values: Record<string, unknown> = {};
const form = {
  getId: vi.fn(async () => 1),
  getFieldValues: vi.fn(async (_fields: string[]) => ({ ...values })),
};
const original = sdk.getService.getMockImplementation()!;
const coll = (name: string) => `${name}-${fake.projectId}`;
const seed = (name: string, docs: any[]) => dataStore.collections.set(coll(name), new Map(docs.map((d) => [d.id, { ...d, __etag: 1 }])));
const lean = () => screen.getByRole("group", { name: "Lean business case" });

beforeEach(() => {
  Object.keys(values).forEach((k) => delete values[k]);
  Object.assign(values, { "System.Title": "Checkout revamp", "System.AreaPath": P, "System.IterationPath": P, "System.WorkItemType": "Epic" });
  form.getId.mockReset();
  form.getId.mockImplementation(async () => 1);
  sdk.getService.mockImplementation((async (id: string) => (id === WORK_ITEM_FORM_SERVICE ? form : original(id))) as any);
  seedConfig();
});

afterEach(() => {
  sdk.getService.mockImplementation(original);
});

async function renderPanel(ui = <FormPanel />) {
  const r = render(ui);
  await waitFor(() => expect(screen.queryByText("Loading SAFe details…")).not.toBeInTheDocument());
  return r;
}

describe("work item form: Lean Business Case of an Epic", () => {
  it("summarises a missing business case and edits it in place", async () => {
    await renderPanel();
    expect(within(lean()).getByText("Pending")).toHaveClass("decision-pending");
    expect(lean()).toHaveTextContent("MVP – · Full –");
    expect(lean()).toHaveTextContent("still needs an Epic hypothesis statement, business outcomes, an MVP definition");

    fireEvent.click(within(lean()).getByRole("button", { name: "Edit business case" }));
    expect(within(lean()).getByText("MVP cost estimate (USD)")).toBeInTheDocument();
    fireEvent.change(within(lean()).getByLabelText("Hypothesis: that"), { target: { value: "cuts checkout time" } });
    fireEvent.change(within(lean()).getByLabelText("Business outcomes"), { target: { value: "+5% conversion" } });
    fireEvent.change(within(lean()).getByLabelText("MVP definition"), { target: { value: "Saved cards" } });
    fireEvent.change(within(lean()).getByLabelText("Epic Owner"), { target: { value: "Grace" } });
    fireEvent.change(within(lean()).getByLabelText("MVP cost estimate (USD)"), { target: { value: "1200" } });
    expect(within(lean()).getByText(/MVP \$1,200 · Full –/)).toBeInTheDocument();
    fireEvent.change(within(lean()).getByLabelText("Go / no-go decision"), { target: { value: "Go" } });
    fireEvent.click(within(lean()).getByRole("button", { name: "Save business case" }));
    await waitFor(() => expect(within(lean()).queryByRole("button", { name: "Save business case" })).toBeNull());
    expect(dataStore.collections.get(coll("leancases"))!.get("1")).toMatchObject({ that: "cuts checkout time", decision: "Go", decidedBy: "Ada Lovelace", mvpCost: 1200 });
    expect(within(lean()).getByText("Go")).toHaveClass("decision-go");
    expect(lean()).toHaveTextContent("Epic Owner Grace");
    expect(lean()).toHaveTextContent("MVP $1,200 · Full –");
    expect(lean()).not.toHaveTextContent("still needs");
  });

  it("shows the stored case in the portfolio's currency, and cancels editing", async () => {
    seed("leancases", [{ id: "1", workItemId: 1, decision: "Pivot", mvpCost: 100, fullCost: 900 }]);
    seed("lpmsettings", [{ id: "n-root", nodeId: "n-root", currency: "EUR" }]);
    await renderPanel();
    expect(within(lean()).getByText("Pivot")).toBeInTheDocument();
    expect(lean()).toHaveTextContent(/MVP €100 · Full €900/);
    fireEvent.click(within(lean()).getByRole("button", { name: "Edit business case" }));
    fireEvent.click(within(lean()).getByRole("button", { name: "Cancel" }));
    expect(within(lean()).getByRole("button", { name: "Edit business case" })).toBeInTheDocument();
    expect(dataManager.getDocument).toHaveBeenCalledWith(coll("leancases"), "1", expect.anything());
  });

  it("is view-only without planning rights", async () => {
    await renderPanel(
      <SafeContext.Provider value={{ can: { ...ALL_ALLOWED, plan: false } } as any}>
        <FormPanel />
      </SafeContext.Provider>
    );
    fireEvent.click(within(lean()).getByRole("button", { name: "View business case" }));
    expect(within(lean()).getByLabelText("MVP definition")).toBeDisabled();
    expect(within(lean()).queryByRole("button", { name: "Save business case" })).toBeNull();
  });

  it("is not shown for other types, or for Epics not yet saved", async () => {
    values["System.WorkItemType"] = "Feature";
    values["System.AreaPath"] = RED;
    form.getId.mockImplementation(async () => 10);
    const { unmount } = await renderPanel();
    expect(screen.getByText("SAFe unit")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Lean business case" })).toBeNull();
    expect(dataManager.getDocument).not.toHaveBeenCalledWith(coll("leancases"), expect.anything(), expect.anything());
    unmount();

    values["System.WorkItemType"] = "Epic";
    values["System.AreaPath"] = P;
    form.getId.mockImplementation(async () => 0);
    await renderPanel();
    expect(screen.queryByRole("group", { name: "Lean business case" })).toBeNull();
  });

  it("is not shown when no Epic type is mapped", async () => {
    const config = makeConfig();
    config.types.epic = "";
    seedConfig(config);
    await renderPanel();
    expect(screen.getByText("SAFe unit")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Lean business case" })).toBeNull();
  });
});
