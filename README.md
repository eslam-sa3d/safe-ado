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
| **Portfolio Kanban** | Portfolio | Epics by state; drag to change state; sort by WSJF |
| **PI Objectives** | Solution / ART / Team | Committed and uncommitted objectives, planned and actual BV, predictability |
| **Risks (ROAM)** | All | ROAM board; probability and impact, with residual values and the exposure matrix |
| **Work Item List** | All | Inline edit of title, priority, assignee and parent. Level-specific columns (owning team, involved teams, assigned PIs, PI involvement). Sort, filter, CSV export |
| **Work Item Hierarchy** | All | Epic → Capability → Feature → Story tree with story-point roll-ups |
| **My Organization** | Global | Canvas with one band per layer. Add, re-parent by drag, detach or remove units |
| **PIs & Iterations** | Global | Create, edit and delete PIs and iterations, including an IP iteration. Overlap checks and a maximum of 10 iterations. Sprint mapping per team |
| **Setup** | Global | Type mapping, PI root iteration, hierarchy editor with members, generate the hierarchy from area paths |
| **SAFe panel** on the work item form | — | Shows the item's unit, PI, parent and children. Edits owning team, assigned PIs and planned dates |

Every board and list has the shared filter bar: text search, Type / State / Assignee / Tags facets, an advanced WIQL clause, Copy WIQL, and Clear. Units can be starred in the sidebar.

## How SAFe maps onto Azure DevOps

| SAFe concept | Azure DevOps |
|---|---|
| Portfolio / Large Solution / ART / Team | Nodes in the SAFe Ado hierarchy; each has an **Area Path** and optionally a **Team** |
| Epic / Capability / Feature / Story | Work item types, mapped in Setup (Capability is optional) |
| PI | A child iteration of the configured *PI root iteration* |
| Iteration / IP iteration | Children of the PI iteration |
| Dependency | `Successor` / `Predecessor` link between work items |
| PI Objective, ROAM risk | Extension Data Service documents (per project) |
| Hierarchy / settings | Extension Data Service value (per project) |

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
- Collection-level hub for portfolios that span several projects
- Work item form group showing PI, ART and objective links
- PI planning mode (team breakouts, confidence vote)
- Dashboard widgets for predictability and the program board
