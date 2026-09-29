import { useEffect, useState } from "react";
import { Icon } from "./common";
import { getUserValue, setUserValue } from "../api/data";
import { flatten, LEVEL_COLOR } from "../api/org";
import { LEVEL_LABEL, OrgNode } from "../api/types";

const STARRED_KEY = "starred";

/** Agile Hive–style left navigation: starred units plus the Portfolio > Solution > ART > Team tree. */
export function Sidebar({
  root,
  selectedId,
  onSelect,
}: {
  root: OrgNode;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [starred, setStarred] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    getUserValue<string[]>(STARRED_KEY, [])
      .then((v) => live && Array.isArray(v) && setStarred(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const toggleStar = (id: string) => {
    const next = starred.includes(id) ? starred.filter((s) => s !== id) : [...starred, id];
    setStarred(next);
    setUserValue(STARRED_KEY, next).catch(() => undefined);
  };

  const all = flatten(root);
  const starredNodes = starred.map((id) => all.find((n) => n.id === id)).filter((n): n is OrgNode => !!n);

  return (
    <nav className="sidebar" aria-label="SAFe hierarchy">
      {starredNodes.length > 0 && (
        <>
          <div className="sidebar-title">Starred</div>
          <ul className="starred" aria-label="Starred units">
            {starredNodes.map((n) => (
              <li key={n.id}>
                <div
                  className={"tree-row" + (n.id === selectedId ? " selected" : "")}
                  style={{ paddingLeft: 8 }}
                  onClick={() => onSelect(n.id)}
                  title={LEVEL_LABEL[n.level]}
                >
                  <i className="level-square" style={{ background: LEVEL_COLOR[n.level] }} />
                  <span className="tree-label">{n.name}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="sidebar-title">My Organization</div>
      <ul className="tree" role="tree">
        <TreeItem node={root} depth={0} selectedId={selectedId} onSelect={onSelect} starred={starred} onStar={toggleStar} />
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
  starred,
  onStar,
}: {
  node: OrgNode;
  depth: number;
  selectedId: string;
  onSelect: (id: string) => void;
  starred: string[];
  onStar: (id: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const isStarred = starred.includes(node.id);
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
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="small" />
        </button>
        <i className="level-square" style={{ background: LEVEL_COLOR[node.level] }} />
        <span className="tree-label">{node.name}</span>
        <button
          className={"star" + (isStarred ? " on" : "")}
          aria-label={`${isStarred ? "Unstar" : "Star"} ${node.name}`}
          aria-pressed={isStarred}
          onClick={(e) => {
            e.stopPropagation();
            onStar(node.id);
          }}
        >
          <Icon name={isStarred ? "FavoriteStarFill" : "FavoriteStar"} />
        </button>
      </div>
      {hasChildren && open && (
        <ul role="group">
          {node.children.map((c) => (
            <TreeItem
              key={c.id}
              node={c}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              starred={starred}
              onStar={onStar}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
