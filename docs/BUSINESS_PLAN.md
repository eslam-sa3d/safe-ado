# SAFe Ado: business plan and open decisions

*Owner decision document. Status: draft for review, 2026-09-30. Product version: 1.3.0 (not yet published).*

This document lists the choices that need to be made before SAFe Ado is sold to organisations.
Every section ends with a **Decision needed** callout. Where a statement depends on third-party rules
(Scaled Agile trademark policy, Visual Studio Marketplace terms), it is marked **Verify**. Those
rules change and nothing here is legal advice.

## Summary of recommendations

| # | Topic | Recommendation |
|---|---|---|
| A | Trademark | Rename the product before the paid launch. Keep nominative "for SAFe®" wording. Ask Scaled Agile about a partnership in parallel, as an upside rather than a dependency. |
| B | Revenue | Open core. A free Community edition on the Marketplace, with paid Pro and Enterprise tiers unlocked by an offline, signed licence key bought outside the Marketplace. Services revenue from the design partners. |
| C | ICP | Organisations with 1 to 10 ARTs on Azure DevOps, especially **Azure DevOps Server** (regulated, on-premises) where Jira Align or SaaS tools aren't an option. The buyer is the Agile PMO / LPM. The daily user is the RTE. |
| D | Pilot | 3 design partners, one of them on Server 2022.1, through one full PI (about 10–12 weeks). |
| E | KPIs | Weekly active ARTs is the north-star metric. Retention past the 2nd PI is the go/no-go signal for charging. |
| F | Differentiation | Azure Pipelines / Release on Demand linkage, then cross-project portfolios and LPM. |

---

## A. Trademark

**Situation.** SAFe® and Scaled Agile Framework® are registered trademarks of Scaled Agile, Inc.
The product name "SAFe Ado", the publisher id `SAFeADO` and the extension id `safe-ado` all contain
the mark. Using a mark *inside a product name* is the use most likely to draw a complaint. Using
it only to describe compatibility ("for SAFe®") is generally the safer, nominative use.

**Already in place (nominative-use wording):**

- The Marketplace description says "Scaled agile planning for SAFe® in Azure Boards…".
- `overview.md` and `README.md` end with: *"SAFe® and Scaled Agile Framework® are registered trademarks of Scaled Agile, Inc. This extension is not affiliated with or endorsed by Scaled Agile, Inc."*
- SAFe terms (ART, PI, WSJF, ROAM) are used descriptively. No Scaled Agile logos or artwork are used.

**Options**

| Option | What it takes | Pros | Cons |
|---|---|---|---|
| 1. **Partner with Scaled Agile** (tool / platform partner programme) | Application, partner fees, possibly a product review; **Verify** the current programme, its fees and whether it allows the mark in a product name | Legitimacy with SAFe buyers, listing in the partner directory, co-marketing | Cost, lead time, dependence on their approval and roadmap, possible constraints on messaging |
| 2. **Rename** and keep nominative "for SAFe®" wording | New display name, logo and domain; a trademark search for the new name | Removes the main legal risk; the brand is fully owned; cheap now (few installs) | Loses "SAFe" search match in the name (tags and description still match); rename work |
| 3. Status quo | Nothing | No effort | Risk of a takedown request, possibly *after* customers depend on it; blocks some enterprise procurement |

**Marketplace constraint (Verify):** the extension's *display name* and the publisher's *display
name* can be changed. The **publisher id and extension id cannot** be changed without publishing
a new listing, and existing installs would not move to it automatically. Renaming before the paid
launch keeps that cost low.

**Candidate names** (a trademark and Marketplace search is required for each before choosing):

1. **TrainYard for Azure DevOps**: release trains, a yard where they are assembled and planned.
2. **PI Compass**: PI planning and direction; short.
3. **Cadence Boards**: cadence and synchronisation, and the "Boards" hub it lives in.
4. **ScaleLane**: swimlanes at scale; neutral and easy to trademark.
5. **ArtFlow Planner**: ART plus flow metrics. Check for conflicts with design-tool brands.

> **Decision needed (A1):** Rename now (recommended), apply to partner, or both?
> **Decision needed (A2):** Which name goes to trademark search (pick 2)?
> **Decision needed (A3):** New listing and new publisher id at the rename, or keep the ids and change only display names?

