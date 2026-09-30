import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgramIncrement } from "../../src/api/types";
import { getProgramIncrements } from "../../src/api/wit";
import { fmtDate } from "../../src/components/common";
import { SafeContext } from "../../src/components/context";
import { PI_LIMIT_MESSAGE } from "../../src/form/planning";
import {
  assignedPiNames,
  csvCell,
  expectedParentType,
  loadMembers,
  mergePeople,
  toCsv,
  WorkItemList,
} from "../../src/views/WorkItemList";
import { callsTo, dataStore, fail, fake, makeConfig, PI1, PI1_S1, PI2 } from "../fakeAdo";
import { renderView } from "../utils";

const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const META = () => `wimeta-${fake.projectId}`;
const url = (id: number) => `${fake.baseUrl}/_apis/wit/workItems/${id}`;

async function renderList(nodeId = "n-arta", config = makeConfig(), ui: ReactElement = <WorkItemList />) {
  const r = await renderView(ui, { nodeId, config });
  await waitFor(() => expect(document.querySelector(".spinner")).toBeNull());
  return r;
}

/** Renders the list with the given capabilities in the SAFe context. */
function WithCan({ plan }: { plan: boolean }) {
  return (
    <SafeContext.Consumer>
      {(v) => (
        <SafeContext.Provider value={{ ...v!, can: { admin: false, managePis: false, plan } }}>
          <WorkItemList />
        </SafeContext.Provider>
      )}
    </SafeContext.Consumer>
  );
}

const ids = () => Array.from(document.querySelectorAll("tbody tr")).map((tr) => Number(tr.getAttribute("data-id")));
const row = (id: number) => document.querySelector(`tbody tr[data-id="${id}"]`) as HTMLElement;
const cell = (id: number, key: string) => row(id).querySelector(`td.col-${key}`) as HTMLElement;
const metaDoc = (id: number) => dataStore.collections.get(META())?.get(String(id));
const patches = (id: number) => callsTo(new RegExp(`^_apis/wit/workitems/${id}$`), "PATCH");

function seedMeta(docs: object[]) {
  dataStore.collections.set(META(), new Map(docs.map((d: any) => [d.id, { ...d, __etag: 1 }])));
}

async function cadence(): Promise<ProgramIncrement[]> {
  return getProgramIncrements("Fabrikam\\PIs");
}

