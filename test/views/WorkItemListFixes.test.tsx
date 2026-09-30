import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { csvCell, WorkItemList } from "../../src/views/WorkItemList";
import { callsTo, dataStore, fail, fake, makeConfig } from "../fakeAdo";
import { renderView } from "../utils";

const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const CHILD = "System.LinkTypes.Hierarchy-Forward";
const url = (id: number) => `${fake.baseUrl}/_apis/wit/workItems/${id}`;

async function renderList(nodeId = "n-arta") {
  const r = await renderView(<WorkItemList />, { nodeId, config: makeConfig() });
  await waitFor(() => expect(document.querySelector(".spinner")).toBeNull());
  return r;
}

const ids = () => Array.from(document.querySelectorAll("tbody tr")).map((tr) => Number(tr.getAttribute("data-id")));
const patches = (id: number) => callsTo(new RegExp(`^_apis/wit/workitems/${id}$`), "PATCH");
const parentsOf = (id: number) => (fake.workItems.get(id)!.relations ?? []).filter((r) => r.rel === PARENT).map((r) => r.url);
const hasChild = (parent: number, child: number) => (fake.workItems.get(parent)!.relations ?? []).some((r) => r.rel === CHILD && r.url === url(child));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Work Item List fixes", () => {
  it("applies the WIQL of active quick filters in the load query", async () => {
    dataStore.collections.set(
      `quickfilters-${fake.projectId}`,
      new Map([["q1", { id: "q1", name: "Wallet only", filter: { text: "", types: [], states: [], assignees: [], tags: [], wiql: "[System.Title] = 'Wallet'" }, __etag: 1 }]])
    );
    await renderList();
    expect(ids()).toEqual([10, 11, 12, 14, 15]);
    const menu = screen.getByRole("group", { name: "Quick filters" });
    fireEvent.click(await within(menu).findByLabelText("Wallet only"));
    await waitFor(() => expect(ids()).toEqual([14]));
    expect(callsTo(/wiql/).some((c) => c.body.query.includes("AND ([System.Title] = 'Wallet') ORDER BY"))).toBe(true);
  });

  it("re-parents a link held only by the old parent: adds first, removes after, rolls back on failure", async () => {
    // #11's link to Epic #1 is only on the epic's side.
    fake.workItems.get(11)!.relations = fake.workItems.get(11)!.relations!.filter((r) => r.rel !== PARENT);
    // The portfolio with all types loads the epics, so the parent is known from the epic's side.
    await renderList("n-root");
    fireEvent.click(screen.getByLabelText(/Show all types/));
    await waitFor(() => expect(ids()).toContain(11));
    const input = () => screen.getByLabelText("Parent of #11");
    expect(input()).toHaveValue("1");

    fail(/PATCH _apis\/wit\/workitems\/1$/, 409, "Epic locked", { once: true });
    fireEvent.change(input(), { target: { value: "2" } });
    fireEvent.blur(input());
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not update the parent of #11: Epic locked");
    expect(input()).toHaveValue("1");
    expect(parentsOf(11)).toEqual([]);
    expect(hasChild(1, 11)).toBe(true);
    expect(hasChild(2, 11)).toBe(false);
    // Add, then the rollback removal.
    expect(patches(11).map((c) => c.body[0].op)).toEqual(["add", "remove"]);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.change(input(), { target: { value: "2" } });
    fireEvent.blur(input());
    await waitFor(() => expect(hasChild(1, 11)).toBe(false));
    expect(parentsOf(11)).toEqual([url(2)]);
    await waitFor(() => expect(input()).toHaveValue("2"));
  });

  it("reports a work item that disappeared before the parent change", async () => {
    await renderList();
    fake.workItems.delete(15);
    fireEvent.change(screen.getByLabelText("Parent of #15"), { target: { value: "1" } });
    fireEvent.blur(screen.getByLabelText("Parent of #15"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not update the parent of #15: the work item no longer exists");
  });

  it("filters by the Teams involved facet on an ART", async () => {
    await renderList();
    const facet = screen.getByRole("group", { name: "Teams involved filter" });
    expect(within(facet).getAllByRole("checkbox").map((c) => c.parentElement!.textContent!.trim())).toEqual(["Team Blue", "Team Red"]);
    fireEvent.click(within(facet).getByLabelText("Team Blue"));
    expect(ids()).toEqual([11, 14]);
  });

  it("exports CSV with a UTF-8 BOM and neutralises whitespace-prefixed formulas", async () => {
    const created: Blob[] = [];
    (URL as any).createObjectURL = vi.fn((b: Blob) => (created.push(b), "blob:csv"));
    (URL as any).revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fake.workItems.get(12)!.fields["System.Title"] = " =1+1";
    await renderList();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    const bytes = new Uint8Array(await created[0].arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(await created[0].text()).toContain("12,Feature,' =1+1,");

    expect(csvCell(" =1")).toBe("' =1");
    expect(csvCell("\t@x")).toBe("'\t@x");
    expect(csvCell("\n+2")).toBe("\"'\n+2\"");
    expect(csvCell("a =1")).toBe("a =1");
    expect(csvCell(-3)).toBe("-3");
  });
});
