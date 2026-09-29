import * as SDK from "azure-devops-extension-sdk";
import { getBaseUrl, getProject } from "./client";

/** URLs into Azure DevOps for the current project (open with urlState.openInNewTab). */

const enc = encodeURIComponent;

export async function workItemUrl(id: number): Promise<string> {
  return `${await getBaseUrl()}${enc(getProject().name)}/_workitems/edit/${id}`;
}

/** A team's backlog (Agile Hive's "open project in Jira"). */
export async function teamBacklogUrl(teamName: string): Promise<string> {
  return `${await getBaseUrl()}${enc(getProject().name)}/_backlogs/backlog/${enc(teamName)}`;
}

/** A team's board. */
export async function teamBoardUrl(teamName: string): Promise<string> {
  return `${await getBaseUrl()}${enc(getProject().name)}/_boards/board/t/${enc(teamName)}`;
}

/** An ad-hoc query results page for a WIQL statement ("Open in Azure Boards query"). */
export async function queryUrl(wiql: string): Promise<string> {
  return `${await getBaseUrl()}${enc(getProject().name)}/_queries/query/?wiql=${enc(wiql)}`;
}

/** The SAFe Ado hub, deep-linked to a unit / view / PI. */
export async function hubUrl(hash: string): Promise<string> {
  const ctx = SDK.getExtensionContext();
  return `${await getBaseUrl()}${enc(getProject().name)}/_apps/hub/${ctx.id}.safe-hub${hash ? `#${hash}` : ""}`;
}
