import { useCallback, useEffect, useMemo, useState } from "react";
import { getProject } from "../api/client";
import { defaultConfig, loadConfig, saveConfig as persistConfig } from "../api/data";
import { findNode, LEVEL_COLOR, pathTo } from "../api/org";
import { Level, LEVEL_LABEL, SafeConfig } from "../api/types";
import { getProgramIncrements } from "../api/wit";
import { HierarchyView } from "../views/HierarchyView";
import { ObjectivesView } from "../views/ObjectivesView";
import { OrganizationView } from "../views/OrganizationView";
import { PiManagementView } from "../views/PiManagementView";
import { PortfolioKanban } from "../views/PortfolioKanban";
import { ProgramBoard } from "../views/ProgramBoard";
import { ReportsView } from "../views/ReportsView";
import { RisksView } from "../views/RisksView";
import { RoadmapView } from "../views/RoadmapView";
import { SetupView } from "../views/SetupView";
import { TeamBoard } from "../views/TeamBoard";
import { WorkItemList } from "../views/WorkItemList";
import { ErrorBar, fmtDate, Spinner, storage, useAsync } from "./common";
import { SafeContext, SafeContextValue } from "./context";
import { Sidebar } from "./Sidebar";

export type ViewKey =
  | "reports"
  | "roadmap"
  | "kanban"
  | "board"
  | "teamboard"
  | "objectives"
  | "risks"
  | "workitems"
  | "hierarchy"
  | "organization"
  | "pis"
  | "setup";

const VIEW_LABEL: Record<ViewKey, string> = {
  reports: "Reports",
  roadmap: "Roadmap",
  kanban: "Portfolio Kanban",
  board: "ART Planning Board",
  teamboard: "Team Planning Board",
  objectives: "PI Objectives",
  risks: "Risks (ROAM)",
  workitems: "Work Item List",
  hierarchy: "Work Item Hierarchy",
  organization: "My Organization",
  pis: "PIs & Iterations",
  setup: "Setup",
};

/** Tabs per SAFe level, mirroring Agile Hive's project navigation (Reports is the landing page). */
export const LEVEL_VIEWS: Record<Level, ViewKey[]> = {
  portfolio: ["reports", "roadmap", "kanban", "risks", "workitems", "hierarchy"],
  solution: ["reports", "roadmap", "board", "objectives", "risks", "workitems", "hierarchy"],
  art: ["reports", "roadmap", "board", "objectives", "risks", "workitems", "hierarchy"],
  team: ["reports", "teamboard", "objectives", "risks", "workitems", "hierarchy"],
};

const GLOBAL_VIEWS: ViewKey[] = ["organization", "pis", "setup"];

/** Views that cannot render without a Program Increment. */
const NEEDS_PI: ViewKey[] = ["board", "teamboard", "objectives"];

