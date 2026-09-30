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
  /** Stable id of the area node; keeps the unit attached when the area is renamed. */
  areaId?: string;
  /** Own PI cadence (e.g. a Solution Train or an ART with its own PIs); inherited when unset. */
  piRootIteration?: string;
  piRootId?: string;
  /** People and their SAFe roles (RTE, PO, ...), shown in the Reports header. */
  members?: Member[];
  children: OrgNode[];
}

export interface WorkItemTypeMap {
  epic: string;
  /** Large Solution level; empty when the process has no Capability type. */
  capability: string;
  feature: string;
  story: string;
  /** Optional Enabler type, planned alongside Features / Capabilities / Epics. */
  enabler?: string;
  /** Optional Strategic Theme type (portfolio level). */
  theme?: string;
}

export interface SafeConfig {
  version: 1;
  root: OrgNode;
  /** Iteration path whose direct children are PIs and grandchildren are sprints. */
  piRootIteration: string;
  /** Stable id of the PI root iteration; keeps PIs found when the node is renamed. */
  piRootId?: string;
  types: WorkItemTypeMap;
  storyPointsField: string;
  /** Optional RR/OE field for WSJF (default Custom.RROEValue when present). */
  rroeField?: string;
  /** Link type used for dependencies (default Predecessor/Successor). */
  dependencyLink?: { forward: string; reverse: string };
  /** Units removed from their parent but kept in the organization. */
  detached?: OrgNode[];
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
  /** Stable iteration id of the PI (survives renames). */
  piId?: string;
  /** Parent objective (Team -> ART -> Solution objective hierarchy). */
  parentId?: string;
  nodeId: string;
  title: string;
  committed: boolean;
  plannedBV: number;
  actualBV: number | null;
  /** Who entered the Actual BV, and when (Business Owner accountability). */
  actualBVBy?: import("./audit").AuditUser;
  actualBVAt?: string;
  featureIds: number[];
  /** Audit stamps, added by the document store on every write. */
  createdBy?: import("./audit").AuditUser;
  createdAt?: string;
  modifiedBy?: import("./audit").AuditUser;
  modifiedAt?: string;
  __etag?: number;
}

export type RoamStatus = "Unroamed" | "Resolved" | "Owned" | "Accepted" | "Mitigated";
export const ROAM_STATUSES: RoamStatus[] = ["Unroamed", "Resolved", "Owned", "Accepted", "Mitigated"];

export interface Risk {
  id: string;
  piPath: string;
  /** Stable iteration id of the PI (survives renames). */
  piId?: string;
  /** Work items this risk treats (in addition to the legacy single workItemId). */
  workItemIds?: number[];
  nodeId: string;
  title: string;
  description: string;
  owner: string;
  impact: "Low" | "Medium" | "High";
  status: RoamStatus;
  workItemId?: number;
  createdAt: string;
  /** Agile Hive risk matrix inputs (see api/risk.ts). */
  probability?: import("./risk").Probability;
  impactLevel?: import("./risk").ImpactLevel;
  residualProbability?: import("./risk").Probability;
  residualImpact?: import("./risk").ImpactLevel;
  /** Audit stamps, added by the document store on every write (createdAt above is kept). */
  createdBy?: import("./audit").AuditUser;
  modifiedBy?: import("./audit").AuditUser;
  modifiedAt?: string;
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
  priority: "Microsoft.VSTS.Common.Priority",
  closedDate: "Microsoft.VSTS.Common.ClosedDate",
  startDate: "Microsoft.VSTS.Scheduling.StartDate",
  targetDate: "Microsoft.VSTS.Scheduling.TargetDate",
  changedDate: "System.ChangedDate",
} as const;

export const LINK = {
  child: "System.LinkTypes.Hierarchy-Forward",
  parent: "System.LinkTypes.Hierarchy-Reverse",
  successor: "System.LinkTypes.Dependency-Forward",
  predecessor: "System.LinkTypes.Dependency-Reverse",
} as const;

// ---------------------------------------------------------------------------------------------
// Planning entities (Agile Hive parity). Stored in the Extension Data Service per project.
// ---------------------------------------------------------------------------------------------

export interface Member {
  name: string;
  /** Display label of the role (free text in older configurations; the custom label for "Other"). */
  role: string;
  /** SAFe role picked in Setup (see api/roles.ts); older members are parsed from `role`. */
  safeRole?: import("./roles").SafeRole;
  /** Azure DevOps identity when picked from the team (enables avatars / profile links). */
  id?: string;
  uniqueName?: string;
  imageUrl?: string;
}

/** A dated milestone shown on the Roadmap, ART board header and Milestone report. */
export interface Milestone {
  id: string;
  nodeId: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  description?: string;
  __etag?: number;
}

/** Story-point capacity of one team (node) for one iteration. id = `${nodeId}|${iterationPath}`. */
export interface IterationCapacity {
  id: string;
  nodeId: string;
  iterationPath: string;
  /** Stable iteration id (survives renames). */
  iterationId?: string;
  capacity: number;
  __etag?: number;
}

/**
 * SAFe planning metadata for a work item that Azure DevOps has no field for
 * (Agile Hive's Owning Unit, Assigned Units, Assigned PIs, Planned Date). id = String(workItemId).
 */
export interface WorkItemMeta {
  id: string;
  workItemId: number;
  owningNodeId?: string;
  assignedNodeIds: string[];
  assignedPiPaths: string[];
  /** Stable ids matching assignedPiPaths (survive renames). */
  assignedPiIds?: string[];
  /** Roadmap planned date range, YYYY-MM-DD. */
  plannedStart?: string;
  plannedEnd?: string;
  /** Roadmap vertical lane (row index). */
  lane?: number;
  __etag?: number;
}

/** Agile Hive dependency criticality. */
export type Criticality = "healthy" | "atRisk" | "critical" | "resolved";
