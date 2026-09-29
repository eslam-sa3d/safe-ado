import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProgramIncrements } from "../../src/api/wit";
import { SafeContext } from "../../src/components/context";
import { FormPanel, notifyFormChange, WORK_ITEM_FORM_SERVICE } from "../../src/form/FormPanel";
import { PI_LIMIT_MESSAGE } from "../../src/form/planning";
import { ART_A, dataManager, dataStore, fake, makeConfig, PI1_S1, PI2, PI2_S1, RED, seedConfig } from "../fakeAdo";
import * as sdk from "../sdkMock";

const META = () => `wimeta-${fake.projectId}`;
const START = "Microsoft.VSTS.Scheduling.StartDate";
const TARGET = "Microsoft.VSTS.Scheduling.TargetDate";

const values: Record<string, unknown> = {};
const form = {
  getId: vi.fn(async () => 10),
  getFieldValues: vi.fn(async (_fields: string[]) => ({ ...values })),
  getFields: vi.fn(async () => [{ referenceName: START }, { referenceName: TARGET }, { referenceName: "System.Title" }] as any[]),
  setFieldValues: vi.fn(async (fields: Record<string, unknown>) => Object.fromEntries(Object.keys(fields).map((k) => [k, true]))),
};

const original = sdk.getService.getMockImplementation()!;
let service: any = form;

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
  form.getFields.mockClear();
  form.setFieldValues.mockClear();
  service = form;
  sdk.getService.mockImplementation((async (id: string) => (id === WORK_ITEM_FORM_SERVICE ? service : original(id))) as any);
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

const row = (label: string) => screen.getByText(label, { selector: ".field-label" }).parentElement as HTMLElement;
const metaDoc = (id = "10") => dataStore.collections.get(META())?.get(id);
const seedMeta = (doc: object) => dataStore.collections.set(META(), new Map([[(doc as any).id, { ...doc, __etag: 1 }]]));
const enabled = (label: string) => waitFor(() => expect(screen.getByLabelText(label)).toBeEnabled());

