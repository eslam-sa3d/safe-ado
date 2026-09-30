import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fake, PI2_S1, RED } from "../../fakeAdo";
import { renderReports, widget } from "./helpers";

// Own file: work item type states are cached per session, and this test needs the Bug states.
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe("Flow metrics with bugs", () => {
  it("Team: stories and bugs, by kind (Defect, Debt), load of the selected PI", async () => {
    fake.states.Bug = fake.states["User Story"];
    fake.workItems.get(100)!.fields["System.Tags"] = "UI; Debt";
    fake.workItems.set(120, {
      id: 120,
      rev: 1,
      fields: {
        "System.Id": 120,
        "System.Title": "Crash on pay",
        "System.WorkItemType": "Bug",
        "System.State": "Closed",
        "System.AreaPath": RED,
        "System.IterationPath": PI2_S1,
        "System.TeamProject": "Fabrikam",
        "Microsoft.VSTS.Common.ClosedDate": ago(1),
      },
      relations: [],
    });
    // An active story of PI 1 is not load of PI 2.
    fake.workItems.get(103)!.fields["System.State"] = "Active";
    await renderReports({ nodeId: "n-red" });
    const tile = (name: string) => within(widget("Flow metrics")).getByRole("group", { name });
    expect(tile("Flow velocity")).toHaveTextContent("2stories completed in PI 2");
    expect(tile("Flow load")).toHaveTextContent("1stories of PI 2 in progress now");
    expect(tile("Flow distribution")).toHaveTextContent("Debt 50% (1)Defect 50% (1)");
    // Bugs don't count as stories in the story-point widgets.
    expect(within(widget("Story Points Burned")).getByText("5 of 8 SP done")).toBeInTheDocument();
  });
});