---

## B. Revenue model

### Options

1. **Open core with tiers** (recommended). A free Community edition drives installs, and a paid
   tier adds what a PMO or RTE needs to run several trains.
2. **Services-led.** The extension stays free, and revenue comes from PI Planning facilitation,
   setup and migration (for example from Excel, Jira Align or Delivery Plans), training, and
   custom work. Fast early revenue, but it doesn't scale and ties the owner's time to delivery.
3. **Licence key sold outside the Marketplace.** Sell through the owner's website or a reseller
   (for example Paddle, Stripe or a software distributor). The extension checks an **offline,
   signed licence file** stored in the Extension Data Service, so it keeps the "no outbound calls"
   promise and works on disconnected Azure DevOps Server installs.

**Visual Studio Marketplace rules (Verify before building anything).** For years, native paid
billing through the Marketplace has been limited or closed to new third-party publishers.
Publishers of paid Azure DevOps extensions typically list the extension for free and link to their
own purchase page. Check the current *Marketplace publisher agreement* and paid-extension
documentation for:
(a) whether native paid or trial billing is available;
(b) the rules for "free listing with in-product licence";
(c) the required disclosure wording on the listing ("Paid", "Trial");
(d) any restrictions on disabling features.
Azure DevOps Server never supported Marketplace billing for disconnected servers. There, a licence
key is the only workable model.

### Proposed free / paid split

| Capability | Community (free) | Pro (per ART) | Enterprise (per organisation) |
|---|---|---|---|
| Hierarchy, Setup, PIs & Iterations, work item form panel | ✅ | ✅ | ✅ |
| Team Planning Board, ART / Solution Planning Board | ✅ (1 ART) | ✅ unlimited ARTs | ✅ |
| PI Objectives, ROAM risks, Work Item List, Hierarchy | ✅ | ✅ | ✅ |
| Reports: core widgets (progress, burnup, velocity, load/capacity) | ✅ | ✅ | ✅ |
| Reports: predictability trend, flow metrics, closed-PI snapshots and history | — | ✅ | ✅ |
| PI Planning event: plan reviews, confidence vote, Inspect & Adapt | — | ✅ | ✅ |
| Roadmap with milestones and dependency criticality | — | ✅ | ✅ |
| Large Solution layer, Portfolio Kanban / WSJF | — | — | ✅ |
| Lean Portfolio Management, cross-project portfolios, capacity planning *(in development)* | — | — | ✅ |
| Audit log, backup/restore, SAFe roles *(in development)* | — | — | ✅ |
| Azure DevOps Server offline licence, priority support | — | — | ✅ |

The first ART stays free, including both planning boards, so one train can run a real PI Planning
without buying anything. That is the adoption loop. Payment starts with the second ART, which is
the point where a PMO gets involved.

**Price hypotheses** (to be tested with the design partners, not published): Pro at a price per
ART per year that sits well below per-user tools. Enterprise as an annual organisation licence
with tiers by number of ARTs. A 30-day full trial with no credit card.

**Build implications.** A licence module (offline signature check, grace period, read-only
fallback, never locking data) and tier flags in the UI. Existing data must stay readable when a
licence lapses.

### Recommendation
Open core with an offline licence key, sold outside the Marketplace. The Community edition stays
fully useful for one ART. Services (PI Planning onboarding) run alongside in year 1 to fund the work
and to learn from customers, but they are not the business model.

> **Decision needed (B1):** Approve open core with an offline licence key?
> **Decision needed (B2):** Approve the free/paid split above, or move a row. The most debated rows are Roadmap and the PI Planning event.
> **Decision needed (B3):** Choose the billing provider / reseller, and check the Marketplace rules (owner, before any build work).
> **Decision needed (B4):** Keep the repository MIT-licensed, or move the paid modules to a separate licence or repository?

---

## C. Target customer (ICP) and personas

**Ideal customer profile**

- An organisation already standardised on **Azure DevOps**, where moving to Jira is not on the table.
- **1–10 ARTs** (roughly 50–1,000 people in trains), running or starting SAFe® PI Planning.
- Planning happens today in Excel, PowerPoint, sticky-note boards or Delivery Plans, and RTEs
  build reports by hand.
