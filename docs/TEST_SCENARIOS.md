# ScaleLane: Test Scenarios

This catalogue lists every scenario the extension must satisfy. For each one it says where it is verified:

- **Auto** means covered by the automated suite (`npm test`), with the test file named.
- **Manual** means it needs a real Azure DevOps host. Run these before each release on both targets in the environment matrix.

The automated suite runs every view against an in-memory fake of the Azure DevOps REST API (api-version 7.0), the Extension Data Service and the SDK. `npm run test:coverage` fails the build if coverage drops below 95% statements/lines/functions or 85% branches.

## Environment matrix (manual runs)

| Target | URL shape | Browsers | Themes | Processes |
|---|---|---|---|---|
| Azure DevOps Services | `https://dev.azure.com/{org}` | Edge, Chrome, Firefox | Light, Dark | Agile, Scrum, CMMI, inherited custom (with Capability) |
| Azure DevOps Server 2022.1 | `https://{server}/tfs/{Collection}` | Edge, Chrome | Light, Dark | Agile, Scrum, CMMI, inherited custom |

Test data: a project with Portfolio → ART A (Team Red, Team Blue) and ART B (Team Green) area paths, matching teams, and a `PIs` iteration node.

---

## 1. Installation and loading

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| INS-01 | Upload the VSIX on Server 2022.1 (Collection settings → Extensions → Upload) and install it | Installs with no manifest or scope errors | Manual |
| INS-02 | Install from the Marketplace on Services | Installs; the consent screen lists Work items (read & write) and Project and team (read) | Manual |
| INS-03 | Open Boards → **SAFe** | The hub appears in the Boards group and loads with no console errors | Manual |
| INS-04 | SDK init runs with theming, then signals load success | `init({loaded:false, applyTheme:true})`, then `ready`, then `notifyLoadSucceeded` | Auto: `components/hub.test.tsx` |
| INS-05 | SDK handshake fails | `notifyLoadFailed` is called and the page shows "ScaleLane failed to load: …" | Auto: `components/hub.test.tsx` |
| INS-06 | The loading spinner shows while config loads | "Loading SAFe configuration…" | Auto: `components/App.test.tsx` |
| INS-07 | Upgrade 1.0.x → newer version | Saved config, objectives and risks are kept | Manual |

## 2. Host compatibility (cloud and Server 2022.1)

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| CMP-01 | Every REST call uses `api-version=7.0` | No request uses a 7.1 or preview version | Auto: `api/client.test.ts` |
| CMP-02 | The collection URL resolves on both hosts (with or without a trailing slash, `/tfs/Collection`) | Requests go to the correct collection | Auto: `api/client.test.ts`; Manual on Server |
| CMP-03 | Auth header uses the extension token, and fed-auth redirects are suppressed | `Authorization: Bearer …`, `X-TFS-FedAuthRedirect: Suppress` | Auto: `api/client.test.ts` |
| CMP-04 | Error bodies are JSON or HTML | The message comes from the JSON `message`, falling back to the HTTP status text | Auto: `api/client.test.ts` |
| CMP-05 | The dark theme applies | Text, backgrounds and borders follow the host theme | Manual |
| CMP-06 | Narrow window (< 800px) | The sidebar shrinks and panels stack; nothing is cut off | Manual |
| CMP-08 | A transient failure while loading work item states | Retried on the next view; not cached for the session | Auto: `api/wit.test.ts` |
| CMP-07 | Work item form dialogs open from the hub | Clicking a card opens the standard work item dialog | Auto (service call): several view tests; Manual (real dialog) |

