import { subtreeIds } from "../../api/org";
import { businessValue, teamProgress } from "../../api/reports";
import { PiObjective } from "../../api/types";
import { Progress } from "../../components/common";
import { useSafe } from "../../components/context";
import { bvTone } from "./BusinessValueWidget";
import { ReportData } from "./data";
import { SelectPi, Widget } from "./Widget";

function ObjectiveTable({ title, objectives }: { title: string; objectives: PiObjective[] }) {
  const planned = objectives.reduce((s, o) => s + (o.plannedBV || 0), 0);
  const actual = objectives.reduce((s, o) => s + (o.actualBV ?? 0), 0);
  return (
    <table className="grid compact objective-table" aria-label={title}>
      <thead>
        <tr>
          <th>{title}</th>
          <th className="num">Plan BV</th>
          <th className="num">Actual BV</th>
        </tr>
      </thead>
      <tbody>
        {objectives.length === 0 ? (
          <tr>
            <td colSpan={3} className="muted small">
              None
            </td>
          </tr>
        ) : (
          objectives.map((o) => (
            <tr key={o.id}>
              <td>{o.title}</td>
              <td className="num">{o.plannedBV}</td>
              <td className="num">{o.actualBV ?? "—"}</td>
            </tr>
          ))
        )}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td className="num">{planned}</td>
          <td className="num">{actual}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** PI Objectives of this unit, plus the business-value progress of each child unit. */
export function ObjectivesWidget({ data }: { data: ReportData }) {
  const { node, pi, selectNode } = useSafe();
  if (!pi)
    return (
      <Widget title="PI Objectives" size="medium">
        <SelectPi />
      </Widget>
    );
  const inPi = data.objectives.filter((o) => o.piPath === pi.path);
  const own = inPi.filter((o) => o.nodeId === node.id).sort((a, b) => b.plannedBV - a.plannedBV || a.title.localeCompare(b.title));
  const bv = businessValue(own);
  const showTeams = node.level === "art" || node.level === "solution";
  const progress = showTeams ? teamProgress(node.children, inPi, subtreeIds) : null;

  return (
    <Widget title="PI Objectives" size="medium">
      <div className="muted small">
        {node.name}: {bv.actual} of {bv.planned} committed BV{bv.pct !== null ? ` (${bv.pct}%)` : ""}
      </div>
      <ObjectiveTable title="Committed" objectives={own.filter((o) => o.committed)} />
      <ObjectiveTable title="Uncommitted" objectives={own.filter((o) => !o.committed)} />
      {progress && (
        <div className="team-progress">
          <h4>
            Team progress
            {progress.average !== null && <span className="muted small"> · average {progress.average}%</span>}
          </h4>
          {progress.rows.length === 0 ? (
            <p className="muted small">No child units.</p>
          ) : (
            progress.rows.map((r) => (
              <div className="team-progress-row" key={r.node.id}>
                <button className="link" onClick={() => selectNode(r.node.id)}>
                  {r.node.name}
                </button>
                <div className={"tone-" + (bvTone(r.pct) ?? "none")}>
                  <Progress done={r.actual} total={r.planned} label={r.pct === null ? "No committed BV" : `${r.pct}% · ${r.actual}/${r.planned} BV`} />
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </Widget>
  );
}
