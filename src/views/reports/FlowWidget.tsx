import { flowMetrics, isLive, RItem } from "../../api/reports";
import { SafeConfig } from "../../api/types";
import { typeColor } from "../../components/common";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { plural, SelectPi, Widget } from "./Widget";

/** Work item types that count as flow items: everything below the epic. */
export function flowTypes(config: SafeConfig): string[] {
  const { capability, feature, story, enabler } = config.types;
  return [story, feature, capability, enabler].filter((t): t is string => !!t);
}

/** The unit's flow items among the loaded work items. */
export function flowItems(data: ReportData, types: string[]): RItem[] {
  return Array.from(data.items.values()).filter((i) => isLive(i) && types.includes(i.type) && data.inScope(i));
}

/**
 * Flow metrics (SAFe flow data): flow velocity per iteration, flow time from activation to
 * closing, flow load (work in progress now) and flow distribution by work item type.
 */
export function FlowWidget({ data }: { data: ReportData }) {
  const { config, pi } = useSafe();
  if (!pi)
    return (
      <Widget title="Flow metrics" size="wide">
        <SelectPi />
      </Widget>
    );
  const m = flowMetrics(flowItems(data, flowTypes(config)), pi, data.firstActive);
  const maxVelocity = Math.max(1, ...m.velocity.map((v) => v.count));

  return (
    <Widget title="Flow metrics" size="wide">
      <div className="flow-grid">
        <div className="flow-tile" role="group" aria-label="Flow velocity">
          <h4>Flow velocity</h4>
          <div className="kpi-value">{m.completed}</div>
          <div className="muted small">items completed in {pi.name}</div>
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
          <div className="muted small">items in progress now</div>
        </div>
        <div className="flow-tile" role="group" aria-label="Flow distribution">
          <h4>Flow distribution</h4>
          {m.distribution.length === 0 ? (
            <p className="muted small">No completed items.</p>
          ) : (
            <>
              <div className="flow-dist" role="img" aria-label={m.distribution.map((d) => `${d.type} ${d.pct}%`).join(", ")}>
                {m.distribution.map((d) => (
                  <span key={d.type} style={{ width: `${d.pct}%`, background: typeColor(d.type) }} title={`${d.type}: ${d.count}`} />
                ))}
              </div>
              <ul className="flow-legend small">
                {m.distribution.map((d) => (
                  <li key={d.type}>
                    <span className="swatch" style={{ background: typeColor(d.type) }} />
                    {d.type} <strong>{d.pct}%</strong> <span className="muted">({d.count})</span>
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