## 3. Setup and configuration

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| SET-01 | First run with no saved config | Setup opens with a welcome banner and other tabs show a "not configured" notice | Auto: `components/App.test.tsx` |
| SET-02 | Agile process is detected | Epic / Feature / User Story, Story Points | Auto: `api/data.test.ts` |
| SET-03 | Scrum process is detected | Product Backlog Item, Effort | Auto: `api/data.test.ts` |
| SET-04 | CMMI process is detected | Requirement, Size | Auto: `api/data.test.ts` |
| SET-05 | Custom process with Capability, and Basic process | Capability mapped; Basic maps Issue | Auto: `api/data.test.ts` |
| SET-06 | Type dropdowns list only enabled types, sorted; Capability can be "(none)" | As described | Auto: `views/SetupView.test.tsx` |
| SET-07 | The size field offers only numeric fields | Integer and double fields only | Auto: `views/SetupView.test.tsx` |
| SET-08 | Choose the PI root iteration | The preview path updates; saving persists it | Auto: `views/SetupView.test.tsx` |
| SET-09 | Unsaved / Saved ✓ / Discard states | The indicator tracks the draft, Discard restores it, and "Saved ✓" clears after 2.5s | Auto: `views/SetupView.test.tsx` |
| SET-10 | Save fails | "Could not save: …", which can be dismissed | Auto: `views/SetupView.test.tsx` |
| SET-11 | Add, rename and remove hierarchy nodes | Children inherit the parent's area; removing a subtree asks for confirmation, removing a leaf does not | Auto: `views/SetupView.test.tsx` |
| SET-12 | Picking a team fills an empty area path from the team's default area | Area filled; an existing area is never overwritten; team selection is not lost | Auto: `views/SetupView.test.tsx` |
| SET-13 | Generate from area paths (Essential SAFe) | Top-level areas become ARTs and their children become teams, linked by default area | Auto: `views/SetupView.test.tsx` |
| SET-14 | Generate from area paths (Full SAFe) | Top-level areas become Large Solutions, then ARTs | Auto: `views/SetupView.test.tsx` |
| SET-15 | Generation confirms before replacing an existing hierarchy, and cancel keeps it | As described | Auto: `views/SetupView.test.tsx` |
| SET-16 | Generation tolerates failed team lookups and teams sharing an area | Teams that fail are left unlinked; the first team by name wins | Auto: `views/SetupView.test.tsx` |
| SET-17 | Metadata or area load errors | An error bar is shown | Auto: `views/SetupView.test.tsx` |
| SET-18 | Config is stored per project | Two projects in one collection keep separate configs | Auto (key naming): `api/data.test.ts`; Manual |
| SET-19 | A Reader (no edit rights) saves config | A clear error is shown and nothing is corrupted | Manual |

## 4. Navigation and hierarchy (Agile Hive-style)

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| NAV-01 | The sidebar shows Portfolio → Solution → ART → Team with level colours and a legend | As described | Auto: `components/Sidebar.test.tsx` |
| NAV-02 | Collapse and expand nodes; deep levels start collapsed | Selection is unchanged by collapsing | Auto: `components/Sidebar.test.tsx` |
| NAV-03 | Selecting a node updates the breadcrumb, level badge and tabs | Portfolio: Kanban / Lean Portfolio / Hierarchy / Risks / Reports. Others: Board / Objectives / Risks / Hierarchy / Reports | Auto: `components/App.test.tsx` |
| NAV-04 | Breadcrumb navigates to ancestors | As described | Auto: `components/App.test.tsx` |
| NAV-05 | Node, tab and PI are remembered per project across reloads | Restored from browser storage | Auto: `components/App.test.tsx` |
| NAV-06 | A saved view that is unavailable at this level, or a deleted node | Falls back to the first tab, or to the root | Auto: `components/App.test.tsx` |
| NAV-07 | Browser storage is blocked (private mode) | The app still works with defaults | Auto: `components/common.test.tsx` |
| NAV-08 | Every view renders through the shell | Board, Objectives, Risks, Hierarchy, Reports and Kanban all render | Auto: `components/App.test.tsx` |
| NAV-09 | A node with no area path, on itself or below | Views show nothing rather than the whole project | Auto: `api/wit.test.ts`, `views/ProgramBoard.test.tsx` |

## 5. PI and iteration management

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| PI-01 | PIs are the children of the PI root, sorted by start date, with sprints sorted | As described | Auto: `api/wit.test.ts` |
| PI-02 | The PI picker defaults to the PI running today, else the latest | As described | Auto: `components/App.test.tsx` |
| PI-03 | No PIs | Empty state with a "Create a PI" shortcut; the picker is disabled | Auto: `components/App.test.tsx` |
| PI-04 | Schedule maths: N sprints of W weeks plus an optional IP iteration | Consecutive dates with no gaps | Auto: `views/PiManagementView.test.tsx` |
| PI-05 | Suggested name and start date | Next "PI n"; start is the day after the last PI; follows PIs that load later but never overrides user edits | Auto: `views/PiManagementView.test.tsx` |
| PI-06 | Create a PI | The PI node and sprints are created with dates, sprints are assigned to all mapped teams, the PI picker refreshes | Auto: `views/PiManagementView.test.tsx`, `components/App.test.tsx`; Manual on Server |
| PI-07 | Create without team assignment | No team-settings calls | Auto: `views/PiManagementView.test.tsx` |
| PI-08 | Duplicate PI name | Warning shown and Create disabled | Auto: `views/PiManagementView.test.tsx` |
| PI-09 | Iteration creation denied | An error is shown and the form re-enables | Auto: `views/PiManagementView.test.tsx` |
| PI-10 | Assign an existing PI to teams, including re-assignment | Per-team log; already-assigned iterations are reported, not fatal | Auto: `views/PiManagementView.test.tsx` |
| PI-11 | Team backlog iteration excludes the PI root | Assignment is reported as partial with the server's message | Auto (error path); Manual (real message) |

