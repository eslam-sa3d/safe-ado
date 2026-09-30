import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuditEntry } from "../../src/api/audit";
import { exportData, objectivesStore, risksStore } from "../../src/api/data";
import { findNode } from "../../src/api/org";
import { PiObjective, SafeConfig } from "../../src/api/types";
import { ObjectivesView } from "../../src/views/ObjectivesView";
import { PiPlanningView } from "../../src/views/PiPlanningView";
import { PortfolioKanban } from "../../src/views/PortfolioKanban";
import { RisksView } from "../../src/views/RisksView";
import { RoadmapView } from "../../src/views/RoadmapView";
import { SetupView } from "../../src/views/SetupView";
import { TeamBoard } from "../../src/views/TeamBoard";
import { dataStore, docs, fail, fake, makeConfig, PI2, seedDocs } from "../fakeAdo";
import { renderApp, renderView } from "../utils";

const UNVERIFIED_PLAN = { unverified: ["plan" as const] };
const UNVERIFIED_ADMIN = { unverified: ["admin" as const] };
const GRACE = { id: "u-grace", name: "grace@fabrikam.com", displayName: "Grace Hopper" };

const objective = (patch: Partial<PiObjective> = {}): PiObjective => ({
  id: "o1",
  piPath: PI2,
  nodeId: "n-red",
  title: "Ship payments",
  committed: true,
  plannedBV: 8,
  actualBV: null,
  featureIds: [],
  ...patch,
});
const entry = (id: string, at: string, patch: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  at,
  collection: "objectives",
  docId: "o1",
  action: "update",
  user: { id: "u-ada", displayName: "Ada Lovelace" },
  changes: [{ field: "title", from: "A", to: "B" }],
  ...patch,
});

/** ART A has Grace Hopper (identity) as its Business Owner. */
function withBusinessOwner(): SafeConfig {
  const config = makeConfig();
  config.root.children[0].members = [
    { name: "Grace Hopper", role: "Business Owner", safeRole: "businessOwner", id: "u-grace", uniqueName: "grace@fabrikam.com" },
    { name: "Rita", role: "RTE" },
  ];
  return config;
}

const redPanel = () => screen.getByRole("heading", { name: "Team Red" }).closest(".panel") as HTMLElement;

async function renderObjectives(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<ObjectivesView />, opts);
  await screen.findAllByRole("heading", { level: 3 });
  return r;
}

