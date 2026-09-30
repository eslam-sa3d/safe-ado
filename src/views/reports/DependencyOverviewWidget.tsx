import { useEffect, useState } from "react";
import { getUserValue, setUserValue } from "../../api/data";
import { CRITICALITY_COLOR, CRITICALITY_LABEL } from "../../api/dependencies";
import { DEP_SOURCE_LABEL, DepRow, DepSource, RItem } from "../../api/reports";
import { Criticality, Level } from "../../api/types";
import { lastSegment } from "../../components/common";
import { useSafe } from "../../components/context";
import { ReportData, reportDependencies } from "./data";
import { ItemRef, OpenInQuery, SelectPi, Widget } from "./Widget";

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

/** ARTs and solutions choose the dependency source; the other layers have a fixed one. */
export const canChooseDepSource = (level: Level) => level === "art" || level === "solution";

/** The source a layer uses: roadmap dates on the portfolio, iterations on teams, else the choice. */
export function effectiveDepSource(level: Level, chosen: DepSource): DepSource {
  return level === "portfolio" ? "roadmap" : canChooseDepSource(level) ? chosen : "team";
}

/**
 * The user's saved dependency source (team / roadmap / combined), shared by the Dependency
 * Overview and the Critical Dependencies widget so both count the same way.
 */
export function useDepSource(level: Level): [DepSource, (v: DepSource) => void] {
  const canChoose = canChooseDepSource(level);
  const [source, setSource] = useState<DepSource>("combined");
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
  return [source, choose];
}

/**
 * Dependency Overview: provider → consumer, internal (both in this unit) and external,
 * with a criticality filter. ARTs and solutions choose the planning source; the portfolio
 * uses roadmap dates; teams use their iteration planning.
 */
export function DependencyOverviewWidget({ data, source, onSource }: { data: ReportData; source: DepSource; onSource: (v: DepSource) => void }) {
  const { node, pi, pis } = useSafe();
  const canChoose = canChooseDepSource(node.level);
  const [shown, setShown] = useState<Set<Criticality>>(new Set(FILTERS));
  const choose = onSource;

  const effective = effectiveDepSource(node.level, source);
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
      <OpenInQuery ids={rows.flatMap((r) => [r.provider.id, r.consumer.id])} />
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
