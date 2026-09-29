import { objectivesStore } from "../api/data";
import { boardRows, boardType, scopeAreas, subtreeIds } from "../api/org";
import { baseFields, loadTree, scopeQuery } from "../api/queries";
import { F } from "../api/types";
import { getStateCategories, isUnder, openWorkItem, queryWorkItems } from "../api/wit";
import { Empty, ErrorBar, Progress, Spinner, useAsync } from "../components/common";
import { useSafe } from "../components/context";
import { predictability } from "./ObjectivesView";

export function ReportsView() {
  const { node } = useSafe();
  return (
    <div className="reports">
      <PredictabilityReport />
      <ProgressReport />
      {node.level !== "portfolio" && <VelocityReport />}
    </div>
  );
}

/** PI predictability across all PIs for the selected subtree, plus per-child for the current PI. */
function PredictabilityReport() {
  const { node, pis, pi } = useSafe();
  const { data, loading, error } = useAsync(() => objectivesStore.list(), []);
  const scope = subtreeIds(node);
  const inScope = (data ?? []).filter((o) => scope.has(o.nodeId));

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>PI Predictability</h3>
        <span className="muted small">Actual BV ÷ planned BV of committed objectives · target 80–100%</span>
      </div>
      <ErrorBar message={error} />
      {loading && !data ? (
        <Spinner />
      ) : (
        <div className="two-col pad">
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
              <h4>By {node.level === "art" ? "team" : "child"} — {pi.name}</h4>
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
      )}
    </section>
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

/** Feature (or epic at portfolio level) completion based on child story points. */
function ProgressReport() {
  const { config, node, pi } = useSafe();
  const type = boardType(config, node.level);
  const areas = scopeAreas(node);
  const iteration = node.level === "portfolio" ? undefined : pi?.path;
  const { data, loading, error } = useAsync(() => loadTree(config, type, areas, iteration), [
    config,
    type,
    areas.join("|"),
    iteration,
  ]);

  const roots = data ?? [];
  const points = roots.reduce((s, r) => s + r.points, 0);
  const done = roots.reduce((s, r) => s + r.donePoints, 0);

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>
          {type} progress{iteration ? ` — ${pi?.name}` : ""}
        </h3>
        <span className="spacer" />
        {roots.length > 0 && (
          <div style={{ width: 220 }}>
            <Progress done={done} total={points} label={`Overall ${done}/${points} pts`} />
          </div>
        )}
      </div>
      <ErrorBar message={error} />
      {loading && !data ? (
        <Spinner />
      ) : roots.length === 0 ? (
        <Empty title={`No ${type}s in scope`} />
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: "50%" }}>{type}</th>
              <th>State</th>
              <th>Children done</th>
              <th style={{ width: 200 }}>Points</th>
            </tr>
          </thead>
          <tbody>
            {[...roots]
              .sort((a, b) => b.points - b.donePoints - (a.points - a.donePoints))
              .map((r) => (
                <tr key={r.item.id}>
                  <td>
                    <button className="link title-link" onClick={() => openWorkItem(r.item.id)}>
                      {r.item.fields[F.title]}
                    </button>{" "}
                    <span className="muted small">#{r.item.id}</span>
                  </td>
                  <td>{r.item.fields[F.state]}</td>
                  <td className="muted">
                    {r.doneCount}/{r.count}
                  </td>
                  <td>
                    <Progress done={r.donePoints} total={r.points} label={`${r.donePoints}/${r.points}`} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Planned vs completed story points per team and iteration in the selected PI. */
function VelocityReport() {
  const { config, node, pi } = useSafe();
  const rows = boardRows(node).filter((r) => r.areaPath);
  const areas = scopeAreas(node);
  const story = config.types.story;
  const { data, loading, error } = useAsync(async () => {
    if (!pi) return [];
    const [items, category] = await Promise.all([
      queryWorkItems(scopeQuery([story], areas, pi.path), baseFields(config)),
      getStateCategories([story]),
    ]);
    return items
      .map((i) => ({ i, cat: category(i.fields[F.type], i.fields[F.state]) }))
      .filter((x) => x.cat !== "Removed");
  }, [story, areas.join("|"), pi?.path, config.storyPointsField]);

  if (!pi) return null;
  const pts = (x: { i: { fields: Record<string, any> } }) => Number(x.i.fields[config.storyPointsField]) || 0;

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Velocity — {pi.name}</h3>
        <span className="muted small">Completed / planned {story} points per iteration</span>
      </div>
      <ErrorBar message={error} />
      {loading && !data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="muted pad">Map teams to area paths in Setup to see velocity.</p>
      ) : (
        <table className="grid velocity">
          <thead>
            <tr>
              <th>Team</th>
              {pi.sprints.map((s) => (
                <th key={s.path}>{s.name}</th>
              ))}
              <th>PI total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const teamItems = (data ?? []).filter((x) => isUnder(x.i.fields[F.area], row.areaPath!));
              const cell = (list: typeof teamItems) => {
                const planned = list.reduce((s, x) => s + pts(x), 0);
                const done = list.filter((x) => x.cat === "Completed").reduce((s, x) => s + pts(x), 0);
                return <Progress done={done} total={planned} label={`${done}/${planned}`} />;
              };
              return (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  {pi.sprints.map((s) => (
                    <td key={s.path}>{cell(teamItems.filter((x) => isUnder(x.i.fields[F.iteration], s.path)))}</td>
                  ))}
                  <td>{cell(teamItems)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
