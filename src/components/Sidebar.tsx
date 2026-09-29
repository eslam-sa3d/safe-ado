import { useState } from "react";
import { LEVEL_COLOR } from "../api/org";
import { LEVEL_LABEL, OrgNode } from "../api/types";

/** Agile Hive–style left navigation: the Portfolio > Solution > ART > Team tree. */
export function Sidebar({
  root,
  selectedId,
  onSelect,
}: {
  root: OrgNode;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="sidebar" aria-label="SAFe hierarchy">
      <div className="sidebar-title">My Organization</div>
      <ul className="tree" role="tree">
        <TreeItem node={root} depth={0} selectedId={selectedId} onSelect={onSelect} />
      </ul>
      <div className="legend">
        {(Object.keys(LEVEL_LABEL) as (keyof typeof LEVEL_LABEL)[]).map((l) => (
          <span key={l}>
            <i className="dot" style={{ background: LEVEL_COLOR[l] }} /> {LEVEL_LABEL[l]}
          </span>
        ))}
      </div>
    </nav>
  );
}

function TreeItem({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: OrgNode;
  depth: number;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  return (
    <li role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-selected={node.id === selectedId}>
      <div
        className={"tree-row" + (node.id === selectedId ? " selected" : "")}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(node.id)}
        title={`${LEVEL_LABEL[node.level]}${node.areaPath ? " · " + node.areaPath : ""}`}
      >
        <button
          className="twisty"
          aria-label={open ? "Collapse" : "Expand"}
          style={{ visibility: hasChildren ? "visible" : "hidden" }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? "▾" : "▸"}
        </button>
        <i className="level-square" style={{ background: LEVEL_COLOR[node.level] }} />
        <span className="tree-label">{node.name}</span>
      </div>
      {hasChildren && open && (
        <ul role="group">
          {node.children.map((c) => (
            <TreeItem key={c.id} node={c} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}
