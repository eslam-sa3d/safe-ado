import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getProject } from "../api/client";
import { defaultConfig, loadConfig, saveConfig as persistConfig } from "../api/data";
import { effectivePiRoot, findNode, pathTo } from "../api/org";
import { ALL_ALLOWED, Capabilities, loadCapabilities } from "../api/permissions";
import { indexTree, reconcileConfig, reconcileDocs } from "../api/reconcile";
import { localToday } from "../api/rules";
import { readUrlState, writeUrlState } from "../api/urlState";
import { Level, LEVEL_LABEL, SafeConfig } from "../api/types";
import { getAreaTree, getIterationTree, getProgramIncrements } from "../api/wit";
import { HierarchyView } from "../views/HierarchyView";
import { ObjectivesView } from "../views/ObjectivesView";
import { OrganizationView } from "../views/OrganizationView";
import { PiManagementView } from "../views/PiManagementView";
import { PiPlanningView } from "../views/PiPlanningView";
import { PortfolioKanban } from "../views/PortfolioKanban";
import { ProgramBoard } from "../views/ProgramBoard";
import { ReportsView } from "../views/ReportsView";
import { RisksView } from "../views/RisksView";
import { RoadmapView } from "../views/RoadmapView";
import { SetupView } from "../views/SetupView";
import { TeamBoard } from "../views/TeamBoard";
import { WorkItemList } from "../views/WorkItemList";
import { ErrorBar, fmtDate, Icon, LevelPill, RefreshContext, Spinner, storage, useAsync } from "./common";
import { SafeContext, SafeContextValue } from "./context";
import { HelpMenu } from "./HelpMenu";
import { OpenInBoardsButton, useNewItemShortcut } from "./shell";
import { Sidebar } from "./Sidebar";
import { Tour } from "./Tour";

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
  | "planning"
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
  planning: "PI Planning",
  organization: "My Organization",
  pis: "PIs & Iterations",
  setup: "Setup",
};

/** Tabs per SAFe level, mirroring Agile Hive's project navigation (Reports is the landing page). */
export const LEVEL_VIEWS: Record<Level, ViewKey[]> = {
  portfolio: ["reports", "roadmap", "kanban", "risks", "workitems", "hierarchy"],
  solution: ["reports", "roadmap", "board", "planning", "objectives", "risks", "workitems", "hierarchy"],
  art: ["reports", "roadmap", "board", "planning", "objectives", "risks", "workitems", "hierarchy"],
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
  // The chosen PI, by iteration id (or, for older preferences, by path).
  const [piPath, setPiPath] = useState(getPrefs().piPath);
  const [can, setCan] = useState<Capabilities>(ALL_ALLOWED);
  const [tick, setTick] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const [tourKey, setTourKey] = useState(0);
  const urlReady = useRef(false);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
    setUpdatedAt(new Date());
  }, []);

  useEffect(() => {
    (async () => {
      // Deep link (#node=...&view=...&pi=...) wins over the remembered preferences.
      const url = await readUrlState();
      if (url.node) setNodeId(url.node);
      if (url.view) setView(url.view as ViewKey);
      if (url.pi) setPiPath(url.pi);
      urlReady.current = true;
      const saved = await loadConfig();
      if (saved) {
        setConfig(saved);
        void heal(saved);
      } else {
        setConfig(await defaultConfig());
        setFirstRun(true);
        setView("setup");
      }
    })().catch((e) => setLoadError(e?.message ?? String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Loads permissions and repairs keys of renamed areas / iterations (see api/reconcile.ts). */
  const heal = async (saved: SafeConfig) => {
    try {
      const [areaTree, iterationTree] = await Promise.all([getAreaTree(), getIterationTree()]);
      const caps = await loadCapabilities(areaTree.identifier, iterationTree.identifier);
      setCan(caps);
      const iterations = indexTree(iterationTree);
      const fixedConfig = reconcileConfig(saved, indexTree(areaTree), iterations);
      if (fixedConfig) {
        setConfig(fixedConfig);
        if (caps.admin) await persistConfig(fixedConfig).catch(() => undefined);
      }
      if (caps.plan && (await reconcileDocs(iterations)) > 0) refresh();
    } catch {
      /* healing is best effort; views still work with the stored keys */
    }
  };

  const piRoot = config ? effectivePiRoot(config, nodeId) : "";
  const pisState = useAsync(() => (config ? getProgramIncrements(piRoot) : Promise.resolve([])), [piRoot, !!config]);
  const pis = pisState.data ?? [];

  // Default to the PI running today, else the latest one.
  const pi = useMemo(() => {
    const chosen = pis.find((p) => p.identifier === piPath || p.path === piPath);
    if (chosen) return chosen;
    const today = localToday();
    return pis.find((p) => p.start && p.finish && p.start.slice(0, 10) <= today && today <= p.finish.slice(0, 10)) ?? pis[pis.length - 1];
  }, [pis, piPath]);

  useEffect(() => setPrefs({ nodeId, view, piPath }), [nodeId, view, piPath, setPrefs]);
  useEffect(() => {
    if (urlReady.current && config) void writeUrlState({ node: nodeId || undefined, view, pi: pi?.identifier });
  }, [nodeId, view, pi?.identifier, config]);

  const shortcutNode = config ? findNode(config.root, nodeId) ?? config.root : undefined;
  useNewItemShortcut({ config: config!, node: shortcutNode!, pi, enabled: !!config && can.plan });

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
    piRoot,
    can,
  };

  const needsPi = NEEDS_PI.includes(activeView);

  return (
    <RefreshContext.Provider value={tick}>
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
              <LevelPill level={node.level} />
              {!can.admin && !can.plan && (
                <span className="pill readonly-pill" title="You can view this project's SAFe data but not change it">
                  Read-only
                </span>
              )}
            </div>
            <div className="pi-picker">
              <OpenInBoardsButton config={config} node={node} />
              <HelpMenu onRestartTour={() => setTourKey((k) => k + 1)} />
              <span className="muted small updated" title={updatedAt.toLocaleString()}>
                Updated {updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              <button className="btn subtle" onClick={refresh} title="Reload all data">
                <Icon name="Refresh" /> Refresh all
              </button>
              <label htmlFor="pi-select">PI</label>
              <select id="pi-select" value={pi?.path ?? ""} onChange={(e) => setPiPath(pis.find((p) => p.path === e.target.value)?.identifier ?? e.target.value)} disabled={!pis.length}>
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
            <Tour view={activeView} suppressed={firstRun && activeView === "setup"} restartKey={tourKey} />
            {firstRun && activeView !== "setup" && (
              <div className="msg msg-info">SAFe Ado is not configured for this project yet. Open Setup to get started.</div>
            )}
            {needsPi && !pi && !pisState.loading ? (
              <div className="empty">
                <h3>No Program Increments found</h3>
                <p>
                  Create PIs under <code>{piRoot}</code> or change the PI root iteration in Setup.
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
    </RefreshContext.Provider>
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
    case "planning":
      return <PiPlanningView />;
    case "setup":
      return <SetupView firstRun={firstRun} />;
  }
}