## 6. Program Board

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| PB-01 | Columns are PI Backlog plus the PI's sprints with dates; rows are teams (at ART level) plus Unassigned when needed | As described | Auto: `views/ProgramBoard.test.tsx` |
| PB-02 | Features are placed by area (most specific team) and iteration | As described, including nested team areas | Auto: `views/ProgramBoard.test.tsx` |
| PB-03 | Removed items, other ARTs and other PIs are excluded | As described | Auto: `views/ProgramBoard.test.tsx` |
| PB-04 | Solution level uses ARTs as rows; team level has a single row | As described | Auto: `views/ProgramBoard.test.tsx` |
| PB-05 | Dependency severities | OK (successor later), warning (same sprint or unscheduled), conflict (successor earlier) with a count | Auto: `views/ProgramBoard.test.tsx` |
| PB-06 | Dependencies to items outside the board | A "↗ n" badge on the card | Auto: `views/ProgramBoard.test.tsx` |
| PB-07 | Line routing forwards and backwards; toggling dependencies | As described | Auto: `views/ProgramBoard.test.tsx` |
| PB-08 | Drag to another team and sprint | Area and Iteration are patched, with an immediate on-screen update | Auto: `views/ProgramBoard.test.tsx`; Manual (real drag) |
| PB-09 | Drag within a row, to Unassigned, or back to the PI Backlog | Only the iteration changes | Auto: `views/ProgramBoard.test.tsx` |
| PB-10 | A no-op drop, empty payload or unknown id | No request is sent | Auto: `views/ProgramBoard.test.tsx` |
| PB-11 | A move is rejected by a rule | "Could not move #id: …", which can be dismissed | Auto: `views/ProgramBoard.test.tsx` |
| PB-12 | Link mode: pick a predecessor, then a successor | A Successor link is created with a comment; clicking the same card is ignored | Auto: `views/ProgramBoard.test.tsx` |
| PB-13 | Clicking a line removes the dependency after confirmation | As described; cancel keeps it; errors are shown | Auto: `views/ProgramBoard.test.tsx` |
| PB-14 | "+" in a cell opens a new work item with the cell's area and iteration | Falls back to the scope area for rows with no area | Auto: `views/ProgramBoard.test.tsx` |
| PB-15 | Empty, "no teams" and "no children" states | Guidance shown | Auto: `views/ProgramBoard.test.tsx` |
| PB-16 | First load fails, or a refresh fails | An error is shown with no crash; the board is kept on refresh failure | Auto: `views/ProgramBoard.test.tsx` |
| PB-17 | More than 200 features | Items are fetched in batches of 200 | Auto: `api/wit.test.ts` |

## 7. PI Objectives

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| OBJ-01 | Predictability formula | Actual business value (BV) of all objectives ÷ planned BV of committed objectives; no committed BV shows "—" | Auto: `views/ObjectivesView.test.tsx` |
| OBJ-02 | Summary tones | ≥80% good, 60–79% warning, <60% bad | Auto: `views/ObjectivesView.test.tsx` |
| OBJ-03 | Sections for the node and each child, with their own predictability | As described | Auto: `views/ObjectivesView.test.tsx` |
| OBJ-04 | Grandchildren's objectives are read-only in roll-up sections | As described | Auto: `views/ObjectivesView.test.tsx` |
| OBJ-05 | Add, edit (on blur), toggle committed, clamp BV to 0–10, clear actual BV | Saved correctly | Auto: `views/ObjectivesView.test.tsx` |
| OBJ-06 | Consecutive edits to the same objective | No etag conflict | Auto: `views/ObjectivesView.test.tsx` |
| OBJ-07 | Linked feature ids are parsed and open on click | Invalid tokens are ignored | Auto: `views/ObjectivesView.test.tsx` |
| OBJ-08 | Delete with confirmation; save and delete errors | As described | Auto: `views/ObjectivesView.test.tsx` |
| OBJ-09 | Two users edit the same objective | The second save gets a conflict message rather than silently overwriting | Auto (etag): `api/data.test.ts`; Manual |

