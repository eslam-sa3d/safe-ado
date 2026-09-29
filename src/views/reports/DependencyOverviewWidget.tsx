import { useEffect, useState } from "react";
import { getUserValue, setUserValue } from "../../api/data";
import { CRITICALITY_COLOR, CRITICALITY_LABEL } from "../../api/dependencies";
import { DEP_SOURCE_LABEL, DepRow, DepSource, RItem } from "../../api/reports";
import { Criticality } from "../../api/types";
import { lastSegment } from "../../components/common";
import { useSafe } from "../../components/context";
import { ReportData, reportDependencies } from "./data";
import { ItemRef, SelectPi, Widget } from "./Widget";

const FILTERS: Criticality[] = ["critical", "atRisk", "healthy", "resolved"];
const SOURCES: DepSource[] = ["team", "roadmap", "combined"];

export function CriticalityChip({ value, prefix }: { value: Criticality; prefix?: string }) {
  return (
    <span className={"crit-chip crit-" + value} style={{ borderColor: CRITICALITY_COLOR[value], color: CRITICALITY_COLOR[value] }}>
      {prefix}
      {CRITICALITY_LABEL[value]}
    </span>
  );
}

function Side({ item }: { item: RItem }) {
  return (
    <div className="dep-side">
      <ItemRef item={item} />
      <span className="muted small">
        {lastSegment(item.area)} · {lastSegment(item.iteration) || "Unplanned"}
      </span>
    </div>
  );
}

function Group({ title, rows }: { title: string; rows: DepRow[] }) {
  return (
    <tbody>
      <tr className="dep-group">
        <th colSpan={4}>
          {title} <span className="count">({rows.length})</span>
        </th>
      </tr>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={4} className="muted small">
            No {title.toLowerCase()} dependencies.
          </td>
        </tr>
      ) : (
        rows.map((r) => (
          <tr key={`${r.provider.id}>${r.consumer.id}`} className={r.criticality === "resolved" ? "dep-resolved" : undefined}>
            <td>
              <Side item={r.provider} />
            </td>
            <td className="dep-arrow" aria-hidden="true">
              →
            </td>
            <td>
              <Side item={r.consumer} />
            </td>
            <td>
              <CriticalityChip value={r.criticality} />
              {r.secondary && (
                <span className="dep-secondary" title="Roadmap criticality">
                  <CriticalityChip value={r.secondary} prefix="Roadmap: " />
                </span>
              )}
            </td>
          </tr>
        ))
      )}
    </tbody>
  );
}

/**
 * Dependency Overview: provider → consumer, internal (both in this unit) and external,
 * with a criticality filter. ARTs and solutions choose the planning source; the portfolio
 * uses roadmap dates; teams use their iteration planning.
 */
export function DependencyOverviewWidget({ data }: { data: ReportData }) {
  const { node, pi, pis } = useSafe();
  const canChoose = node.level === "art" || node.level === "solution";
  const [source, setSource] = useState<DepSource>("combined");
  const [shown, setShown] = useState<Set<Criticality>>(new Set(FILTERS));

  useEffect(() => {
    if (!canChoose) return;
    let live = true;
    getUserValue<DepSource>("depSource", "combined")
      .then((v) => live && SOURCES.includes(v) && setSource(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [canChoose]);

  const choose = (v: DepSource) => {
    setSource(v);
    setUserValue("depSource", v).catch(() => undefined);
  };

  const effective: DepSource = node.level === "portfolio" ? "roadmap" : canChoose ? source : "team";
  const needsPi = node.level !== "portfolio" && !pi;
  const rows = needsPi ? [] : reportDependencies(data, pis, effective).filter((r) => shown.has(r.criticality));

  const actions = (
    <>
      {canChoose && (
        <label className="check small">
          Source
          <select aria-label="Dependency source" value={source} onChange={(e) => choose(e.target.value as DepSource)}>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {DEP_SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      )}
      {FILTERS.map((f) => (
        <label className="check small" key={f}>
          <input
            type="checkbox"
            checked={shown.has(f)}
            onChange={(e) => {
              const next = new Set(shown);
              if (e.target.checked) next.add(f);
              else next.delete(f);
              setShown(next);
            }}
          />
          {CRITICALITY_LABEL[f]}
        </label>
      ))}
    </>
  );

  return (
    <Widget title="Dependency Overview" size="wide" actions={actions}>
      {needsPi ? (
        <SelectPi />
      ) : (
        <table className="grid compact dep-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th />
              <th>Consumer</th>
              <th>Criticality ({node.level === "portfolio" ? "roadmap dates" : DEP_SOURCE_LABEL[effective].toLowerCase()})</th>
            </tr>
          </thead>
          <Group title="Internal" rows={rows.filter((r) => r.internal)} />
          <Group title="External" rows={rows.filter((r) => !r.internal)} />
        </table>
      )}
    </Widget>
  );
}
