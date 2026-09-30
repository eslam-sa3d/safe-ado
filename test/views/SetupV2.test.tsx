import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { findNode } from "../../src/api/org";
import { Capabilities } from "../../src/api/permissions";
import { SafeConfig } from "../../src/api/types";
import { SafeContext, useSafe } from "../../src/components/context";
import { checklist, dependencyLinkOptions, reverseLinkType, SetupView } from "../../src/views/SetupView";
import { fail, fake, makeConfig } from "../fakeAdo";
import { renderView } from "../utils";

const lastSaved = (ctx: { saveConfig: any }) => ctx.saveConfig.mock.calls.at(-1)[0] as SafeConfig;
const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
const nodeRow = (name: string) =>
  (screen.getAllByLabelText("Name").find((i) => (i as HTMLInputElement).value === name) as HTMLElement).closest(".node-row") as HTMLElement;

function Override({ can, children }: { can?: Capabilities; children: ReactNode }) {
  const ctx = useSafe();
  return <SafeContext.Provider value={{ ...ctx, can: can ?? ctx.can }}>{children}</SafeContext.Provider>;
}

async function renderSetup(opts: { config?: SafeConfig; can?: Capabilities } = {}) {
  const r = await renderView(
    <Override can={opts.can}>
      <SetupView firstRun={false} />
    </Override>,
    { nodeId: "n-root", config: opts.config }
  );
  await screen.findByRole("heading", { name: "Work item types" });
  return r;
}

async function save(ctx: { saveConfig: any }) {
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await screen.findByText("Saved ✓");
  return lastSaved(ctx);
}

const checklistPanel = () => screen.getByRole("region", { name: "Configuration checklist" });
const item = (key: string) => checklistPanel().querySelector(`[data-check="${key}"]`) as HTMLElement;
const isOk = (key: string) => item(key).classList.contains("ok");

describe("Setup — configuration checklist", () => {
  it("checks the default configuration", async () => {
    await renderSetup();
    expect(within(checklistPanel()).getByText("7 of 8 done")).toBeInTheDocument();
    for (const k of ["types", "points", "piRoot", "pis", "art", "teams", "link"]) expect(isOk(k)).toBe(true);
    expect(item("pis")).toHaveTextContent("2 PIs");
    expect(item("link")).toHaveTextContent("Default (Successor / Predecessor)");
    expect(isOk("members")).toBe(false);
    expect(within(item("members")).getByRole("img", { name: "Missing" })).toHaveTextContent("✗");
    expect(item("members")).toHaveTextContent("No members: ART A, ART B");
    expect(within(item("types")).getByRole("img", { name: "Done" })).toHaveTextContent("✓");
  });

  it("updates while editing the draft", async () => {
    await renderSetup();
    fireEvent.change(select("Team level (Story)"), { target: { value: "" } });
    expect(isOk("types")).toBe(false);
    expect(item("types")).toHaveTextContent("Choose the Epic, Feature and Story types.");
    fireEvent.change(select("PI root iteration"), { target: { value: "Fabrikam\\Undated" } });
    expect(isOk("pis")).toBe(false);
    expect(item("pis")).toHaveTextContent("Create one in PIs & Iterations.");
    fireEvent.change(within(nodeRow("Team Red")).getByLabelText("Area path"), { target: { value: "" } });
    expect(item("teams")).toHaveTextContent("Incomplete: Team Red");
  });

  it("scrolls to the related section", async () => {
    await renderSetup();
    const scroll = vi.fn();
    (Element.prototype as any).scrollIntoView = scroll;
    fireEvent.click(within(item("link")).getByRole("button", { name: "Dependency link type set" }));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.instances[0]).toBe(document.getElementById("setup-dependencies"));
    fireEvent.click(within(item("members")).getByRole("button"));
    expect(scroll.mock.instances[1]).toBe(document.getElementById("setup-hierarchy"));
    delete (Element.prototype as any).scrollIntoView;
    // Without scrolling support nothing breaks.
    fireEvent.click(within(item("types")).getByRole("button"));
  });

  it("evaluates each rule", () => {
    const meta = {
      types: ["Epic", "Feature", "User Story"],
      numericFields: [{ referenceName: "Microsoft.VSTS.Scheduling.StoryPoints" }],
      iterations: ["Fabrikam", "Fabrikam\\PIs"],
      childCount: new Map([
        ["fabrikam", 1],
        ["fabrikam\\pis", 1],
      ]),
      relationTypes: [{ referenceName: "System.LinkTypes.Dependency-Forward", name: "Successor" }],
    };
    const byKey = (c: SafeConfig, m: typeof meta | undefined = meta) => Object.fromEntries(checklist(c, m).map((i) => [i.key, i]));

    const good = makeConfig();
    good.root.children.forEach((a) => (a.members = [{ name: "Rita", role: "RTE" }]));
    expect(checklist(good, meta).every((i) => i.ok)).toBe(true);
    expect(byKey(good).pis.detail).toBe("1 PI");

    const bad = makeConfig({
      piRootIteration: "Fabrikam\\Gone",
      storyPointsField: "System.Title",
      types: { epic: "Epic", capability: "", feature: "Feature", story: "User Story", enabler: "Enabler" },
      dependencyLink: { forward: "X.Gone", reverse: "X.Gone" },
    });
    bad.root.children = [];
    const b = byKey(bad);
    expect(b.types).toMatchObject({ ok: false, detail: "Not in this process: Enabler" });
    expect(b.points.ok).toBe(false);
    expect(b.piRoot).toMatchObject({ ok: false, detail: "Fabrikam\\Gone" });
    expect(b.art.ok).toBe(false);
    expect(b.members.ok).toBe(false);
    expect(b.link).toMatchObject({ ok: false, detail: "Unknown link type X.Gone" });

    // A configured link type that exists, or unknown relation types, count as set.
    const linked = makeConfig({ dependencyLink: { forward: "System.LinkTypes.Dependency-Forward", reverse: "System.LinkTypes.Dependency-Reverse" } });
    expect(byKey(linked).link).toMatchObject({ ok: true, detail: undefined });
    expect(byKey(bad, { ...meta, relationTypes: [] }).link.ok).toBe(true);
    // Before metadata loads nothing about the project can be confirmed.
    const unloaded = checklist(good, undefined);
    expect(unloaded.find((i) => i.key === "piRoot")!.ok).toBe(false);
    expect(unloaded.find((i) => i.key === "types")!.detail).toBe("Not in this process: Epic, Feature, User Story");
  });
});