## 8. Risks (ROAM)

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| RSK-01 | Five ROAM columns with hints and counts | As described | Auto: `views/RisksView.test.tsx` |
| RSK-02 | Scoped to the node's subtree and PI, with an "All PIs" toggle | As described | Auto: `views/RisksView.test.tsx` |
| RSK-03 | Create a risk with every field | Saved, and the card appears in the right column | Auto: `views/RisksView.test.tsx` |
| RSK-04 | Edit, cancel, clear the linked work item | As described | Auto: `views/RisksView.test.tsx` |
| RSK-05 | Drag between columns; same-column drops are ignored | Status is saved | Auto: `views/RisksView.test.tsx` |
| RSK-06 | Linked work item button opens the work item, not the editor | As described | Auto: `views/RisksView.test.tsx` |
| RSK-07 | Delete with confirmation; save and delete errors | As described | Auto: `views/RisksView.test.tsx` |

## 9. Work Item Hierarchy

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| WIH-01 | Recursive tree query, with Removed items dropped | Epic → Feature → Story (and Capability when mapped) | Auto: `api/queries.test.ts`, `views/HierarchyView.test.tsx` |
| WIH-02 | Point roll-up, falling back to item counts | As described | Auto: `api/queries.test.ts`, `views/HierarchyView.test.tsx` |
| WIH-03 | Expand/collapse per row and all at once | As described | Auto: `views/HierarchyView.test.tsx` |
| WIH-04 | Filter by title (keeping ancestors of matches) or by exact id | As described | Auto: `views/HierarchyView.test.tsx` |
| WIH-05 | PI filter toggle; no PI filter at portfolio level | As described | Auto: `views/HierarchyView.test.tsx` |
| WIH-06 | Empty scope and query errors | Guidance or error shown | Auto: `views/HierarchyView.test.tsx` |

## 10. Reports

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| RPT-01 | Predictability per PI, and per team or child, with the target band | As described | Auto: `views/ReportsView.test.tsx` |
| RPT-02 | Feature progress (PI) or Epic progress (portfolio), sorted by remaining work | As described | Auto: `views/ReportsView.test.tsx` |
| RPT-03 | Velocity per team per sprint, excluding Removed items | Completed / planned points | Auto: `views/ReportsView.test.tsx` |
| RPT-04 | No PIs, no area mapping, report errors | Guidance or errors per report | Auto: `views/ReportsView.test.tsx` |

## 11. Portfolio Kanban

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| KAN-01 | Columns are the SAFe stages Funnel, Reviewing, Analyzing, Ready, Implementing, Done; each maps to an Epic state (a state named like the stage, else by category); Removed epics are not shown or counted | As described | Auto: `views/PortfolioKanban.test.tsx`, `api/lpm.test.ts` |
| KAN-02 | WSJF = (BV + TC + RR/OE) ÷ Effort, only when the fields exist; sort by WSJF | As described | Auto: `views/PortfolioKanban.test.tsx` |
| KAN-03 | Drag to change state; invalid transition shows an error | As described | Auto: `views/PortfolioKanban.test.tsx`; Manual (process rules) |
| KAN-04 | Open an epic, create a new epic in the portfolio area, refresh | As described | Auto: `views/PortfolioKanban.test.tsx` |
| KAN-05 | No Epic type mapped | Guidance shown | Auto: `views/PortfolioKanban.test.tsx` |
| KAN-06 | Columns sharing a state: moving between them changes no state and the column is remembered per Epic; a stale column falls back to the state's category | As described | Auto: `views/PortfolioKanban.test.tsx` |
| KAN-07 | Columns & WIP dialog: map each column to an Epic state and set WIP limits, saved per portfolio | Unknown states are ignored; save errors shown | Auto: `views/PortfolioKanban.test.tsx` |
| KAN-08 | A column over its WIP limit is highlighted and a warning names it; moving into a full column asks for confirmation | As described | Auto: `views/PortfolioKanban.test.tsx` |
| KAN-09 | Guardrail: moving an Epic past Analyzing without a Lean Business Case (hypothesis, business outcomes, MVP) and a Go decision lists what is missing and asks for confirmation; cancel keeps it | As described | Auto: `views/PortfolioKanban.test.tsx`, `api/lpm.test.ts` |
| KAN-10 | Lean Business Case dialog from the card: hypothesis statement, outcomes, leading indicators, NFRs, MVP, MVP and full cost, Epic Owner, go / no-go with who and when; read-only without planning rights | Saved per Epic (`leancases`) | Auto: `views/PortfolioKanban.test.tsx` |