export function App() {
  const [config, setConfig] = useState<SafeConfig | null>(null);
  const [firstRun, setFirstRun] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [getPrefs, setPrefs] = useMemo(
    () => storage(`safe-ado-prefs-${getProject().id}`, { nodeId: "", view: "reports" as ViewKey, piPath: "" }),
    []
  );
  const [nodeId, setNodeId] = useState(getPrefs().nodeId);
  const [view, setView] = useState<ViewKey>(getPrefs().view);
  const [piPath, setPiPath] = useState(getPrefs().piPath);

  useEffect(() => {
    (async () => {
      const saved = await loadConfig();
      if (saved) {
        setConfig(saved);
      } else {
        setConfig(await defaultConfig());
        setFirstRun(true);
        setView("setup");
      }
    })().catch((e) => setLoadError(e?.message ?? String(e)));
  }, []);

  const pisState = useAsync(
    () => (config ? getProgramIncrements(config.piRootIteration) : Promise.resolve([])),
    [config?.piRootIteration]
  );
  const pis = pisState.data ?? [];

  // Default to the PI running today, else the latest one.
  const pi = useMemo(() => {
    const chosen = pis.find((p) => p.path === piPath);
    if (chosen) return chosen;
    const now = new Date().toISOString();
    return pis.find((p) => p.start && p.finish && p.start <= now && now <= p.finish) ?? pis[pis.length - 1];
  }, [pis, piPath]);

  useEffect(() => setPrefs({ nodeId, view, piPath }), [nodeId, view, piPath, setPrefs]);

  const saveConfig = useCallback(async (next: SafeConfig) => {
    const saved = await persistConfig(next);
    setConfig(saved);
    setFirstRun(false);
  }, []);

  if (loadError) return <ErrorBar message={`Could not load SAFe configuration: ${loadError}`} />;
  if (!config) return <Spinner label="Loading SAFe configuration…" />;

  const node = findNode(config.root, nodeId) ?? config.root;
  const levelViews = LEVEL_VIEWS[node.level];
  const activeView: ViewKey = levelViews.includes(view) || GLOBAL_VIEWS.includes(view) ? view : levelViews[0];

  const ctx: SafeContextValue = {
    config,
    saveConfig,
    node,
    selectNode: setNodeId,
    pis,
    pi,
    reloadPis: () => pisState.reload(),
    openView: (v) => setView(v as ViewKey),
  };

  const needsPi = NEEDS_PI.includes(activeView);

  return (
    <SafeContext.Provider value={ctx}>
      <div className="layout">
        <Sidebar root={config.root} selectedId={node.id} onSelect={setNodeId} />
        <main className="main">
          <header className="header">
            <div className="breadcrumb">
              {pathTo(config.root, node.id).map((n, i, all) => (
                <span key={n.id}>
                  <button className="link" onClick={() => setNodeId(n.id)}>
                    {n.name}
                  </button>
                  {i < all.length - 1 && <span className="sep">›</span>}
                </span>
              ))}
              <span className="level-badge" style={{ background: LEVEL_COLOR[node.level] }}>
                {LEVEL_LABEL[node.level]}
              </span>
            </div>
            <div className="pi-picker">
              <label htmlFor="pi-select">PI</label>
              <select id="pi-select" value={pi?.path ?? ""} onChange={(e) => setPiPath(e.target.value)} disabled={!pis.length}>
                {!pis.length && <option value="">No PIs yet</option>}
                {pis.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.name}
                    {p.start ? ` (${fmtDate(p.start)} – ${fmtDate(p.finish)})` : ""}
                  </option>
                ))}
              </select>
            </div>
          </header>

          <div className="tabs" role="tablist">
            {levelViews.map((v) => (
              <Tab key={v} active={activeView === v} onClick={() => setView(v)}>
                {v === "board" && node.level === "solution" ? "Solution Planning Board" : VIEW_LABEL[v]}
              </Tab>
            ))}
            <span className="tabs-spacer" />
            {GLOBAL_VIEWS.map((v) => (
              <Tab key={v} active={activeView === v} onClick={() => setView(v)}>
                {VIEW_LABEL[v]}
              </Tab>
            ))}
          </div>

          <section className="content">
            <ErrorBar message={pisState.error && `Could not load PIs: ${pisState.error}`} />
            {firstRun && activeView !== "setup" && (
              <div className="msg msg-info">SAFe Ado is not configured for this project yet. Open Setup to get started.</div>
            )}
            {needsPi && !pi && !pisState.loading ? (
              <div className="empty">
                <h3>No Program Increments found</h3>
                <p>
                  Create PIs under <code>{config.piRootIteration}</code> or change the PI root iteration in Setup.
                </p>
                <button className="btn primary" onClick={() => setView("pis")}>
                  Create a PI
                </button>
              </div>
            ) : (
              <ViewSwitch view={activeView} firstRun={firstRun} />
            )}
          </section>
        </main>
      </div>
    </SafeContext.Provider>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button role="tab" aria-selected={active} className={"tab" + (active ? " active" : "")} onClick={onClick}>
      {children}
    </button>
  );
}

function ViewSwitch({ view, firstRun }: { view: ViewKey; firstRun: boolean }) {
  switch (view) {
    case "roadmap":
      return <RoadmapView />;
    case "kanban":
      return <PortfolioKanban />;
    case "teamboard":
      return <TeamBoard />;
    case "workitems":
      return <WorkItemList />;
    case "organization":
      return <OrganizationView />;
    case "board":
      return <ProgramBoard />;
    case "objectives":
      return <ObjectivesView />;
    case "risks":
      return <RisksView />;
    case "hierarchy":
      return <HierarchyView />;
    case "reports":
      return <ReportsView />;
    case "pis":
      return <PiManagementView />;
    case "setup":
      return <SetupView firstRun={firstRun} />;
  }
}