describe("Setup — dependency link, optional types and RR/OE", () => {
  it("chooses the dependency link type with its paired reverse", async () => {
    const { ctx } = await renderSetup();
    const linkSelect = select("Dependency link type");
    expect(linkSelect.value).toBe("System.LinkTypes.Dependency-Forward");
    expect(Array.from(linkSelect.options).map((o) => o.value)).toEqual([
      "System.LinkTypes.Dependency-Forward",
      "System.LinkTypes.Related",
      "Custom.Blocks-Forward",
    ]);
    expect(document.querySelector(".link-direction")).toHaveTextContent(
      "Direction: provider → consumer. The provider links to the consumer with Dependency-Forward; the consumer links back with Dependency-Reverse."
    );

    fireEvent.change(linkSelect, { target: { value: "System.LinkTypes.Related" } });
    expect(document.querySelector(".link-direction")).toHaveTextContent("symmetric link");
    expect((await save(ctx)).dependencyLink).toEqual({ forward: "System.LinkTypes.Related", reverse: "System.LinkTypes.Related" });

    fireEvent.change(select("Dependency link type"), { target: { value: "Custom.Blocks-Forward" } });
    expect((await save(ctx)).dependencyLink).toEqual({ forward: "Custom.Blocks-Forward", reverse: "Custom.Blocks-Reverse" });
    // A reverse end the server did not list is shown by reference name.
    expect(document.querySelector(".link-direction")).toHaveTextContent("links back with Custom.Blocks-Reverse");
  });

  it("keeps the configured link type when link types cannot be loaded", async () => {
    fail(/workitemrelationtypes/, 500, "nope");
    await renderSetup({ config: makeConfig({ dependencyLink: { forward: "Custom.Needs-Forward", reverse: "Custom.Needs-Reverse" } }) });
    expect(Array.from(select("Dependency link type").options).map((o) => o.value)).toEqual(["Custom.Needs-Forward"]);
    expect(screen.queryByText("nope")).toBeNull();
  });

  it("filters and pairs link types", () => {
    const t = (referenceName: string, topology: string) => ({ referenceName, name: referenceName, attributes: { topology } });
    expect(
      dependencyLinkOptions([t("A-Forward", "dependency"), t("A-Reverse", "dependency"), t("H", "tree"), t("R", "network"), { referenceName: "N", name: "N" }]).map(
        (x) => x.referenceName
      )
    ).toEqual(["A-Forward", "R"]);
    expect(reverseLinkType("A-Forward")).toBe("A-Reverse");
    expect(reverseLinkType("System.LinkTypes.Related")).toBe("System.LinkTypes.Related");
  });

  it("maps optional Enabler and Strategic Theme types", async () => {
    const { ctx } = await renderSetup();
    expect(select("Enabler type — optional").value).toBe("");
    expect(select("Enabler type — optional").options[0].textContent).toBe("(none)");
    fireEvent.change(select("Enabler type — optional"), { target: { value: "Feature" } });
    fireEvent.change(select("Strategic Theme type — optional"), { target: { value: "Epic" } });
    const saved = await save(ctx);
    expect(saved.types).toMatchObject({ enabler: "Feature", theme: "Epic" });
    fireEvent.change(select("Enabler type — optional"), { target: { value: "" } });
    fireEvent.change(select("Strategic Theme type — optional"), { target: { value: "" } });
    const cleared = await save(ctx);
    expect(cleared.types.enabler).toBeUndefined();
    expect(cleared.types.theme).toBeUndefined();
  });

  it("chooses the RR/OE field, defaulting to Custom.RROEValue when present", async () => {
    fake.fields.push({ name: "RR/OE", referenceName: "Custom.RROEValue", type: "integer" });
    const { ctx } = await renderSetup();
    expect(select("RR/OE field (WSJF)").value).toBe("Custom.RROEValue");
    fireEvent.change(select("RR/OE field (WSJF)"), { target: { value: "Microsoft.VSTS.Common.Priority" } });
    expect((await save(ctx)).rroeField).toBe("Microsoft.VSTS.Common.Priority");
    fireEvent.change(select("RR/OE field (WSJF)"), { target: { value: "" } });
    expect((await save(ctx)).rroeField).toBe("");
  });

  it("has no RR/OE field by default when the process lacks Custom.RROEValue", async () => {
    await renderSetup();
    expect(select("RR/OE field (WSJF)").value).toBe("");
  });
});

