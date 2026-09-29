import { subtreeIds } from "../../api/org";
import { useSafe } from "../../components/context";
import { predictability } from "../ObjectivesView";
import { ReportData } from "./data";
import { Widget } from "./Widget";

/** PI predictability trend (not in Agile Hive): by PI for this unit, and by child for the selected PI. */
export function PredictabilityWidget({ data }: { data: ReportData }) {
  const { node, pis, pi } = useSafe();
  const scope = subtreeIds(node);
  const inScope = data.objectives.filter((o) => scope.has(o.nodeId));
  return (
    <Widget title="PI Predictability" size="wide">
      <p className="muted small">Actual BV ÷ planned BV of committed objectives · target 80–100%</p>
      <div className="two-col">
        <div>
          <h4>By PI — {node.name}</h4>
          <BarChart
            rows={pis.map((p) => {
              const r = predictability(inScope.filter((o) => o.piPath === p.path));
              return { label: p.name, value: r.pct, detail: `${r.actual}/${r.planned} BV` };
            })}
          />
        </div>
        {node.children.length > 0 && pi && (
          <div>
            <h4>
              By {node.level === "art" ? "team" : "child"} — {pi.name}
            </h4>
            <BarChart
              rows={node.children.map((c) => {
                const ids = subtreeIds(c);
                const r = predictability(inScope.filter((o) => o.piPath === pi.path && ids.has(o.nodeId)));
                return { label: c.name, value: r.pct, detail: `${r.actual}/${r.planned} BV` };
              })}
            />
          </div>
        )}
      </div>
    </Widget>
  );
}

function BarChart({ rows }: { rows: { label: string; value: number | null; detail: string }[] }) {
  if (rows.length === 0) return <p className="muted">No data.</p>;
  const max = Math.max(120, ...rows.map((r) => r.value ?? 0));
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.label}>
          <span className="bar-label" title={r.label}>
            {r.label}
          </span>
          <div className="bar-track">
            <div className="bar-band" style={{ left: `${(80 / max) * 100}%`, width: `${(20 / max) * 100}%` }} />
            {r.value !== null && (
              <div
                className={"bar-fill " + (r.value >= 80 ? "good" : r.value >= 60 ? "warn" : "bad")}
                style={{ width: `${(Math.min(r.value, max) / max) * 100}%` }}
              />
            )}
          </div>
          <span className="bar-value">{r.value === null ? "—" : `${r.value}%`}</span>
          <span className="muted small bar-detail">{r.detail}</span>
        </div>
      ))}
    </div>
  );
}