- **Strongest segment:** regulated or sovereign organisations on **Azure DevOps Server
  2022.1 on-premises** (government, defence, banking, energy, healthcare). There, SaaS tools and
  outbound data flows are hard to get approved, and "data stays in your Azure DevOps" is the deciding point.
- Too big or not a fit for Jira Align, Planview or Targetprocess, whether because of price,
  time-to-value or data residency.

**Buyer vs. user personas**

| Persona | Role in purchase | Cares about | What wins them |
|---|---|---|---|
| **Head of Agile PMO / LACE lead** | **Economic buyer**, owns the tool budget | One consistent SAFe structure, predictability across trains, audit/compliance | Portfolio-level reports, audit/roles, Server support, price per ART |
| **LPM / portfolio manager** | Co-buyer at Enterprise tier | WSJF, epic flow, budgets and guardrails | Portfolio Kanban, LPM roadmap, cross-project view |
| **Release Train Engineer** | **Champion and daily power user** | Running PI Planning and ART sync without spreadsheets | ART board, dependencies, confidence vote, I&A, flow metrics |
| **Product / Solution Manager** | User | Feature placement, roadmap | Roadmap, ART board |
| **Product Owner / Scrum Master** | User (team level) | Breakout planning, capacity | Team Planning Board |
| **Azure DevOps administrator / security** | **Gatekeeper** | Scopes, data flows, install on Server | PRIVACY.md, no outbound calls, api-version 7.0, VSIX upload |

> **Decision needed (C1):** Is the go-to-market Server-first (a sharper message and less competition) or cloud-first (bigger volume, more competition)? Recommended: **lead with Server 2022.1 and regulated industries**, and keep cloud as the volume channel.

---

## D. Pilot programme

**Goal:** prove that one ART can run a full PI (PI Planning → execution → Inspect & Adapt) in
SAFe Ado, and learn what they would pay for.

**Design partners: 3**, recruited within 4 weeks:

1. An **Azure DevOps Server 2022.1 on-premises** organisation (required), ideally regulated.
2. An **Azure DevOps Services** organisation with a single ART that is new to SAFe.
3. An **Azure DevOps Services** organisation with 2 or more ARTs or a Large Solution, to test the Pro/Enterprise boundary.

**Entry criteria**

- An RTE (or equivalent) sponsors the pilot, and a PMO/LPM stakeholder agrees to a final review.
- At least one ART with 4 or more teams in one Azure DevOps project, and a PI Planning event 3–8 weeks away.
- A project administrator can install the extension. A test project is used for a dry run first.
- They agree to the feedback cadence below and, if the pilot succeeds, to be a named or anonymous reference.
- They accept the pilot terms: free Pro/Enterprise during the pilot plus a discount for the first year, and no SLA.

**Success criteria (measured through one full PI)**

| Area | Criterion |
|---|---|
| Adoption | PI Planning run in SAFe Ado. At least 80% of the ART's teams plan on the Team Planning Board. The ART board is used in the final plan review. |
| Artefacts | All PI objectives (with BV) and ROAM risks are captured in the tool. The confidence vote is recorded. |
| Execution | The RTE uses Reports in at least 75% of ART syncs. Dependencies are kept in the tool. |
| Close | Predictability is reported at Inspect & Adapt from the tool, and I&A items are recorded. |
| Quality | No data loss. No blocker bug open for more than 5 business days. Works on Server 2022.1 without workarounds. |
| Value | The RTE rates it at least 8/10 as "would be very disappointed without it". The sponsor states a price they would pay, or refuses with a reason. |
| Continuation | The partner plans the next PI in SAFe Ado (this is the retention signal). |

**Feedback cadence**

- **Before PI Planning:** a 60-minute setup session and a dry run on a test project.
- **PI Planning:** on-call support on both days, then a 45-minute retro within 3 days.
- **During the PI:** a weekly 30-minute call with the RTE, and a shared issue board (GitHub issues, private labels).
- **At Inspect & Adapt:** a 60-minute review with the RTE and the PMO/LPM sponsor, covering the success criteria and a pricing conversation.
- **Releases:** fixes every 2 weeks during the pilot. Server partners receive a VSIX with release notes.