describe("Setup — PI cadences", () => {
  it("sets a unit's own cadence or inherits it, clearing stored ids", async () => {
    const config = makeConfig({ piRootId: "old-root" });
    config.root.children[1].piRootIteration = "Fabrikam\\Undated";
    config.root.children[1].piRootId = "old";
    const { ctx } = await renderSetup({ config });
    const artA = within(nodeRow("ART A")).getByLabelText("PI cadence") as HTMLSelectElement;
    expect(artA.value).toBe("");
    expect(artA.options[0].textContent).toBe("Inherit cadence");
    expect(Array.from(artA.options).map((o) => o.value)).toContain("Fabrikam\\PIs\\PI 2");
    expect(within(nodeRow("Team Red")).queryByLabelText("PI cadence")).toBeNull();
    expect(within(nodeRow("Fabrikam")).queryByLabelText("PI cadence")).toBeNull();
    expect((within(nodeRow("ART B")).getByLabelText("PI cadence") as HTMLSelectElement).value).toBe("Fabrikam\\Undated");

    fireEvent.change(artA, { target: { value: "Fabrikam\\PIs" } });
    fireEvent.change(within(nodeRow("ART B")).getByLabelText("PI cadence"), { target: { value: "" } });
    let saved = await save(ctx);
    expect(findNode(saved.root, "n-arta")).toMatchObject({ piRootIteration: "Fabrikam\\PIs" });
    expect(findNode(saved.root, "n-artb")!.piRootIteration).toBeUndefined();
    expect(findNode(saved.root, "n-artb")!.piRootId).toBeUndefined();

    fireEvent.change(select("PI root iteration"), { target: { value: "Fabrikam" } });
    saved = await save(ctx);
    expect(saved.piRootIteration).toBe("Fabrikam");
    expect(saved.piRootId).toBeUndefined();
  });

  it("offers cadences for Large Solutions and clears the area id when the area changes", async () => {
    const config = makeConfig();
    config.root.children.push({ id: "n-sol", name: "Solution X", level: "solution", children: [] });
    config.root.children[0].areaId = "area-guid";
    const { ctx } = await renderSetup({ config });
    expect(within(nodeRow("Solution X")).getByLabelText("PI cadence")).toBeInTheDocument();
    fireEvent.change(within(nodeRow("ART A")).getByLabelText("Area path"), { target: { value: "Fabrikam\\ART B" } });
    const saved = await save(ctx);
    expect(findNode(saved.root, "n-arta")).toMatchObject({ areaPath: "Fabrikam\\ART B", areaId: undefined });
  });
});

