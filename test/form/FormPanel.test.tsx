import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FormPanel,
  notifyFormChange,
  onFormChange,
  registerFormHandlers,
  startForm,
  unitForArea,
  WORK_ITEM_FORM_SERVICE,
  FIELD_CHANGE_DEBOUNCE_MS,
} from "../../src/form/FormPanel";
import { callsTo, ART_A, dataStore, fake, makeConfig, P, PI1, PI2, PI2_S1, RED, seedConfig } from "../fakeAdo";
import * as sdk from "../sdkMock";

const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const META = () => `wimeta-${fake.projectId}`;
const url = (id: number) => `${fake.baseUrl}/_apis/wit/workItems/${id}`;

const values: Record<string, unknown> = {};
const form = {
  getId: vi.fn(async () => 10),
  getFieldValues: vi.fn(async (_fields: string[]) => ({ ...values })),
};

const original = sdk.getService.getMockImplementation()!;

beforeEach(() => {
  Object.keys(values).forEach((k) => delete values[k]);
  Object.assign(values, {
    "System.Title": "Payment API",
    "System.AreaPath": RED,
    "System.IterationPath": PI2_S1,
    "System.WorkItemType": "Feature",
  });
  form.getId.mockReset();
  form.getId.mockImplementation(async () => 10);
  form.getFieldValues.mockClear();
  sdk.getService.mockImplementation((async (id: string) => (id === WORK_ITEM_FORM_SERVICE ? form : original(id))) as any);
  fake.workItems.get(10)!.relations!.push({ rel: PARENT, url: url(1), attributes: {} });
  seedConfig();
});

afterEach(() => {
  sdk.getService.mockImplementation(original);
});

async function renderPanel() {
  const r = render(<FormPanel />);
  expect(screen.getByText("Loading SAFe details…")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText("Loading SAFe details…")).not.toBeInTheDocument());
  return r;
}

const row = (label: string) => screen.getByText(label, { selector: ".field-label" }).parentElement as HTMLElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const metaDoc = (id = "10") => dataStore.collections.get(META())?.get(id);