describe("PI objectives — history", () => {
  it("records who changed an objective and shows it in the History dialog", async () => {
    await objectivesStore.save(objective());
    fake.user = GRACE;
    await renderObjectives();
    const title = within(redPanel()).getByDisplayValue("Ship payments");
    fireEvent.change(title, { target: { value: "Ship payments v2" } });
    fireEvent.blur(title);
    await waitFor(() => expect(docs("objectives")[0].title).toBe("Ship payments v2"));
    expect(docs("objectives")[0]).toMatchObject({ createdBy: { displayName: "Ada Lovelace" }, modifiedBy: { displayName: "Grace Hopper" } });

    fireEvent.click(await screen.findByRole("button", { name: "History of Ship payments v2" }));
    const dialog = screen.getByRole("dialog", { name: "History: Ship payments v2" });
    await waitFor(() => expect(within(dialog).getAllByTestId("audit-entry")).toHaveLength(2));
    const [latest, first] = within(dialog).getAllByTestId("audit-entry");
    expect(latest).toHaveTextContent("Grace Hopper");
    expect(latest).toHaveTextContent("Changed");
    expect(latest).toHaveTextContent("title: Ship payments → Ship payments v2");
    expect(first).toHaveTextContent("Ada Lovelace");
    expect(first).toHaveTextContent("Created");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows an empty history and load errors", async () => {
    seedDocs("objectives", [objective()]);
    await renderObjectives();
    fireEvent.click(screen.getByRole("button", { name: "History of Ship payments" }));
    expect(await screen.findByText("No changes recorded yet.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);

    dataStore.failures.push({ op: "getDocuments", error: Object.assign(new Error("audit down"), { status: 500 }) });
    fireEvent.click(screen.getByRole("button", { name: "History of Ship payments" }));
    expect(await screen.findByText("Could not load the history: audit down")).toBeInTheDocument();
  });

  it("is available to read-only users", async () => {
    seedDocs("objectives", [objective()]);
    await renderObjectives({ can: { plan: false } });
    expect(screen.getByRole("button", { name: "History of Ship payments" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete objective" })).toBeNull();
  });
});

describe("PI objectives — Business Owners enter Actual BV", () => {
  it("keeps today's behaviour when the unit has no Business Owners", async () => {
    seedDocs("objectives", [objective()]);
    await renderObjectives();
    const actual = within(redPanel()).getByLabelText("Actual BV");
    expect(actual).toBeEnabled();
    fireEvent.change(actual, { target: { value: "7" } });
    fireEvent.blur(actual);
    await waitFor(() => expect(docs("objectives")[0].actualBV).toBe(7));
    expect(docs("objectives")[0]).toMatchObject({ actualBVBy: { id: "u-ada", displayName: "Ada Lovelace" } });
    expect(docs("objectives")[0].actualBVAt).toEqual(expect.any(String));
    expect(await within(redPanel()).findByText(/^by Ada Lovelace/)).toBeInTheDocument();
  });

  it("locks Actual BV for everyone but the unit's (or an ancestor's) Business Owners", async () => {
    seedDocs("objectives", [objective({ actualBV: 5 })]);
    await renderObjectives({ config: withBusinessOwner() });
    const actual = within(redPanel()).getByLabelText("Actual BV");
    expect(actual).toBeDisabled();
    expect(actual).toHaveAttribute("title", "Only this unit's Business Owners can enter Actual BV: Grace Hopper");
    expect(within(redPanel()).getByText("Business Owners only")).toBeInTheDocument();
    // Everything else stays editable.
    expect(within(redPanel()).getByDisplayValue("Ship payments")).toBeEnabled();
  });

  it("lets a Business Owner (matched by identity) enter Actual BV and records it", async () => {
    fake.user = GRACE;
    seedDocs("objectives", [objective()]);
    await renderObjectives({ config: withBusinessOwner() });
    const actual = within(redPanel()).getByLabelText("Actual BV");
    expect(actual).toBeEnabled();
    expect(within(redPanel()).queryByText("Business Owners only")).toBeNull();
    fireEvent.change(actual, { target: { value: "9" } });
    fireEvent.blur(actual);
    await waitFor(() => expect(docs("objectives")[0].actualBV).toBe(9));
    expect(docs("objectives")[0].actualBVBy).toEqual({ id: "u-grace", displayName: "Grace Hopper", uniqueName: "grace@fabrikam.com" });
    expect(await within(redPanel()).findByText(/^by Grace Hopper/)).toBeInTheDocument();
    // Other edits don't touch the Actual BV stamp.
    const planned = within(redPanel()).getAllByRole("spinbutton")[0];
    fireEvent.change(planned, { target: { value: "6" } });
    fireEvent.blur(planned);
    await waitFor(() => expect(docs("objectives")[0].plannedBV).toBe(6));
    expect(docs("objectives")[0].actualBVBy.id).toBe("u-grace");
  });
});

describe("Risks — history and stamps", () => {
  it("shows who raised and last changed a risk, and its history", async () => {
    const base = { piPath: PI2, nodeId: "n-red", description: "", owner: "", impact: "High" as const, status: "Unroamed" as const, createdAt: "2026-09-01T00:00:00Z" };
    await risksStore.save({ id: "r1", title: "Vendor delay", ...base });
    fake.user = GRACE;
    const saved = docs("risks")[0];
    await risksStore.save({ ...saved, status: "Owned" });
    await renderView(<RisksView />);
    fireEvent.click(await screen.findByText("Vendor delay"));
    const dialog = screen.getByRole("dialog", { name: "Edit risk" });
    expect(within(dialog).getByText(/Raised by Ada Lovelace/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Last changed by Grace Hopper/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "History of Vendor delay" }));
    const history = screen.getByRole("dialog", { name: "History: Vendor delay" });
    await waitFor(() => expect(within(history).getAllByTestId("audit-entry")).toHaveLength(2));
    expect(within(history).getAllByTestId("audit-entry")[0]).toHaveTextContent("status: Unroamed → Owned");
  });

  it("offers the history to read-only users and none for a new risk", async () => {
    seedDocs("risks", [{ id: "r1", title: "Vendor delay", piPath: PI2, nodeId: "n-red", description: "", owner: "", impact: "High", status: "Unroamed", createdAt: "" }]);
    const { unmount } = await renderView(<RisksView />, { can: { plan: false } });
    fireEvent.click(await screen.findByText("Vendor delay"));
    expect(within(screen.getByRole("dialog", { name: "Risk details" })).getByRole("button", { name: "History of Vendor delay" })).toBeInTheDocument();
    unmount();
    await renderView(<RisksView />);
    fireEvent.click(await screen.findByRole("button", { name: /New risk/ }));
    expect(within(screen.getByRole("dialog", { name: "New risk" })).queryByRole("button", { name: /History/ })).toBeNull();
  });
});

describe("Permissions fail closed for extension data", () => {
  it("makes objectives and risks read-only with an explanation when the check could not be answered", async () => {
    seedDocs("objectives", [objective()]);
    const { unmount } = await renderObjectives({ can: UNVERIFIED_PLAN });
    expect(screen.getByRole("status")).toHaveTextContent("Your permissions could not be verified");
    expect(screen.getByRole("status")).toHaveTextContent("Azure DevOps cannot protect SAFe Ado's own data");
    // Outside the shell there is nothing to retry with.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: /New objective/ })).toBeNull();
    expect(within(redPanel()).getByDisplayValue("Ship payments")).toBeDisabled();
    unmount();

    await renderView(<RisksView />, { can: UNVERIFIED_PLAN });
    await screen.findByText(/\d+ risks/);
    expect(screen.getByText(/Your permissions could not be verified/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New risk/ })).toBeNull();
  });

  it("locks capacity, milestones and PI planning records but keeps Azure DevOps-enforced work item edits", async () => {
    const kanban = await renderView(<PortfolioKanban />, { nodeId: "n-root", can: UNVERIFIED_PLAN });
    await screen.findByText("Checkout revamp");
    expect(screen.queryByText(/read-only access/)).toBeNull();
    expect(screen.getByText("Checkout revamp").closest("[draggable]")).toHaveAttribute("draggable", "true");
    kanban.unmount();

    const board = await renderView(<TeamBoard />, { nodeId: "n-red", can: UNVERIFIED_PLAN });
    await screen.findByText("Charge card");
    expect(screen.queryByRole("button", { name: /of capacity/ })).toBeNull();
    expect(screen.getByText(/Your permissions could not be verified/)).toBeInTheDocument();
    expect(screen.queryByText(/Read-only: you don't have permission/)).toBeNull();
    board.unmount();

    seedDocs("milestones", [{ id: "m1", nodeId: "n-arta", title: "Beta", date: "2026-10-01" }]);
    const roadmap = await renderView(<RoadmapView />, { can: UNVERIFIED_PLAN });
    await waitFor(() => expect(screen.queryByText("Loading roadmap…")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "New milestone" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Milestone Beta" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/read-only access to this area/)).toBeNull();
    roadmap.unmount();

    await renderView(<PiPlanningView />, { can: UNVERIFIED_PLAN });
    await screen.findByRole("heading", { name: "PI summary" });
    expect(screen.getByText(/You can view the PI Planning event but not change it/)).toBeInTheDocument();
  });

  it("makes Setup read-only when the admin check could not be answered, but keeps Export", async () => {
    await renderView(<SetupView firstRun={false} />, { nodeId: "n-root", can: UNVERIFIED_ADMIN });
    await screen.findByRole("heading", { name: "Work item types" });
    expect(screen.getByText(/Read-only: only project administrators/)).toBeInTheDocument();
    expect(screen.getByText(/Your permissions could not be verified/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save configuration" })).toBeNull();
    expect(screen.getByRole("button", { name: /Export SAFe data/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Import/ })).toBeNull();
  });

  it("retries the checks from the shell and unlocks once they succeed", async () => {
    // The unit's planning probe fails with a server error: unknown, not denied.
    fail(/workitems\/\$/, 500, "server busy");
    seedDocs("objectives", [objective({ nodeId: "n-arta", title: "ART goal" })]);
    await renderApp({ nodeId: "n-arta", view: "objectives" });
    const notice = await screen.findByText(/Your permissions could not be verified/);
    expect(screen.getByDisplayValue("ART goal")).toBeDisabled();
    fake.failures = [];
    fireEvent.click(within(notice.closest(".permission-notice") as HTMLElement).getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(screen.queryByText(/Your permissions could not be verified/)).toBeNull());
    await waitFor(() => expect(screen.getByDisplayValue("ART goal")).toBeEnabled());
  });

  it("treats every check as unverified when the permission sources can't be read at all", async () => {
    fail(/classificationnodes/, 500, "trees unavailable");
    await renderApp({ nodeId: "n-root", view: "setup" });
    expect(await screen.findByText(/Your permissions could not be verified/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save configuration" })).toBeNull();
  });
});

describe("Setup — backup and restore", () => {
  async function renderSetup(opts: Parameters<typeof renderView>[1] = {}) {
    const r = await renderView(<SetupView firstRun={false} />, { nodeId: "n-root", ...opts });
    await screen.findByRole("heading", { name: "Work item types" });
    return r;
  }
  const backupPanel = () => screen.getByRole("heading", { name: "Backup & restore" }).closest(".panel") as HTMLElement;

  async function pickFile(content: string, name = "backup.json") {
    const input = within(backupPanel()).getByLabelText("Backup file") as HTMLInputElement;
    const file = new File([content], name, { type: "application/json" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
  }

  it("exports the configuration and every collection as one JSON file", async () => {
    seedDocs("objectives", [objective()]);
    const blobs: Blob[] = [];
    (URL as any).createObjectURL = vi.fn((b: Blob) => (blobs.push(b), "blob:backup"));
    (URL as any).revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await renderSetup();
    fireEvent.click(within(backupPanel()).getByRole("button", { name: /Export SAFe data/ }));
    expect(await within(backupPanel()).findByText("Exported the configuration and 1 document.")).toBeInTheDocument();
    const backup = JSON.parse(await blobs[0].text());
    expect(backup).toMatchObject({ format: "safe-ado-backup", schemaVersion: 1, project: { id: "p1" } });
    expect(backup.collections.objectives).toHaveLength(1);
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it("reports export failures", async () => {
    await renderSetup();
    dataStore.failures.push({ op: "getDocuments", error: Object.assign(new Error("service down"), { status: 500 }) });
    fireEvent.click(within(backupPanel()).getByRole("button", { name: /Export SAFe data/ }));
    expect(await within(backupPanel()).findByText("Could not export: service down")).toBeInTheDocument();
  });

  it("rejects files that are not valid backups before writing anything", async () => {
    await renderSetup();
    await pickFile("{not json", "broken.json");
    expect(within(backupPanel()).getByText("broken.json is not a valid JSON file.")).toBeInTheDocument();
    await pickFile(JSON.stringify({ format: "something-else" }));
    expect(within(backupPanel()).getByText("This is not a SAFe Ado backup file.")).toBeInTheDocument();
    // Choosing nothing does nothing.
    await act(async () => {
      fireEvent.change(within(backupPanel()).getByLabelText("Backup file"), { target: { files: [] } });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a summary and merges documents and the configuration after confirmation", async () => {
    seedDocs("objectives", [objective()]);
    const backup = JSON.parse(JSON.stringify(await exportData()));
    backup.config = makeConfig({ storyPointsField: "Microsoft.VSTS.Scheduling.Effort" });
    backup.collections.risks = [{ id: "r1", title: "Restored risk" }];
    backup.exportedBy = { id: "u-grace", displayName: "Grace Hopper" };
    seedDocs("objectives", []);
    const { ctx } = await renderSetup();
    await pickFile(JSON.stringify(backup));
    const dialog = screen.getByRole("dialog", { name: "Import SAFe data" });
    expect(dialog).toHaveTextContent("Backup of Fabrikam");
    expect(dialog).toHaveTextContent("by Grace Hopper: 2 documents and the configuration.");
    expect(within(dialog).getByRole("row", { name: "objectives 1" })).toBeInTheDocument();
    expect(within(dialog).getByRole("row", { name: "risks 1" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/another project/)).toBeNull();
    expect(within(dialog).getByRole("radio", { name: /Merge/ })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(await within(backupPanel()).findByText(/Restored 2 documents and the configuration\./)).toBeInTheDocument();
    expect(docs("risks").map((r) => r.title)).toEqual(["Restored risk"]);
    expect(ctx.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ storyPointsField: "Microsoft.VSTS.Scheduling.Effort" }));
    // The Setup form shows the restored configuration.
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });

  it("overwrites without the configuration and warns about another project", async () => {
    seedDocs("risks", [{ id: "r-old", title: "Old" }]);
    const backup = JSON.parse(JSON.stringify(await exportData()));
    backup.project = { id: "p-other", name: "Contoso" };
    backup.config = makeConfig();
    backup.collections.risks = [];
    backup.collections.future = [{ id: "x" }];
    const { ctx } = await renderSetup();
    await pickFile(JSON.stringify(backup));
    const dialog = screen.getByRole("dialog", { name: "Import SAFe data" });
    expect(within(dialog).getByText(/This backup comes from another project/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Not restored \(unknown to this version\): future/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Overwrite/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Restore the configuration/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(await within(backupPanel()).findByText(/Restored 0 documents, removed 1\./)).toBeInTheDocument();
    expect(docs("risks")).toEqual([]);
    expect(ctx.saveConfig).not.toHaveBeenCalled();
  });

  it("can be cancelled, and reports failed imports", async () => {
    const backup = JSON.parse(JSON.stringify(await exportData()));
    backup.config = null;
    backup.collections.risks = [{ id: "r1", title: "One" }];
    await renderSetup();
    await pickFile(JSON.stringify(backup));
    expect(screen.getByRole("dialog", { name: "Import SAFe data" })).toHaveTextContent("1 document.");
    expect(screen.queryByRole("checkbox", { name: /Restore the configuration/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(docs("risks")).toEqual([]);

    await pickFile(JSON.stringify(backup));
    dataStore.failures.push({ op: "setDocument", error: new Error("quota exceeded") });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await within(backupPanel()).findByText(/Could not import: quota exceeded/)).toBeInTheDocument();
  });

  it("offers import to administrators only", async () => {
    await renderSetup({ can: { admin: false } });
    expect(within(backupPanel()).queryByRole("button", { name: /Import/ })).toBeNull();
    expect(within(backupPanel()).getByText("Only project administrators can import a backup.")).toBeInTheDocument();
    expect(within(backupPanel()).getByRole("button", { name: /Export SAFe data/ })).toBeEnabled();
  });

  it("opens the file picker from the Import button", async () => {
    await renderSetup();
    const input = within(backupPanel()).getByLabelText("Backup file") as HTMLInputElement;
    const click = vi.spyOn(input, "click").mockImplementation(() => undefined);
    fireEvent.click(within(backupPanel()).getByRole("button", { name: /Import/ }));
    expect(click).toHaveBeenCalled();
  });
});

describe("Setup — audit log", () => {
  const auditPanel = () => screen.getByRole("heading", { name: "Audit log" }).closest(".panel") as HTMLElement;
  async function openLog() {
    await renderView(<SetupView firstRun={false} />, { nodeId: "n-root" });
    await screen.findByRole("heading", { name: "Work item types" });
    fireEvent.click(within(auditPanel()).getByRole("button", { name: /Show audit log/ }));
  }

  it("lists changes newest first and filters by data and user", async () => {
    seedDocs("audit", [
      entry("a1", "2026-09-01T10:00:00Z", { label: "Ship payments" }),
      entry("a2", "2026-09-02T10:00:00Z", { collection: "risks", docId: "r1", label: "Vendor delay", user: { id: "u-grace", displayName: "Grace Hopper" }, action: "create", changes: [] }),
      entry("a3", "2026-09-03T10:00:00Z", { collection: "config", docId: "config", changes: [{ field: "root" }] }),
      entry("a4", "2026-09-04T10:00:00Z", { collection: "backup", docId: "import", action: "import", label: "Restored 3 documents (merge)", changes: undefined }),
      entry("a5", "2026-09-05T10:00:00Z", { action: "delete", label: undefined, changes: [{ field: "note", from: "" }] }),
    ]);
    await openLog();
    const rows = await within(auditPanel()).findAllByTestId("audit-entry");
    expect(rows.map((r) => within(r).getAllByRole("cell")[2].textContent)).toEqual(["Deleted", "Imported", "Changed", "Created", "Changed"]);
    expect(rows[0]).toHaveTextContent("o1");
    expect(rows[0]).toHaveTextContent("note: (empty) → (empty)");
    expect(rows[1]).toHaveTextContent("Restored 3 documents (merge)");
    expect(rows[2]).toHaveTextContent("root changed");
    expect(rows[3]).toHaveTextContent("—");
    expect(within(auditPanel()).getByText("5 changes")).toBeInTheDocument();

    fireEvent.change(within(auditPanel()).getByLabelText("Filter by data"), { target: { value: "risks" } });
    expect(within(auditPanel()).getAllByTestId("audit-entry")).toHaveLength(1);
    expect(within(auditPanel()).getByText("1 change")).toBeInTheDocument();
    fireEvent.change(within(auditPanel()).getByLabelText("Filter by data"), { target: { value: "" } });
    fireEvent.change(within(auditPanel()).getByLabelText("Filter by user"), { target: { value: "u-ada" } });
    expect(within(auditPanel()).getAllByTestId("audit-entry")).toHaveLength(4);
    fireEvent.change(within(auditPanel()).getByLabelText("Filter by user"), { target: { value: "u-grace" } });
    expect(within(auditPanel()).getAllByTestId("audit-entry")).toHaveLength(1);
  });

  it("pages long logs, refreshes, and reports load errors", async () => {
    seedDocs(
      "audit",
      Array.from({ length: 130 }, (_, i) => entry(`e${String(i).padStart(3, "0")}`, new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(), { user: { id: "", displayName: "Legacy user" } }))
    );
    await openLog();
    expect(await within(auditPanel()).findAllByTestId("audit-entry")).toHaveLength(100);
    fireEvent.click(within(auditPanel()).getByRole("button", { name: "Show more (30 older)" }));
    expect(within(auditPanel()).getAllByTestId("audit-entry")).toHaveLength(130);
    // Users without an id are filtered by name.
    fireEvent.change(within(auditPanel()).getByLabelText("Filter by user"), { target: { value: "Legacy user" } });
    expect(within(auditPanel()).getAllByTestId("audit-entry")).toHaveLength(130);

    dataStore.failures.push({ op: "getDocuments", error: Object.assign(new Error("log down"), { status: 500 }) });
    fireEvent.click(within(auditPanel()).getByRole("button", { name: /Refresh/ }));
    expect(await within(auditPanel()).findByText("Could not load the audit log: log down")).toBeInTheDocument();
  });

  it("shows an empty log", async () => {
    await openLog();
    expect(await within(auditPanel()).findByText("No changes recorded yet.")).toBeInTheDocument();
  });
});

describe("Setup — SAFe roles", () => {
  it("maps older free-text roles and keeps unknown ones as Other with their label", async () => {
    const config = makeConfig();
    config.root.children[0].members = [
      { name: "Rita", role: "release train engineer" },
      { name: "Hal", role: "Chief Happiness Officer" },
    ];
    const { ctx } = await renderView(<SetupView firstRun={false} />, { nodeId: "n-root", config });
    await screen.findByRole("heading", { name: "Work item types" });
    fireEvent.click(screen.getByRole("button", { name: "Members of ART A" }));
    const group = screen.getByRole("group", { name: "ART A members" });
    expect((within(group).getByLabelText("Member 1 role") as HTMLSelectElement).value).toBe("rte");
    expect(within(group).queryByLabelText("Member 1 custom role")).toBeNull();
    expect((within(group).getByLabelText("Member 2 role") as HTMLSelectElement).value).toBe("other");
    expect((within(group).getByLabelText("Member 2 custom role") as HTMLInputElement).value).toBe("Chief Happiness Officer");

    fireEvent.change(within(group).getByLabelText("Member 2 role"), { target: { value: "businessOwner" } });
    fireEvent.change(within(group).getByLabelText("Member 1 name"), { target: { value: "Rita R." } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await screen.findByText("Saved ✓");
    const saved = ctx.saveConfig.mock.calls.at(-1)![0] as SafeConfig;
    expect(findNode(saved.root, "n-arta")!.members).toEqual([
      { name: "Rita R.", role: "release train engineer" },
      { name: "Hal", role: "Business Owner", safeRole: "businessOwner" },
    ]);
  });
});
