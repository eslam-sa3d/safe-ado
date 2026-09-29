import { DragEvent, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { newId } from "../api/data";
import { childLevels, findNode, flatten, LEVEL_COLOR, parentOf, pathTo } from "../api/org";
import { Level, LEVEL_LABEL, OrgNode } from "../api/types";
import { getAreaPaths } from "../api/wit";
import { ErrorBar, Field, Info, Modal, Spinner, useAsync } from "../components/common";
import { useSafe } from "../components/context";

export const LAYERS: Level[] = ["portfolio", "solution", "art", "team"];

export function updateNode(root: OrgNode, id: string, fn: (n: OrgNode) => OrgNode): OrgNode {
  if (root.id === id) return fn(root);
  return { ...root, children: root.children.map((c) => updateNode(c, id, fn)) };
}

export function removeNode(root: OrgNode, id: string): OrgNode {
  return { ...root, children: root.children.filter((c) => c.id !== id).map((c) => removeNode(c, id)) };
}

/** Moves the subtree `id` under `targetId`. */
export function moveNode(root: OrgNode, id: string, targetId: string): OrgNode {
  const sub = findNode(root, id);
  if (!sub) return root;
  return updateNode(removeNode(root, id), targetId, (n) => ({ ...n, children: [...n.children, sub] }));
}

/** "a Team" / "an Agile Release Train". */
const withArticle = (level: Level) => `${/^[aeiou]/i.test(LEVEL_LABEL[level]) ? "an" : "a"} ${LEVEL_LABEL[level]}`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Levels that may be the parent of `level` (solution→portfolio; art→solution|portfolio; team→art). */
export function parentLevels(level: Level): Level[] {
  return LAYERS.filter((l) => childLevels(l).includes(level));
}

/** Why `dragged` cannot be re-parented under `target`, or null when the move is valid. */
export function moveError(root: OrgNode, dragged: OrgNode, target: OrgNode): string | null {
  if (dragged.id === root.id) return "The portfolio root cannot be moved.";
  if (dragged.id === target.id || flatten(dragged).some((n) => n.id === target.id)) {
    return `"${dragged.name}" cannot be moved under itself or one of its sub-units.`;
  }
  if (!childLevels(target.level).includes(dragged.level)) {
    return `${capitalize(withArticle(dragged.level))} cannot be placed under ${withArticle(target.level)}.`;
  }
  return null;
}

/** Detach re-attaches a unit to the portfolio root, so it is only offered where that is valid. */
export function canDetach(root: OrgNode, node: OrgNode): boolean {
  const parent = parentOf(root, node.id);
  return !!parent && parent.id !== root.id && childLevels(root.level).includes(node.level);
}

interface Line {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Agile Hive's "My Organization": layered canvas of units with editing and chain highlighting. */
export function OrganizationView() {
  const { config, saveConfig, node: selected, selectNode } = useSafe();
  const root = config.root;
  const all = useMemo(() => flatten(root), [root]);
  const [hover, setHover] = useState<string>();
  const [dragId, setDragId] = useState<string>();
  const [overId, setOverId] = useState<string>();
  const [menuId, setMenuId] = useState<string>();
  const [adding, setAdding] = useState<{ level: Level; parentId?: string }>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [lines, setLines] = useState<Line[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const boxes = useRef(new Map<string, HTMLElement>());

  const chain = useMemo(() => {
    if (!hover) return null;
    const hovered = findNode(root, hover);
    if (!hovered) return null;
    return new Set([...pathTo(root, hover).map((n) => n.id), ...flatten(hovered).map((n) => n.id)]);
  }, [hover, root]);

  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const origin = canvas.getBoundingClientRect();
    const out: Line[] = [];
    for (const parent of all) {
      for (const child of parent.children) {
        const a = boxes.current.get(parent.id)?.getBoundingClientRect();
        const b = boxes.current.get(child.id)?.getBoundingClientRect();
        if (!a || !b) continue;
        out.push({
          from: parent.id,
          to: child.id,
          x1: a.left - origin.left + a.width / 2,
          y1: a.bottom - origin.top,
          x2: b.left - origin.left + b.width / 2,
          y2: b.top - origin.top,
        });
      }
    }
    setLines(out);
  }, [all]);

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(() => measure());
    if (canvasRef.current) observer.observe(canvasRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  const persist = async (nextRoot: OrgNode, message: string): Promise<boolean> => {
    setError(undefined);
    setNotice(undefined);
    try {
      await saveConfig({ ...config, root: nextRoot });
      setNotice(message);
      return true;
    } catch (e: any) {
      setError(`Could not save the organization: ${e?.message ?? e}`);
      return false;
    }
  };

  const relink = (dragged: OrgNode, target: OrgNode) => {
    const problem = moveError(root, dragged, target);
    if (problem) {
      setNotice(undefined);
      setError(problem);
      return;
    }
    if (parentOf(root, dragged.id)?.id === target.id) return;
    if (
      !window.confirm(
        `Move "${dragged.name}" under "${target.name}"? Re-linking units may invalidate existing work item hierarchy and PI assignments.`
      )
    )
      return;
    return persist(moveNode(root, dragged.id, target.id), `Moved "${dragged.name}" under "${target.name}".`);
  };

  const detach = (n: OrgNode) => {
    setMenuId(undefined);
    if (!window.confirm(`Detach "${n.name}" from its parent? It will be attached directly to "${root.name}".`)) return;
    return persist(moveNode(root, n.id, root.id), `Detached "${n.name}".`);
  };

  const remove = (n: OrgNode) => {
    setMenuId(undefined);
    const subs = flatten(n).length - 1;
    const what = subs ? ` and its ${subs} sub-unit${subs === 1 ? "" : "s"}` : "";
    if (!window.confirm(`Remove "${n.name}"${what} from the hierarchy? Work items are not changed.`)) return;
    if (flatten(n).some((x) => x.id === selected.id)) selectNode(root.id);
    return persist(removeNode(root, n.id), `Removed "${n.name}".`);
  };

  const add = async (level: Level, parentId: string, name: string, areaPath: string) => {
    const created: OrgNode = { id: newId(), name, level, areaPath: areaPath || undefined, children: [] };
    const ok = await persist(
      updateNode(root, parentId, (p) => ({ ...p, children: [...p.children, created] })),
      `Added "${name}".`
    );
    if (ok) setAdding(undefined);
  };

  const onDrop = (e: DragEvent, target: OrgNode) => {
    e.preventDefault();
    setOverId(undefined);
    const id = e.dataTransfer.getData("text/plain") || dragId;
    setDragId(undefined);
    const dragged = id ? findNode(root, id) : undefined;
    if (dragged) relink(dragged, target);
  };

  const setBox = (id: string) => (el: HTMLElement | null) => {
    if (el) boxes.current.set(id, el);
    else boxes.current.delete(id);
  };

  return (
    <div className="org-view">
      <Info>
        Hover a unit to highlight its chain. Drag a unit onto another unit to re-link it, use <strong>+</strong> to add a unit to a
        layer and <strong>⋯</strong> for more actions. Click a unit to open it.
      </Info>
      <ErrorBar message={error} onClose={() => setError(undefined)} />
      {notice && (
        <div className="msg msg-info" role="status">
          {notice}
        </div>
      )}
      <div className="org-canvas" ref={canvasRef}>
        <svg className="org-lines" aria-hidden="true">
          {lines.map((l) => (
            <line
              key={`${l.from}>${l.to}`}
              data-edge={`${l.from}>${l.to}`}
              className={"org-line" + (chain ? (chain.has(l.from) && chain.has(l.to) ? " hot" : " dim") : "")}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
            />
          ))}
        </svg>
        {LAYERS.map((level) => {
          const nodes = all.filter((n) => n.level === level);
          const parents = all.filter((n) => childLevels(n.level).includes(level));
          const addTitle =
            level === "portfolio"
              ? "The organization has a single portfolio"
              : parents.length
              ? `Add ${LEVEL_LABEL[level]}`
              : `Needs a parent unit first (${parentLevels(level).map((l) => LEVEL_LABEL[l]).join(" or ")})`;
          return (
            <section
              key={level}
              className="org-band"
              aria-label={`${LEVEL_LABEL[level]} layer`}
              style={{ borderColor: LEVEL_COLOR[level], background: `${LEVEL_COLOR[level]}12` }}
            >
              <div className="org-band-header" style={{ color: LEVEL_COLOR[level] }}>
                <span>{LEVEL_LABEL[level]}</span>
                <span className="count">{nodes.length}</span>
                <button
                  className="org-add"
                  aria-label={`Add ${LEVEL_LABEL[level]}`}
                  title={addTitle}
                  disabled={level === "portfolio" || !parents.length}
                  onClick={() => setAdding({ level })}
                >
                  +
                </button>
              </div>
              <div className="org-band-nodes">
                {nodes.length === 0 && <span className="muted small">No {LEVEL_LABEL[level]} units</span>}
                {nodes.map((n) => {
                  const isRoot = n.id === root.id;
                  const detachable = canDetach(root, n);
                  const cls = [
                    "org-node",
                    n.id === selected.id ? "selected" : "",
                    chain ? (chain.has(n.id) ? "hot" : "dim") : "",
                    overId === n.id ? "drop-over" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <div
                      key={n.id}
                      ref={setBox(n.id)}
                      data-node-id={n.id}
                      className={cls}
                      style={{ borderColor: LEVEL_COLOR[n.level] }}
                      draggable={!isRoot}
                      onMouseEnter={() => setHover(n.id)}
                      onMouseLeave={() => setHover(undefined)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", n.id);
                        setDragId(n.id);
                      }}
                      onDragEnd={() => {
                        setDragId(undefined);
                        setOverId(undefined);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (overId !== n.id) setOverId(n.id);
                      }}
                      onDragLeave={() => setOverId(undefined)}
                      onDrop={(e) => onDrop(e, n)}
                    >
                      <button className="org-node-name" onClick={() => selectNode(n.id)} title={n.areaPath ?? "No area path"}>
                        {n.name}
                      </button>
                      <button
                        className="org-menu-btn"
                        aria-label={`Actions for ${n.name}`}
                        aria-expanded={menuId === n.id}
                        onClick={() => setMenuId(menuId === n.id ? undefined : n.id)}
                      >
                        ⋯
                      </button>
                      {menuId === n.id && (
                        <div className="org-menu" role="menu" aria-label={`${n.name} actions`}>
                          {childLevels(n.level).map((l) => (
                            <button
                              key={l}
                              role="menuitem"
                              onClick={() => {
                                setMenuId(undefined);
                                setAdding({ level: l, parentId: n.id });
                              }}
                            >
                              Add {LEVEL_LABEL[l]} here
                            </button>
                          ))}
                          {!isRoot && (
                            <>
                              <button
                                role="menuitem"
                                disabled={!detachable}
                                title={
                                  detachable
                                    ? `Attach directly to ${root.name}`
                                    : `${capitalize(withArticle(n.level))} can only be detached when it can attach to the portfolio root`
                                }
                                onClick={() => detach(n)}
                              >
                                Detach from parent
                              </button>
                              <button role="menuitem" className="danger" onClick={() => remove(n)}>
                                Remove from hierarchy
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {adding && (
        <AddUnitDialog
          level={adding.level}
          parents={all.filter((n) => childLevels(n.level).includes(adding.level))}
          initialParentId={adding.parentId}
          onClose={() => setAdding(undefined)}
          onSave={(parentId, name, area) => add(adding.level, parentId, name, area)}
        />
      )}
    </div>
  );
}

function AddUnitDialog({
  level,
  parents,
  initialParentId,
  onClose,
  onSave,
}: {
  level: Level;
  parents: OrgNode[];
  initialParentId?: string;
  onClose: () => void;
  onSave: (parentId: string, name: string, areaPath: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [area, setArea] = useState("");
  const [parentId, setParentId] = useState(initialParentId ?? parents[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const areas = useAsync(() => getAreaPaths(), []);

  const submit = async () => {
    setSaving(true);
    try {
      await onSave(parentId, name.trim(), area);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Add ${LEVEL_LABEL[level]}`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || !parentId || saving} onClick={submit}>
            {saving ? "Adding…" : "Add"}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Area path">
        {areas.loading ? (
          <Spinner label="Loading area paths…" />
        ) : (
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">(none)</option>
            {(areas.data ?? []).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        )}
      </Field>
      <ErrorBar message={areas.error && `Could not load area paths: ${areas.error}`} />
      <Field label="Parent">
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({LEVEL_LABEL[p.level]})
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}
