import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { findNode } from "../../src/api/org";
import { OrgNode, ProgramIncrement } from "../../src/api/types";
import { boardsUrl, isTyping, newItemFields, OpenInBoardsButton, useNewItemShortcut } from "../../src/components/shell";
import { ART_A, fail, fake, makeConfig, P, PI2, RED } from "../fakeAdo";
import * as sdk from "../sdkMock";

const config = makeConfig();
const node = (id: string) => findNode(config.root, id)!;
const pi = { name: "PI 2", path: PI2, identifier: "iteration-PIs-PI_2", sprints: [] } as ProgramIncrement;
const opened = () => sdk.hostNavigation.openNewWindow.mock.calls.map((c) => c[0]);
const wiqlOf = (url: string) => new URL(url).searchParams.get("wiql")!;

beforeEach(() => sdk.hostNavigation.openNewWindow.mockClear());

describe("Open in Azure Boards", () => {
  it("opens a team's backlog by its Azure DevOps team name", async () => {
    expect(await boardsUrl(config, node("n-arta"))).toBe(`${fake.baseUrl}/Fabrikam/_backlogs/backlog/ART%20A%20Team`);
    expect(await boardsUrl(config, node("n-red"))).toBe(`${fake.baseUrl}/Fabrikam/_backlogs/backlog/Team%20Red`);
  });

  it("falls back to the unit name when the team is unknown or teams can't be listed", async () => {
    const ghost: OrgNode = { id: "g", name: "Ghost Team", level: "team", teamId: "t-missing", children: [] };
    expect(await boardsUrl(config, ghost)).toMatch(/_backlogs\/backlog\/Ghost%20Team$/);
    fail(/_apis\/projects\/.*\/teams|teams/, 500, "teams down");
    expect(await boardsUrl(config, node("n-red"))).toMatch(/_backlogs\/backlog\/Team%20Red$/);
  });

  it("opens a query of the unit's board type under its area for units without a team", async () => {
    const root = await boardsUrl(config, node("n-root"));
    expect(root).toContain(`${fake.baseUrl}/Fabrikam/_queries/query/?wiql=`);
    expect(wiqlOf(root)).toContain("[System.WorkItemType] IN ('Epic')");
    expect(wiqlOf(root)).toContain(`[System.AreaPath] UNDER '${P}'`);
    const artB = await boardsUrl(config, node("n-artb"));
    expect(wiqlOf(artB)).toContain("IN ('Feature')");
    // A process without the board type falls back to stories.
    const noFeature = makeConfig({ types: { epic: "Epic", capability: "", feature: "", story: "User Story" } });
    expect(wiqlOf(await boardsUrl(noFeature, findNode(noFeature.root, "n-artb")!))).toContain("IN ('User Story')");
  });

  it("button opens the link in a new tab, and is disabled for units without area or team", async () => {
    const { rerender } = render(<OpenInBoardsButton config={config} node={node("n-artb")} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in Azure Boards" }));
    await waitFor(() => expect(opened()).toHaveLength(1));
    expect(opened()[0]).toContain("_queries/query");
    rerender(<OpenInBoardsButton config={config} node={{ id: "x", name: "Empty", level: "art", children: [] }} />);
    expect(screen.getByRole("button", { name: "Open in Azure Boards" })).toBeDisabled();
  });

  it("reports failures in the button's tooltip", async () => {
    sdk.hostNavigation.openNewWindow.mockImplementationOnce(() => {
      throw new Error("popup blocked");
    });
    render(<OpenInBoardsButton config={config} node={node("n-root")} />);
    const button = screen.getByRole("button", { name: "Open in Azure Boards" });
    expect(button).toHaveAttribute("title", "Open this unit's work items as an Azure Boards query");
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("title", "Could not open Azure Boards: popup blocked"));
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("title", "Open this unit's work items as an Azure Boards query"));
  });
});

