import { teamVelocity, trainVelocity } from "../../api/reports";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { SelectPi, Widget } from "./Widget";

/** Velocity: per-iteration average for teams, per-PI totals for ARTs and solutions. */
export function VelocityWidget({ data, today }: { data: ReportData; today: number }) {
  const { node, pi, pis } = useSafe();
  if (!pi)
    return (
      <Widget title="Velocity">
        <SelectPi />
      </Widget>
    );
  const team = node.level === "team";
  const v = team ? teamVelocity(pi, pis, data.stories, today) : trainVelocity(pi, pis, data.stories, today);
  return (
    <Widget title="Velocity">
      <div className="kpi">
        <div className="kpi-value">{v.value === null ? "—" : v.value}</div>
        <div className="muted small">
          SP {team ? "per iteration" : "per PI"} · {v.basis}
        </div>
      </div>
    </Widget>
  );
}
