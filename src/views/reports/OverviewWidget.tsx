import { useState } from "react";
import { boardType, flatten, scopeAreas } from "../../api/org";
import { typeChain } from "../../api/queries";
import { childrenIndex, estimatedCompletion, eventDay, inIteration, OverviewRow, overviewIds, overviewRows, PlannedNode, RItem } from "../../api/reports";
import { fmtDate, Progress, Icon } from "../../components/common";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { ItemRef, OpenInQuery, SelectPi, Widget } from "./Widget";

/** Epics shown on the portfolio: in progress, or closed within the last 30 days. */
export function epicInOverview(epic: RItem, today: number): boolean {
  if (epic.category === "Completed") return !!epic.closedDate && eventDay(epic.closedDate) >= today - 30;
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

function Row({
  row,
  depth,
  onTeam,
  eta,
  enabler,
}: {
  row: OverviewRow;
  depth: number;
  onTeam: (id: string) => void;
  eta: (row: OverviewRow) => string | null;
  /** The enabler work item type; its rows get an "Enabler" pill. */
  enabler?: string;
}) {
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
            {!!enabler && row.item.type === enabler && <span className="pill enabler-pill">Enabler</span>}
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
      {open && row.children.map((c) => <Row key={c.item.id} row={c} depth={depth + 1} onTeam={onTeam} eta={eta} enabler={enabler} />)}
    </>
  );
}

/** Whether any ancestor of `item` (walking parent links, cycles once) has `type`. */
function hasAncestor(item: RItem, type: string, items: Map<number, RItem>): boolean {
  const seen = new Set<number>([item.id]);
  for (let p = item.parentId !== undefined ? items.get(item.parentId) : undefined; p && !seen.has(p.id); p = p.parentId !== undefined ? items.get(p.parentId) : undefined) {
    if (p.type === type) return true;
    seen.add(p.id);
  }
  return false;
}

/**
 * PI Overview (Solution / ART): parent items with children planned in the PI, Enablers
 * included (marked with a pill) so their stories aren't orphans. On a Large Solution with
 * Capabilities, Features linked straight to an Epic get their own lane.
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
  // Enablers not already inside a row's tree become rows of their own.
  const enablerType = config.types.enabler;
  const enablers =
    !portfolio && enablerType && enablerType !== rootType
      ? overviewRows({ ...common, rootType: enablerType, rootFilter: (e) => !hasAncestor(e, rootType, data.items), exclude: direct?.covered })
      : null;
  const { rows, orphans } = overviewRows({
    ...common,
    rootType,
    keepRoot: portfolio ? (e) => data.inScope(e) && epicInOverview(e, today) : undefined,
    exclude: new Set([...(direct?.covered ?? []), ...(enablers?.covered ?? [])]),
  });
  const ranked = [...rows, ...(enablers?.rows ?? [])].sort((a, b) => (b.wsjf ?? -1) - (a.wsjf ?? -1) || a.item.id - b.item.id);
  const all = orphans && !portfolio ? [...ranked, orphans] : ranked;
  const lane = direct?.rows ?? [];

  const sprints = pis.flatMap((p) => p.sprints);
  const childrenOf = childrenIndex(items);
  // Parents: their descendants' latest sprint. Leaf stories and the "Without parent" group
  // are virtual roots (id 0) over themselves / their stories.
  const eta = (row: OverviewRow) => {
    const leaf = row.item.id === 0 || row.item.type === config.types.story;
    if (!leaf) return estimatedCompletion(row.item.id, childrenOf, sprints);
    const below: PlannedNode[] = row.item.id === 0 ? row.children.map((c) => c.item) : [row.item];
    return estimatedCompletion(0, (id) => (id === 0 ? below : []), sprints);
  };
  const scope = {
    types: portfolio ? [...typeChain(config), enablerType ?? ""] : [rootType, config.types.feature, enablerType ?? "", config.types.story],
    areas: scopeAreas(node),
    iterationPath: portfolio ? undefined : pi!.path,
  };
  const actions = <OpenInQuery ids={overviewIds([...all, ...lane])} scope={scope} />;

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
              <th title="Finish of the latest iteration any descendant is planned in">Est. completion</th>
            </tr>
          </thead>
          <tbody>
            {all.map((r) => (
              <Row key={r.item.id} row={r} depth={0} onTeam={selectNode} eta={eta} enabler={enablerType} />
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
                <Row key={r.item.id} row={r} depth={0} onTeam={selectNode} eta={eta} enabler={enablerType} />
              ))}
            </tbody>
          )}
        </table>
      )}
    </Widget>
  );
}