> **Decision needed (D1):** Approve the 3-partner shape and the pilot terms (free during the pilot, first-year discount)?
> **Decision needed (D2):** Which contacts do we approach first, especially for the Server 2022.1 slot?

---

## E. KPIs and how telemetry supports them

Telemetry is **opt-in** (see [PRIVACY.md](PRIVACY.md)), so the telemetry figures are a lower bound
from consenting projects. They are always read together with Marketplace statistics and the
design-partner interviews.

| KPI | Definition | Source today | Telemetry support |
|---|---|---|---|
| **Installs** | Organisations / collections with the extension installed | Marketplace publisher statistics (installs, uninstalls; Services only). Server installs are not visible. | Distinct `collection` hashes that send any event (opted-in only). This includes Server installs whose build has an endpoint. |
| **Weekly active ARTs** (north star) | ARTs with planning activity in a week | Not available | **Gap:** events carry no unit identity. Options: a salted hash of the ART id on board events, or only a count per collection. This needs a privacy decision (E2). Proxy until then: collections with `view_opened.board`/`view_opened.teamboard` in the week. |
| **PIs created** | New PIs per collection per month | Not available | `pi_created` (the name is reserved; it needs wiring in PIs & Iterations) |
| **Retention past the 2nd PI** | Share of collections that create a 2nd PI and are still active 30 days after it starts | Design partners | `pi_created` count ≥ 2 per collection hash, plus `view_opened.*` after it |
| **Conversion** | Share of active collections with a paid licence; trial → paid | Licence / billing system (outside telemetry) | None needed. Licence keys are matched to customers in the billing system, not through telemetry. |
| Feature usage | Which views matter, to inform the free/paid split | Interviews | `view_opened.<view>` (shipped in 1.3.0 when opted in) |

**Needed to make these measurable:** a telemetry endpoint (small, EU-hosted, stores only the
payload, drops IP addresses at ingestion), the `pi_created` and `board_replanned` events wired,
and a dashboard.

> **Decision needed (E1):** Stand up a telemetry endpoint and ship a build with it (with the Setup opt-in unchanged)? Where is it hosted and how long are events kept?
> **Decision needed (E2):** Allow a salted hash of the ART id in events, so weekly active ARTs can be measured, or stay at collection level?

---

## F. Differentiation roadmap

The native Azure DevOps tools (Delivery Plans, backlogs) and connector-based SAFe tools (Jira Align,
Planview and others) either lack SAFe structure or take data outside Azure DevOps. SAFe Ado is
built **inside** Azure DevOps, so it can use data that the others can't reach easily:

1. **Pipelines and Release on Demand (next).** Link features and epics to Azure Pipelines runs,
   deployments and environments through the existing development links (commits, PRs,
   builds, releases). Show "released / deployed to prod" on the ART board and the Roadmap, add
   **lead time to production** to the flow metrics, and show Release on Demand milestones fed
   by actual deployments. Neither Jira-centric tools nor Delivery Plans offer this in Azure DevOps.
2. **Cross-project portfolios** *(in development)*: a portfolio that spans several projects in a collection.
3. **Lean Portfolio Management** *(in development)*: lean budgets and guardrails, the epic
   hypothesis and lean business case, and portfolio flow.
4. **Capacity** *(in development)*: capacity per team per iteration, fed into load vs. capacity and PI Planning.
5. **Governance** *(in development)*: audit log, backup/restore and SAFe roles, which Enterprise buyers need.
6. **Server-first quality:** every feature tested against Server 2022.1 (`api-version=7.0`) and
   an offline licence, which keeps the regulated on-prem segment defensible.

> **Decision needed (F1):** Confirm Pipelines / Release on Demand as the next differentiator after the current in-flight work (portfolios, LPM, capacity, governance).
> **Decision needed (F2):** Which tier does Pipelines linkage belong to? Recommended: **Enterprise**, with a read-only "deployed" badge in Pro.

---

## Next 30 days (if the recommendations are accepted)

1. Trademark search on 2 candidate names; choose a name; update the listing's display name, logo and wording.
2. Check the current Marketplace paid-extension rules; choose a billing provider.
3. Recruit the 3 design partners (Server 2022.1 first); publish 1.3.0 to the Marketplace.
4. Design the licence module; wire `pi_created` / `board_replanned`; decide on the telemetry endpoint.
