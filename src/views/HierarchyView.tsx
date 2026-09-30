import { useMemo, useState } from "react";
import { queryUrl } from "../api/links";
import { boardType, flatten, scopeAreas } from "../api/org";
import { loadTree, TreeNode, typeChain } from "../api/queries";
import { openInNewTab } from "../api/urlState";
import { F, OrgNode, SafeConfig, WorkItem } from "../api/types";
import { isUnder, openWorkItem } from "../api/wit";
import { CATEGORY_COLOR, Empty, ErrorBar, Info, lastSegment, Progress, Spinner, typeColor, useAsync, Icon } from "../components/common";
import { useCan, useSafe } from "../components/context";

/** The unit that owns an area path: the configured unit with the longest matching area path. */
export function owningUnit(units: OrgNode[], area: string | undefined): OrgNode | undefined {
  let best: OrgNode | undefined;
  for (const u of units) {
    if (u.areaPath && isUnder(area, u.areaPath) && (!best || u.areaPath.length > best.areaPath!.length)) best = u;
  }
  return best;
}

/**
 * H2 hierarchy hints: a child should sit on the SAFe level right below its parent (e.g. a
 * Story under a Feature, not directly under an Epic when the process has Features), and in
 * the parent's unit or one of its sub-units.
 */
export function hierarchyHints(config: SafeConfig, units: OrgNode[], parent: WorkItem, child: WorkItem): string[] {
  const hints: string[] = [];
  const chain = typeChain(config);
  const p = chain.indexOf(parent.fields[F.type]);
  const c = chain.indexOf(child.fields[F.type]);
  if (p >= 0 && c > p + 1) {
    hints.push(`${child.fields[F.type]} is linked directly under a ${parent.fields[F.type]}; expected a ${chain[p + 1]} in between.`);
  }
  const unit = owningUnit(units, parent.fields[F.area]);
  if (unit && child.fields[F.area] && !isUnder(child.fields[F.area], unit.areaPath!)) {
    hints.push(`Area ${child.fields[F.area]} is outside ${unit.name}, the unit of its parent #${parent.id}.`);
  }
  return hints;
}

/** WIQL listing the given work items (for "Open children in query"). */
export function idsQuery(ids: number[]): string {
  return `SELECT [System.Id], [System.WorkItemType], [System.Title], [System.State], [System.AreaPath], [System.IterationPath] FROM WorkItems WHERE [System.Id] IN (${ids.join(", ")})`;
}

