# Agile Hive → ScaleLane feature parity

This document compares Agile Hive Cloud with ScaleLane 2.0.0. The Agile Hive side comes from its Cloud documentation (all 166 pages, including the 2023–2026 changelog), its Atlassian Marketplace listing and agile-hive.com. The statuses come from three independent code audits of this release. Each audit read the source and checked every claim against the code and tests.

**Status legend**

- ✅ **Full**: equivalent behaviour
- 🔀 **Different**: the same need is met with a different design that fits Azure DevOps
- 🟡 **Partial**: implemented, with the gap listed
- ➖ **N/A**: Jira- or Forge-internal, with no Azure DevOps counterpart

**Scorecard (81 rows below):** 47 full · 13 different · 19 partial · 0 missing · 2 N/A

**How Jira concepts map to Azure DevOps**

| Agile Hive (Jira) | ScaleLane (Azure DevOps) |
|---|---|
| One Jira project per unit (Portfolio / Solution / ART / Team) | One hierarchy node per unit, mapped to an **Area Path** and optionally an **Azure DevOps team** |
| Work item hierarchy property | Native **Parent/Child** links |
| Dependency link type ("requires") | **Predecessor/Successor** links (configurable in Setup) |
| PI entity; iterations mapped to Jira Sprints per team | PI = a child of the PI root iteration; iterations = its children; mapping = **team iteration subscriptions**. A unit may have its own PI root (its own cadence) |
| Sprint capacity property | `capacity` extension-data documents (story points per team per iteration) |
| Assigned PIs / Assigned Units / Owning Unit / Planned Date | `wimeta` extension-data documents per work item. Planned dates are also written to Start/Target Date when the process has them |
| Risk / Objective / Milestone / Improvement work types | Extension-data documents |
| JQL box and quick filters | Filter bar: text and facets, an advanced **WIQL clause** validated by the server, saved quick filters, Copy WIQL |
| Project members with roles | Members per hierarchy node (up to 25), with a SAFe role (RTE, STE, Product Management, Product Owner, Scrum Master / Team Coach, Business Owner, System Architect, Epic Owner, LPM, Team Member, Other) |

## Navigation and shell

| Agile Hive | Status | ScaleLane |
|---|---|---|
| Sidebar with the 4-layer hierarchy, colour-coded by layer | ✅ | Sidebar with keyboard navigation and a section for unattached units |
| Starred projects section | ✅ | Star any unit. Stars are stored per user |
| Per-project top navigation filtered by layer | 🔀 | Tabs by level; Reports is the landing tab. PIs & Iterations and Setup are global tabs |
| Open the unit's Jira board | ✅ | "Open in Azure Boards" opens the team's backlog, or a query for units without a team |
| "Update data" / refresh | ✅ | "Refresh all" in the header plus Refresh on every view; the header shows when data was last loaded ("Updated 5 min ago") |
| PI selection kept across views and shareable | 🟡 | The unit, view and PI are in the URL (`#node=&view=&pi=`), with back/forward support. Gap: filters and board layouts are not in the URL |
| "C" shortcut to create an item | 🔀 | "c" opens the Azure DevOps new work item form for the unit's area and current PI |
| Onboarding tour and Help menu | ✅ | Per-view tour (restartable from the Help menu) |
| Rate-limit retry | ✅ | Retries on 429 (and 503 for reads), honours Retry-After, and shows a "rate-limiting" notice while waiting |
| Dark mode and look and feel | ✅ | Follows the Azure DevOps theme, using its design tokens and Fluent icons |
| "SAFe® Hierarchy" panel on the work item | 🟡 | A **SAFe** group on the work item form: unit, PI, sprint, parent, children (with "Open children in query"), planning fields. Gap: parent and children are read-only there |
| Licence banner, IndexedDB cache | ➖ | Not needed: the extension calls the Azure DevOps REST API directly |

## My Organization and administration