## 11b. Lean Portfolio (beyond Agile Hive)

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| LPM-01 | Lean Portfolio is a tab at portfolio level only | Not shown for ARTs or teams | Auto: `views/LeanPortfolioView.test.tsx`, `components/App.test.tsx` |
| LPM-02 | Value streams (portfolio, solutions, ARTs) show planned and completed story points of the selected PI | Removed stories excluded | Auto: `views/LeanPortfolioView.test.tsx` |
| LPM-03 | Cost per story point: forecast = rate × planned SP, actual = rate × completed SP; rate inherited from the parent unit unless overridden | As described | Auto: `views/LeanPortfolioView.test.tsx`, `api/lpm.test.ts` |
| LPM-04 | Cost per team per PI: forecast = rate × teams, actual = forecast × share of the PI elapsed | As described | Auto: `views/LeanPortfolioView.test.tsx`, `api/lpm.test.ts` |
| LPM-05 | Budgets per unit and PI (by PI id, path fallback): save, update, clear | As described | Auto: `views/LeanPortfolioView.test.tsx` |
| LPM-06 | Guardrail warnings: forecast over budget; child budgets adding up to more than the parent's | As described | Auto: `views/LeanPortfolioView.test.tsx` |
| LPM-07 | Configurable currency (ISO code), used for all amounts | As described | Auto: `views/LeanPortfolioView.test.tsx` |
| LPM-08 | Epic cost vs. estimate: actual and forecast cost against MVP and full estimates | Status: within, beyond MVP, forecast / actual over full | Auto: `views/LeanPortfolioView.test.tsx`, `api/lpm.test.ts` |
| LPM-09 | Portfolio canvas: vision; strategic themes as Theme work items when the type is mapped, else as a list in the settings | As described | Auto: `views/LeanPortfolioView.test.tsx` |
| LPM-10 | Read-only without planning rights; failed saves are reported | As described | Auto: `views/LeanPortfolioView.test.tsx` |
| LPM-11 | The work item form shows an Epic's Lean Business Case (decision, owner, estimates in the portfolio currency) and edits it | Not shown for other types or unsaved items | Auto: `form/FormPanelLean.test.tsx`; **Manual**: open an Epic in real Azure DevOps |