const finishOf = (pis: ProgramIncrement[], sprint: string) =>
  pis.flatMap((p) => p.sprints).find((s) => s.name === sprint)!.finish!.slice(0, 10);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Work Item List: SAFe columns", () => {
  it("shows PI involvement and estimated completion from the children (removed children ignored)", async () => {
    // #104 is a removed child of #10; planned in PI 1 it must not count.
    fake.workItems.get(104)!.fields["System.IterationPath"] = PI1_S1;
    const pis = await cadence();
    await renderList();
    expect(cell(10, "piInvolvement")).toHaveTextContent(/^PI 2$/);
    expect(cell(15, "piInvolvement")).toHaveTextContent(/^PI 1$/);
    expect(cell(12, "piInvolvement")).toHaveTextContent(/^$/);
    // #10's children are in PI 2 Sprint 1 and 2: the latest sprint wins.
    // Displayed with fmtDate like every other date; the ISO date stays as the tooltip.
    expect(cell(10, "completion")).toHaveTextContent(fmtDate(finishOf(pis, "PI 2 Sprint 2")));
    expect(cell(10, "completion").querySelector("span")).toHaveAttribute("title", finishOf(pis, "PI 2 Sprint 2"));
    expect(cell(14, "completion")).toHaveTextContent(fmtDate(finishOf(pis, "PI 2 Sprint 1")));
    expect(cell(15, "completion")).toHaveTextContent(fmtDate(finishOf(pis, "PI 1 Sprint 1")));
    expect(cell(12, "completion")).toHaveTextContent(/^$/);
    // Children are fetched with the fields needed for the SAFe columns.
    const batch = callsTo(/workitemsbatch/).find((c) => c.body.fields);
    expect(batch!.body.fields).toEqual(["System.Id", "System.AreaPath", "System.IterationPath", "System.WorkItemType", "System.State"]);
  });

  it("edits assigned teams through a popover of the unit's child units", async () => {
    seedMeta([{ id: "11", workItemId: 11, assignedNodeIds: ["n-blue", "n-gone"], assignedPiPaths: [] }]);
    await renderList();
    expect(cell(11, "assigned")).toHaveTextContent("Team Blue");
    const group = screen.getByRole("group", { name: "Assigned teams of #10" });
    expect(within(group).getAllByRole("checkbox").map((c) => c.parentElement!.textContent!.trim())).toEqual(["Team Red", "Team Blue"]);
    expect(cell(10, "assigned").querySelector("summary")).toHaveTextContent("–");

    fireEvent.click(within(group).getByLabelText("Team Red"));
    await waitFor(() => expect(metaDoc(10)).toMatchObject({ workItemId: 10, assignedNodeIds: ["n-red"] }));
    expect(cell(10, "assigned").querySelector("summary")).toHaveTextContent("Team Red");
    fireEvent.click(within(screen.getByRole("group", { name: "Assigned teams of #10" })).getByLabelText("Team Blue"));
    await waitFor(() => expect(metaDoc(10).assignedNodeIds).toEqual(["n-red", "n-blue"]));
    expect(cell(10, "assigned")).toHaveTextContent("Team Red, Team Blue");
    fireEvent.click(within(screen.getByRole("group", { name: "Assigned teams of #10" })).getByLabelText("Team Red"));
    await waitFor(() => expect(metaDoc(10).assignedNodeIds).toEqual(["n-blue"]));

    dataStore.failures.push({ op: "setDocument", error: new Error("etag mismatch") });
    fireEvent.click(within(screen.getByRole("group", { name: "Assigned teams of #11" })).getByLabelText("Team Blue"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not update the assigned teams of #11: etag mismatch");
    expect(within(screen.getByRole("group", { name: "Assigned teams of #11" })).getByLabelText("Team Blue")).toBeChecked();
  });

  it("edits assigned PIs (ids kept in step with paths) and caps them at 5", async () => {
    const pis = await cadence();
    const id = (name: string) => pis.find((p) => p.name === name)!.identifier;
    const five = ["A", "B", "C", "D", "E"].map((n) => `Fabrikam\\PIs\\Old ${n}`);
    seedMeta([{ id: "11", workItemId: 11, assignedNodeIds: [], assignedPiPaths: five, assignedPiIds: ["", "", "", "", ""] }]);
    await renderList();
    const group = () => screen.getByRole("group", { name: "Assigned PIs of #10" });
    expect(within(group()).getAllByRole("checkbox").map((c) => c.parentElement!.textContent!.trim())).toEqual(["PI 1", "PI 2"]);
    fireEvent.click(within(group()).getByLabelText("PI 2"));
    await waitFor(() => expect(metaDoc(10)).toMatchObject({ assignedPiPaths: [PI2], assignedPiIds: [id("PI 2")] }));
    fireEvent.click(within(group()).getByLabelText("PI 1"));
    await waitFor(() => expect(metaDoc(10)).toMatchObject({ assignedPiPaths: [PI2, PI1], assignedPiIds: [id("PI 2"), id("PI 1")] }));
    expect(cell(10, "pis")).toHaveTextContent("PI 2, PI 1");
    fireEvent.click(within(group()).getByLabelText("PI 2"));
    await waitFor(() => expect(metaDoc(10)).toMatchObject({ assignedPiPaths: [PI1], assignedPiIds: [id("PI 1")] }));

    // Agile Hive allows at most five assigned PIs.
    const saves = dataStore.collections.get(META())!.get("11").__etag;
    fireEvent.click(within(screen.getByRole("group", { name: "Assigned PIs of #11" })).getByLabelText("PI 1"));
    expect(screen.getByRole("alert")).toHaveTextContent(PI_LIMIT_MESSAGE);
    expect(metaDoc(11).__etag).toBe(saves);
    expect(within(screen.getByRole("group", { name: "Assigned PIs of #11" })).getByLabelText("PI 1")).not.toBeChecked();
  });

  it("shows and edits assigned PIs at team level", async () => {
    await renderList("n-red");
    fireEvent.click(within(screen.getByRole("group", { name: "Assigned PIs of #15" })).getByLabelText("PI 1"));
    await waitFor(() => expect(metaDoc(15).assignedPiPaths).toEqual([PI1]));
    expect(cell(15, "pis")).toHaveTextContent("PI 1");
  });

  it("offers the SAFe facets in the filter bar", async () => {
    seedMeta([
      { id: "10", workItemId: 10, owningNodeId: "n-red", assignedNodeIds: ["n-red"], assignedPiPaths: [PI2] },
      { id: "11", workItemId: 11, owningNodeId: "n-blue", assignedNodeIds: ["n-blue", "n-red"], assignedPiPaths: [PI1] },
    ]);
    await renderList();
    const facet = (name: string) => screen.getByRole("group", { name: `${name} filter` });
    const optionsOf = (name: string) => within(facet(name)).getAllByRole("checkbox").map((c) => c.parentElement!.textContent!.trim());
    expect(optionsOf("Assigned PIs")).toEqual(["PI 1", "PI 2"]);
    expect(optionsOf("Owning team")).toEqual(["Team Blue", "Team Red"]);
    expect(optionsOf("Assigned teams")).toEqual(["Team Blue", "Team Red"]);
    expect(optionsOf("PI involvement")).toEqual(["PI 1", "PI 2"]);

    fireEvent.click(within(facet("PI involvement")).getByLabelText("PI 1"));
    expect(ids()).toEqual([15]);
    fireEvent.click(within(facet("PI involvement")).getByLabelText("PI 1"));
    fireEvent.click(within(facet("Assigned teams")).getByLabelText("Team Red"));
    expect(ids()).toEqual([10, 11]);
    fireEvent.click(within(facet("Owning team")).getByLabelText("Team Blue"));
    expect(ids()).toEqual([11]);
    fireEvent.click(within(facet("Assigned PIs")).getByLabelText("PI 2"));
    expect(ids()).toEqual([]);
  });

  it("offers PI facets at team level and none at portfolio level", async () => {
    const { unmount } = await renderList("n-red");
    expect(screen.getByRole("group", { name: "Assigned PIs filter" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "PI involvement filter" })).getByLabelText("PI 1"));
    expect(ids()).toEqual([15, 103]);
    expect(screen.queryByRole("group", { name: "Owning team filter" })).not.toBeInTheDocument();
    unmount();
    await renderList("n-root");
    expect(screen.queryByRole("group", { name: "Assigned PIs filter" })).not.toBeInTheDocument();
  });

  it("exports the SAFe columns and neutralises formulas", async () => {
    const created: Blob[] = [];
    (URL as any).createObjectURL = vi.fn((b: Blob) => (created.push(b), "blob:csv"));
    (URL as any).revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fake.workItems.get(12)!.fields["System.Title"] = '=HYPERLINK("http://evil")';
    seedMeta([{ id: "10", workItemId: 10, owningNodeId: "n-red", assignedNodeIds: ["n-red", "n-blue"], assignedPiPaths: [PI2] }]);
    const pis = await cadence();
    await renderList();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    const lines = (await created[0].text()).split("\r\n");
    expect(lines[1]).toBe(
      `10,Feature,Payment API,Active,,Grace Hopper,1,Fabrikam\\PIs\\PI 2\\PI 2 Sprint 1,Fabrikam\\ART A\\Team Red,Team Red,Team Red,"Team Red, Team Blue",PI 2,PI 2,${finishOf(pis, "PI 2 Sprint 2")}`
    );
    expect(lines[3]).toMatch(/^12,Feature,"'=HYPERLINK\(""http:\/\/evil""\)",New,/);
  });
});