| Agile Hive | Status | ScaleLane |
|---|---|---|
| Layered canvas (Portfolio / Solution / ART / Team) with hover highlighting | ✅ | My Organization view |
| Add a unit to a layer, add a connected parent or child | ✅ | My Organization view and Setup |
| Drag to re-parent; detach; remove with children | ✅ | Detached units keep their subtree and appear under "Unattached" |
| Adjacency rules (ART may sit under Portfolio directly) | ✅ | Enforced when re-parenting |
| Cadence change when a unit moves | 🟡 | The move confirmation says when the unit's PI cadence changes. Gap: no explicit carry-over of existing PI assignments |
| Initial Setup | 🟡 | Configuration checklist, and "generate" builds the hierarchy from area paths and teams. Gap: it does not create areas, teams, types or fields in Azure DevOps |
| Unit settings: members, board, sprint mapping | 🟡 | Members with roles, team link, sprint mapping. Gap: the type mapping is project-wide, not per unit |
| Permissions | 🔀 | Azure DevOps security: project admin for configuration, iteration rights for PIs, and a validate-only create per unit area for planning. See [Limitations](#limitations) |
| Locked placeholders for units you cannot browse | 🟡 | Azure DevOps trims work item results by area security. Gap: org units and extension data are not hidden |

## PI and iteration management

| Agile Hive | Status | ScaleLane |
|---|---|---|
| Create a PI with iterations; one sprint per team | 🟡 | Creates the PI and an editable iteration plan, and subscribes the teams on that cadence. Gap: iterations are shared (`<PI> Sprint n`), not one per team |
| IP iteration | ✅ | Optional IP iteration, detected by name |
| Separate Solution and ART cadences | 🔀 | Any unit can own a PI root; units below inherit it. PI and iterations are owned together |
| Edit a PI (Agile Hive cannot) | 🔀 | Rename and re-date (a superset) |
| Overlap validation; maximum 10 iterations | 🟡 | Both enforced. Gap: the PI name limit is 255 characters, not 10 |
| Delete a PI or its iterations | 🟡 | Delete with reclassification to the parent, and a warning that lists the affected work items and team subscriptions. Gap: no "delete the sprints' items" option |
| Sprint mapping per team | ✅ | View and edit each team's subscribed iterations |

## Planning views

| Agile Hive | Status | ScaleLane |
|---|---|---|
| **Roadmap**: timeline, PI/iteration bands, milestones, Today button, zoom | 🟡 | Roadmap with a windowed timeline. Gap: the range is fixed by the data (±14/30 days) rather than extended by month as you scroll |
| Roadmap: drag/resize writes the planned date; default durations 60/30/21 days | ✅ | Roadmap |
| Roadmap: unplanned sidebar with search, rank and drag onto the canvas | ✅ | Ranked by Stack Rank, or Backlog Priority on Scrum projects |
| Roadmap: overlap assigns the PI automatically (ART) | ✅ | Roadmap |
| Roadmap: with filters on, only resizing is allowed | ✅ | Roadmap |
| Roadmap: date-based dependency criticality, filter and edge indicators | ✅ | Roadmap |
| **Team Planning Board**: sprint columns, feature swimlanes, Independent lane | ✅ | Team Planning Board |
| Team board: sibling teams (read-only, collapsible) | ✅ | Team Planning Board |
| Team board: capacity / load per iteration, overload highlight, closed sprints locked | ✅ | Team Planning Board |
| Team board: Team and ART backlog tabs with markers, search, sort and filters | ✅ | Team Planning Board, with the full facet set |
| Team board: drag sets sprint and parent; drag a feature to create a swimlane | ✅ | Team Planning Board |
| Team board: create in a cell; remove from board | 🔀 | "Remove from board" moves the story to the PI root iteration (see notes) |
| Team board: dependency lines with criticality; EXTERNAL lanes; swimlane filter | 🟡 | Gap: cross-team partners are drawn in EXTERNAL, not in the sibling block |
| **ART Planning Board**: calculated placement, Owning Unit swimlanes, milestones | ✅ | ART Planning Board, calculated mode (the default) |
| ART board: involved teams, unplanned-children warning, critical dependencies, collapse | ✅ | ART Planning Board |
| Drag-and-drop program board (not in Agile Hive) | 🔀 | ART Planning Board, "feature iteration" mode |
| **PI Planning** event support | 🟡 | PI Planning tab: confidence vote (fist of five), plan reviews, Inspect & Adapt improvements. Gap: no System Demo or Solution Intent |
| Portfolio Kanban with WSJF | ✅ | Portfolio Kanban, with the SAFe columns (see [Beyond Agile Hive](#beyond-agile-hive-lean-portfolio-management)) |

## Work Item List and filters

| Agile Hive | Status | ScaleLane |
|---|---|---|
| Table of the unit's items with inline edit of title, priority, assignee and parent | ✅ | Work Item List |
| Parent type check (Feature under Capability, or directly under Epic) | 🟡 | Checked in the parent column. Gap: not checked on board drag or native links |
| Layer-specific columns (involved units, owning unit, assigned PIs, PI involvement) | ✅ | Work Item List |
| Sorting, text and extended filters | 🟡 | Text, type, state, assignee, priority, tags, iteration and the SAFe facets. Gap: filters are not in the URL |
| JQL box | ✅ | WIQL clause, rejected if it could escape the unit's scope, and validated by the server before it applies |
| Quick filters | 🔀 | Saved per project, several active at once (AND). Azure DevOps boards have no quick filters to reuse |
| Copy JQL, clear filters | 🟡 | Copy WIQL and Clear filters. Gap: the SAFe facets are not part of the copied WIQL (the button says so) |
| Export | 🔀 | CSV export (Agile Hive exports through Jira search) |
| Bulk edit | ✅ | Neither product has one |

## Reports (Reports is the landing page)

| Widget | Levels | Status |
|---|---|---|
| Header: unit, layer, current PI and iteration, members | all | 🔀 Members link to e-mail (Azure DevOps has no profile page). There is no PI picker on the portfolio |
| PI Progress (elapsed %) | Solution, ART, Team | ✅ |
| Story Points Burned | Solution, ART, Team | ✅ |
| Business Value (actual ÷ planned) | Solution, ART, Team | ✅ |
| Load vs. Capacity | Solution, ART, Team | ✅ |
| Velocity | Solution, ART, Team | ✅ |
| Critical Dependencies count | Solution, ART, Team | ✅ |
| Dependency Overview (internal/external, criticality, source) | all | ✅ |
| Burnup (scope, burned, ideal excluding IP, forecast) | Solution, ART, Team | ✅ |
| Milestone Overview (parents toggle remembered per layer; portfolio −30 days to +5 years) | all | ✅ |
| PI Objectives (committed/uncommitted, team progress) | Solution, ART, Team | ✅ |
| PI Risks (exposure and residual exposure) | Solution, ART, Team | ✅ |
| PI Overview / Epic Overview (WSJF, job size, SP split, drill-down, open in query) | Portfolio, Solution, ART | ✅ |
| Iteration Overview (paging, capacity, burned vs. planned) | Team | ✅ |
| Closed-PI history | Solution, ART, Team | 🟡 A snapshot is saved when a planner opens Reports within 14 days after the PI ends; otherwise the report says it was not captured |
| PI predictability trend and flow metrics (not in Agile Hive) | Solution, ART, Team | 🔀 |

## Entities and fields

| Agile Hive | Status | ScaleLane |
|---|---|---|
| Work types (Capability, Enabler, Theme, Objective, Risk, Milestone, Improvement) | 🔀 | Capability, Enabler and Theme are mapped work item types; the rest are extension-data documents |
| WSJF: (UBV + TC + RROE) ÷ Job Size | 🟡 | One shared formula, `rules.wsjfScore`: (Business Value + Time Criticality + RR/OE) ÷ job size (Effort). It is used by the Portfolio Kanban, the Reports PI / Epic Overview and the Team board's ART-backlog WSJF sort. RR/OE is read from the field chosen in Setup (default `Custom.RROEValue` when the process has it). A missing input counts as 0. There is no score without a job size or without any cost-of-delay input. Gap: the modified Fibonacci scale is defined (`WSJF_SCALE`) but not enforced on input |
| Enablers | 🟡 | Shown in reports and flow. Gap: team board lanes and the list's type chain use the Feature type only |
| Objective fields: Plan BV, Actual BV, Uncommitted | ✅ | PI Objectives, with parent-objective links. When a unit (or an ancestor) has Business Owners, only they can enter Actual BV; who entered it and when is shown |
| Work item history of objectives, risks and other planning records | 🔀 | Extension data has no history in Azure DevOps: ScaleLane stamps every write and keeps its own change log (History dialog on objectives and risks, Audit log in Setup) |
| Risk fields: probability, impact, residual values, exposure matrix | ✅ | Risks (ROAM) |
| Milestones with a date | ✅ | Roadmap, Reports, ART board |
| Assigned PIs (max 5), Assigned Units (max 30), Owning Unit | 🟡 | `wimeta` documents. Gap: Involved Units is not shown on the work item form |
| Involved Units, PI Involvement, Estimated Completion (calculated) | ✅ | Calculated from children |
| Dependency and risk links | 🔀 | Dependency link type set in Setup; risks and objectives keep their work item ids in the document |
| Jira permission scheme entries | ➖ | Azure DevOps project and area security applies |

## Beyond Agile Hive: Lean Portfolio Management

These SAFe Lean Portfolio Management features have no Agile Hive counterpart, so they are not counted in the scorecard.

| SAFe practice | ScaleLane |
|---|---|
| Portfolio Kanban states (Funnel, Reviewing, Analyzing, Ready, Implementing, Done) | Portfolio Kanban columns, each mapped onto an Epic state (configurable per portfolio; default: a state named like the column, else by state category). Columns sharing a state remember each Epic's column |
| WIP limits per Kanban state | WIP limit per column, stored per portfolio; over-limit columns are highlighted, and moving into a full column asks for confirmation |
| Epic Lean Business Case | Per Epic (`leancases` documents): Epic hypothesis statement (For / who / the / is a / that / unlike / our solution), business outcomes, leading indicators, NFRs, MVP, MVP and full cost estimates, Epic Owner. Edited from the Kanban card and on the Epic's work item form |
| Go / no-go decision | Pending / Go / No-go / Pivot, recording who decided and when |
| Guardrail: no Epic past Analyzing without an approved business case | Moving an Epic out of Funnel / Reviewing / Analyzing into Ready or later lists what is missing and asks for confirmation (override possible) |
| Lean budgets per value stream | Budget per PI for the portfolio, each solution and each ART, in a configurable currency. Forecast spend = cost per story point × planned SP (or cost per team per PI × teams); actual = cost per SP × completed SP (or forecast × share of the PI elapsed). Rates are inherited down the hierarchy |
| Spending guardrails | A warning when a value stream's forecast exceeds its budget, or when the budgets below a unit add up to more than its own |
| Epic cost vs. estimate | Actual (completed SP × rate) and forecast (all SP × rate) cost per Epic against its MVP and full estimates |
| Portfolio canvas | Lean Portfolio view: portfolio vision and strategic themes (Theme work items when the type is mapped, else a simple list) |

## Adaptation notes

- **Remove from board** on the Team Planning Board moves the story to the PI root iteration. It leaves every PI and returns to the Team backlog, which is the Azure DevOps equivalent of clearing the Jira sprint.
- **Burnup** counts a story as burned on its Closed Date, or today if it has none. The forecast uses the velocity of completed non-IP iterations.
- **Velocity** counts completed points in the iteration a story is planned in.
- **Swimlane un-assignment** removes the PI once no team remains assigned to the feature.
- **Renames heal themselves.** Every stored record keeps both the path and the node id, and is repaired when an area or iteration is renamed or moved.
- **Dates** use the viewer's local calendar day, and are tested in UTC, UTC+14 and UTC−11.

## Limitations

- **Extension data is not protected by Azure DevOps security.** Planning data (objectives, risks, capacity, PI assignments, milestones, votes) is stored in the extension's data service, which every project member can write through the REST API. ScaleLane hides edit controls from users without the matching Azure DevOps permissions, but that is a UI rule, not a server-side one. The control is the change log: every write through ScaleLane is stamped and logged (Setup → Audit log). Work item changes are always checked by Azure DevOps.
- **Permission checks fail closed for extension data.** If a permission check cannot be answered, objectives, risks, milestones, capacity, votes, reviews and the configuration are read-only (with a Retry) until it can. Work item edits stay available, because Azure DevOps rejects them itself if the user lacks rights.
- **Uninstalling removes extension data.** Export a backup from Setup first; importing it restores the configuration and every document.
- **Azure DevOps Server 2022.1**: every call uses REST api-version 7.0.
