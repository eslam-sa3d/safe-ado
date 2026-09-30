# Changelog

All notable changes to SAFe Ado are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The release workflow (`.github/workflows/release.yml`) publishes the section whose heading matches
the pushed tag, so every release needs a `## [x.y.z] - YYYY-MM-DD` heading here first.

## [Unreleased]

### Added
- **Cross-project portfolios**: units may point to areas and teams in other projects of the same
  collection; collection-level queries, PI matching by name or dates, writes mapped to each
  item's own project.
- **Lean Portfolio Management**: Lean Business Case and go / no-go decision per Epic, SAFe
  Portfolio Kanban columns with WIP limits and the Analyzing guardrail, value stream budgets per PI
  with forecast and actual spend, Epic cost vs. estimate, portfolio canvas.
- **Capacity source**: manual story points, derived from Azure DevOps team capacity (SAFe
  normalized estimation), or hybrid with overrides; the source is shown wherever capacity is.
- **Data governance**: audit stamps and a per-project change log for all SAFe data, History on
  objectives and risks, Setup audit log, export / import of all SAFe data.
- SAFe roles for unit members; only Business Owners enter Actual BV when a unit has any.
- Opt-in anonymous usage telemetry (off by default; see [docs/PRIVACY.md](docs/PRIVACY.md)).
- Release workflow, `npm run release:check`, and a guard that stops `npm run package` when
  `package.json` and `vss-extension.json` versions differ.
- Marketplace screenshots; privacy, support and security policies.

### Changed
- Writes that go only to extension data are read-only when a permission check cannot be
  answered (they used to be allowed).
- Marketplace listing rewritten for SAFe® program offices; trademark attribution added.

## [1.3.0] - 2026-09-30

### Added
- **PI Planning** view: PI summary, draft and final plan reviews per unit, confidence vote
  (fist of five) and Inspect & Adapt improvement items.
- **Reports v2**: PI snapshots for closed PIs, history burnup, flow metrics (flow velocity, flow
  time, flow load, flow distribution), estimated completion, create objectives and risks from the
  widgets, and "open in query".
- **ART / Solution Planning Board v2**: full item set, shared filter bar, story-level and external
  dependencies, cadence bands, read-only mode.
- **Roadmap v2**: virtualized timeline, filter bar, external dependencies, resize-only while filtered.
- **Team Planning Board v2**: sibling-team counts and no-access state, sidebar markers and filter,
  drag highlights, rolled-over shadows, PI on create, SAFe facets, edge indicators, external
  placement, read-only mode.
- **Work Item List and work item form panel v2**: identity picker, SAFe-layer parent validation,
  editing of assigned teams and PIs, PI involvement, estimated completion, "open children in query",
  hub deep link.
- Extended filter bar: priority, iteration and SAFe facets, saved quick filters, server-validated
  WIQL clause.
- Shell: help menu, onboarding tour, `C` shortcut to create an item, "Open in Azure Boards",
  keyboard navigation in the sidebar, deep links (`#node=…&view=…&pi=…`) with back/forward,
  "Updated X ago" and a notice while throttled requests wait to retry.
- Setup: configuration checklist, dependency link type, RR/OE field for WSJF, Enabler and Strategic
  Theme types, per-unit PI cadence, member picker, unattached units.
- PIs & Iterations: editable PI plan with rollback, iteration delete, team assignment scoped to the
  unit's cadence.
- Read-only UI for users without the matching Azure DevOps permissions; per-unit planning
  permission checked with a validate-only work item create.

### Changed
- Stored records keep stable node ids as well as paths and repair themselves after area or
  iteration renames and moves.
- Capacity is keyed by iteration id.
- Dates use the viewer's local calendar day everywhere (tested from UTC−11 to UTC+14).
- One shared WSJF formula, (BV + TC + RR/OE) ÷ job size, in every view; the Portfolio Kanban now
  uses the configured RR/OE field.
- A Feature may sit directly under an Epic when the process has no Capability layer in use.

### Fixed
- Team board, Work Item List and filter findings from the parity audit.
- Reports: honest snapshots, truncated history handling, PI-id matching, flow and forecast fixes.
- Throttled (429) and transient 503 responses are retried safely; WIQL queries page past 20,000
  results; `ORDER BY` handling respects string literals.

## [1.2.0] - 2026-09-29

### Changed
- UI rebuilt on the Azure DevOps design system ("Formula"): host theme tokens, buttons, pivot tabs,
  depth-8 cards, tables, pills, message bars and dialogs; Light, Dark and High-contrast themes.
- Fluent icons (a ~7 KB subset of the official icon fonts) replace unicode glyphs.

### Added
- `npm run preview`: a browser preview of the hub against the in-memory fake backend.

### Fixed
- Host palette variables are `r, g, b` triplets and are now wrapped in `rgba()`; backgrounds,
  borders and selection colours were previously dropped inside Azure DevOps.

## [1.1.0] - 2026-09-29

### Added
- **Roadmap**: PI, iteration and milestone rows; drag and resize planned dates; unplanned sidebar;
  automatic PI assignment; date-based dependency criticality.
- **Team Planning Board**: sprint columns, feature swimlanes, Independent lane, load vs. capacity,
  Team and ART backlogs, drag to set sprint and parent, create in a cell, read-only sibling teams,
  EXTERNAL dependency lanes.
- **ART / Solution Planning Board** calculated mode (default): placement from the teams' plans,
  owning and involved teams, unplanned-children warnings, milestones, critical dependencies per row.
- **Reports** rebuilt as a widget dashboard: PI progress, story points burned, business value,
  load vs. capacity, velocity, critical dependencies, dependency overview, burnup, milestones,
  PI objectives, PI risks with exposure, PI / Epic overview, iteration overview, predictability.
- **Work Item List**, **My Organization** canvas, starred units, and the **SAFe panel** on the
  work item form.
- ROAM risk assessment: probability, impact, residual values and the exposure matrix.
- PI edit and delete, sprint mapping per team, unit members and roles.
- Shared filter bar with a WIQL clause; `docs/AGILE_HIVE_PARITY.md`.

## [1.0.2] - 2026-09-29

### Changed
- Marked the extension public on the Visual Studio Marketplace.
- Added repository and support links to the manifest.

## [1.0.1] - 2026-09-29

### Changed
- Marketplace publisher set to `SAFeADO`.

## [1.0.0] - 2026-09-29

### Added
- SAFe hub under Boards for Azure DevOps Services and Azure DevOps Server 2022.1.
- Portfolio → Large Solution → ART → Team hierarchy mapped to area paths and teams.
- Program Board with dependency lines, PI Objectives, ROAM risks, work item hierarchy, reports,
  PI and iteration management, and Setup.
- All REST calls pinned to `api-version=7.0` for Server 2022.1 compatibility.

[Unreleased]: https://github.com/eslam-sa3d/safe-ado/compare/v1.2.0...HEAD
[1.3.0]: https://github.com/eslam-sa3d/safe-ado/compare/v1.2.0...main
[1.2.0]: https://github.com/eslam-sa3d/safe-ado/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/eslam-sa3d/safe-ado/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/eslam-sa3d/safe-ado/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/eslam-sa3d/safe-ado/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/eslam-sa3d/safe-ado/commit/1a0d65c
