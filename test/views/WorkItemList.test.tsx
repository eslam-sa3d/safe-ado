import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { columnsFor, piOf, teamsInvolved, toCsv, WorkItemList } from "../../src/views/WorkItemList";
import { callsTo, dataStore, fail, fake, makeConfig, PI1, PI2, RED } from "../fakeAdo";
import * as sdk from "../sdkMock";
import { renderView } from "../utils";

const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const CHILD = "System.LinkTypes.Hierarchy-Forward";
const url = (id: number) => `${fake.baseUrl}/_apis/wit/workItems/${id}`;
const META = () => `wimeta-${fake.projectId}`;

async function renderList(nodeId = "n-arta", config = makeConfig()) {
  const r = await renderView(<WorkItemList />, { nodeId, config });
  await waitFor(() => expect(document.querySelector(".spinner")).toBeNull());
  return r;
}

const ids = () => Array.from(document.querySelectorAll("tbody tr")).map((tr) => Number(tr.getAttribute("data-id")));
const row = (id: number) => document.querySelector(`tbody tr[data-id="${id}"]`) as HTMLElement;
const headers = () => Array.from(document.querySelectorAll("thead th")).map((th) => th.textContent!.replace(/ [▲▼]$/, ""));
const cell = (id: number, key: string) => row(id).querySelector(`td.col-${key}`) as HTMLElement;
const patches = (id: number) => callsTo(new RegExp(`^_apis/wit/workitems/${id}$`), "PATCH");

