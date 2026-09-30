import { useState } from "react";
import { boardType, flatten } from "../../api/org";
import { descendantIterations, estimatedCompletion, inIteration, OverviewRow, overviewIds, overviewRows, RItem, toDay } from "../../api/reports";
import { fmtDate, Progress, Icon } from "../../components/common";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { ItemRef, OpenInQuery, SelectPi, Widget } from "./Widget";

/** Epics shown on the portfolio: in progress, or closed within the last 30 days. */
export function epicInOverview(epic: RItem, today: number): boolean {
  if (epic.category === "Completed") return !!epic.closedDate && toDay(epic.closedDate) >= today - 30;
  return epic.category === "InProgress" || epic.category === "Resolved";
}

function SplitBar({ row }: { row: OverviewRow }) {
  const { todo, inProgress, done } = row.split;
  const total = todo + inProgress + done;
  const w = (v: number) => `${total ? (v / total) * 100 : 0}%`;
  return (
    <div className="split-bar" title={`To Do ${todo} · In Progress ${inProgress} · Done ${done} SP`} aria-label="SP by status">
      <span className="split-todo" style={{ width: w(todo) }} />
      <span className="split-doing" style={{ width: w(inProgress) }} />
      <span className="split-done" style={{ width: w(done) }} />
    </div>
  );
}

function Row({ row, depth, onTeam, eta }: { row: OverviewRow; depth: number; onTeam: (id: string) => void; eta: (row: OverviewRow) => string | null }) {
  const [open, setOpen] = useState(false);
  const synthetic = row.item.id === 0;
  const completion = eta(row);
  return (
    <>
      <tr className={depth ? "overview-child" : undefined}>
        <td>
          <span className="tree-cell" style={{ paddingLeft: depth * 18 }}>
            {row.children.length > 0 ? (
              <button className="twisty" aria-label={(open ? "Collapse " : "Expand ") + row.item.title} aria-expanded={open} onClick={() => setOpen(!open)}>
                <Icon name={open ? "ChevronDown" : "ChevronRight"} className="small" />
              </button>
            ) : (
              <span className="twisty" />
            )}
            {synthetic ? <strong>{row.item.title}</strong> : <ItemRef item={row.item} />}
          </span>
        </td>
        <td className="num">{row.wsjf ?? "—"}</td>
        <td className="num">{row.item.effort ?? "—"}</td>
        <td>{row.item.assignedTo ?? ""}</td>
        <td>
          <Progress done={row.done} total={row.points} label={row.pct === null ? "—" : `${row.pct}%`} />
        </td>
        <td>
          <SplitBar row={row} />
        </td>
        <td>
          <span className="team-chips">
            {row.teams.map((t) => (
              <button key={t.node.id} className="team-chip" onClick={() => onTeam(t.node.id)} title={`Open ${t.node.name}`}>
                {t.node.name} <strong>{t.points}</strong>
              </button>
            ))}
          </span>
        </td>
        <td className="eta">{completion ? fmtDate(completion) : "—"}</td>
      </tr>
      {open && row.children.map((c) => <Row key={c.item.id} row={c} depth={depth + 1} onTeam={onTeam} eta={eta} />)}
    </>
  );
}

/**
 * PI Overview (Solution / ART): parent items with children planned in the PI. On a Large
 * Solution with Capabilities, Features linked straight to an Epic get their own lane.
 * Epic Overview (Portfolio): epics in progress or closed within the last 30 days.
 */
export function OverviewWidget({ data, today }: { data: ReportData; today: number }) {
  const { config, node, pi, pis, selectNode } = useSafe();
  const portfolio = node.level === "portfolio";
  const title = portfolio ? "Epic Overview" : "PI Overview";
  if (!portfolio && !pi)
    return (
      <Widget title={title} size="wide">
        <SelectPi />
      </Widget>
    );
  const items = Array.from(data.items.values());
  const rootType = boardType(config, node.level);
  const common = {
    items,
    storyType: config.types.story,
    counts: portfolio ? () => true : (s: RItem) => inIteration(s, pi!.path) && data.inScope(s),
    teams: flatten(portfolio ? config.root : node).filter((n) => n.level === "team"),
  };
  // Solution level: ART items (Features) whose parent is an Epic, skipping the Capability level.
  const direct =
    node.level === "solution" && config.types.capability
      ? overviewRows({
          ...common,
          rootType: config.types.feature,
          rootFilter: (f) => f.parentId !== undefined && data.items.get(f.parentId)?.type === config.types.epic,
        })
      : null;
  const { rows, orphans } = overviewRows({
    ...common,
    rootType,
    keepRoot: portfolio ? (e) => data.inScope(e) && epicInOverview(e, today) : undefined,
    exclude: direct?.covered,
  });
  const all = orphans && !portfolio ? [...rows, orphans] : rows;
  const lane = direct?.rows ?? [];

  const sprints = pis.flatMap((p) => p.sprints);
  const below = descendantIterations(items);
  const eta = (row: OverviewRow) => {
    const iterations =
      row.item.id === 0 ? row.children.map((c) => c.item.iteration) : row.item.type === config.types.story ? [row.item.iteration] : below(row.item.id);
    return estimatedCompletion(iterations, sprints);
  };
  const actions = <OpenInQuery ids={overviewIds([...all, ...lane])} />;

  return (
    <Widget title={title} size="wide" actions={actions}>
      {all.length === 0 && lane.length === 0 ? (
        <p className="muted widget-hint">{portfolio ? "No epics in progress or recently closed." : `No ${rootType}s with work planned in ${pi!.name}.`}</p>
      ) : (
        <table className="grid compact overview-table">
          <thead>
            <tr>
              <th>{rootType}</th>
              <th className="num">WSJF</th>
              <th className="num">Job size</th>
              <th>Assignee</th>
              <th>Progress</th>
              <th>Status (SP)</th>
              <th>Teams (SP)</th>
              <th title="Finish of the latest iteration any child is planned in">Est. completion</th>
            </tr>
          </thead>
          <tbody>
            {all.map((r) => (
              <Row key={r.item.id} row={r} depth={0} onTeam={selectNode} eta={eta} />
            ))}
          </tbody>
          {lane.length > 0 && (
            <tbody className="overview-lane" aria-label="ART items linked directly to Portfolio">
              <tr className="overview-lane-header">
                <th colSpan={8}>
                  ART items linked directly to Portfolio <span className="count">({lane.length})</span>
                </th>
              </tr>
              {lane.map((r) => (
                <Row key={r.item.id} row={r} depth={0} onTeam={selectNode} eta={eta} />
              ))}
            </tbody>
          )}
        </table>
      )}
    </Widget>
  );
}