describe("Setup — member identity picker", () => {
  const openMembers = (node: string) => {
    fireEvent.click(screen.getByRole("button", { name: `Members of ${node}` }));
    return screen.getByRole("group", { name: `${node} members` });
  };

  it("adds members of the linked Azure DevOps team", async () => {
    fake.teamMembers["t-red"][1].imageUrl = "https://img/grace.png";
    const { ctx } = await renderSetup();
    const group = openMembers("Team Red");
    const picker = (await within(group).findByRole("combobox", { name: "Add a team member to Team Red" })) as HTMLSelectElement;
    await waitFor(() => expect(picker.options).toHaveLength(3));
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual([
      "Add from the team…",
      "Ada Lovelace (ada@fabrikam.com)",
      "Grace Hopper (grace@fabrikam.com)",
    ]);
    fireEvent.change(picker, { target: { value: "u-grace" } });
    expect((within(group).getByLabelText("Member 1 name") as HTMLInputElement).value).toBe("Grace Hopper");
    expect(within(group).getByText("grace@fabrikam.com")).toHaveClass("member-identity");
    expect(group.querySelector("img.member-avatar")).toHaveAttribute("src", "https://img/grace.png");
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(["", "u-ada"]);
    fireEvent.change(within(group).getByLabelText("Member 1 role"), { target: { value: "scrumMaster" } });
    fireEvent.change(picker, { target: { value: "u-ada" } });
    expect(picker.options[0].textContent).toBe("(no more team members)");
    // Unknown values are ignored.
    fireEvent.change(picker, { target: { value: "u-nobody" } });

    let saved = await save(ctx);
    expect(findNode(saved.root, "n-red")!.members).toEqual([
      { name: "Grace Hopper", role: "Scrum Master / Team Coach", safeRole: "scrumMaster", id: "u-grace", uniqueName: "grace@fabrikam.com", imageUrl: "https://img/grace.png" },
      { name: "Ada Lovelace", role: "", id: "u-ada", uniqueName: "ada@fabrikam.com" },
    ]);

    // Editing the name turns the member into a free-text entry.
    fireEvent.change(within(group).getByLabelText("Member 2 name"), { target: { value: "Ada L." } });
    saved = await save(ctx);
    expect(findNode(saved.root, "n-red")!.members![1]).toEqual({ name: "Ada L.", role: "" });
  });

  it("offers no picker without a team and reports load errors", async () => {
    fail(/teams\/t-blue\/members/, 500, "members unavailable");
    await renderSetup();
    const green = openMembers("Fabrikam");
    expect(within(green).queryByRole("combobox")).toBeNull();
    const blue = openMembers("Team Blue");
    expect(await within(blue).findByText(/Could not load team members: members unavailable/)).toBeInTheDocument();
  });

  it("shows a loading hint while team members load", async () => {
    await renderSetup();
    const group = openMembers("Team Blue");
    const picker = within(group).getByRole("combobox") as HTMLSelectElement;
    expect(picker.options[0].textContent).toBe("Loading team members…");
    expect(picker).toBeDisabled();
    await waitFor(() => expect(picker).toBeEnabled());
  });
});

describe("Setup — read-only", () => {
  it("disables editing for non-administrators", async () => {
    const config = makeConfig();
    config.root.children[0].members = [{ name: "Rita", role: "RTE" }];
    await renderSetup({ config, can: { admin: false, managePis: true, plan: true } });
    expect(screen.getByRole("note")).toHaveTextContent("Read-only: only project administrators can change the SAFe configuration.");
    expect(screen.queryByRole("button", { name: "Save configuration" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate from area paths" })).toBeNull();
    expect(select("Portfolio level (Epic)")).toBeDisabled();
    expect(select("Dependency link type")).toBeDisabled();
    expect(select("PI root iteration")).toBeDisabled();
    const art = nodeRow("ART A");
    expect(within(art).getByLabelText("Name")).toBeDisabled();
    expect(within(art).getByLabelText("Area path")).toBeDisabled();
    expect(within(art).getByLabelText("Azure DevOps team")).toBeDisabled();
    expect(within(art).getByLabelText("PI cadence")).toBeDisabled();
    expect(within(art).queryByRole("button", { name: /Add Team|Remove/ })).toBeNull();
    // Members can still be viewed.
    fireEvent.click(within(art).getByRole("button", { name: "Members of ART A" }));
    const group = screen.getByRole("group", { name: "ART A members" });
    expect(within(group).getByLabelText("Member 1 name")).toBeDisabled();
    expect(within(group).queryByRole("button")).toBeNull();
    expect(within(group).getByLabelText("Member 1 role")).toBeDisabled();
    expect(within(group).queryByRole("combobox", { name: /Add a team member/ })).toBeNull();
    // The checklist still navigates.
    expect(within(checklistPanel()).getAllByRole("button")[0]).toBeEnabled();
  });
});
