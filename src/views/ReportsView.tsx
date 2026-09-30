import { useMemo } from "react";
import { DepSource, toDay } from "../api/reports";
import { Level } from "../api/types";
import { ErrorBar, Spinner, useAsync } from "../components/common";
import { useCan, useSafe } from "../components/context";
import { FlowWidget } from "./reports/FlowWidget";
import { BurnupWidget } from "./reports/BurnupWidget";
import { BusinessValueWidget } from "./reports/BusinessValueWidget";
import { CriticalDependenciesWidget } from "./reports/CriticalDependenciesWidget";
import { loadReportData, ReportData } from "./reports/data";
import { DependencyOverviewWidget, useDepSource } from "./reports/DependencyOverviewWidget";
import { HeaderWidget } from "./reports/HeaderWidget";
import { IterationOverviewWidget } from "./reports/IterationOverviewWidget";
import { LoadCapacityWidget } from "./reports/LoadCapacityWidget";
import { MilestonesWidget } from "./reports/MilestonesWidget";
import { ObjectivesWidget } from "./reports/ObjectivesWidget";
import { OverviewWidget } from "./reports/OverviewWidget";
import { PiProgressWidget } from "./reports/PiProgressWidget";
import { PointsBurnedWidget } from "./reports/PointsBurnedWidget";
import { PredictabilityWidget } from "./reports/PredictabilityWidget";
import { RisksWidget } from "./reports/RisksWidget";
import { VelocityWidget } from "./reports/VelocityWidget";
import { localToday } from "../api/rules";

export type WidgetKey =
  | "piProgress"
  | "burned"
  | "businessValue"
  | "load"
  | "velocity"
  | "critical"
  | "dependencies"
  | "burnup"
  | "milestones"
  | "objectives"
  | "risks"
  | "overview"
  | "iterations"
  | "predictability"
  | "flow";

const PI_WIDGETS: WidgetKey[] = [
  "piProgress",
  "burned",
  "businessValue",
  "load",
  "velocity",
  "critical",
  "burnup",
  "dependencies",
  "objectives",
  "risks",
  "milestones",
];

/** Agile Hive's widget matrix per layer (the header is always shown). */
export const LEVEL_WIDGETS: Record<Level, WidgetKey[]> = {
  portfolio: ["dependencies", "milestones", "overview"],
  solution: [...PI_WIDGETS, "overview", "predictability", "flow"],
  art: [...PI_WIDGETS, "overview", "predictability", "flow"],
  team: [...PI_WIDGETS, "iterations", "predictability", "flow"],
};

/** State the dashboard shares between widgets. */
interface Shared {
  depSource: DepSource;
  setDepSource: (v: DepSource) => void;
  reload: () => void;
}

function render(key: WidgetKey, data: ReportData, today: number, shared: Shared) {
  switch (key) {
    case "piProgress":
      return <PiProgressWidget key={key} today={today} />;
    case "burned":
      return <PointsBurnedWidget key={key} data={data} />;
    case "businessValue":
      return <BusinessValueWidget key={key} data={data} />;
    case "load":
      return <LoadCapacityWidget key={key} data={data} />;
    case "velocity":
      return <VelocityWidget key={key} data={data} today={today} />;
    case "critical":
      return <CriticalDependenciesWidget key={key} data={data} source={shared.depSource} />;
    case "dependencies":
      return <DependencyOverviewWidget key={key} data={data} source={shared.depSource} onSource={shared.setDepSource} />;
    case "burnup":
      return <BurnupWidget key={key} data={data} today={today} onRecorded={shared.reload} />;
    case "milestones":
      return <MilestonesWidget key={key} data={data} today={today} />;
    case "objectives":
      return <ObjectivesWidget key={key} data={data} />;
    case "risks":
      return <RisksWidget key={key} data={data} />;
    case "overview":
      return <OverviewWidget key={key} data={data} today={today} />;
    case "iterations":
      return <IterationOverviewWidget key={key} data={data} today={today} />;
    case "predictability":
      return <PredictabilityWidget key={key} data={data} />;
    case "flow":
      return <FlowWidget key={key} data={data} />;
  }
}

/** Reports: Agile Hive's landing dashboard, composed per SAFe layer. */
export function ReportsView() {
  const { config, node, pi, pis } = useSafe();
  const today = useMemo(() => toDay(localToday()), []);
  const can = useCan();
  const [depSource, setDepSource] = useDepSource(node.level);
  const { data, loading, error, reload } = useAsync(
    () => loadReportData(config, node, pi, { today, persist: can.plan, pis }),
    [config, node.id, pi?.path, can.plan, pis.map((p) => p.path).join("|")]
  );
  const shared: Shared = { depSource, setDepSource, reload: () => reload(true) };

  return (
    <div className="reports-dashboard">
      <div className="reports-grid">
        <HeaderWidget today={today} />
        {error ? (
          <div className="widget widget-wide">
            <ErrorBar message={error} />
            <button className="btn" onClick={() => reload()}>
              Retry
            </button>
          </div>
        ) : loading || !data ? (
          <div className="widget widget-wide">
            <Spinner label="Loading reports…" />
          </div>
        ) : (
          LEVEL_WIDGETS[node.level].map((k) => render(k, data, today, shared))
        )}
      </div>
    </div>
  );
}
