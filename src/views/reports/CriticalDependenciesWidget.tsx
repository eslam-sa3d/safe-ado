import { DEP_SOURCE_LABEL, DepSource } from "../../api/reports";
import { useSafe } from "../../components/context";
import { ReportData, reportDependencies } from "./data";
import { effectiveDepSource } from "./DependencyOverviewWidget";
import { SelectPi, Widget } from "./Widget";

/**
 * Critical Dependencies: unresolved dependencies rated critical by the same source the
 * Dependency Overview uses (the saved team / roadmap / combined choice).
 */
export function CriticalDependenciesWidget({ data, source }: { data: ReportData; source: DepSource }) {
  const { node, pi, pis } = useSafe();
  if (!pi)
    return (
      <Widget title="Critical Dependencies">
        <SelectPi />
      </Widget>
    );
  const effective = effectiveDepSource(node.level, source);
  const rows = reportDependencies(data, pis, effective);
  const critical = rows.filter((r) => r.criticality === "critical").length;
  return (
    <Widget title="Critical Dependencies">
      <div className="kpi">
        <div className={"kpi-value" + (critical > 0 ? " bad" : " good")}>{critical}</div>
        <div className="muted small">
          of {rows.filter((r) => r.criticality !== "resolved").length} unresolved in {pi.name}
        </div>
        <div className="muted small">by {DEP_SOURCE_LABEL[effective].toLowerCase()}</div>
      </div>
    </Widget>
  );
}