describe("work item form SAFe panel", () => {
  it("shows the unit, PI, sprint, parent and children of the item", async () => {
    await renderPanel();
    expect(form.getFieldValues).toHaveBeenCalledWith(["System.Title", "System.AreaPath", "System.IterationPath", "System.WorkItemType"]);
    expect(row("SAFe unit")).toHaveTextContent("Fabrikam›ART A›Team RedTeam");
    expect(within(row("SAFe unit")).getByText("Team")).toHaveClass("level-badge");
    expect(row("PI")).toHaveTextContent("PI 2 · PI 2 Sprint 1");
    expect(within(row("Parent")).getByRole("button")).toHaveTextContent("Epic #1: Checkout revamp");
    const children = within(row("Children")).getAllByRole("button").map((b) => b.textContent);
    expect(children).toEqual(["User Story #100: Charge card", "User Story #101: Refund card", "User Story #104: Removed story"]);
    fireEvent.click(within(row("Children")).getByRole("button", { name: /#101/ }));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(101));
    expect(within(row("Children")).getByRole("button", { name: /#101/ })).toHaveAttribute("title", "User Story · Active");
  });

  it("uses the deepest unit and handles items without links or sprint", async () => {
    values["System.AreaPath"] = ART_A;
    values["System.IterationPath"] = PI2;
    form.getId.mockImplementation(async () => 15);
    await renderPanel();
    expect(row("SAFe unit")).toHaveTextContent("Fabrikam›ART AAgile Release Train");
    expect(row("PI")).toHaveTextContent(/^PIPI 2$/);
    expect(row("Parent")).toHaveTextContent("None");
    // #15 has one child story (#103).
    expect(within(row("Children")).getAllByRole("button")).toHaveLength(1);
  });

  it("shows the parent found through the reverse link", async () => {
    values["System.AreaPath"] = ART_A;
    form.getId.mockImplementation(async () => 12);
    await renderPanel();
    expect(row("Parent")).toHaveTextContent("Checkout revamp");
    expect(row("Children")).toHaveTextContent("None");
  });

  it("says when the item is not planned in a PI or its links cannot be read", async () => {
    values["System.IterationPath"] = P;
    fake.workItems.get(10)!.relations!.push({ rel: PARENT, url: "https://elsewhere/no-id", attributes: {} });
    fake.workItems.delete(1);
    await renderPanel();
    expect(row("PI")).toHaveTextContent("Not planned in a PI");
    expect(row("Parent")).toHaveTextContent("None");
    expect(within(row("Children")).getAllByRole("button")).toHaveLength(3);
  });

  it("copes with a work item the REST API does not return", async () => {
    form.getId.mockImplementation(async () => 99999);
    await renderPanel();
    expect(row("Parent")).toHaveTextContent("None");
    expect(screen.getByLabelText("Planned start")).toBeInTheDocument();
  });

  it("explains when the item is outside the SAFe organization", async () => {
    values["System.AreaPath"] = "Other project\\Area";
    await renderPanel();
    expect(screen.getByText("Not part of the SAFe organization")).toBeInTheDocument();
    expect(screen.getByText(/Area path Other project\\Area is not inside/)).toBeInTheDocument();

    values["System.AreaPath"] = undefined;
    await act(async () => notifyFormChange());
    await waitFor(() => expect(screen.getByText(/Area path \(none\)/)).toBeInTheDocument());
  });

  it("explains when SAFe Ado is not configured", async () => {
    dataStore.values.clear();
    await renderPanel();
    expect(screen.getByText("SAFe Ado is not configured for this project.")).toBeInTheDocument();
  });

  it("shows load errors", async () => {
    form.getFieldValues.mockRejectedValueOnce(new Error("form unavailable"));
    render(<FormPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load SAFe details: form unavailable");
    form.getId.mockRejectedValueOnce("gone");
    await act(async () => notifyFormChange());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not load SAFe details: gone"));
  });

  it("refreshes when the form notifies a change and stops listening after unmount", async () => {
    const { unmount } = await renderPanel();
    values["System.IterationPath"] = PI1;
    await act(async () => notifyFormChange());
    await waitFor(() => expect(row("PI")).toHaveTextContent(/^PIPI 1$/));
    const count = form.getFieldValues.mock.calls.length;
    unmount();
    notifyFormChange();
    expect(form.getFieldValues.mock.calls.length).toBe(count);
  });

  it("asks to save new work items before editing SAFe data", async () => {
    form.getId.mockImplementation(async () => 0);
    await renderPanel();
    expect(screen.getByText("Save the work item to edit its SAFe planning data.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Planned start")).not.toBeInTheDocument();
    expect(callsTo(/workitemsbatch/)).toHaveLength(0);
  });

  describe("SAFe planning data", () => {
    it("edits owning team, assigned PIs and planned dates", async () => {
      await renderPanel();
      const owner = screen.getByLabelText("Owning team") as HTMLSelectElement;
      expect(Array.from(owner.options).map((o) => o.text)).toEqual(["–", "Team Red", "Team Blue", "Team Green"]);
      fireEvent.change(owner, { target: { value: "n-blue" } });
      await waitFor(() => expect(metaDoc()).toMatchObject({ workItemId: 10, owningNodeId: "n-blue", __etag: 1 }));

      const pis = screen.getByRole("group", { name: "Assigned PIs" });
      expect(within(pis).getAllByRole("checkbox")).toHaveLength(2);
      await waitFor(() => expect(within(pis).getByLabelText("PI 2")).toBeEnabled());
      fireEvent.click(within(pis).getByLabelText("PI 2"));
      await waitFor(() => expect(metaDoc().assignedPiPaths).toEqual([PI2]));
      await waitFor(() => expect(within(pis).getByLabelText("PI 1")).toBeEnabled());
      fireEvent.click(within(pis).getByLabelText("PI 1"));
      await waitFor(() => expect(metaDoc().assignedPiPaths).toEqual([PI2, PI1]));
      await waitFor(() => expect(within(pis).getByLabelText("PI 2")).toBeEnabled());
      fireEvent.click(within(pis).getByLabelText("PI 2"));
      await waitFor(() => expect(metaDoc().assignedPiPaths).toEqual([PI1]));

      await waitFor(() => expect(screen.getByLabelText("Planned start")).toBeEnabled());
      fireEvent.change(screen.getByLabelText("Planned start"), { target: { value: "2026-01-05" } });
      await waitFor(() => expect(metaDoc().plannedStart).toBe("2026-01-05"));
      await waitFor(() => expect(screen.getByLabelText("Planned end")).toBeEnabled());
      fireEvent.change(screen.getByLabelText("Planned end"), { target: { value: "2026-02-05" } });
      await waitFor(() => expect(metaDoc().plannedEnd).toBe("2026-02-05"));
      expect(metaDoc()).toMatchObject({ owningNodeId: "n-blue", __etag: 6 });

      await waitFor(() => expect(screen.getByLabelText("Planned end")).toBeEnabled());
      fireEvent.change(screen.getByLabelText("Planned end"), { target: { value: "" } });
      await waitFor(() => expect(metaDoc().plannedEnd).toBeUndefined());
      await waitFor(() => expect(screen.getByLabelText("Owning team")).toBeEnabled());
      fireEvent.change(screen.getByLabelText("Owning team"), { target: { value: "" } });
      await waitFor(() => expect(metaDoc().owningNodeId).toBeUndefined());
      await waitFor(() => expect(screen.getByLabelText("Planned start")).toBeEnabled());
      fireEvent.change(screen.getByLabelText("Planned start"), { target: { value: "" } });
      await waitFor(() => expect(metaDoc().plannedStart).toBeUndefined());
    });

    it("loads saved data, rejects end dates before the start and rolls back failed saves", async () => {
      dataStore.collections.set(
        META(),
        new Map([
          ["10", { id: "10", workItemId: 10, owningNodeId: "n-red", assignedNodeIds: [], assignedPiPaths: [PI1], plannedStart: "2026-03-01", __etag: 3 }],
        ])
      );
      await renderPanel();
      expect(screen.getByLabelText("Owning team")).toHaveValue("n-red");
      expect(screen.getByLabelText("PI 1")).toBeChecked();
      expect(screen.getByLabelText("Planned start")).toHaveValue("2026-03-01");

      fireEvent.change(screen.getByLabelText("Planned end"), { target: { value: "2026-02-01" } });
      expect(screen.getByRole("alert")).toHaveTextContent("The planned end date is before the planned start date.");
      expect(metaDoc().plannedEnd).toBeUndefined();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

      dataStore.failures.push({ op: "setDocument", error: new Error("etag mismatch") });
      fireEvent.change(screen.getByLabelText("Owning team"), { target: { value: "n-green" } });
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not save: etag mismatch");
      expect(screen.getByLabelText("Owning team")).toHaveValue("n-red");
      expect(metaDoc().owningNodeId).toBe("n-red");
    });

    it("shows when there are no PIs to assign", async () => {
      seedConfig(makeConfig({ piRootIteration: "Fabrikam\\Undated" }));
      await renderPanel();
      expect(within(screen.getByRole("group", { name: "Assigned PIs" })).getByText("No PIs")).toBeInTheDocument();
      expect(row("PI")).toHaveTextContent("Not planned in a PI");
    });
  });
});

describe("form host integration", () => {
  it("registers a notification listener that refreshes on relevant events only (field changes debounced)", async () => {
    let instance: any;
    const fakeSdk = { register: vi.fn((_id: string, obj: object) => (instance = obj)), getContributionId: vi.fn(() => "pub.ext.form") };
    registerFormHandlers(fakeSdk);
    expect(fakeSdk.register).toHaveBeenCalledWith("pub.ext.form", expect.any(Object));

    const listener = vi.fn();
    const off = onFormChange(listener);
    instance.onLoaded({ id: 1 });
    instance.onSaved({ id: 1 });
    instance.onRefreshed({ id: 1 });
    instance.onReset({ id: 1 });
    expect(listener).toHaveBeenCalledTimes(4);
    // Fields the panel does not show never refresh it.
    instance.onFieldChanged({ id: 1, changedFields: { "System.Description": "x", "System.Title": "y" } });
    await sleep(FIELD_CHANGE_DEBOUNCE_MS + 50);
    expect(listener).toHaveBeenCalledTimes(4);

    // A burst of relevant changes refreshes once, after the pause.
    instance.onFieldChanged({ id: 1, changedFields: { "System.AreaPath": RED } });
    instance.onFieldChanged({ id: 1, changedFields: { "System.IterationPath": PI1 } });
    instance.onFieldChanged({ id: 1 });
    instance.onFieldChanged(undefined);
    expect(listener).toHaveBeenCalledTimes(4);
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(5));
    await sleep(FIELD_CHANGE_DEBOUNCE_MS + 50);
    expect(listener).toHaveBeenCalledTimes(5);

    // Another event supersedes a pending field refresh; unloading cancels it.
    instance.onFieldChanged({ id: 1, changedFields: { "System.AreaPath": RED } });
    instance.onSaved({ id: 1 });
    expect(listener).toHaveBeenCalledTimes(6);
    instance.onFieldChanged({ id: 1, changedFields: { "System.AreaPath": RED } });
    instance.onUnloaded({ id: 1 });
    instance.onUnloaded({ id: 1 });
    await sleep(FIELD_CHANGE_DEBOUNCE_MS + 50);
    expect(listener).toHaveBeenCalledTimes(6);
    off();
    notifyFormChange();
    expect(listener).toHaveBeenCalledTimes(6);
  });

  it("starts up in order: init, ready, register, render, notify", async () => {
    const order: string[] = [];
    const fakeSdk = {
      init: vi.fn(async () => void order.push("init")),
      ready: vi.fn(async () => void order.push("ready")),
      register: vi.fn(() => void order.push("register")),
      getContributionId: vi.fn(() => "c"),
      notifyLoadSucceeded: vi.fn(() => void order.push("notify")),
    };
    await startForm(fakeSdk as any, () => order.push("render"));
    expect(order).toEqual(["init", "ready", "register", "render", "notify"]);
    expect(fakeSdk.init).toHaveBeenCalledWith({ loaded: false, applyTheme: true });
  });

  it("finds the deepest unit containing an area path", () => {
    const root = makeConfig().root;
    root.children[0].children.push({ id: "n-noarea", name: "No area", level: "team", children: [] });
    expect(unitForArea(root, RED + "\\Sub")!.id).toBe("n-red");
    expect(unitForArea(root, ART_A)!.id).toBe("n-arta");
    expect(unitForArea(root, P)!.id).toBe("n-root");
    expect(unitForArea(root, "Elsewhere")).toBeUndefined();
    expect(unitForArea(root, undefined)).toBeUndefined();
  });
});
