import { teamVelocity, trainVelocity } from "../../api/reports";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { SelectPi, SnapshotNote, Widget } from "./Widget";

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
  const snap = data.snapshot;
  const v = snap?.velocity ?? (team ? teamVelocity(pi, pis, data.stories, today) : trainVelocity(pi, pis, data.stories, today));
  return (
    <Widget title="Velocity">
      <div className="kpi">
        <div className="kpi-value">{v.value === null ? "—" : v.value}</div>
        <div className="muted small">
          SP {team ? "per iteration" : "per PI"} · {v.basis}
        </div>
        {snap && (
          <>
            {team && snap.sprintVelocity.length > 0 && (
              <ul className="snapshot-sprints small" aria-label="Velocity per iteration">
                {snap.sprintVelocity.map((s) => (
                  <li key={s.path}>
                    <span>{s.name}</span> <strong>{s.done}</strong>
                  </li>
                ))}
              </ul>
            )}
            <SnapshotNote createdAt={snap.createdAt} />
          </>
        )}
      </div>
    </Widget>
  );
}
