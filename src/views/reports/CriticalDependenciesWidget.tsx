import { useSafe } from "../../components/context";
import { ReportData, reportDependencies } from "./data";
import { SelectPi, Widget } from "./Widget";

/** Critical Dependencies: unresolved dependencies whose provider is planned after its consumer. */
export function CriticalDependenciesWidget({ data }: { data: ReportData }) {
  const { pi, pis } = useSafe();
  if (!pi)
    return (
      <Widget title="Critical Dependencies">
        <SelectPi />
      </Widget>
    );
  const rows = reportDependencies(data, pis, "team");
  const critical = rows.filter((r) => r.criticality === "critical").length;
  return (
    <Widget title="Critical Dependencies">
      <div className="kpi">
        <div className={"kpi-value" + (critical > 0 ? " bad" : " good")}>{critical}</div>
        <div className="muted small">
          of {rows.filter((r) => r.criticality !== "resolved").length} unresolved in {pi.name}
        </div>
      </div>
    </Widget>
  );
}