describe("Work Item List: parent validation", () => {
  it("accepts only the next SAFe level up as parent", async () => {
    await renderList();
    fireEvent.click(screen.getByLabelText(/Show all types/));
    await waitFor(() => expect(ids()).toContain(100));

    // Feature -> User Story is the wrong direction.
    fireEvent.change(screen.getByLabelText("Parent of #11"), { target: { value: "100" } });
    fireEvent.blur(screen.getByLabelText("Parent of #11"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Work item #100 is of type User Story; the parent of #11 (Feature) must be of type Epic.");
    expect(patches(11)).toHaveLength(0);
    expect(screen.getByLabelText("Parent of #11")).toHaveValue("1");

    // Story -> Feature is fine.
    fireEvent.change(screen.getByLabelText("Parent of #100"), { target: { value: "11" } });
    fireEvent.blur(screen.getByLabelText("Parent of #100"));
    await waitFor(() => expect(fake.workItems.get(100)!.relations!.filter((r) => r.rel === PARENT).map((r) => r.url)).toEqual([url(11)]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects missing parents and reports lookup failures", async () => {
    await renderList();
    fireEvent.change(screen.getByLabelText("Parent of #11"), { target: { value: "99999" } });
    fireEvent.blur(screen.getByLabelText("Parent of #11"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Work item #99999 does not exist.");

    fail(/workitemsbatch/, 500, "Down", { once: true });
    fireEvent.change(screen.getByLabelText("Parent of #11"), { target: { value: "2" } });
    fireEvent.blur(screen.getByLabelText("Parent of #11"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not check work item #2: Down"));
    expect(patches(11)).toHaveLength(0);
  });

  it("expects a Capability above Features when the process has one", async () => {
    fake.workItems.set(30, {
      id: 30,
      rev: 1,
      fields: { "System.Id": 30, "System.Title": "Cap", "System.WorkItemType": "Capability", "System.State": "New", "System.AreaPath": "Fabrikam", "System.IterationPath": "Fabrikam" },
      relations: [],
    });
    fake.states.Capability = fake.states.Epic;
    const config = makeConfig({ types: { epic: "Epic", capability: "Capability", feature: "Feature", story: "User Story" } });
    await renderList("n-arta", config);
    fireEvent.change(screen.getByLabelText("Parent of #15"), { target: { value: "100" } });
    fireEvent.blur(screen.getByLabelText("Parent of #15"));
    expect(await screen.findByRole("alert")).toHaveTextContent("must be of type Capability");
    // Agile Hive lets a Feature skip the Large Solution level and sit under an Epic.
    fireEvent.change(screen.getByLabelText("Parent of #15"), { target: { value: "1" } });
    fireEvent.blur(screen.getByLabelText("Parent of #15"));
    await waitFor(() => expect(patches(15)).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Parent of #15"), { target: { value: "30" } });
    fireEvent.blur(screen.getByLabelText("Parent of #15"));
    await waitFor(() => expect(patches(15)).toHaveLength(2));
  });

  it("knows the level above each type", () => {
    const config = makeConfig({ types: { epic: "Epic", capability: "Capability", feature: "Feature", story: "User Story", theme: "Theme" } });
    expect(expectedParentType(config, "User Story")).toBe("Feature");
    expect(expectedParentType(config, "Feature")).toBe("Capability");
    expect(expectedParentType(config, "Capability")).toBe("Epic");
    expect(expectedParentType(config, "Epic")).toBe("Theme");
    expect(expectedParentType(config, "Bug")).toBeUndefined();
    expect(expectedParentType(makeConfig(), "Epic")).toBeUndefined();
    expect(expectedParentType(makeConfig(), "Feature")).toBe("Epic");
  });
});

describe("Work Item List: permissions and people", () => {
  it("is read-only without the plan permission", async () => {
    seedMeta([{ id: "10", workItemId: 10, owningNodeId: "n-red", assignedNodeIds: ["n-blue"], assignedPiPaths: [PI2] }]);
    await renderList("n-arta", makeConfig(), <WithCan plan={false} />);
    expect(screen.getByText(/You can view this list but not edit it/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Title of #10")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Priority of #10")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Assigned to of #10")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Parent of #10")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Owning team of #10")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Assigned PIs of #10" })).not.toBeInTheDocument();
    expect(cell(10, "title")).toHaveTextContent("Payment API");
    expect(cell(10, "assignee")).toHaveTextContent("Grace Hopper");
    expect(cell(10, "parent")).toHaveTextContent("1");
    expect(cell(10, "owner")).toHaveTextContent("Team Red");
    expect(cell(10, "assigned")).toHaveTextContent("Team Blue");
    expect(cell(10, "pis")).toHaveTextContent("PI 2");
    expect(cell(11, "assignee")).toHaveTextContent("Unassigned");
    // No identity lookups for a read-only list.
    expect(callsTo(/members/)).toHaveLength(0);
  });

  it("is editable with the plan permission", async () => {
    await renderList("n-arta", makeConfig(), <WithCan plan />);
    expect(screen.queryByText(/You can view this list/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Title of #10")).toBeInTheDocument();
  });

  it("skips teams whose members cannot be read", async () => {
    fail(/teams\/t-red\/members/, 403, "Forbidden");
    await renderList();
    const select = screen.getByLabelText("Assigned to of #11") as HTMLSelectElement;
    await waitFor(() => expect(Array.from(select.options).map((o) => o.text)).toEqual(["Unassigned", "Alan Turing", "Grace Hopper"]));
    // Grace is known only by name from #10.
    expect(screen.getByLabelText("Assigned to of #10")).toHaveValue("Grace Hopper");
  });

  it("merges team members with assigned people", async () => {
    expect(
      mergePeople(
        [{ displayName: "Ada", uniqueName: "ada@x" }, { displayName: "Ada", uniqueName: "ADA@x" }, { displayName: "Bob", uniqueName: "bob@x" }],
        [{ displayName: "Ada" }, { displayName: "Bob", uniqueName: "bob@x" }, { displayName: "Cy" }, { displayName: "" }]
      )
    ).toEqual([{ displayName: "Ada", uniqueName: "ada@x" }, { displayName: "Bob", uniqueName: "bob@x" }, { displayName: "Cy" }]);
    const art = makeConfig().root.children[0];
    fake.teamMembers["t-arta"] = [{ id: "u-1", displayName: "Rita", uniqueName: "rita@x" }];
    expect((await loadMembers(art)).map((p) => p.uniqueName)).toEqual(["rita@x", "ada@fabrikam.com", "grace@fabrikam.com", "alan@fabrikam.com"]);
  });
});

describe("Work Item List: CSV and names", () => {
  it("escapes formula-looking text and keeps the quoting rules", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+x")).toBe("'+x");
    expect(csvCell("-x")).toBe("'-x");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe("\"'\rx\"");
    expect(csvCell('=A1,"b"')).toBe('"\'=A1,""b"""');
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell(-5)).toBe("-5");
    expect(toCsv(["h"], [["@x"]])).toBe("h\r\n'@x");
  });

  it("names assigned PIs by id, then path, then last segment", () => {
    const pis = [
      { name: "PI 1", path: PI1, identifier: "i1", sprints: [] },
      { name: "PI 2", path: PI2, identifier: "i2", sprints: [] },
    ];
    const meta = { id: "1", workItemId: 1, assignedNodeIds: [], assignedPiPaths: ["Fabrikam\\Renamed", PI2, "X\\Gone"], assignedPiIds: ["i1", ""] };
    expect(assignedPiNames(meta, pis)).toEqual(["PI 1", "PI 2", "Gone"]);
    expect(assignedPiNames(undefined, pis)).toEqual([]);
  });
});
