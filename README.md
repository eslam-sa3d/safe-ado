# SAFe Ado for Azure DevOps

An Azure DevOps extension that adds a **SAFe** hub under **Boards**. Its navigation is modeled on Agile Hive for Jira: a sidebar with the Portfolio → Large Solution → ART → Team hierarchy, and a set of SAFe views scoped to the node you select.

It supports **Azure DevOps Services** and **Azure DevOps Server 2022.1**.

## Features

The feature set follows Agile Hive for Jira. [docs/AGILE_HIVE_PARITY.md](docs/AGILE_HIVE_PARITY.md) compares the two feature by feature.

| View | Level | What it does |
|---|---|---|
| **Reports** (landing page) | All | Header with members; PI progress; story points burned; business value; load vs. capacity; velocity; critical dependencies; dependency overview; burnup (scope, burned, ideal, forecast); milestones; PI objectives; PI risks with exposure; PI / Epic overview; iteration overview; predictability trend |
| **Roadmap** | Portfolio / Solution / ART | Timeline with PI, iteration and milestone rows. Drag and resize to set planned dates. Unplanned items sit in a sidebar. The PI is assigned automatically at ART level. Dependencies are rated by date |
| **ART / Solution Planning Board** | Solution / ART | *Calculated* mode (the default) places features by their teams' plans and shows involved teams, the owning team, unplanned-children warnings, milestones and critical dependencies per row. *Feature iteration* mode supports drag-and-drop re-planning and dependency editing |
| **Team Planning Board** | Team | Sprint columns with feature swimlanes and an Independent lane. Load vs. capacity per sprint. Team and ART backlogs. Drag to set sprint and parent. Create items in a cell. Read-only sibling teams. EXTERNAL dependency lanes |
| **Portfolio Kanban** | Portfolio | SAFe columns (Funnel, Reviewing, Analyzing, Ready, Implementing, Done) mapped onto the Epic states, with WIP limits per column and an over-limit warning. Drag to move; leaving Analyzing without a Lean Business Case and a Go decision asks for confirmation. Edit each Epic's Lean Business Case from its card. Sort by WSJF |
| **Lean Portfolio** | Portfolio | Portfolio canvas (vision, strategic themes). Value stream budgets per PI for the portfolio, solutions and ARTs, with forecast and actual spend and a guardrail warning when the forecast exceeds the budget. Epic cost vs. the MVP and full estimates of its Lean Business Case |
| **PI Objectives** | Solution / ART / Team | Committed and uncommitted objectives, planned and actual BV (entered by the unit's Business Owners when it has any), predictability, change history |
| **Risks (ROAM)** | All | ROAM board; probability and impact, with residual values and the exposure matrix; who raised and changed each risk, and its history |
| **Work Item List** | All | Inline edit of title, priority, assignee and parent. Level-specific columns (owning team, involved teams, assigned PIs, PI involvement). Sort, filter, CSV export |
| **Work Item Hierarchy** | All | Epic → Capability → Feature → Story tree with story-point roll-ups |
| **My Organization** | Global | Canvas with one band per layer. Add, re-parent by drag, detach or remove units |
| **PIs & Iterations** | Global | Create, edit and delete PIs and iterations, including an IP iteration. Overlap checks and a maximum of 10 iterations. Sprint mapping per team |
| **Setup** | Global | Type mapping, PI root iteration, capacity source, hierarchy editor with members and their SAFe roles, generate the hierarchy from area paths, backup / restore of all SAFe data, audit log |
| **SAFe panel** on the work item form | — | Shows the item's unit, PI, parent and children. Edits owning team, assigned PIs and planned dates. For Epics, shows and edits the Lean Business Case |

Every board and list has the shared filter bar: text search, Type / State / Assignee / Tags facets, an advanced WIQL clause, Copy WIQL, and Clear. Units can be starred in the sidebar.

## How SAFe maps onto Azure DevOps

| SAFe concept | Azure DevOps |
|---|---|
| Portfolio / Large Solution / ART / Team | Nodes in the SAFe Ado hierarchy; each has an **Area Path** and optionally a **Team** |
| Epic / Capability / Feature / Story | Work item types, mapped in Setup (Capability is optional) |
| PI | A child iteration of the configured *PI root iteration* |
| Iteration / IP iteration | Children of the PI iteration |
| Dependency | `Successor` / `Predecessor` link between work items |
| PI Objective, ROAM risk | Extension Data Service documents (per project), stamped and logged in the audit log |
| Lean Business Case, value stream budget, portfolio canvas | Extension Data Service documents: `leancases` (per Epic), `budgets` (per unit and PI), `lpmsettings` (per unit: Kanban mapping, WIP limits, currency, rates, vision, themes) |
| SAFe roles (RTE, Product Owner, Business Owner, …) | Members of hierarchy nodes, linked to Azure DevOps identities |
| Hierarchy / settings | Extension Data Service value (per project) |
| Team capacity | Manual story points (Extension Data Service), or derived from the Azure DevOps team capacity (see below) |
| Units in other projects | A unit may point to an area path and team in **another project of the same collection** (pick the project first in Setup or My Organization). The configuration stays in the host project |

## Capacity source

Setup → **Capacity** decides where team capacity comes from. Every place that shows capacity (Team Planning Board, Load vs. Capacity, Iteration Overview, PI snapshots) resolves it through one function (`resolveCapacity` in [src/api/capacity.ts](src/api/capacity.ts)), so the numbers always agree.

| Source | Capacity per team and iteration |
|---|---|
| **Manual story points** (default; existing configurations keep it) | The story points entered on the Team Planning Board |
| **Derived from Azure DevOps team capacity** | SAFe normalized estimation from the team's capacity page (Boards → Sprints → Capacity): each member with a capacity per day above 0 in any activity contributes one point factor per available working day. Working days follow the team's settings; team days off and the member's days off are excluded. The factor defaults to **0.8 SP per person-day**, so a full-time member in a 2-week iteration yields 8 SP. Hours per day and activities only decide whether a member counts. |
| **Hybrid** | The derived value by default; a value entered on the Team Planning Board overrides it, and clearing it restores the derived value |

With a derived or hybrid source, capacity values carry a small marker (*manual*, *derived*, *override*, *mixed* or *not set*). Its tooltip explains the calculation, including the person-days and the points per member. When a team has no capacity in Azure DevOps (nothing entered, the iteration is not selected for the team, or no team is linked to the unit), the value shows as *not set* with a link to the team's capacity page. Capacity is read with `_apis/work/teamsettings` (working days), `.../iterations/{id}/capacities` and `.../iterations/{id}/teamdaysoff`, all at api-version 7.0; both the `{ teamMembers }` shape of Azure DevOps Services and the plain list shape are accepted.

## Data governance and permissions

SAFe Ado's own data (PI objectives, ROAM risks, milestones, capacity, planning metadata, confidence votes, plan reviews, improvements and the configuration) lives in the **Extension Data Service**. Azure DevOps keeps no history of it and has no permissions for it: **any project member can write it through the REST API, and it cannot be ACL-protected server-side.** SAFe Ado therefore:

- **Hides edit controls** from users without the matching Azure DevOps permission (planning rights in the unit's area; project administrator for the configuration). This is a UX guard, not an access control.
- **Fails closed for extension data.** If a permission check cannot be answered (an error rather than "denied"), objectives, risks, milestones, capacity, votes, reviews and the configuration are read-only, with a message explaining why and a **Retry**. Work item edits stay available, because Azure DevOps enforces those itself.
- **Keeps an audit log, which is the control.** Every write through SAFe Ado is stamped (`createdBy`/`createdAt`, `modifiedBy`/`modifiedAt`) and appended to a per-project change log (`audit-<projectId>`) with the changed fields. Objectives and risks have a **History** dialog; **Setup → Audit log** shows every change, filterable by data and user. The log keeps the latest 2000 changes of the last 180 days. Writes made outside SAFe Ado (directly through the REST API) are not logged.
- **Lets Business Owners own Actual BV.** When a unit or one of its ancestors has members with the *Business Owner* role, only those people (matched by their Azure DevOps identity, so pick them from the team) can enter Actual BV on PI objectives. Who entered it and when is shown.
- **Backs up and restores.** Azure DevOps deletes extension data when the extension is uninstalled. **Setup → Export SAFe data** downloads one JSON file with the configuration and every document collection (with a schema version); **Import** (administrators) validates it, shows a summary, and merges or overwrites. Export before uninstalling or moving to another collection.

## Cross-project portfolios

Large enterprises often keep ARTs or solutions in separate projects. A portfolio configured in one project (the *host*) can include units from other projects of the same collection:

- **Queries.** A scope inside the host project works exactly as before (`[System.TeamProject] = @project`). A scope that spans projects lists them (`[System.TeamProject] IN (...)`, plus the area clauses) and runs WIQL at collection level. Work items are always read by id at collection level.
- **PIs.** The host project's PI root (or the unit's cadence in the host project) defines the PIs. Each project has its own iteration tree, so a unit in another project names its **PI root in that project** (inherited by its children; by default the cadence's path in that project, e.g. `Contoso\PIs`). Its PIs and sprints are matched to the cadence **by name, else by identical dates**. Boards, reports and lists show foreign items in the matched cadence sprint; iterations with no match are listed in a note at the top of the hub.
- **Writes.** Re-planning a foreign item (drag, create in a cell, remove from board) writes that project's matching iteration; new items are created in the area's project. Moving an item between projects is refused (use *Move to team project* in Azure Boards).
- **Limitations.** Team iteration subscriptions (sprint mapping and "Assign to teams" in PIs & Iterations) are not available for teams of other projects; a note says so. All projects should use the same work item types (states are read from the host project's process). Objectives, risks and other SAFe data stay in the host project. The SAFe panel on the work item form of a foreign item uses that project's own configuration. There is no collection-level hub; open the hub in the host project.

## Compatibility notes (Server 2022.1)

- All REST calls go through [src/api/client.ts](src/api/client.ts) and are pinned to `api-version=7.0`. That is the highest version Server 2022.1 supports, and Azure DevOps Services accepts it too. The typed REST clients in `azure-devops-extension-api` are deliberately not used, because they request 7.1/preview versions that on-prem servers reject.
- The collection URL comes from the location service, so it works for `dev.azure.com/org`, `org.visualstudio.com` and `https://server/tfs/Collection`.
- The target is `Microsoft.VisualStudio.Services`, which covers both cloud and on-prem.

## Build

```bash
npm install
npm run typecheck
npm run package          # typecheck + tests + build -> out/SAFeADO.safe-ado-<version>.vsix
```

The Marketplace publisher is `SAFeADO` (set in [vss-extension.json](vss-extension.json)). Bump `version` there before each publish.

## Design

The UI follows the Azure DevOps design system (the "Formula" styles used by `azure-devops-ui`):
- **Theme:** colours come from the theme variables the host injects, so Light, Dark and High-contrast all work.
- **Components:** buttons, pivot tabs, cards (depth-8), tables, pills, message bars and dialogs match the `bolt-*` components.
- **Icons:** Fluent icons are subset from the official icon fonts (`src/hub/fonts`, about 7 KB).

To look at the UI without an Azure DevOps organization:

```bash
npm run preview   # builds preview-dist/ against the in-memory fake backend used by the tests
# open preview-dist/index.html?view=board&node=n-arta&theme=dark
```

## Testing

```bash
npm test               # 558 tests
npm run test:coverage  # with coverage report (fails below 95% lines / 85% branches)
npm run typecheck      # src + tests
```

Tests run each view end to end against an in-memory fake of the Azure DevOps REST API, the Extension Data Service and the SDK (`test/fakeAdo.ts`, `test/sdkMock.ts`). [docs/TEST_SCENARIOS.md](docs/TEST_SCENARIOS.md) lists every scenario, marks whether it is automated or manual, and includes the manual checklist for Azure DevOps Services and Server 2022.1. CI runs typecheck, tests with coverage, and packaging on every push (`.github/workflows/ci.yml`).

## Install

**Azure DevOps Services**
1. Create a publisher at https://marketplace.visualstudio.com/manage.
2. Upload the VSIX. Keep it private and share it with your organization, or run `tfx extension publish --share-with <org>`.
3. Install it from *Organization settings → Extensions*.

**Azure DevOps Server 2022.1**
1. Go to *Collection settings → Extensions → Browse local extensions → Manage extensions → Upload extension* and select the VSIX.
2. Install it into the collection.

After installing, open **Boards → SAFe** and go to **Setup**:
1. Check the work item type mapping. It is auto-detected for Agile, Scrum and CMMI.
2. Choose the PI root iteration, for example a `PIs` iteration under the project.
3. Click **Generate from area paths**, or build the hierarchy by hand, and link Azure DevOps teams.
4. Save, then use **PIs & Iterations** to create your first PI.

## Project layout

```
src/
  api/        REST client (api 7.0), WIT helpers, extension data, org tree helpers, shared queries
  components/ App shell, sidebar, shared UI
  views/      One file per view
  hub/        Entry point, HTML, styles
```

## Roadmap ideas
- Work item form group showing PI, ART and objective links
- PI planning mode (team breakouts, confidence vote)
- Dashboard widgets for predictability and the program board

## Trademarks

SAFe® and Scaled Agile Framework® are registered trademarks of Scaled Agile, Inc. This extension is not affiliated with or endorsed by Scaled Agile, Inc.
