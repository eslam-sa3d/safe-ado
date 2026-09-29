export type Level = "portfolio" | "solution" | "art" | "team";

export const LEVEL_LABEL: Record<Level, string> = {
  portfolio: "Portfolio",
  solution: "Large Solution",
  art: "Agile Release Train",
  team: "Team",
};

/** A node in the SAFe organization hierarchy (Portfolio > Large Solution > ART > Team). */
export interface OrgNode {
  id: string;
  name: string;
  level: Level;
  /** Area path in work item form, e.g. "Fabrikam\\ART Payments\\Team Red". */
  areaPath?: string;
  /** Azure DevOps team backing this node (usually teams, optionally ARTs). */
  teamId?: string;
  children: OrgNode[];
}

export interface WorkItemTypeMap {
  epic: string;
  /** Large Solution level; empty when the process has no Capability type. */
  capability: string;
  feature: string;
  story: string;
}

export interface SafeConfig {
  version: 1;
  root: OrgNode;
  /** Iteration path whose direct children are PIs and grandchildren are sprints. */
  piRootIteration: string;
  types: WorkItemTypeMap;
  storyPointsField: string;
}

export interface Sprint {
  name: string;
  path: string;
  identifier: string;
  start?: string;
  finish?: string;
}

export interface ProgramIncrement extends Sprint {
  sprints: Sprint[];
}

export interface PiObjective {
  id: string;
  piPath: string;
  nodeId: string;
  title: string;
  committed: boolean;
  plannedBV: number;
  actualBV: number | null;
  featureIds: number[];
  __etag?: number;
}

export type RoamStatus = "Unroamed" | "Resolved" | "Owned" | "Accepted" | "Mitigated";
export const ROAM_STATUSES: RoamStatus[] = ["Unroamed", "Resolved", "Owned", "Accepted", "Mitigated"];

export interface Risk {
  id: string;
  piPath: string;
  nodeId: string;
  title: string;
  description: string;
  owner: string;
  impact: "Low" | "Medium" | "High";
  status: RoamStatus;
  workItemId?: number;
  createdAt: string;
  __etag?: number;
}

export interface WorkItemRelation {
  rel: string;
  url: string;
  attributes?: Record<string, unknown>;
}

export interface WorkItem {
  id: number;
  rev?: number;
  fields: Record<string, any>;
  relations?: WorkItemRelation[];
}

export const F = {
  id: "System.Id",
  title: "System.Title",
  type: "System.WorkItemType",
  state: "System.State",
  area: "System.AreaPath",
  iteration: "System.IterationPath",
  assignedTo: "System.AssignedTo",
  tags: "System.Tags",
  businessValue: "Microsoft.VSTS.Common.BusinessValue",
  timeCriticality: "Microsoft.VSTS.Common.TimeCriticality",
  effort: "Microsoft.VSTS.Scheduling.Effort",
  stackRank: "Microsoft.VSTS.Common.StackRank",
} as const;

export const LINK = {
  child: "System.LinkTypes.Hierarchy-Forward",
  parent: "System.LinkTypes.Hierarchy-Reverse",
  successor: "System.LinkTypes.Dependency-Forward",
  predecessor: "System.LinkTypes.Dependency-Reverse",
} as const;