function seedMeta(docs: object[]) {
  dataStore.collections.set(META(), new Map(docs.map((d: any) => [d.id, { ...d, __etag: 1 }])));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Work Item List", () => {
  it("lists the ART's features (not removed) with ART-specific columns", async () => {
    await renderView(<WorkItemList />, { nodeId: "n-arta" });
    expect(screen.getByText("Loading work items…")).toBeInTheDocument();
    await waitFor(() => expect(ids()).toEqual([10, 11, 12, 14, 15]));
    expect(headers()).toEqual([
      "ID",
      "Type",
      "Title",
      "State",
      "Priority",
      "Assigned To",
      "Parent",
      "Iteration",
      "Area",
      "Teams involved",
      "Owning team",
      "Assigned PIs",
    ]);
    expect(screen.getByText("5 of 5 items")).toBeInTheDocument();
    const query = callsTo(/wiql/)[0].body.query;
    expect(query).toContain("[System.WorkItemType] IN ('Feature')");
    expect(query).toContain("[System.AreaPath] UNDER 'Fabrikam\\ART A'");
    expect(screen.getByLabelText("Title of #10")).toHaveValue("Payment API");
    expect(within(row(10)).getByText("Active")).toBeInTheDocument();
    expect(cell(10, "iteration")).toHaveTextContent("PI 2 Sprint 1");
    expect(cell(10, "area")).toHaveTextContent("Team Red");
    expect(screen.getByLabelText("Assigned to of #10")).toHaveValue("Grace Hopper");
    expect(screen.getByLabelText("Assigned to of #11")).toHaveValue("");
    // Teams involved come from the areas of the children.
    expect(cell(10, "teams")).toHaveTextContent("Team Red");
    expect(cell(11, "teams")).toHaveTextContent("Team Blue");
    expect(cell(12, "teams")).toHaveTextContent("");
    expect(screen.getByLabelText("Priority of #10")).toHaveValue("");
  });

  it("shows all types in the type chain on request", async () => {
    await renderList();
    fireEvent.click(screen.getByLabelText(/Show all types/));
    await waitFor(() => expect(ids()).toEqual([10, 11, 12, 14, 15, 100, 101, 102, 103, 105]));
    expect(callsTo(/wiql/).at(-1)!.body.query).toContain("IN ('Epic', 'Feature', 'User Story')");
    // Parent is derived from the loaded parent's child link.
    expect(screen.getByLabelText("Parent of #100")).toHaveValue("10");
    expect(screen.getByLabelText("Priority of #100")).toHaveValue("1");
  });

  it("shows every chain type and PI involvement at team level", async () => {
    await renderList("n-red");
    expect(ids()).toEqual([10, 15, 100, 101, 103]);
    expect(screen.queryByLabelText(/Show all types/)).not.toBeInTheDocument();
    expect(headers().slice(9)).toEqual(["PI involvement"]);
    expect(cell(10, "piInvolvement")).toHaveTextContent("PI 2");
    expect(cell(15, "piInvolvement")).toHaveTextContent("PI 1");
  });

  it("lists epics at portfolio level with the base columns only", async () => {
    await renderList("n-root");
    expect(ids()).toEqual([1, 2, 3]);
    expect(headers()).toHaveLength(9);
    expect(screen.getByLabelText("Assigned to of #1")).toHaveValue("Ada Lovelace");
  });

  it("sorts by any column ascending and descending", async () => {
    await renderList();
    const title = screen.getByRole("button", { name: "Title" });
    fireEvent.click(title);
    expect(ids()).toEqual([11, 12, 15, 10, 14]);
    expect(title.closest("th")).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(screen.getByRole("button", { name: /Title/ }));
    expect(ids()).toEqual([14, 10, 15, 12, 11]);
    expect(screen.getByRole("button", { name: /Title/ }).closest("th")).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("button", { name: "ID" }).closest("th")).toHaveAttribute("aria-sort", "none");

    fireEvent.click(screen.getByRole("button", { name: "Teams involved" }));
    expect(ids()).toEqual([12, 11, 14, 10, 15]);
    fireEvent.click(screen.getByRole("button", { name: "ID" }));
    fireEvent.click(screen.getByRole("button", { name: /ID/ }));
    expect(ids()).toEqual([15, 14, 12, 11, 10]);
  });

  it("sorts numbers numerically with blanks last", async () => {
    fake.workItems.get(12)!.fields["Microsoft.VSTS.Common.Priority"] = 3;
    fake.workItems.get(14)!.fields["Microsoft.VSTS.Common.Priority"] = 1;
    fake.workItems.get(15)!.fields["Microsoft.VSTS.Common.Priority"] = 3;
    await renderList();
    fireEvent.click(screen.getByRole("button", { name: "Priority" }));
    expect(ids()).toEqual([14, 12, 15, 10, 11]);
    fireEvent.click(screen.getByRole("button", { name: "Parent" }));
    expect(ids()).toEqual([10, 11, 12, 14, 15]);
  });

  it("filters client-side by facets and server-side by WIQL", async () => {
    await renderList();
    fireEvent.change(screen.getByLabelText("Filter text"), { target: { value: "pay" } });
    expect(ids()).toEqual([10]);
    expect(screen.getByText("1 of 5 items")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter text"), { target: { value: "zzz" } });
    expect(screen.getByText("No work items match the filter.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Filter text"), { target: { value: "" } });

    const states = screen.getByRole("group", { name: "State filter" });
    fireEvent.click(within(states).getByLabelText("New"));
    expect(ids()).toEqual([11, 12, 14]);

    const wiql = screen.getByLabelText("WIQL clause");
    fireEvent.change(wiql, { target: { value: "[System.Tags] CONTAINS 'MVP'" } });
    fireEvent.keyDown(wiql, { key: "Enter" });
    // First the server validates the clause, then the list reloads with it.
    await waitFor(() => expect(callsTo(/wiql/)).toHaveLength(3));
    expect(callsTo(/wiql/)[1].url).toContain("$top=1");
    expect(callsTo(/wiql/)[2].body.query).toContain("AND ([System.Tags] CONTAINS 'MVP') ORDER BY");
  });

  it("opens a work item from its ID", async () => {
    await renderList();
    fireEvent.click(within(row(11)).getByRole("button", { name: "#11" }));
    await waitFor(() => expect(sdk.workItemForm.openWorkItem).toHaveBeenCalledWith(11));
  });

  describe("inline editing", () => {
    it("saves a title on Enter / blur, reverts on Escape and rejects blank titles", async () => {
      await renderList();
      const input = screen.getByLabelText("Title of #11");
      fireEvent.change(input, { target: { value: "  Checkout UX " } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
      await waitFor(() => expect(fake.workItems.get(11)!.fields["System.Title"]).toBe("Checkout UX"));
      expect(patches(11)[0].body).toEqual([{ op: "add", path: "/fields/System.Title", value: "Checkout UX" }]);
      expect(screen.getByLabelText("Title of #11")).toHaveValue("Checkout UX");

      const again = screen.getByLabelText("Title of #11");
      fireEvent.change(again, { target: { value: "Something else" } });
      fireEvent.keyDown(again, { key: "Escape" });
      expect(again).toHaveValue("Checkout UX");
      fireEvent.blur(again);

      // Only whitespace changes: nothing to save.
      fireEvent.change(again, { target: { value: "Checkout UX " } });
      fireEvent.blur(again);

      fireEvent.change(again, { target: { value: "   " } });
      fireEvent.blur(again);
      expect(screen.getByRole("alert")).toHaveTextContent("Title cannot be empty.");
      expect(screen.getByLabelText("Title of #11")).toHaveValue("Checkout UX");
      expect(patches(11)).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("rolls a failed title save back", async () => {
      fail(/PATCH _apis\/wit\/workitems\/12/, 409, "Conflict");
      await renderList();
      const input = screen.getByLabelText("Title of #12");
      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.blur(input);
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not update the title of #12: Conflict");
      expect(screen.getByLabelText("Title of #12")).toHaveValue("Fraud rules");
    });

    it("saves priority and rolls back on failure", async () => {
      await renderList();
      fireEvent.change(screen.getByLabelText("Priority of #10"), { target: { value: "2" } });
      await waitFor(() => expect(fake.workItems.get(10)!.fields["Microsoft.VSTS.Common.Priority"]).toBe(2));
      expect(screen.getByLabelText("Priority of #10")).toHaveValue("2");

      fail(/PATCH/, 500, "Down", { once: true });
      fireEvent.change(screen.getByLabelText("Priority of #10"), { target: { value: "4" } });
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not update the priority of #10: Down");
      expect(screen.getByLabelText("Priority of #10")).toHaveValue("2");
    });

    it("assigns from the people present (unique name when known) or unassigns", async () => {
      fake.workItems.get(12)!.fields["System.AssignedTo"] = { displayName: "Ada Lovelace", uniqueName: "ada@fabrikam.com" };
      fake.workItems.get(14)!.fields["System.AssignedTo"] = "Linus";
      await renderList();
      const select = screen.getByLabelText("Assigned to of #11") as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.text)).toEqual(["Unassigned", "Ada Lovelace", "Grace Hopper", "Linus"]);
      expect(screen.getByLabelText("Assigned to of #14")).toHaveValue("Linus");

      fireEvent.change(select, { target: { value: "Ada Lovelace" } });
      await waitFor(() => expect(fake.workItems.get(11)!.fields["System.AssignedTo"]).toBe("ada@fabrikam.com"));
      expect(screen.getByLabelText("Assigned to of #11")).toHaveValue("Ada Lovelace");

      fireEvent.change(screen.getByLabelText("Assigned to of #10"), { target: { value: "Grace Hopper" } });
      await waitFor(() => expect(fake.workItems.get(10)!.fields["System.AssignedTo"]).toBe("Grace Hopper"));

      fireEvent.change(screen.getByLabelText("Assigned to of #10"), { target: { value: "" } });
      await waitFor(() => expect(fake.workItems.get(10)!.fields["System.AssignedTo"]).toBe(""));
      expect(screen.getByLabelText("Assigned to of #10")).toHaveValue("");

      fail(/PATCH/, 500, "Nope");
      fireEvent.change(screen.getByLabelText("Assigned to of #14"), { target: { value: "" } });
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not update the assignee of #14: Nope");
      expect(screen.getByLabelText("Assigned to of #14")).toHaveValue("Linus");
    });

    it("re-parents: removes the old reverse link and adds the new one", async () => {
      // #10's parent link to Epic #1 comes from the seed; Azure DevOps keeps both ends.
      await renderList();
      const input = screen.getByLabelText("Parent of #10");
      expect(input).toHaveValue("1");
      fireEvent.change(input, { target: { value: "#2" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
      await waitFor(() => expect(patches(10)).toHaveLength(2));
      const rels = fake.workItems.get(10)!.relations!.filter((r) => r.rel === PARENT);
      expect(rels.map((r) => r.url)).toEqual([url(2)]);
      expect(patches(10)[0].body[0].op).toBe("remove");
      expect(screen.getByLabelText("Parent of #10")).toHaveValue("2");

      // Escape reverts the draft; unchanged input does nothing.
      const again = screen.getByLabelText("Parent of #10");
      fireEvent.change(again, { target: { value: "3" } });
      fireEvent.keyDown(again, { key: "Escape" });
      expect(again).toHaveValue("2");
      fireEvent.blur(again);
      fireEvent.change(again, { target: { value: "#2" } });
      fireEvent.blur(again);
      expect(patches(10)).toHaveLength(2);

      // Blank removes the parent.
      fireEvent.change(again, { target: { value: " " } });
      fireEvent.blur(again);
      await waitFor(() => expect(patches(10)).toHaveLength(3));
      expect(fake.workItems.get(10)!.relations!.some((r) => r.rel === PARENT)).toBe(false);
      expect(screen.getByLabelText("Parent of #10")).toHaveValue("");
    });

    it("adds a parent to an orphan and removes a story's parent on both ends", async () => {
      await renderList();
      // #15 "Old feature" has no parent.
      expect(screen.getByLabelText("Parent of #15")).toHaveValue("");
      fireEvent.change(screen.getByLabelText("Parent of #15"), { target: { value: "1" } });
      fireEvent.blur(screen.getByLabelText("Parent of #15"));
      await waitFor(() => expect(patches(15)).toHaveLength(1));
      expect(patches(15)[0].body[0]).toMatchObject({ op: "add", path: "/relations/-", value: { rel: PARENT, url: url(1) } });
      expect(fake.workItems.get(1)!.relations!.some((r) => r.rel === CHILD && r.url === url(15))).toBe(true);

      fireEvent.click(screen.getByLabelText(/Show all types/));
      await waitFor(() => expect(ids()).toContain(100));
      expect(screen.getByLabelText("Parent of #100")).toHaveValue("10");
      fireEvent.change(screen.getByLabelText("Parent of #100"), { target: { value: "" } });
      fireEvent.blur(screen.getByLabelText("Parent of #100"));
      await waitFor(() => expect(fake.workItems.get(10)!.relations!.some((r) => r.rel === CHILD && r.url === url(100))).toBe(false));
      expect(fake.workItems.get(100)!.relations!.some((r) => r.rel === PARENT)).toBe(false);
    });

    it("validates parent input and rolls back failed link changes", async () => {
      await renderList();
      const input = screen.getByLabelText("Parent of #11");
      fireEvent.change(input, { target: { value: "abc" } });
      fireEvent.blur(input);
      expect(screen.getByRole("alert")).toHaveTextContent('"abc" is not a work item ID.');
      expect(screen.getByLabelText("Parent of #11")).toHaveValue("1");
      fireEvent.change(input, { target: { value: "11" } });
      fireEvent.blur(input);
      expect(screen.getByRole("alert")).toHaveTextContent("A work item cannot be its own parent.");

      fail(/PATCH/, 400, "TF201036: parent already exists");
      fireEvent.change(input, { target: { value: "2" } });
      fireEvent.blur(input);
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not update the parent of #11: TF201036");
      expect(screen.getByLabelText("Parent of #11")).toHaveValue("1");
    });

    it("sets the owning team in the SAFe metadata and shows assigned PIs", async () => {
      seedMeta([
        { id: "11", workItemId: 11, owningNodeId: "n-blue", assignedNodeIds: [], assignedPiPaths: [PI2, "Fabrikam\\PIs\\Old PI"] },
      ]);
      await renderList();
      expect(screen.getByLabelText("Owning team of #11")).toHaveValue("n-blue");
      expect(cell(11, "pis")).toHaveTextContent("PI 2, Old PI");
      const select = screen.getByLabelText("Owning team of #10") as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.text)).toEqual(["–", "Team Red", "Team Blue"]);

      fireEvent.change(select, { target: { value: "n-red" } });
      await waitFor(() => expect(dataStore.collections.get(META())!.get("10")).toMatchObject({ workItemId: 10, owningNodeId: "n-red" }));
      // A second change uses the returned etag.
      fireEvent.change(screen.getByLabelText("Owning team of #10"), { target: { value: "" } });
      await waitFor(() => expect(dataStore.collections.get(META())!.get("10").owningNodeId).toBeUndefined());

      fireEvent.click(screen.getByRole("button", { name: "Owning team" }));
      expect(ids()[0]).not.toBe(11);

      dataStore.failures.push({ op: "setDocument", error: new Error("etag mismatch") });
      fireEvent.change(screen.getByLabelText("Owning team of #11"), { target: { value: "n-red" } });
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not update the owning team of #11: etag mismatch");
      expect(screen.getByLabelText("Owning team of #11")).toHaveValue("n-blue");
    });
  });

  it("exports the visible rows as CSV", async () => {
    const created: Blob[] = [];
    (URL as any).createObjectURL = vi.fn((b: Blob) => (created.push(b), "blob:csv"));
    (URL as any).revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("ART A work items.csv");
      expect(this.href).toBe("blob:csv");
    });
    fake.workItems.get(12)!.fields["System.Title"] = 'Fraud "rules", v2';
    await renderList();
    fireEvent.change(screen.getByLabelText("Filter text"), { target: { value: "r" } });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:csv");
    const text = await created[0].text();
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("ID,Type,Title,State,Priority,Assigned To,Parent,Iteration,Area,Teams involved,Owning team,Assigned PIs");
    expect(lines[1]).toBe(`12,Feature,"Fraud ""rules"", v2",New,,Unassigned,1,${"Fabrikam\\PIs\\PI 2"},${"Fabrikam\\ART A"},,,`);
    expect(lines[2]).toMatch(/^15,Feature,Old feature,Closed,/);
    expect(lines.length).toBe(3);
  });

  it("shows load errors", async () => {
    fail(/wiql/, 400, "TF51005: bad query");
    await renderList();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load work items: TF51005: bad query");
    expect(document.querySelector("table")).toBeNull();
  });

  it("shows an empty state for units without items", async () => {
    fake.workItems.clear();
    await renderList("n-green");
    expect(screen.getByText("No work items")).toBeInTheDocument();
    expect(screen.getByText(/No Epic, Feature, User Story items in Team Green/)).toBeInTheDocument();
    expect(screen.getByText("0 of 0 items")).toBeInTheDocument();
  });

  it("uses the Capability type for Large Solutions", async () => {
    const config = makeConfig({ types: { epic: "Epic", capability: "Capability", feature: "Feature", story: "User Story" } });
    config.root.children = [{ id: "n-sol", name: "Solution", level: "solution", areaPath: "Fabrikam", children: config.root.children }];
    await renderList("n-sol", config);
    expect(callsTo(/wiql/)[0].body.query).toContain("IN ('Capability')");
    expect(screen.getByText("No Capability items in Solution.")).toBeInTheDocument();
  });
});

describe("Work Item List helpers", () => {
  it("builds columns per level", () => {
    expect(columnsFor("portfolio")).toHaveLength(9);
    expect(columnsFor("solution").map((c) => c.key).slice(9)).toEqual(["teams", "owner", "pis"]);
    expect(columnsFor("team").at(-1)!.key).toBe("piInvolvement");
  });

  it("quotes CSV cells only when needed", () => {
    expect(toCsv(["a", "b"], [["x,y", 'q"'], ["line\nbreak", 3]])).toBe('a,b\r\n"x,y","q"""\r\n"line\nbreak",3');
  });

  it("finds involved teams and the PI of an iteration", () => {
    const art = makeConfig().root.children[0];
    const row = { item: { id: 1, fields: {} }, category: "", parentId: null, parentOnItem: false, childAreas: [RED + "\\Sub"] };
    expect(teamsInvolved(art, row).map((n) => n.id)).toEqual(["n-red"]);
    const pis = [{ name: "PI 1", path: PI1, identifier: "", sprints: [] }];
    expect(piOf(PI1 + "\\S1", pis)?.name).toBe("PI 1");
    expect(piOf(undefined, pis)).toBeUndefined();
  });
});
