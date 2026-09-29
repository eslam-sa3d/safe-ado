import { useState } from "react";
import { newId } from "../api/data";
import { childLevels, flatten, LEVEL_COLOR } from "../api/org";
import { Level, LEVEL_LABEL, Member, OrgNode, SafeConfig } from "../api/types";
import {
  ClassificationNode,
  getAreaPaths,
  getAreaTree,
  getFieldNames,
  getIterationPaths,
  getTeamDefaultArea,
  getTeams,
  getWorkItemTypes,
  nodePathToFieldPath,
} from "../api/wit";
import { ErrorBar, Field, Info, Spinner, useAsync } from "../components/common";
import { useSafe } from "../components/context";

function updateNode(root: OrgNode, id: string, fn: (n: OrgNode) => OrgNode): OrgNode {
  if (root.id === id) return fn(root);
  return { ...root, children: root.children.map((c) => updateNode(c, id, fn)) };
}

export const MAX_MEMBERS = 25;
export const MAX_ROLE_LENGTH = 100;

function removeNode(root: OrgNode, id: string): OrgNode {
  return { ...root, children: root.children.filter((c) => c.id !== id).map((c) => removeNode(c, id)) };
}

export function SetupView({ firstRun }: { firstRun: boolean }) {
  const { config, saveConfig } = useSafe();
  const [draft, setDraft] = useState<SafeConfig>(config);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [generateMode, setGenerateMode] = useState<"art" | "solution">("art");

  const meta = useAsync(async () => {
    const [types, fields, iterations, areas, teams] = await Promise.all([
      getWorkItemTypes(),
      getFieldNames(),
      getIterationPaths(),
      getAreaPaths(),
      getTeams(),
    ]);
    return {
      types: types.map((t) => t.name).sort(),
      numericFields: fields.filter((f) => f.type === "double" || f.type === "integer").sort((a, b) => a.name.localeCompare(b.name)),
      iterations,
      areas,
      teams,
    };
  }, []);

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await saveConfig(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(`Could not save: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    if (flatten(draft.root).length > 1 && !window.confirm("Replace the current hierarchy with one generated from area paths?")) return;
    setError(undefined);
    try {
      const [tree, teams] = await Promise.all([getAreaTree(), getTeams()]);
      const defaults = await Promise.all(teams.map((t) => getTeamDefaultArea(t.id).catch(() => undefined)));
      const teamByArea = new Map<string, string>();
      teams.forEach((t, i) => defaults[i] && !teamByArea.has(defaults[i]!.toLowerCase()) && teamByArea.set(defaults[i]!.toLowerCase(), t.id));

      const build = (n: ClassificationNode, level: Level): OrgNode => {
        const areaPath = nodePathToFieldPath(n.path);
        const next = childLevels(level).find((l) => l !== "solution" || generateMode === "solution");
        return {
          id: newId(),
          name: n.name,
          level,
          areaPath,
          teamId: teamByArea.get(areaPath.toLowerCase()),
          children: next ? (n.children ?? []).map((c) => build(c, next)) : [],
        };
      };
      const root = build(tree, "portfolio");
      root.children = (tree.children ?? []).map((c) => build(c, generateMode));
      setDraft({ ...draft, root });
    } catch (e: any) {
      setError(`Could not generate hierarchy: ${e.message}`);
    }
  };

  if (meta.loading && !meta.data) return <Spinner label="Loading project metadata…" />;
  const m = meta.data;

  return (
    <div className="setup">
      {firstRun && (
        <Info>
          <strong>Welcome to SAFe Ado.</strong> Map your process's work item types, choose where PIs live in the iteration tree, and
          model your Portfolio → Large Solution → ART → Team hierarchy. The quickest start is <em>Generate from area paths</em>.
        </Info>
      )}
      <ErrorBar message={meta.error ?? error} onClose={() => setError(undefined)} />

      <div className="savebar">
        <span className="muted">{dirty ? "Unsaved changes" : saved ? "Saved ✓" : "All changes saved"}</span>
        <span className="spacer" />
        <button className="btn" disabled={!dirty || saving} onClick={() => setDraft(config)}>
          Discard
        </button>
        <button className="btn primary" disabled={(!dirty && !firstRun) || saving} onClick={save}>
          {saving ? "Saving…" : "Save configuration"}
        </button>
      </div>

      <div className="two-col">
        <section className="panel">
          <div className="panel-header">
            <h3>Work item types</h3>
          </div>
          <div className="pad form">
            {(
              [
                ["epic", "Portfolio level (Epic)"],
                ["capability", "Large Solution level (Capability) — optional"],
                ["feature", "ART level (Feature)"],
                ["story", "Team level (Story)"],
              ] as const
            ).map(([k, label]) => (
              <Field key={k} label={label}>
                <select
                  value={draft.types[k]}
                  onChange={(e) => setDraft({ ...draft, types: { ...draft.types, [k]: e.target.value } })}
                >
                  <option value="">{k === "capability" ? "(none — Features link directly to Epics)" : "(select)"}</option>
                  {m?.types.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
            ))}
            <Field label="Story size field">
              <select value={draft.storyPointsField} onChange={(e) => setDraft({ ...draft, storyPointsField: e.target.value })}>
                {m?.numericFields.map((f) => (
                  <option key={f.referenceName} value={f.referenceName}>
                    {f.name} ({f.referenceName})
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>Program Increments</h3>
          </div>
          <div className="pad form">
            <Field label="PI root iteration">
              <select value={draft.piRootIteration} onChange={(e) => setDraft({ ...draft, piRootIteration: e.target.value })}>
                {m?.iterations.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
            <p className="muted small">
              Each direct child of this iteration is treated as a PI, and its children as the PI's iterations (sprints + IP). Example:{" "}
              <code>{draft.piRootIteration}\PI 1\PI 1 Sprint 1</code>.
            </p>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-header">
          <h3>Organization hierarchy</h3>
          <span className="spacer" />
          <label className="small muted">Top-level areas are</label>
          <select value={generateMode} onChange={(e) => setGenerateMode(e.target.value as "art" | "solution")}>
            <option value="art">ARTs (Essential / Portfolio SAFe)</option>
            <option value="solution">Large Solutions (Full SAFe)</option>
          </select>
          <button className="btn" onClick={generate}>
            Generate from area paths
          </button>
        </div>
        <p className="muted small pad-x">
          Area Paths scope every view: a node sees work items under its area path. Link Teams so PIs can be assigned to their sprint lists.
        </p>
        <ul className="node-editor">
          <NodeEditor
            node={draft.root}
            isRoot
            areas={m?.areas ?? []}
            teams={m?.teams ?? []}
            // Functional updates: the team lookup resolves later and must not overwrite newer edits.
            onChange={(id, fn) => setDraft((d) => ({ ...d, root: updateNode(d.root, id, fn) }))}
            onRemove={(id) => setDraft((d) => ({ ...d, root: removeNode(d.root, id) }))}
          />
        </ul>
      </section>
    </div>
  );
}

function NodeEditor(props: {
  node: OrgNode;
  isRoot?: boolean;
  areas: string[];
  teams: { id: string; name: string }[];
  onChange: (id: string, fn: (n: OrgNode) => OrgNode) => void;
  onRemove: (id: string) => void;
}) {
  const { node, onChange } = props;
  const [showMembers, setShowMembers] = useState(false);
  const members = node.members ?? [];
  const set = (patch: Partial<OrgNode>) => onChange(node.id, (n) => ({ ...n, ...patch }));
  // An empty list is stored as "no members" so adding and removing leaves the config unchanged.
  const updateMembers = (fn: (m: Member[]) => Member[]) =>
    onChange(node.id, (n) => {
      const next = fn(n.members ?? []);
      return { ...n, members: next.length ? next : undefined };
    });
  const move = (i: number, delta: number) =>
    updateMembers((m) => {
      const next = [...m];
      [next[i], next[i + delta]] = [next[i + delta], next[i]];
      return next;
    });
  const add = (level: Level) =>
    onChange(node.id, (n) => ({
      ...n,
      children: [...n.children, { id: newId(), name: `New ${LEVEL_LABEL[level]}`, level, areaPath: n.areaPath, children: [] }],
    }));

  const onTeam = async (teamId: string) => {
    set({ teamId: teamId || undefined });
    if (teamId && !node.areaPath) {
      const area = await getTeamDefaultArea(teamId).catch(() => undefined);
      if (area) onChange(node.id, (n) => ({ ...n, areaPath: area }));
    }
  };

  return (
    <li>
      <div className="node-row">
        <span className="level-badge" style={{ background: LEVEL_COLOR[node.level] }}>
          {LEVEL_LABEL[node.level]}
        </span>
        <input className="node-name" value={node.name} onChange={(e) => set({ name: e.target.value })} aria-label="Name" />
        <select value={node.areaPath ?? ""} onChange={(e) => set({ areaPath: e.target.value || undefined })} aria-label="Area path">
          <option value="">(no area path)</option>
          {props.areas.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        {node.level !== "portfolio" && (
          <select value={node.teamId ?? ""} onChange={(e) => onTeam(e.target.value)} aria-label="Azure DevOps team">
            <option value="">(no team)</option>
            {props.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        {childLevels(node.level).map((l) => (
          <button key={l} className="link small" onClick={() => add(l)}>
            + {LEVEL_LABEL[l]}
          </button>
        ))}
        <button
          className="link small"
          aria-expanded={showMembers}
          aria-label={`Members of ${node.name}`}
          onClick={() => setShowMembers(!showMembers)}
        >
          {showMembers ? "▾" : "▸"} Members ({members.length})
        </button>
        {!props.isRoot && (
          <button
            className="link small danger"
            onClick={() =>
              (node.children.length === 0 || window.confirm(`Remove "${node.name}" and everything under it?`)) && props.onRemove(node.id)
            }
          >
            Remove
          </button>
        )}
      </div>
      {showMembers && (
        <div className="members-editor" role="group" aria-label={`${node.name} members`}>
          {members.length === 0 && <div className="muted small">No members yet.</div>}
          {members.map((m, i) => (
            <div key={i} className="member-row">
              <input
                aria-label={`Member ${i + 1} name`}
                placeholder="Name"
                value={m.name}
                onChange={(e) => updateMembers((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <input
                aria-label={`Member ${i + 1} role`}
                placeholder="Role (e.g. RTE, Product Owner)"
                maxLength={MAX_ROLE_LENGTH}
                value={m.role}
                onChange={(e) =>
                  updateMembers((list) => list.map((x, j) => (j === i ? { ...x, role: e.target.value.slice(0, MAX_ROLE_LENGTH) } : x)))
                }
              />
              <button className="link small" aria-label={`Move member ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button
                className="link small"
                aria-label={`Move member ${i + 1} down`}
                disabled={i === members.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
              <button
                className="link small danger"
                aria-label={`Remove member ${i + 1}`}
                onClick={() => updateMembers((list) => list.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="link small"
            disabled={members.length >= MAX_MEMBERS}
            onClick={() => updateMembers((list) => [...list, { name: "", role: "" }])}
          >
            + Add member
          </button>
          {members.length >= MAX_MEMBERS && <span className="muted small"> A node can have at most {MAX_MEMBERS} members.</span>}
        </div>
      )}
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <NodeEditor key={c.id} {...props} node={c} isRoot={false} />
          ))}
        </ul>
      )}
    </li>
  );
}