describe("new work item shortcut", () => {
  it("knows when the user is typing", () => {
    const make = (html: string) => {
      const div = document.createElement("div");
      div.innerHTML = html;
      return div.firstElementChild!;
    };
    expect(isTyping(make("<input />"))).toBe(true);
    expect(isTyping(make("<textarea></textarea>"))).toBe(true);
    expect(isTyping(make("<select></select>"))).toBe(true);
    expect(isTyping(make('<div contenteditable="true"></div>'))).toBe(true);
    expect(isTyping(make("<button></button>"))).toBe(false);
    expect(isTyping(document.body)).toBe(false);
    expect(isTyping(null)).toBe(false);
    expect(isTyping(window)).toBe(false);
  });

  it("prefills the area, and the PI below portfolio level", () => {
    expect(newItemFields(node("n-red"), pi)).toEqual({ "System.AreaPath": RED, "System.IterationPath": PI2 });
    expect(newItemFields(node("n-root"), pi)).toEqual({ "System.AreaPath": P });
    expect(newItemFields(node("n-arta"), undefined)).toEqual({ "System.AreaPath": ART_A });
    const noArea: OrgNode = { id: "s", name: "Solution", level: "solution", children: [node("n-arta")] };
    expect(newItemFields(noArea, pi)).toEqual({ "System.AreaPath": ART_A, "System.IterationPath": PI2 });
    expect(newItemFields({ id: "e", name: "Empty", level: "team", children: [] }, undefined)).toEqual({});
  });

  function Harness(props: { node: OrgNode; enabled?: boolean; cfg?: typeof config }) {
    useNewItemShortcut({ config: props.cfg ?? config, node: props.node, pi, enabled: props.enabled ?? true });
    return (
      <div>
        <input aria-label="text" />
        <button>plain</button>
      </div>
    );
  }

  it("opens a new item of the unit's board type on 'c'", async () => {
    render(<Harness node={node("n-red")} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "plain" }), { key: "c" });
    await waitFor(() =>
      expect(sdk.workItemForm.openNewWorkItem).toHaveBeenCalledWith("Feature", { "System.AreaPath": RED, "System.IterationPath": PI2 })
    );
  });

  it("uses Epic at portfolio level and the story type when the level has no board type", async () => {
    const { rerender } = render(<Harness node={node("n-root")} />);
    fireEvent.keyDown(document.body, { key: "C" });
    await waitFor(() => expect(sdk.workItemForm.openNewWorkItem).toHaveBeenLastCalledWith("Epic", { "System.AreaPath": P }));
    const noFeature = makeConfig({ types: { epic: "Epic", capability: "", feature: "", story: "User Story" } });
    rerender(<Harness node={node("n-red")} cfg={noFeature} />);
    fireEvent.keyDown(document.body, { key: "c" });
    await waitFor(() => expect(sdk.workItemForm.openNewWorkItem).toHaveBeenLastCalledWith("User Story", expect.anything()));
  });

  it("ignores typing, modifiers, other keys, open dialogs, missing types and disabled state", async () => {
    const { rerender } = render(<Harness node={node("n-red")} />);
    fireEvent.keyDown(screen.getByLabelText("text"), { key: "c" });
    fireEvent.keyDown(document.body, { key: "c", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "c", metaKey: true });
    fireEvent.keyDown(document.body, { key: "c", altKey: true });
    fireEvent.keyDown(document.body, { key: "x" });
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    fireEvent.keyDown(document.body, { key: "c" });
    backdrop.remove();
    const none = makeConfig({ types: { epic: "", capability: "", feature: "", story: "" } });
    rerender(<Harness node={node("n-red")} cfg={none} />);
    fireEvent.keyDown(document.body, { key: "c" });
    rerender(<Harness node={node("n-red")} enabled={false} />);
    fireEvent.keyDown(document.body, { key: "c" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sdk.workItemForm.openNewWorkItem).not.toHaveBeenCalled();
  });

  it("swallows failures of the work item form service", async () => {
    sdk.workItemForm.openNewWorkItem.mockRejectedValueOnce(new Error("form unavailable"));
    render(<Harness node={node("n-red")} />);
    fireEvent.keyDown(document.body, { key: "c" });
    await waitFor(() => expect(sdk.workItemForm.openNewWorkItem).toHaveBeenCalledTimes(1));
  });
});
