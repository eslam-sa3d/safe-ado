# SAFe Ado: Test Scenarios

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
| INS-05 | SDK handshake fails | `notifyLoadFailed` is called and the page shows "SAFe Ado failed to load: …" | Auto: `components/hub.test.tsx` |
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
| NAV-03 | Selecting a node updates the breadcrumb, level badge and tabs | Portfolio: Kanban / Hierarchy / Risks / Reports. Others: Board / Objectives / Risks / Hierarchy / Reports | Auto: `components/App.test.tsx` |
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
| KAN-01 | Columns come from Epic states, excluding Removed; counts exclude Removed epics | As described | Auto: `views/PortfolioKanban.test.tsx` |
| KAN-02 | WSJF = (BV + TC + RR/OE) ÷ Effort, only when the fields exist; sort by WSJF | As described | Auto: `views/PortfolioKanban.test.tsx` |
| KAN-03 | Drag to change state; invalid transition shows an error | As described | Auto: `views/PortfolioKanban.test.tsx`; Manual (process rules) |
| KAN-04 | Open an epic, create a new epic in the portfolio area, refresh | As described | Auto: `views/PortfolioKanban.test.tsx` |
| KAN-05 | No Epic type mapped | Guidance shown | Auto: `views/PortfolioKanban.test.tsx` |

## 12. Security and permissions (manual)

| ID | Scenario | Expected |
|---|---|---|
| SEC-01 | Stakeholder or Reader opens the hub | Views load; edits fail with a readable error; nothing is half-applied |
| SEC-02 | User without "Edit project-level information" creates a PI | Iteration creation fails with the server message |
| SEC-03 | Project A's data is not visible from project B | Config, objectives and risks are isolated per project |
| SEC-04 | Scopes are minimal | Only `vso.work_write` and `vso.project` are requested |

## 13. Regression bugs caught by this suite

These were found while writing the tests, fixed in the source, and are now covered:

1. **Program Board crashed when the first load failed.** It now shows the error (PB-16).
2. **A node with no area path queried the whole project.** It now matches nothing (NAV-09).
3. **Picking a team could discard the selection.** The area lookup wrote back into stale form state (SET-12).
4. **The Kanban count included Removed epics** (KAN-01).
5. **PI suggestions ignored PIs that loaded later.** This could lead to an overlapping "PI 1" (PI-05).
