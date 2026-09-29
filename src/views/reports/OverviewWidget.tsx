import { useState } from "react";
import { boardType, flatten } from "../../api/org";
import { inIteration, OverviewRow, overviewRows, RItem, toDay } from "../../api/reports";
import { Progress } from "../../components/common";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { ItemRef, SelectPi, Widget } from "./Widget";

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

function Row({ row, depth, onTeam }: { row: OverviewRow; depth: number; onTeam: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const synthetic = row.item.id === 0;
  return (
    <>
      <tr className={depth ? "overview-child" : undefined}>
        <td>
          <span className="tree-cell" style={{ paddingLeft: depth * 18 }}>
            {row.children.length > 0 ? (
              <button className="twisty" aria-label={(open ? "Collapse " : "Expand ") + row.item.title} aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? "▾" : "▸"}
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
      </tr>
      {open && row.children.map((c) => <Row key={c.item.id} row={c} depth={depth + 1} onTeam={onTeam} />)}
    </>
  );
}

/**
 * PI Overview (Solution / ART): parent items with children planned in the PI.
 * Epic Overview (Portfolio): epics in progress or closed within the last 30 days.
 */
export function OverviewWidget({ data, today }: { data: ReportData; today: number }) {
  const { config, node, pi, selectNode } = useSafe();
  const portfolio = node.level === "portfolio";
  const title = portfolio ? "Epic Overview" : "PI Overview";
  if (!portfolio && !pi)
    return (
      <Widget title={title} size="wide">
        <SelectPi />
      </Widget>
    );
  const rootType = boardType(config, node.level);
  const { rows, orphans } = overviewRows({
    items: Array.from(data.items.values()),
    rootType,
    storyType: config.types.story,
    counts: portfolio ? () => true : (s) => inIteration(s, pi!.path) && data.inScope(s),
    teams: flatten(portfolio ? config.root : node).filter((n) => n.level === "team"),
    keepRoot: portfolio ? (e) => data.inScope(e) && epicInOverview(e, today) : undefined,
  });
  const all = orphans && !portfolio ? [...rows, orphans] : rows;

  return (
    <Widget title={title} size="wide">
      {all.length === 0 ? (
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
            </tr>
          </thead>
          <tbody>
            {all.map((r) => (
              <Row key={r.item.id} row={r} depth={0} onTeam={selectNode} />
            ))}
          </tbody>
        </table>
      )}
    </Widget>
  );
}