## 11a. Agile Hive parity features

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| RMP-01 | Roadmap timeline: zoom, Today button, PI / iteration / milestone rows | As in Agile Hive | Auto: `views/RoadmapView.test.tsx` |
| RMP-02 | Move, resize and change the lane of a card; save planned dates (and Start/Target Date when the fields exist) | Saved; overlap with a PI assigns it at ART level | Auto: `views/RoadmapView.test.tsx`, `api/roadmap.test.ts` |
| RMP-03 | Plan an item by dragging it from the unplanned sidebar (or with the Plan button) | Default durations 60/30/21 days | Auto: `views/RoadmapView.test.tsx` |
| RMP-04 | Date-based dependency criticality, filter and edge indicators | Healthy / At risk / Critical / Resolved | Auto: `views/RoadmapView.test.tsx` |
| TPB-01 | Team board: sprint columns, feature swimlanes, Independent lane, completed sprints locked | As described | Auto: `views/TeamBoard.test.tsx`, `api/teamboard.test.ts` |
| TPB-02 | Edit capacity; load vs. capacity with the overload highlight | Saved per team and sprint (derived and hybrid capacity: see 11b) | Auto: `views/TeamBoard.test.tsx` |
| TPB-03 | Drag a story to set its sprint and parent; drag a feature to create a swimlane; remove an empty swimlane | As described | Auto: `views/TeamBoard.test.tsx` |
| TPB-04 | Create an item in a cell; remove an item from the board | As described | Auto: `views/TeamBoard.test.tsx` |
| TPB-05 | Sibling teams load lazily and are read-only; EXTERNAL lanes; swimlane filter | As described | Auto: `views/TeamBoard.test.tsx` |
| ART-01 | Calculated placement from children; owning team; involved teams; unplanned-children warning | As described | Auto: `views/ProgramBoard.test.tsx`, `api/artboard.test.ts` |
| ART-02 | Milestones in the header; critical dependencies per row; collapse rows | As described | Auto: `views/ProgramBoard.test.tsx` |
| REP-01 | All 14 report widgets and their formulas, per level | See the parity document | Auto: `views/ReportsView.test.tsx`, `views/reports/*`, `api/reports.test.ts` |
| WIL-01 | Work Item List: inline edits with rollback on failure, sorting, level columns, CSV export | As described | Auto: `views/WorkItemList.test.tsx` |
| ORG-01 | My Organization: add, re-parent by drag with adjacency rules, detach, remove, hover highlighting | As described | Auto: `views/OrganizationView.test.tsx` |
| STAR-01 | Star units; the list persists per user | As described | Auto: `components/Sidebar.test.tsx` |
| FORM-01 | SAFe panel on the work item form shows the unit, PI, parent and children, and edits planning metadata | As described | Auto: `form/FormPanel.test.tsx`, `form/form.test.tsx`; **Manual**: open a work item in real Azure DevOps and check the panel loads and refreshes on save |
| PIM-01 | Edit or delete a PI; add or edit iterations; overlap and 10-iteration limits; sprint mapping per team | As described | Auto: `views/PiManagementDetails.test.tsx`, `api/artboard.test.ts` (PI rules); **Manual on Server 2022.1**: delete with reclassification |
| RSK-08 | Risk probability and impact, residual values, exposure chips, sort by exposure | Follows the Agile Hive matrix | Auto: `views/RisksView.test.tsx`, `api/risk.test.ts` |
| MEM-01 | Members per unit in Setup (maximum 25), shown in the Reports header | As described | Auto: `views/SetupMembers.test.tsx`, `views/ReportsView.test.tsx` |
| FLT-01 | Shared filter bar: facets, WIQL clause, Copy WIQL, Clear | As described | Auto: `components/FilterBar.test.tsx`, `api/foundation.test.ts` |
| SHL-10 | The header says how long ago data was loaded ("just now", "5 min ago") and hides the PI picker on the portfolio | As described | Auto: `components/App.test.tsx` |
| SHL-11 | Azure DevOps throttles a request (429): a rate-limiting notice shows while the client waits, then disappears | As described | Auto: `components/App.test.tsx`, `api/robustness.test.ts` |
| WIL-02 | A Feature may have a Capability or an Epic parent; any other parent type is rejected | As described | Auto: `views/WorkItemListSafe.test.tsx` |
| META-02 | At most 30 Assigned Units; removing still works when the limit is reached | As described | Auto: `form/planning.test.ts` |
| ORG-02 | Moving a unit under a parent with another PI cadence says so in the confirmation | As described | Auto: `views/OrganizationView.test.tsx` |
| RM-20 | Roadmap sidebar ranks by Backlog Priority on Scrum projects | As described | Auto: `views/RoadmapView.test.tsx` |
| REP-02 | Milestone Overview remembers "Include parent levels" per SAFe layer | As described | Auto: `views/reports/milestones.test.tsx` |
| FORM-02 | "Open children in query" opens the item's children in Azure Boards | As described | Auto: `form/FormPanel.test.tsx` |
| MAN-DND | Mouse and touchpad dragging on the Roadmap and boards in a real browser | Smooth; no text selection glitches | **Manual** |

## 11b. Capacity source

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| CAP-01 | Existing configs, or Setup → Capacity source = *Manual story points* | Today's behaviour: capacity is entered on the Team Planning Board; no source marker; no Azure DevOps capacity requests | Auto: `views/Capacity.test.tsx` |
| CAP-02 | Setup: choose *Derived* or *Hybrid* and a points-per-person-day factor | Saved in the config (`capacity.source`, `capacity.pointsPerPersonDay`); an invalid factor falls back to 0.8; switching back to manual removes the setting | Auto: `views/Capacity.test.tsx` |
| CAP-03 | Derived calculation (SAFe normalized estimation) | Per member with capacity per day > 0 in any activity: working days of the iteration (team working days, minus team and personal days off) × factor; a full-time member in a 2-week iteration yields 8 SP at 0.8; members with no capacity are not counted | Auto: `api/capacity.test.ts` |
| CAP-04 | Capacities response shapes (`{ teamMembers }` on Services 7.x, `{ value }`, bare array); working days as names or numbers | All read the same way; requests use api-version 7.0 | Auto: `api/capacity.test.ts`, `views/Capacity.test.tsx` |
| CAP-05 | Derived: Team Planning Board | The derived value is shown read-only with a "derived" marker; the tooltip lists person-days, factor and each member | Auto: `views/Capacity.test.tsx` |
| CAP-06 | Hybrid: override on the Team Planning Board | Entering a value marks it "override"; clearing the value removes the override and shows the derived value | Auto: `views/Capacity.test.tsx` |
| CAP-07 | No capacity in Azure DevOps (nothing set up, iteration not selected for the team, no team linked, request failed, undated iteration) | "not set" marker with the reason in the tooltip, and a *Set up capacity in Azure DevOps* link to the team's capacity page | Auto: `api/capacity.test.ts`, `views/Capacity.test.tsx` |
| CAP-08 | Load vs. Capacity and Iteration Overview reports | Use the same effective value as the board; the marker shows the source (or "mixed") and how many team iterations are not set | Auto: `views/Capacity.test.tsx` |
| CAP-09 | Real hosts: capacity, team days off and working days read on Services and Server 2022.1 | Values match the Azure DevOps capacity page; the setup link opens the right team and iteration | **Manual** |

