# Agile Hive → SAFe Ado feature parity

This document compares Agile Hive Cloud with SAFe Ado. The Agile Hive side comes from its Cloud documentation (all 166 pages, including the 2023–2026 changelog), its Atlassian Marketplace listing and agile-hive.com. The Status column says whether SAFe Ado has the feature.

**Status legend**

- ✅ implemented
- 🟡 implemented with an Azure DevOps-specific adaptation
- ➖ not applicable to Azure DevOps (Jira- or Forge-internal)

**How Jira concepts map to Azure DevOps**

| Agile Hive (Jira) | SAFe Ado (Azure DevOps) |
|---|---|
| One Jira project per unit (Portfolio / Solution / ART / Team) | One hierarchy node per unit, mapped to an **Area Path** and optionally an **Azure DevOps team** |
| Work item hierarchy property | Native **Parent/Child** links |
| Dependency link type ("requires") | **Predecessor/Successor** links |
| PI entity; iterations mapped to Jira Sprints per team | PI = a child of the PI root iteration; iterations = its children; mapping = **team iteration subscriptions** |
| Sprint capacity property | `capacity` extension-data documents (story points per team per iteration) |
| Assigned PIs / Assigned Units / Owning Unit / Planned Date | `wimeta` extension-data documents per work item. Planned dates are also written to Start/Target Date when the process has them |
| Risk / Objective / Milestone work types | Extension-data documents (ROAM risks with the exposure matrix, PI objectives, milestones) |
| JQL box and quick filters | Filter bar: text, Type / State / Assignee / Tags facets, an advanced **WIQL clause**, Copy WIQL |
| Project members with roles | Members per hierarchy node, with a free-text role |

## Navigation and shell

| Agile Hive | Status | SAFe Ado |
|---|---|---|
| Sidebar with the 4-layer hierarchy, colour-coded by layer | ✅ | Sidebar |
| Starred projects section | ✅ | Star any node. Stars are stored per user |
| Per-project top navigation filtered by layer | ✅ | Tabs by level. Reports is the landing tab |
| PI selection kept across views | ✅ | Header PI picker, remembered per project |
| "Update data" / refresh | ✅ | Refresh on every board and report |
| Dark mode | ✅ | Follows the Azure DevOps theme |
| "View in Agile Hive" link and "SAFe® Hierarchy" panel on the work item | 🟡 | A **SAFe** group on the Azure DevOps work item form |
| "C" shortcut to create an item | 🟡 | "+ New" actions on the boards and in cells |
| Onboarding tour, Help menu, licence banner | ➖ | Marketplace listing and README |
| IndexedDB cache, rate-limit retry, account pooling | ➖ | Not needed: the extension calls the Azure DevOps REST API directly |

## My Organization

| Agile Hive | Status | SAFe Ado |
|---|---|---|
| Layered canvas (Portfolio / Solution / ART / Team) with hover highlighting | ✅ | My Organization view |
| Add a unit to a layer, add a connected parent or child | ✅ | My Organization view and Setup |
| Drag to re-parent; detach; remove with children | ✅ | My Organization view |
| Adjacency rules (ART may sit under Portfolio directly) | ✅ | Enforced when re-parenting |
| Permission placeholders | ➖ | Azure DevOps security trims work item results |

## PI and iteration management

| Agile Hive | Status | SAFe Ado |
|---|---|---|
| Create a PI with iterations; one sprint per team | ✅ | Creates the PI and iterations, and subscribes every mapped team |
| IP iteration | ✅ | Optional "<PI> IP" iteration |
| Delete a PI or its iterations (keep or delete sprints) | ✅ | Delete with reclassification to the PI root |
| Edit a PI (Agile Hive cannot) | ✅ | Rename and re-date |
| Overlap validation; maximum 10 iterations | ✅ | Both enforced |
| Sprint mapping per team | ✅ | View and edit each team's subscribed iterations |

## Planning views