/** Epic > Capability > Feature > Story tree with story-point roll-up, scoped to the selected node. */
export function HierarchyView() {
  const { config, node, pi } = useSafe();
  const canPlan = useCan().plan;
  const units = useMemo(() => flatten(config.root), [config]);
  const rootType = boardType(config, node.level);
  const areas = scopeAreas(node);
  // Epics span PIs, so the PI filter is only offered below portfolio level.
  const canFilterPi = node.level !== "portfolio";
  const [piOnly, setPiOnly] = useState(canFilterPi);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const iteration = canFilterPi && piOnly ? pi?.path : undefined;
  const { data, loading, error, reload } = useAsync(
    () => loadTree(config, rootType, areas, iteration),
    [config, rootType, areas.join("|"), iteration]
  );

  const visible = useMemo(() => {
    const roots = data ?? [];
    if (!filter.trim()) return roots;
    const q = filter.toLowerCase();
    const matches = (n: TreeNode): boolean =>
      String(n.item.fields[F.title]).toLowerCase().includes(q) || String(n.item.id) === q || n.children.some(matches);
    return roots.filter(matches);
  }, [data, filter]);

  const toggle = (id: number) => {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpanded(next);
  };
  const expandAll = () => {
    const all = new Set<number>();
    const walk = (n: TreeNode) => {
      if (n.children.length) all.add(n.item.id);
      n.children.forEach(walk);
    };
    (data ?? []).forEach(walk);
    setExpanded(all);
  };

  return (
    <div>
      <div className="toolbar">
        <input className="search" placeholder="Filter by title or ID" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {canFilterPi && (
          <label className="check">
            <input type="checkbox" checked={piOnly} onChange={(e) => setPiOnly(e.target.checked)} /> {pi?.name ?? "Current PI"} only
          </label>
        )}
        <span className="spacer" />
        <button className="btn" onClick={expandAll}>
          Expand all
        </button>
        <button className="btn" onClick={() => setExpanded(new Set())}>
          Collapse all
        </button>
        <button className="btn" onClick={() => reload()}>
          <Icon name="Refresh" /> Refresh
        </button>
      </div>
      <ErrorBar message={error} />
      {!canPlan && <Info>You have read-only access to this project's planning data.</Info>}
      {loading && !data ? (
        <Spinner label="Loading hierarchy…" />
      ) : visible.length === 0 ? (
        <Empty title={`No ${rootType}s found`}>
          <p>
            Scope: <code>{areas.join(", ") || "(no area configured)"}</code>
            {iteration && (
              <>
                {" "}in <code>{iteration}</code>
              </>
            )}
          </p>
        </Empty>
      ) : (
        <table className="grid tree-grid">
          <thead>
            <tr>
              <th style={{ width: "46%" }}>Title</th>
              <th>State</th>
              <th>Iteration</th>
              <th>Assigned to</th>
              <th style={{ width: 170 }}>Progress (points)</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((n) => (
              <TreeRows key={n.item.id} node={n} depth={0} expanded={expanded} toggle={toggle} hint={(p, c) => hierarchyHints(config, units, p, c)} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TreeRows({
  node,
  depth,
  expanded,
  toggle,
  hint,
  hints = [],
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<number>;
  toggle: (id: number) => void;
  hint: (parent: WorkItem, child: WorkItem) => string[];
  /** Problems with how this item is linked to its parent (H2). */
  hints?: string[];
}) {
  const f = node.item.fields;
  const open = expanded.has(node.item.id);
  const usePoints = node.points > 0;
  return (
    <>
      <tr>
        <td>
          <div className="tree-cell" style={{ paddingLeft: depth * 20 }}>
            <button
              className="twisty"
              style={{ visibility: node.children.length ? "visible" : "hidden" }}
              onClick={() => toggle(node.item.id)}
              aria-label={open ? "Collapse" : "Expand"}
            >
              <Icon name={open ? "ChevronDown" : "ChevronRight"} className="small" />
            </button>
            <i className="type-bar" style={{ background: typeColor(f[F.type]) }} title={f[F.type]} />
            <button className="link title-link" onClick={() => openWorkItem(node.item.id)}>
              {f[F.title]}
            </button>
            <span className="muted small">#{node.item.id}</span>
            {hints.length > 0 && (
              <span className="hier-hint" role="img" aria-label={`Hierarchy hint: ${hints.join(" ")}`} title={hints.join("\n")}>
                <Icon name="Warning" />
              </span>
            )}
            {node.children.length > 0 && (
              <button
                className="link hier-query"
                title="Open children in an Azure Boards query"
                aria-label={`Open children of #${node.item.id} in query`}
                onClick={() =>
                  queryUrl(idsQuery(node.children.map((c) => c.item.id)))
                    .then(openInNewTab)
                    .catch(() => undefined)
                }
              >
                <Icon name="OpenInNewTab" />
              </button>
            )}
          </div>
        </td>
        <td>
          <span className="state">
            <i className="dot" style={{ background: CATEGORY_COLOR[node.category] ?? "#999" }} />
            {f[F.state]}
          </span>
        </td>
        <td className="muted">{lastSegment(f[F.iteration])}</td>
        <td className="muted">{f[F.assignedTo]?.displayName ?? ""}</td>
        <td>
          {node.children.length > 0 &&
            (usePoints ? (
              <Progress done={node.donePoints} total={node.points} label={`${node.donePoints}/${node.points} pts`} />
            ) : (
              <Progress done={node.doneCount} total={node.count} label={`${node.doneCount}/${node.count} items`} />
            ))}
        </td>
      </tr>
      {open &&
        node.children.map((c) => (
          <TreeRows
            key={c.item.id}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            hint={hint}
            hints={hint(node.item, c.item)}
          />
        ))}
    </>
  );
}
