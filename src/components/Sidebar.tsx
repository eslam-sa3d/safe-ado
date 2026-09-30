import { KeyboardEvent, useEffect, useRef, useState } from "react";
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
  detached = [],
}: {
  root: OrgNode;
  selectedId: string;
  onSelect: (id: string) => void;
  /** Units detached from the hierarchy (My Organization), listed below the tree. */
  detached?: OrgNode[];
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

  // Expanded state lives here (not per row) so arrow keys can walk the visible rows.
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({});
  const [focusId, setFocusId] = useState<string>();
  const rows = useRef(new Map<string, HTMLLIElement>());
  const isOpen = (n: OrgNode, depth: number) => n.children.length > 0 && (openOverride[n.id] ?? depth < 2);
  const setOpen = (id: string, open: boolean) => setOpenOverride((o) => ({ ...o, [id]: open }));

  // Visible rows in display order, with their depth and parent.
  const visible: { node: OrgNode; depth: number; parent?: OrgNode }[] = [];
  const walk = (n: OrgNode, depth: number, parent?: OrgNode) => {
    visible.push({ node: n, depth, parent });
    if (isOpen(n, depth)) n.children.forEach((c) => walk(c, depth + 1, n));
  };
  walk(root, 0);
  const tabbable = [focusId, selectedId].find((id) => visible.some((v) => v.node.id === id)) ?? root.id;

  const moveTo = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    rows.current.get(id)?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLLIElement>, id: string) => {
    if (e.target !== e.currentTarget) return; // keys on the twisty / star buttons keep their own meaning
    const i = visible.findIndex((v) => v.node.id === id);
    const { node, depth, parent } = visible[i];
    const open = isOpen(node, depth);
    switch (e.key) {
      case "ArrowDown":
        moveTo(visible[i + 1]?.node.id);
        break;
      case "ArrowUp":
        moveTo(visible[i - 1]?.node.id);
        break;
      case "Home":
        moveTo(visible[0].node.id);
        break;
      case "End":
        moveTo(visible[visible.length - 1].node.id);
        break;
      case "ArrowRight":
        if (node.children.length && !open) setOpen(node.id, true);
        else if (open) moveTo(node.children[0].id);
        break;
      case "ArrowLeft":
        if (open) setOpen(node.id, false);
        else moveTo(parent?.id);
        break;
      case "Enter":
      case " ":
        onSelect(node.id);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const all = [root, ...detached].flatMap(flatten);
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
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(n.id)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    onSelect(n.id);
                  }}
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
      <ul className="tree" role="tree" aria-label="Organization units">
        <TreeItem
          node={root}
          depth={0}
          selectedId={selectedId}
          onSelect={onSelect}
          starred={starred}
          onStar={toggleStar}
          tree={{ isOpen, setOpen, tabbable, onKey, setFocusId, rows: rows.current }}
        />
      </ul>
      {detached.length > 0 && (
        <>
          <div className="sidebar-title">Unattached units</div>
          <ul className="starred" aria-label="Unattached units">
            {detached.flatMap(flatten).map((n) => (
              <li key={n.id}>
                <div
                  className={"tree-row" + (n.id === selectedId ? " selected" : "")}
                  style={{ paddingLeft: 12 }}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(n.id)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(n.id))}
                  title={`${LEVEL_LABEL[n.level]} · not attached to the hierarchy`}
                >
                  <i className="level-square" style={{ background: LEVEL_COLOR[n.level] }} />
                  <span className="tree-label">{n.name}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
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

interface TreeNav {
  isOpen: (n: OrgNode, depth: number) => boolean;
  setOpen: (id: string, open: boolean) => void;
  /** The one row reachable with Tab (roving tabindex). */
  tabbable: string;
  onKey: (e: KeyboardEvent<HTMLLIElement>, id: string) => void;
  setFocusId: (id: string) => void;
  rows: Map<string, HTMLLIElement>;
}

function TreeItem({
  node,
  depth,
  selectedId,
  onSelect,
  starred,
  onStar,
  tree,
}: {
  node: OrgNode;
  depth: number;
  selectedId: string;
  onSelect: (id: string) => void;
  starred: string[];
  onStar: (id: string) => void;
  tree: TreeNav;
}) {
  const open = tree.isOpen(node, depth);
  const setOpen = (v: boolean) => tree.setOpen(node.id, v);
  const hasChildren = node.children.length > 0;
  const isStarred = starred.includes(node.id);
  return (
    <li
      role="treeitem"
      aria-expanded={hasChildren ? open : undefined}
      aria-selected={node.id === selectedId}
      aria-level={depth + 1}
      aria-label={node.name}
      tabIndex={tree.tabbable === node.id ? 0 : -1}
      ref={(el) => {
        if (el) tree.rows.set(node.id, el);
        else tree.rows.delete(node.id);
      }}
      onKeyDown={(e) => tree.onKey(e, node.id)}
      onFocus={(e) => e.target === e.currentTarget && tree.setFocusId(node.id)}
    >
      <div
        className={"tree-row" + (node.id === selectedId ? " selected" : "")}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(node.id)}
        title={`${LEVEL_LABEL[node.level]}${node.areaPath ? " · " + node.areaPath : ""}`}
      >
        <button
          className="twisty"
          tabIndex={-1}
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
              tree={tree}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