## 11c. Data governance (audit, backup, permissions, roles)

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| GOV-01 | Every write through the document stores is stamped | `createdBy`/`createdAt` on create (kept on update, never credited to the current user for older documents), `modifiedBy`/`modifiedAt` on every write; snapshots are not stamped | Auto: `api/governance.test.ts` |
| GOV-02 | Every create, update and delete is appended to `audit-<projectId>` | Collection, document id, action, user, time, label and a compact diff of the changed top-level fields; no-op updates are not logged; config changes are logged too | Auto: `api/governance.test.ts` |
| GOV-03 | The change log cannot break a save | A failed pre-read or audit write is ignored and the document is still saved or deleted | Auto: `api/governance.test.ts` |
| GOV-04 | Retention | Entries older than 180 days and beyond the newest 2000 are pruned, at most 50 per pass, by a background pass started on about 1 write in 25 | Auto: `api/governance.test.ts` |
| GOV-05 | History of an objective or a risk | The History dialog lists who changed which fields and when, newest first; available to read-only users | Auto: `views/Governance.test.tsx` |
| GOV-06 | Setup audit log | Loads on demand, newest first, filters by data and user, pages 100 at a time, shows load errors | Auto: `views/Governance.test.tsx` |
| GOV-07 | Export SAFe data | One JSON file with the format name, schema version, project, configuration and every document collection (without etags) | Auto: `api/governance.test.ts`, `views/Governance.test.tsx` |
| GOV-08 | Import a backup | The file is validated first; a summary (counts, source project, author, unknown collections) is confirmed; merge or overwrite; the configuration is optional; the audit log is never deleted; one "import" entry is logged; administrators only | Auto: `api/governance.test.ts`, `views/Governance.test.tsx` |
| GOV-09 | A permission check errors (not "denied") | Extension-data writes (objectives, risks, milestones, capacity, votes, reviews, config) become read-only with an explanation and Retry; work item edits stay available | Auto: `views/Governance.test.tsx`, `api/governance.test.ts` |
| GOV-10 | Retry after a failed check | The checks run again and the views unlock once they succeed | Auto: `views/Governance.test.tsx` |
| GOV-11 | SAFe roles | Members' roles come from a list; older free-text roles are mapped case-insensitively, unknown ones become "Other" with their label kept | Auto: `api/governance.test.ts`, `views/Governance.test.tsx`, `views/SetupMembers.test.tsx` |
| GOV-12 | Actual BV by Business Owners | When the unit or an ancestor has Business Owners, only they (matched by identity id or sign-in name) can enter Actual BV; others see it read-only with a hint; who entered it and when is recorded and shown | Auto: `views/Governance.test.tsx`, `api/governance.test.ts` |
| GOV-13 | Restore on a freshly installed extension | Export, uninstall, reinstall, import: configuration and documents come back | Manual |

## 11d. Cross-project portfolios

The configuration lives in the host project; units may point to an area path and team in another project of the same collection. The fake backend models a second project, *Contoso* (`seedCrossProject`, `makeCrossConfig` in `test/fakeAdo.ts`), whose PI 2 matches the host's PI 2 by name, its first sprint by dates and its second sprint by name, and which has no IP iteration and no PI 1.

