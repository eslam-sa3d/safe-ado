# SAFe Ado for Azure DevOps

Run the Scaled Agile Framework (SAFe) in Azure Boards. It works on **Azure DevOps Services** and **Azure DevOps Server 2022.1**.

## Organization hierarchy
Model **Portfolio → Large Solution → Agile Release Train → Team** in a sidebar that is always visible. Each node maps to an Area Path and, if you choose, an Azure DevOps team. Every view is scoped to the node you select.

## Views
- **Portfolio Kanban**: Epics by state, sortable by WSJF.
- **Program Board**: Features by team and iteration for the selected PI. Drag a card to re-plan it. Dependencies are drawn as lines, and a line turns red when the successor is planned before its predecessor.
- **PI Objectives**: Committed and uncommitted objectives with planned and actual business value, plus automatic predictability.
- **Risks (ROAM)**: Drag-and-drop board with Resolved, Owned, Accepted and Mitigated columns.
- **Work Item Hierarchy**: Epic → Capability → Feature → Story tree, with story points rolled up.
- **Reports**: PI predictability trend, feature/epic progress, and team velocity per iteration.
- **PIs & Iterations**: Creates a PI with its sprints and IP iteration in one step, and assigns them to every team.

Works with the Agile, Scrum, CMMI and custom inherited processes.