| Agile Hive | Status | SAFe Ado |
|---|---|---|
| **Roadmap**: timeline, PI/iteration bands, milestones, Today button, zoom | ✅ | Roadmap |
| Roadmap: drag/resize writes the planned date; default durations 60/30/21 days | ✅ | Roadmap |
| Roadmap: unplanned sidebar with search; drag onto the canvas | ✅ | Roadmap |
| Roadmap: overlap assigns the PI automatically (ART) | ✅ | Roadmap |
| Roadmap: date-based dependency criticality, filter and edge indicators | ✅ | Roadmap |
| **Team Planning Board**: sprint columns, feature swimlanes, Independent lane | ✅ | Team Planning Board |
| Team board: sibling teams (read-only, collapsible) | ✅ | Team Planning Board |
| Team board: capacity / load per iteration, overload highlight, closed sprints locked | ✅ | Team Planning Board |
| Team board: Team and ART backlog tabs with search and sort | ✅ | Team Planning Board |
| Team board: drag sets sprint and parent; drag a feature to create a swimlane | ✅ | Team Planning Board |
| Team board: create in a cell; remove from board | ✅ | Team Planning Board |
| Team board: dependency lines with criticality; EXTERNAL lanes; swimlane filter | ✅ | Team Planning Board |
| **ART Planning Board**: calculated placement (last child's sprint), Owning Unit swimlanes | ✅ | ART Planning Board, calculated mode |
| ART board: involved teams, unplanned-children warning, critical dependencies per row, collapse | ✅ | ART Planning Board |
| ART board: milestones in the header | ✅ | ART Planning Board |
| Drag-and-drop program board (not in Agile Hive) | ✅ | ART Planning Board, "feature iteration" mode |
| Portfolio Kanban with WSJF | ✅ | Portfolio Kanban |

## Work Item List and filters

| Agile Hive | Status | SAFe Ado |
|---|---|---|
| Table of the unit's items with inline edit of title, priority, assignee and parent | ✅ | Work Item List |
| Layer-specific columns (involved teams, owning team, assigned PIs, PI involvement) | ✅ | Work Item List |
| Sorting, text / JQL / extended filters | 🟡 | Sorting, filter bar, WIQL clause |
| Export (via Jira search) | 🟡 | CSV export |
| Copy JQL, clear filters | 🟡 | Copy WIQL, clear filters |

## Reports (Reports is the landing page)

| Widget | Levels | Status |
|---|---|---|
| Header: unit, layer, current PI and iteration, members | all | ✅ |
| PI Progress (elapsed %) | Solution, ART, Team | ✅ |
| Story Points Burned | Solution, ART, Team | ✅ |
| Business Value (actual ÷ planned) | Solution, ART, Team | ✅ |
| Load vs. Capacity | Solution, ART, Team | ✅ |
| Velocity | Solution, ART, Team | ✅ |
| Critical Dependencies count | Solution, ART, Team | ✅ |
| Dependency Overview (internal/external, criticality filter, source: team planning / roadmap / combined) | all | ✅ |
| Burnup (scope, burned, ideal excluding IP, forecast) | Solution, ART, Team | ✅ |
| Milestone Overview | all | ✅ |
| PI Objectives (committed/uncommitted, team progress) | Solution, ART, Team | ✅ |
| PI Risks (exposure and residual exposure) | Solution, ART, Team | ✅ |
| PI Overview / Epic Overview (WSJF, job size, SP split, team distribution, drill-down) | Portfolio, Solution, ART | ✅ |
| Iteration Overview (paging, capacity, burned vs. planned) | Team | ✅ |
| PI predictability trend (not in Agile Hive) | Solution, ART, Team | ✅ |

## Entities and fields

| Agile Hive | Status | SAFe Ado |
|---|---|---|
| WSJF: (UBV + TC + RROE) ÷ Job Size | ✅ | Business Value, Time Criticality, optional RR/OE field, Effort |
| Objective fields: Plan BV, Actual BV, Uncommitted | ✅ | PI Objectives |
| Risk fields: probability, impact, residual values, exposure matrix | ✅ | Risks (ROAM); `api/risk.ts` |
| Milestones with a date | ✅ | Roadmap, Reports, ART board |
| Assigned PIs, Assigned Units, Owning Unit | ✅ | `wimeta` documents |
| Involved Units, PI Involvement, Estimated Completion (calculated) | ✅ | Calculated from children |
| Project members and roles | ✅ | Setup |
| Initial Setup (create Jira types, schemes, workflows, screens) | ➖ | Azure DevOps processes already provide Epic/Feature/Story. The type mapping is set in Setup |
| Jira permission scheme entries | ➖ | Azure DevOps project and area security applies |
