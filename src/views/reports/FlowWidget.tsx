import { FlowKind, flowMetrics, isLive, RItem } from "../../api/reports";
import { Level, SafeConfig } from "../../api/types";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { plural, SelectPi, Widget } from "./Widget";

/** Colours of the flow distribution's kinds of work. */
export const KIND_COLOR: Record<FlowKind, string> = {
  Feature: "#009ccc",
  Enabler: "#773b93",
  Defect: "#cc293d",
  Debt: "#e0a800",
};

/**
 * Work item types that count as flow items, one backlog level per layer: team stories (and
 * bugs, when the process has them) for a team; features and enablers for an ART or solution.
 */
export function flowTypes(config: SafeConfig, level: Level, bug?: string): string[] {
  const { feature, story, enabler } = config.types;
  const types = level === "team" ? [story, bug] : [feature, enabler];
  return types.filter((t): t is string => !!t);
}

/** The unit's flow items among the loaded work items. */
export function flowItems(data: ReportData, types: string[]): RItem[] {
  return Array.from(data.items.values()).filter((i) => isLive(i) && types.includes(i.type) && data.inScope(i));
}

/**
 * Flow metrics (SAFe flow data) over one backlog level: flow velocity per iteration, flow
 * time from activation to closing, flow load (work of the selected PI in progress now) and
 * flow distribution by kind of work (Feature, Enabler, Defect, Debt).
 */
export function FlowWidget({ data }: { data: ReportData }) {
  const { config, node, pi } = useSafe();
  if (!pi)
    return (
      <Widget title="Flow metrics" size="wide">
        <SelectPi />
      </Widget>
    );
  const m = flowMetrics(flowItems(data, flowTypes(config, node.level, data.kinds.bug)), pi, data.firstActive, data.kinds);
  const level = node.level === "team" ? "stories" : "features and enablers";
  const maxVelocity = Math.max(1, ...m.velocity.map((v) => v.count));

  return (
    <Widget title="Flow metrics" size="wide">
      <div className="flow-grid">
        <div className="flow-tile" role="group" aria-label="Flow velocity">
          <h4>Flow velocity</h4>
          <div className="kpi-value">{m.completed}</div>
          <div className="muted small">
            {level} completed in {pi.name}
          </div>
          {m.velocity.length > 0 && (
            <ul className="flow-bars">
              {m.velocity.map((v) => (
                <li key={v.path} className={v.ip ? "ip" : undefined} title={`${v.name}: ${plural(v.count, "item")}`}>
                  <span className="flow-bar-label">{v.name}</span>
                  <span className="flow-bar-track">
                    <span className="flow-bar-fill" style={{ width: `${(v.count / maxVelocity) * 100}%` }} />
                  </span>
                  <span className="flow-bar-value">{v.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flow-tile" role="group" aria-label="Flow time">
          <h4>Flow time</h4>
          <div className="kpi-value">{m.time.median === null ? "—" : `${m.time.median} d`}</div>
          <div className="muted small">
            {m.time.samples > 0 ? `median · average ${m.time.average} d · ${plural(m.time.samples, "item")}` : "no completed items with a start date"}
          </div>
          {m.time.missing > 0 && <div className="muted small">{m.time.missing} without a start date</div>}
        </div>
        <div className="flow-tile" role="group" aria-label="Flow load">
          <h4>Flow load</h4>
          <div className="kpi-value">{m.load}</div>
          <div className="muted small">
            {level} of {pi.name} in progress now
          </div>
        </div>
        <div className="flow-tile" role="group" aria-label="Flow distribution">
          <h4>Flow distribution</h4>
          {m.distribution.length === 0 ? (
            <p className="muted small">No completed items.</p>
          ) : (
            <>
              <div className="flow-dist" role="img" aria-label={m.distribution.map((d) => `${d.kind} ${d.pct}%`).join(", ")}>
                {m.distribution.map((d) => (
                  <span key={d.kind} style={{ width: `${d.pct}%`, background: KIND_COLOR[d.kind] }} title={`${d.kind}: ${d.count}`} />
                ))}
              </div>
              <ul className="flow-legend small">
                {m.distribution.map((d) => (
                  <li key={d.kind}>
                    <span className="swatch" style={{ background: KIND_COLOR[d.kind] }} />
                    {d.kind} <strong>{d.pct}%</strong> <span className="muted">({d.count})</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </Widget>
  );
}
