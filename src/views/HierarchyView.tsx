import { useMemo, useState } from "react";
import { boardType, scopeAreas } from "../api/org";
import { loadTree, TreeNode } from "../api/queries";
import { F } from "../api/types";
import { openWorkItem } from "../api/wit";
import { CATEGORY_COLOR, Empty, ErrorBar, lastSegment, Progress, Spinner, typeColor, useAsync, Icon } from "../components/common";
import { useSafe } from "../components/context";

/** Epic > Capability > Feature > Story tree with story-point roll-up, scoped to the selected node. */
export function HierarchyView() {
  const { config, node, pi } = useSafe();
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
              <TreeRows key={n.item.id} node={n} depth={0} expanded={expanded} toggle={toggle} />
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
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<number>;
  toggle: (id: number) => void;
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
        node.children.map((c) => <TreeRows key={c.item.id} node={c} depth={depth + 1} expanded={expanded} toggle={toggle} />)}
    </>
  );
}