describe("form panel: SAFe details", () => {
  it("reads only the item's own metadata document", async () => {
    seedMeta({ id: "10", workItemId: 10, owningNodeId: "n-red", assignedNodeIds: [], assignedPiPaths: [] });
    await renderPanel();
    expect(screen.getByLabelText("Owning team")).toHaveValue("n-red");
    expect(dataManager.getDocument).toHaveBeenCalledWith(META(), "10", expect.anything());
    expect(dataManager.getDocuments).not.toHaveBeenCalledWith(META(), expect.anything());
  });

  it("shows PI involvement and estimated completion of the children", async () => {
    // #104 is removed: its PI must not count.
    fake.workItems.get(104)!.fields["System.IterationPath"] = PI1_S1;
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    const finish = pis[1].sprints.find((s) => s.name === "PI 2 Sprint 2")!.finish!.slice(0, 10);
    await renderPanel();
    expect(row("PI involvement")).toHaveTextContent(/^PI involvementPI 2$/);
    expect(row("Estimated completion")).toHaveTextContent(finish);
  });

  it("says when no child is planned", async () => {
    values["System.AreaPath"] = ART_A;
    form.getId.mockImplementation(async () => 12);
    await renderPanel();
    expect(row("PI involvement")).toHaveTextContent("None");
    expect(row("Estimated completion")).toHaveTextContent("Unknown");
  });

  it("opens the SAFe Ado hub on the item's unit", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Open in SAFe Ado" }));
    await waitFor(() =>
      expect(sdk.hostNavigation.openNewWindow).toHaveBeenCalledWith(
        "https://dev.azure.com/org/Fabrikam/_apps/hub/SAFeADO.safe-ado.safe-hub#node=n-red&view=workitems",
        ""
      )
    );
    sdk.hostNavigation.openNewWindow.mockImplementationOnce(() => {
      throw new Error("popup blocked");
    });
    fireEvent.click(screen.getByRole("button", { name: "Open in SAFe Ado" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open SAFe Ado: popup blocked");
  });

  it("lists the PIs of the unit's own cadence", async () => {
    const config = makeConfig();
    config.root.children[0].piRootIteration = PI2; // ART A plans in PI 2's sprints
    seedConfig(config);
    await renderPanel();
    const labels = within(screen.getByRole("group", { name: "Assigned PIs" }))
      .getAllByRole("checkbox")
      .map((c) => c.parentElement!.textContent!.trim());
    expect(labels).toEqual(["PI 2 Sprint 1", "PI 2 Sprint 2", "PI 2 IP"]);
  });
});

describe("form panel: editing", () => {
  it("edits assigned teams among the unit's child units", async () => {
    values["System.AreaPath"] = ART_A;
    form.getId.mockImplementation(async () => 12);
    await renderPanel();
    const group = () => screen.getByRole("group", { name: "Assigned teams" });
    expect(within(group()).getAllByRole("checkbox").map((c) => c.parentElement!.textContent!.trim())).toEqual(["Team Red", "Team Blue"]);
    fireEvent.click(within(group()).getByLabelText("Team Blue"));
    await waitFor(() => expect(metaDoc("12")).toMatchObject({ workItemId: 12, assignedNodeIds: ["n-blue"] }));
    await enabled("Team Red");
    fireEvent.click(within(group()).getByLabelText("Team Red"));
    await waitFor(() => expect(metaDoc("12").assignedNodeIds).toEqual(["n-blue", "n-red"]));
    await enabled("Team Blue");
    fireEvent.click(within(group()).getByLabelText("Team Blue"));
    await waitFor(() => expect(metaDoc("12").assignedNodeIds).toEqual(["n-red"]));
  });

  it("has no assigned teams for a team", async () => {
    await renderPanel();
    expect(screen.queryByRole("group", { name: "Assigned teams" })).not.toBeInTheDocument();
  });

  it("keeps assigned PI ids in step and caps assigned PIs at 5", async () => {
    const pis = await getProgramIncrements("Fabrikam\\PIs");
    await renderPanel();
    fireEvent.click(screen.getByLabelText("PI 2"));
    await waitFor(() => expect(metaDoc()).toMatchObject({ assignedPiPaths: [PI2], assignedPiIds: [pis[1].identifier] }));

    seedMeta({ id: "10", workItemId: 10, assignedNodeIds: [], assignedPiPaths: ["a", "b", "c", "d", "e"] });
    await act(async () => notifyFormChange());
    await waitFor(() => expect(screen.getByLabelText("PI 2")).not.toBeChecked());
    fireEvent.click(screen.getByLabelText("PI 1"));
    expect(screen.getByRole("alert")).toHaveTextContent(PI_LIMIT_MESSAGE);
    expect(metaDoc().assignedPiPaths).toHaveLength(5);
    expect(metaDoc().__etag).toBe(1);
  });

  it("writes planned dates to the metadata and the item's scheduling fields", async () => {
    await renderPanel();
    fireEvent.change(screen.getByLabelText("Planned start"), { target: { value: "2026-01-05" } });
    await waitFor(() => expect(form.setFieldValues).toHaveBeenCalledWith({ [START]: new Date(2026, 0, 5) }));
    expect(metaDoc().plannedStart).toBe("2026-01-05");
    await enabled("Planned end");
    fireEvent.change(screen.getByLabelText("Planned end"), { target: { value: "2026-02-05" } });
    await waitFor(() => expect(form.setFieldValues).toHaveBeenLastCalledWith({ [TARGET]: new Date(2026, 1, 5) }));
    await enabled("Planned end");
    fireEvent.change(screen.getByLabelText("Planned end"), { target: { value: "" } });
    await waitFor(() => expect(form.setFieldValues).toHaveBeenLastCalledWith({ [TARGET]: null }));
    await waitFor(() => expect(metaDoc().plannedEnd).toBeUndefined());
    // Other SAFe data never touches the fields.
    await enabled("Owning team");
    fireEvent.change(screen.getByLabelText("Owning team"), { target: { value: "n-blue" } });
    await waitFor(() => expect(metaDoc().owningNodeId).toBe("n-blue"));
    expect(form.setFieldValues).toHaveBeenCalledTimes(3);
  });

  it("only writes the date fields the work item type has", async () => {
    form.getFields.mockResolvedValueOnce([{ referenceName: START }]);
    await renderPanel();
    fireEvent.change(screen.getByLabelText("Planned end"), { target: { value: "2026-02-05" } });
    await waitFor(() => expect(metaDoc().plannedEnd).toBe("2026-02-05"));
    await enabled("Planned end");
    expect(form.setFieldValues).not.toHaveBeenCalled();
  });

  it("writes metadata only when the field list is unavailable", async () => {
    form.getFields.mockRejectedValueOnce(new Error("no fields"));
    await renderPanel();
    fireEvent.change(screen.getByLabelText("Planned start"), { target: { value: "2026-02-05" } });
    await waitFor(() => expect(metaDoc().plannedStart).toBe("2026-02-05"));
    expect(form.setFieldValues).not.toHaveBeenCalled();

    service = { getId: form.getId, getFieldValues: form.getFieldValues };
    await act(async () => notifyFormChange());
    await enabled("Planned end");
    fireEvent.change(screen.getByLabelText("Planned end"), { target: { value: "2026-03-05" } });
    await waitFor(() => expect(metaDoc().plannedEnd).toBe("2026-03-05"));
  });

  it("rolls the metadata back when the field write fails", async () => {
    seedMeta({ id: "10", workItemId: 10, assignedNodeIds: [], assignedPiPaths: [], plannedEnd: "2026-04-01" });
    await renderPanel();
    form.setFieldValues.mockResolvedValueOnce({ [TARGET]: false });
    fireEvent.change(screen.getByLabelText("Planned end"), { target: { value: "2026-05-01" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(`Could not save: Azure DevOps rejected ${TARGET}`);
    expect(metaDoc()).toMatchObject({ plannedEnd: "2026-04-01", __etag: 3 });
    expect(screen.getByLabelText("Planned end")).toHaveValue("2026-04-01");

    // A later save uses the restored document's etag.
    await enabled("Planned start");
    fireEvent.change(screen.getByLabelText("Planned start"), { target: { value: "2026-03-01" } });
    await waitFor(() => expect(metaDoc()).toMatchObject({ plannedStart: "2026-03-01", __etag: 4 }));
  });

  it("reports when neither the fields nor the rollback can be written", async () => {
    await renderPanel();
    form.setFieldValues.mockImplementationOnce(async () => {
      dataStore.failures.push({ op: "setDocument", error: new Error("offline") });
      throw new Error("form closed");
    });
    fireEvent.change(screen.getByLabelText("Planned start"), { target: { value: "2026-01-05" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save: form closed (the SAFe data could not be restored: offline)");
    expect(screen.getByLabelText("Planned start")).toHaveValue("2026-01-05");

    // The form cannot set fields at all.
    service = { ...form, setFieldValues: undefined };
    await enabled("Planned end");
    fireEvent.change(screen.getByLabelText("Planned end"), { target: { value: "2026-02-05" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save: the work item form cannot set field values"));
    expect(metaDoc().plannedEnd).toBeUndefined();
  });

  it("disables editing without the plan permission", async () => {
    const ctx = { can: { admin: false, managePis: false, plan: false } } as any;
    await renderPanel(
      <SafeContext.Provider value={ctx}>
        <FormPanel />
      </SafeContext.Provider>
    );
    expect(screen.getByLabelText("Owning team")).toBeDisabled();
    expect(screen.getByLabelText("PI 1")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open in SAFe Ado" })).toBeEnabled();
  });
});