| ID | Scenario | Expected | Verified by |
|---|---|---|---|
| XP-01 | Old configuration without `projectId` | Queries, routes and writes are exactly as before (`@project`, project-scoped WIQL); no cross-project note | Auto: `api/crossProject.test.ts`, `views/CrossProject.test.tsx` |
| XP-02 | Setup: pick another project for a unit, then its area path, team and PI root in that project | Saved as `projectId` / `projectName`; switching back to the host project clears area, team and PI root; children start in the parent's project; an unreadable project shows an error on its row | Auto: `views/CrossProject.test.tsx` |
| XP-03 | My Organization: add a unit in another project | The dialog lists the collection's projects and that project's area paths; the card shows the project | Auto: `views/CrossProject.test.tsx` |
| XP-04 | A scope spanning projects | WIQL uses `[System.TeamProject] IN (...)` plus area clauses and runs at collection level (no project in the URL, no `@project`); the PI clause includes the matched iteration of each project; a scope inside the host project keeps `@project` | Auto: `api/crossProject.test.ts` |
| XP-05 | PI matching | The host cadence defines the PIs; each foreign PI root (the unit's own, a same-project ancestor's, else the cadence path in that project) is matched by name, else by identical dates; iterations without a match are listed in a note | Auto: `api/crossProject.test.ts`, `views/CrossProject.test.tsx` |
| XP-06 | Program board, reports, work item list and team board with items from two projects | Foreign items appear in the cadence's sprint columns and counts | Auto: `views/CrossProject.test.tsx` |
| XP-07 | Re-plan a foreign item (drag, create in a cell, remove from board) | The write uses the item's own project's iteration; creating posts to that project | Auto: `api/crossProject.test.ts`, `views/CrossProject.test.tsx` |
| XP-08 | Move a foreign item to a row of another project, or into a sprint with no match | Refused with a clear message; nothing is written | Auto: `api/crossProject.test.ts`, `views/CrossProject.test.tsx` |
| XP-09 | Foreign teams in PIs & Iterations | Left out of sprint mapping and "Assign to teams", with a visible note | Auto: `views/CrossProject.test.tsx` |
| XP-10 | Another project's PIs can't be loaded | The hub still renders; a note names the missing PI root | Auto: `views/CrossProject.test.tsx` |
| XP-11 | "New item" in a foreign unit's area | Opens that project's new-work-item page in a new tab with area and mapped iteration | Auto: `api/crossProject.test.ts` |

**Manual checklist (run on Azure DevOps Services and on Server 2022.1):**

1. Create two projects in one collection (for example *Fabrikam* and *Contoso*) with the same process. In Contoso create areas `ART C\Team Orange`, a team with that default area, and iterations `Cadence\PI 2\Sprint 1..n` with the same names or dates as the host's PI 2.
2. In Fabrikam's Setup, add an ART, choose project *Contoso*, pick `Contoso\ART C`, the PI root `Contoso\Cadence` and the team. Save. Reload the hub: the unit keeps its project; no errors in the console (check that `_apis/projects` and Contoso's classification nodes load with `api-version=7.0`).
3. Select the Contoso ART: the ART Planning Board, Reports, Work Item List and Hierarchy show Contoso items in the host PI's sprints. In the network tab, cross-project WIQL posts go to `{collection}/_apis/wit/wiql` (no project segment) and succeed.
4. Select a Large Solution or portfolio containing units from both projects: items of both appear together.
5. In *Feature iteration* mode drag a Contoso feature to another sprint: it lands in Contoso's matching sprint (check the item in Azure Boards). Drag it to a Fabrikam row: a message explains that items can't move between projects.
6. On the Contoso team's Team Planning Board, create an item in a cell: it is created in Contoso with Contoso's sprint.
7. Delete or rename a Contoso sprint so it no longer matches: a note lists the unmatched iteration; dragging into it is refused with a message.
8. Open PIs & Iterations: the note says the Contoso team can't be mapped from here; sprint mapping lists host teams only.
9. As a user without access to Contoso: the hub still loads; Contoso units show nothing and a note / error explains why.
10. Server 2022.1 only: repeat steps 2, 3 and 5 on `https://{server}/tfs/{Collection}` and confirm collection-level WIQL and `workitemsbatch` work without a project in the URL.

## 12. Security and permissions (manual)

| ID | Scenario | Expected |
|---|---|---|
| SEC-01 | Stakeholder or Reader opens the hub | Views load; edits fail with a readable error; nothing is half-applied |
| SEC-02 | User without "Edit project-level information" creates a PI | Iteration creation fails with the server message |
| SEC-03 | Project A's data is not visible from project B | Config, objectives and risks are isolated per project |
| SEC-04 | Scopes are minimal | Only `vso.work_write` and `vso.project` are requested |
| SEC-05 | A member writes an objective through the Extension Data REST API directly | The write succeeds (there is no server-side ACL) and does not appear in the audit log, which records writes made through ScaleLane only. The next ScaleLane write to that document logs the difference |

## 13. Regression bugs caught by this suite

These were found while writing the tests, fixed in the source, and are now covered:

1. **Program Board crashed when the first load failed.** It now shows the error (PB-16).
2. **A node with no area path queried the whole project.** It now matches nothing (NAV-09).
3. **Picking a team could discard the selection.** The area lookup wrote back into stale form state (SET-12).
4. **The Kanban count included Removed epics** (KAN-01).
5. **PI suggestions ignored PIs that loaded later.** This could lead to an overlapping "PI 1" (PI-05).
6. **A failed state lookup was cached for the whole session.** Every later view showed the error until the page was reloaded (CMP-08). CI found this, and it also led to hardening the harness so tests can never reach the real network.
