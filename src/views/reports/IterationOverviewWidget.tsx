import { useEffect, useState } from "react";
import { capacityTotal, defaultIterationIndex, iterationSummary } from "../../api/reports";
import { CATEGORY_COLOR, fmtDate, Progress } from "../../components/common";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { ItemRef, SelectPi, Widget } from "./Widget";

/** Iteration Overview (team): page through the PI's iterations and their planned items. */
export function IterationOverviewWidget({ data, today }: { data: ReportData; today: number }) {
  const { node, pi } = useSafe();
  const [index, setIndex] = useState(() => (pi ? defaultIterationIndex(pi, today) : 0));
  useEffect(() => setIndex(pi ? defaultIterationIndex(pi, today) : 0), [pi?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pi)
    return (
      <Widget title="Iteration Overview" size="wide">
        <SelectPi />
      </Widget>
    );
  if (pi.sprints.length === 0)
    return (
      <Widget title="Iteration Overview" size="wide">
        <p className="muted widget-hint">{pi.name} has no iterations.</p>
      </Widget>
    );

  const sprint = pi.sprints[Math.min(index, pi.sprints.length - 1)];
  const hasCapacity = data.capacity.some((c) => c.nodeId === node.id && c.iterationPath.toLowerCase() === sprint.path.toLowerCase());
  const s = iterationSummary(data.piStories, sprint, hasCapacity ? capacityTotal(data.capacity, new Set([node.id]), [sprint.path]) : null);

  const pager = (
    <span className="pager">
      <button className="btn" aria-label="Previous iteration" disabled={index <= 0} onClick={() => setIndex(index - 1)}>
        ‹
      </button>
      <span className="pager-label">
        {sprint.name}
        {sprint.start && (
          <span className="muted small">
            {" "}
            {fmtDate(sprint.start)} – {fmtDate(sprint.finish)}
          </span>
        )}
      </span>
      <button className="btn" aria-label="Next iteration" disabled={index >= pi.sprints.length - 1} onClick={() => setIndex(index + 1)}>
        ›
      </button>
    </span>
  );

  return (
    <Widget title="Iteration Overview" size="wide" actions={pager}>
      <div className="iteration-stats">
        <div>
          <div className="kpi-value">{s.count}</div>
          <div className="muted small">Items</div>
        </div>
        <div>
          <div className="kpi-value">{s.capacity ?? "—"}</div>
          <div className="muted small">Capacity (SP)</div>
        </div>
        <div className="iteration-burn">
          <Progress done={s.done} total={s.planned} label={`${s.done} / ${s.planned} SP burned`} />
          {s.capacity !== null && s.planned > s.capacity && <div className="small bad-text">Overloaded by {s.planned - s.capacity} SP</div>}
        </div>
      </div>
      {s.groups.length === 0 ? (
        <p className="muted widget-hint">No items planned in {sprint.name}.</p>
      ) : (
        s.groups.map((g) => {
          const parent = g.parentId !== null ? data.items.get(g.parentId) : undefined;
          return (
            <div className="iteration-group" key={g.parentId ?? "none"}>
              <h4>{parent ? <ItemRef item={parent} /> : g.parentId !== null ? `#${g.parentId}` : "No parent feature"}</h4>
              <ul className="iteration-items">
                {g.items.map((i) => (
                  <li key={i.id} style={{ borderLeftColor: CATEGORY_COLOR[i.category] ?? CATEGORY_COLOR.InProgress }} data-category={i.category}>
                    <ItemRef item={i} />
                    <span className="spacer" />
                    <span className="muted small">{i.state}</span>
                    <span className="pill">{i.sp ?? "–"} SP</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </Widget>
  );
}
