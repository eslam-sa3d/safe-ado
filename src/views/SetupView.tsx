import { useMemo, useState } from "react";
import { CAPACITY_SOURCE_LABEL, capacitySettings, DEFAULT_POINTS_PER_PERSON_DAY } from "../api/capacity";
import { getProject } from "../api/client";
import { newId } from "../api/data";
import { DEFAULT_DEPENDENCY_LINK } from "../api/dependencies";
import { childLevels, flatten } from "../api/org";
import { getProjects, isForeignNode, ProjectRef } from "../api/projects";
import { memberRole, SAFE_ROLES, SafeRole, withRole } from "../api/roles";
import { DEFAULT_RROE_FIELD } from "../api/rules";
import { telemetryAvailable } from "../api/telemetry";
import { CapacitySource, Level, LEVEL_LABEL, Member, OrgNode, SafeConfig } from "../api/types";
import {
  ClassificationNode,
  getAreaPaths,
  getAreaTree,
  getFieldNames,
  getIterationPaths,
  getIterationTree,
  getRelationTypes,
  getTeamDefaultArea,
  getTeamMembers,
  getTeams,
  getWorkItemTypes,
  nodePathToFieldPath,
  RelationType,
} from "../api/wit";
import { ErrorBar, Field, Info, Spinner, useAsync, Icon, LevelPill } from "../components/common";
import { useDataCan, useSafe } from "../components/context";
import { PermissionNotice } from "../components/PermissionNotice";
import { AuditSection, BackupPanel } from "./SetupData";

function updateNode(root: OrgNode, id: string, fn: (n: OrgNode) => OrgNode): OrgNode {
  if (root.id === id) return fn(root);
  return { ...root, children: root.children.map((c) => updateNode(c, id, fn)) };
}

export const MAX_MEMBERS = 25;
export const MAX_ROLE_LENGTH = 100;

function removeNode(root: OrgNode, id: string): OrgNode {
  return { ...root, children: root.children.filter((c) => c.id !== id).map((c) => removeNode(c, id)) };
}

/** Link types that can express a provider → consumer dependency (dependency or network topology, forward ends only). */
export function dependencyLinkOptions(types: RelationType[]): RelationType[] {
  return types.filter(
    (t) => (t.attributes?.topology === "dependency" || t.attributes?.topology === "network") && !/-Reverse$/.test(t.referenceName)
  );
}

/** The paired end of a link type: "X-Forward" ↔ "X-Reverse"; symmetric (network) types pair with themselves. */
export function reverseLinkType(forward: string): string {
  return /-Forward$/.test(forward) ? forward.replace(/-Forward$/, "-Reverse") : forward;
}

interface CheckItem {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
  target: string;
}

const SECTION = { types: "setup-types", pis: "setup-pis", hierarchy: "setup-hierarchy", dependencies: "setup-dependencies", capacity: "setup-capacity" };

/** Areas, iterations and teams of another project (for units of cross-project portfolios). */
export interface ProjectMeta {
  areas: string[];
  iterations: string[];
  teams: { id: string; name: string }[];
}

async function loadProjectMeta(projectId: string): Promise<ProjectMeta> {
  const [areas, iterations, teams] = await Promise.all([getAreaPaths(projectId), getIterationPaths(projectId), getTeams(projectId)]);
  return { areas, iterations, teams };
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

export function SetupView({ firstRun }: { firstRun: boolean }) {
  const { config, saveConfig } = useSafe();
  const readOnly = !useDataCan().admin;
  const [draft, setDraft] = useState<SafeConfig>(config);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [generateMode, setGenerateMode] = useState<"art" | "solution">("art");
  /** Text of the points-per-person-day input while it is edited (may be temporarily invalid). */
  const [factorText, setFactorText] = useState<string>();
  // Other projects' metadata, loaded once per project while this view is open.
  const projectMeta = useMemo(() => {
    const cache = new Map<string, Promise<ProjectMeta>>();
    return (projectId: string) => {
      if (!cache.has(projectId)) {
        const request = loadProjectMeta(projectId);
        request.catch(() => cache.delete(projectId));
        cache.set(projectId, request);
      }
      return cache.get(projectId)!;
    };
  }, []);

  const meta = useAsync(async () => {
    const [types, fields, iterationTree, areas, teams, relationTypes, projects] = await Promise.all([
      getWorkItemTypes(),
      getFieldNames(),
      getIterationTree(),
      getAreaPaths(),
      getTeams(),
      // Optional: without link types the dependency setting keeps its current value.
      getRelationTypes().catch(() => [] as RelationType[]),
      // Optional: without the project list, units stay in this project.
      getProjects().catch(() => [] as ProjectRef[]),
    ]);
    const iterations: string[] = [];
    const childCount = new Map<string, number>();
    const walk = (n: ClassificationNode) => {
      const path = nodePathToFieldPath(n.path);
      iterations.push(path);
      childCount.set(path.toLowerCase(), n.children?.length ?? 0);
      n.children?.forEach(walk);
    };
    walk(iterationTree);
    return {
      types: types.map((t) => t.name).sort(),
      numericFields: fields.filter((f) => f.type === "double" || f.type === "integer").sort((a, b) => a.name.localeCompare(b.name)),
      iterations,
      childCount,
      areas,
      teams,
      relationTypes,
      projects,
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
  const linkOptions = dependencyLinkOptions(m?.relationTypes ?? []);
  const link = draft.dependencyLink ?? DEFAULT_DEPENDENCY_LINK;
  const linkName = (ref: string) => m?.relationTypes.find((t) => t.referenceName === ref)?.name ?? ref;
  const hasDefaultRroe = !!m?.numericFields.some((f) => f.referenceName === DEFAULT_RROE_FIELD);
  const rroe = draft.rroeField ?? (hasDefaultRroe ? DEFAULT_RROE_FIELD : "");
  const capacity = capacitySettings(draft);
  const checks = checklist(draft, m);
  const done = checks.filter((c) => c.ok).length;

  return (
    <div className="setup">
      {firstRun && (
        <Info>
          <strong>Welcome to ScaleLane.</strong> Map your process's work item types, choose where PIs live in the iteration tree, and
          model your Portfolio → Large Solution → ART → Team hierarchy. The quickest start is <em>Generate from area paths</em>.
        </Info>
      )}
      {readOnly && (
        <div className="msg msg-info readonly-banner" role="note">
          Read-only: only project administrators can change the SAFe configuration.
        </div>
      )}
      <ErrorBar message={meta.error ?? error} onClose={() => setError(undefined)} />
      <PermissionNotice needs="admin" />

      {!readOnly && (
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
      )}

      <section className="panel setup-checklist" aria-label="Configuration checklist">
        <div className="panel-header">
          <h3>Configuration checklist</h3>
          <span className="muted small">
            {done} of {checks.length} done
          </span>
        </div>
        <ul className="checklist pad">
          {checks.map((c) => (
            <li key={c.key} className={c.ok ? "ok" : "missing"} data-check={c.key}>
              <span className="check-mark" aria-label={c.ok ? "Done" : "Missing"} role="img">
                {c.ok ? "✓" : "✗"}
              </span>
              <button className="link" onClick={() => scrollToSection(c.target)}>
                {c.label}
              </button>
              {c.detail && <span className="muted small">{c.detail}</span>}
            </li>
          ))}
        </ul>
      </section>

      <fieldset className="plain-fieldset" disabled={readOnly}>
        <div className="two-col">
          <section className="panel" id={SECTION.types}>
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
                  ["enabler", "Enabler type — optional"],
                  ["theme", "Strategic Theme type — optional"],
                ] as const
              ).map(([k, label]) => {
                const optional = k === "capability" || k === "enabler" || k === "theme";
                return (
                  <Field key={k} label={label}>
                    <select
                      value={draft.types[k] ?? ""}
                      onChange={(e) => {
                        // Unset optional types are left out so choosing "(none)" restores the saved config.
                        const value = e.target.value || (k === "enabler" || k === "theme" ? undefined : "");
                        setDraft({ ...draft, types: { ...draft.types, [k]: value } });
                      }}
                    >
                      <option value="">
                        {k === "capability" ? "(none — Features link directly to Epics)" : optional ? "(none)" : "(select)"}
                      </option>
                      {m?.types.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </Field>
                );
              })}
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

          <section className="panel" id={SECTION.pis}>
            <div className="panel-header">
              <h3>Program Increments</h3>
            </div>
            <div className="pad form">
              <Field label="PI root iteration">
                <select
                  value={draft.piRootIteration}
                  // A new path needs a new id: the App resolves (and stores) it on the next load.
                  onChange={(e) => setDraft({ ...draft, piRootIteration: e.target.value, piRootId: undefined })}
                >
                  {m?.iterations.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </Field>
              <p className="muted small">
                Each direct child of this iteration is treated as a PI, and its children as the PI's iterations (sprints + IP). Example:{" "}
                <code>{draft.piRootIteration}\PI 1\PI 1 Sprint 1</code>. Solution Trains and ARTs can run their own cadence (set it in the
                hierarchy below).
              </p>
            </div>
          </section>
        </div>

        <section className="panel" id={SECTION.dependencies}>
          <div className="panel-header">
            <h3>Dependencies &amp; WSJF</h3>
          </div>
          <div className="pad form">
            <div className="field-row">
              <Field label="Dependency link type">
                <select
                  value={link.forward}
                  onChange={(e) => setDraft({ ...draft, dependencyLink: { forward: e.target.value, reverse: reverseLinkType(e.target.value) } })}
                >
                  {!linkOptions.some((t) => t.referenceName === link.forward) && <option value={link.forward}>{link.forward}</option>}
                  {linkOptions.map((t) => (
                    <option key={t.referenceName} value={t.referenceName}>
                      {t.name} ({t.referenceName})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="RR/OE field (WSJF)">
                <select value={rroe} onChange={(e) => setDraft({ ...draft, rroeField: e.target.value })}>
                  <option value="">(none)</option>
                  {m?.numericFields.map((f) => (
                    <option key={f.referenceName} value={f.referenceName}>
                      {f.name} ({f.referenceName})
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <p className="muted small link-direction">
              Direction: provider → consumer. The provider links to the consumer with <strong>{linkName(link.forward)}</strong>; the
              consumer links back with <strong>{linkName(link.reverse)}</strong>
              {link.forward === link.reverse ? " (a symmetric link: the first-linked item counts as the provider)" : ""}.
            </p>
          </div>
        </section>

        <section className="panel" id={SECTION.capacity}>
          <div className="panel-header">
            <h3>Capacity</h3>
          </div>
          <div className="pad form">
            <div className="field-row">
              <Field label="Capacity source">
                <select
                  value={capacity.source}
                  onChange={(e) => {
                    const source = e.target.value as CapacitySource;
                    // Manual (the default) is stored as "no setting" so existing configs stay unchanged.
                    setDraft({ ...draft, capacity: source === "manual" && !draft.capacity?.pointsPerPersonDay ? undefined : { ...draft.capacity, source } });
                  }}
                >
                  {(Object.keys(CAPACITY_SOURCE_LABEL) as CapacitySource[]).map((k) => (
                    <option key={k} value={k}>
                      {CAPACITY_SOURCE_LABEL[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Story points per person-day">
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  disabled={capacity.source === "manual"}
                  value={factorText ?? String(draft.capacity?.pointsPerPersonDay ?? DEFAULT_POINTS_PER_PERSON_DAY)}
                  onBlur={() => setFactorText(undefined)}
                  onChange={(e) => {
                    setFactorText(e.target.value);
                    const f = Number(e.target.value);
                    setDraft({
                      ...draft,
                      capacity: { ...draft.capacity, source: capacity.source, pointsPerPersonDay: Number.isFinite(f) && f > 0 ? f : undefined },
                    });
                  }}
                />
              </Field>
            </div>
            <p className="muted small capacity-help">
              {capacity.source === "manual"
                ? "Teams enter their capacity in story points per iteration on the Team Planning Board."
                : `Capacity is derived from each team's Azure DevOps capacity (Boards → Sprints → Capacity) with SAFe normalized estimation: every working day a member with capacity per day is available (weekends, team and personal days off excluded) counts ${capacity.pointsPerPersonDay} SP, so a full-time member in a 2-week iteration yields ${Math.round(capacity.pointsPerPersonDay * 100) / 10} SP.`}
              {capacity.source === "hybrid" && " A value entered on the Team Planning Board overrides the derived one."}
            </p>
          </div>
        </section>

        <section className="panel setup-telemetry">
          <div className="panel-header">
            <h3>Usage data</h3>
          </div>
          <div className="pad form">
            <label className="check">
              <input
                type="checkbox"
                checked={draft.telemetryOptIn === true}
                onChange={(e) => setDraft({ ...draft, telemetryOptIn: e.target.checked })}
              />{" "}
              Share anonymous usage data
            </label>
            <p className="muted small">
              Only event names (such as &ldquo;view opened: Reports&rdquo;), the extension version and a salted hash of the
              collection id. Never titles, names, e-mails or work item data. Off by default.{" "}
              {telemetryAvailable() ? "" : "This build has no telemetry endpoint, so nothing is sent even when this is on."}
            </p>
          </div>
        </section>
      </fieldset>

      <section className="panel" id={SECTION.hierarchy}>
        <div className="panel-header">
          <h3>Organization hierarchy</h3>
          <span className="spacer" />
          {!readOnly && (
            <>
              <label className="small muted">Top-level areas are</label>
              <select value={generateMode} onChange={(e) => setGenerateMode(e.target.value as "art" | "solution")}>
                <option value="art">ARTs (Essential / Portfolio SAFe)</option>
                <option value="solution">Large Solutions (Full SAFe)</option>
              </select>
              <button className="btn" onClick={generate}>
                Generate from area paths
              </button>
            </>
          )}
        </div>
        <p className="muted small pad-x">
          Area Paths scope every view: a node sees work items under its area path. Link Teams so PIs can be assigned to their sprint lists.
          {(m?.projects.length ?? 0) > 1 &&
            " A unit can live in another project of this collection: pick its project first, then its area path, team and (optionally) the PI root in that project. Its PIs are matched to this cadence by name, else by dates."}
        </p>
        <ul className="node-editor">
          <NodeEditor
            node={draft.root}
            isRoot
            readOnly={readOnly}
            areas={m?.areas ?? []}
            iterations={m?.iterations ?? []}
            teams={m?.teams ?? []}
            projects={m?.projects ?? []}
            projectMeta={projectMeta}
            // Functional updates: the team lookup resolves later and must not overwrite newer edits.
            onChange={(id, fn) => setDraft((d) => ({ ...d, root: updateNode(d.root, id, fn) }))}
            onRemove={(id) => setDraft((d) => ({ ...d, root: removeNode(d.root, id) }))}
          />
        </ul>
      </section>

      <section className="panel" id="setup-backup">
        <div className="panel-header">
          <h3>Backup &amp; restore</h3>
        </div>
        <BackupPanel
          canImport={!readOnly}
          onConfigRestored={async (restored) => {
            await saveConfig(restored);
            setDraft(restored);
          }}
        />
      </section>

      <section className="panel" id="setup-audit">
        <div className="panel-header">
          <h3>Audit log</h3>
        </div>
        <AuditSection />
      </section>
    </div>
  );
}

interface Meta {
  types: string[];
  numericFields: { referenceName: string }[];
  iterations: string[];
  childCount: Map<string, number>;
  relationTypes: RelationType[];
}

/** Agile Hive-style setup checklist, evaluated against the draft so it updates while editing. */
export function checklist(draft: SafeConfig, m: Meta | undefined): CheckItem[] {
  const all = flatten(draft.root);
  const required = [draft.types.epic, draft.types.feature, draft.types.story];
  const mapped = [...required, draft.types.capability, draft.types.enabler, draft.types.theme].filter(Boolean) as string[];
  const unknownTypes = mapped.filter((t) => !m?.types.includes(t));
  const piRootFound = !!m?.childCount.has(draft.piRootIteration.toLowerCase());
  const piCount = m?.childCount.get(draft.piRootIteration.toLowerCase()) ?? 0;
  const arts = all.filter((n) => n.level === "art");
  const incompleteTeams = all.filter((n) => n.level === "team" && (!n.areaPath || !n.teamId));
  const artsWithoutMembers = arts.filter((a) => !a.members?.length);
  const link = draft.dependencyLink;
  const linkKnown = !link || !m?.relationTypes.length || m.relationTypes.some((t) => t.referenceName === link.forward);
  const names = (nodes: OrgNode[]) => nodes.map((n) => n.name).join(", ");

  return [
    {
      key: "types",
      label: "Work item types mapped",
      ok: required.every(Boolean) && unknownTypes.length === 0,
      detail: !required.every(Boolean) ? "Choose the Epic, Feature and Story types." : unknownTypes.length ? `Not in this process: ${unknownTypes.join(", ")}` : undefined,
      target: SECTION.types,
    },
    {
      key: "points",
      label: "Story size field is numeric",
      ok: !!m?.numericFields.some((f) => f.referenceName === draft.storyPointsField),
      target: SECTION.types,
    },
    { key: "piRoot", label: "PI root iteration found", ok: piRootFound, detail: piRootFound ? undefined : draft.piRootIteration, target: SECTION.pis },
    {
      key: "pis",
      label: "At least one PI exists",
      ok: piCount > 0,
      detail: piCount > 0 ? `${piCount} PI${piCount === 1 ? "" : "s"}` : "Create one in PIs & Iterations.",
      target: SECTION.pis,
    },
    { key: "art", label: "Hierarchy has an Agile Release Train", ok: arts.length > 0, target: SECTION.hierarchy },
    {
      key: "teams",
      label: "Every team has an area path and an Azure DevOps team",
      ok: incompleteTeams.length === 0,
      detail: incompleteTeams.length ? `Incomplete: ${names(incompleteTeams)}` : undefined,
      target: SECTION.hierarchy,
    },
    {
      key: "link",
      label: "Dependency link type set",
      ok: linkKnown,
      detail: !link ? "Default (Successor / Predecessor)" : linkKnown ? undefined : `Unknown link type ${link.forward}`,
      target: SECTION.dependencies,
    },
    {
      key: "members",
      label: "Every ART has at least one member",
      ok: arts.length > 0 && artsWithoutMembers.length === 0,
      detail: artsWithoutMembers.length ? `No members: ${names(artsWithoutMembers)}` : undefined,
      target: SECTION.hierarchy,
    },
  ];
}

function NodeEditor(props: {
  node: OrgNode;
  isRoot?: boolean;
  readOnly: boolean;
  areas: string[];
  iterations: string[];
  teams: { id: string; name: string }[];
  /** Projects of the collection; the project picker shows when there is more than one. */
  projects: ProjectRef[];
  projectMeta: (projectId: string) => Promise<ProjectMeta>;
  onChange: (id: string, fn: (n: OrgNode) => OrgNode) => void;
  onRemove: (id: string) => void;
}) {
  const { node, onChange, readOnly } = props;
  const [showMembers, setShowMembers] = useState(false);
  const members = node.members ?? [];
  // A unit of another project picks its area, team and PI root from that project.
  const foreign = isForeignNode(node);
  const foreignProject = foreign ? node.projectId : undefined;
  const projectMeta = useAsync(
    () => (foreignProject ? props.projectMeta(foreignProject) : Promise.resolve(undefined)),
    [foreignProject]
  );
  const areas = foreign ? projectMeta.data?.areas ?? [] : props.areas;
  const teams = foreign ? projectMeta.data?.teams ?? [] : props.teams;
  const iterations = foreign ? projectMeta.data?.iterations ?? [] : props.iterations;
  const teamMembers = useAsync(
    () => (showMembers && node.teamId && !readOnly ? getTeamMembers(node.teamId, foreignProject) : Promise.resolve([])),
    [showMembers, node.teamId, readOnly, foreignProject]
  );
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
      children: [
        ...n.children,
        {
          id: newId(),
          name: `New ${LEVEL_LABEL[level]}`,
          level,
          areaPath: n.areaPath,
          // A child starts in its parent's project.
          ...(isForeignNode(n) ? { projectId: n.projectId, projectName: n.projectName } : {}),
          children: [],
        },
      ],
    }));
  /** Moves the unit to another project: its area, team and PI root belong to the old one and are cleared. */
  const setProject = (projectId: string) =>
    onChange(node.id, (n) => {
      const { projectId: _p, projectName: _n, areaPath: _a, areaId: _i, teamId: _t, piRootIteration: _r, piRootId: _ri, ...rest } = n;
      if (projectId === getProject().id) return rest;
      return { ...rest, projectId, projectName: props.projects.find((p) => p.id === projectId)?.name ?? projectId };
    });
  const pickable = (teamMembers.data ?? []).filter((t) => !members.some((m) => m.id === t.id));
  const addIdentity = (id: string) => {
    const t = pickable.find((p) => p.id === id);
    if (!t) return;
    updateMembers((list) => [...list, { name: t.displayName, role: "", id: t.id, uniqueName: t.uniqueName, ...(t.imageUrl ? { imageUrl: t.imageUrl } : {}) }]);
  };

  const onTeam = async (teamId: string) => {
    set({ teamId: teamId || undefined });
    if (teamId && !node.areaPath) {
      const area = await getTeamDefaultArea(teamId, foreignProject).catch(() => undefined);
      if (area) onChange(node.id, (n) => ({ ...n, areaPath: area }));
    }
  };

  const hasCadence = node.level === "solution" || node.level === "art";
  const full = members.length >= MAX_MEMBERS;

  return (
    <li>
      <div className="node-row">
        <LevelPill level={node.level} />
        <input className="node-name" value={node.name} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} aria-label="Name" />
        {(props.projects.length > 1 || foreign) && (
          <select
            value={foreign ? node.projectId : getProject().id}
            disabled={readOnly}
            onChange={(e) => setProject(e.target.value)}
            aria-label="Project"
            title="Azure DevOps project of this unit's area path and team"
          >
            {foreign && !props.projects.some((p) => p.id === node.projectId) && (
              <option value={node.projectId}>{node.projectName ?? node.projectId}</option>
            )}
            {!props.projects.some((p) => p.id === getProject().id) && <option value={getProject().id}>{getProject().name}</option>}
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <select
          value={node.areaPath ?? ""}
          disabled={readOnly}
          onChange={(e) => set({ areaPath: e.target.value || undefined, areaId: undefined })}
          aria-label="Area path"
        >
          <option value="">(no area path)</option>
          {foreign && node.areaPath && !areas.includes(node.areaPath) && <option>{node.areaPath}</option>}
          {areas.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        {node.level !== "portfolio" && (
          <select value={node.teamId ?? ""} disabled={readOnly} onChange={(e) => onTeam(e.target.value)} aria-label="Azure DevOps team">
            <option value="">(no team)</option>
            {foreign && node.teamId && !teams.some((t) => t.id === node.teamId) && <option value={node.teamId}>{node.teamId}</option>}
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        {foreign && (
          <select
            value={node.piRootIteration ?? ""}
            disabled={readOnly}
            onChange={(e) => set({ piRootIteration: e.target.value || undefined, piRootId: undefined })}
            aria-label="PI root in project"
            title={`Where this unit's PIs live in ${node.projectName ?? "its project"}; they are matched to the cadence by name, else by dates`}
          >
            <option value="">PIs at the cadence's path</option>
            {node.piRootIteration && !iterations.includes(node.piRootIteration) && <option>{node.piRootIteration}</option>}
            {iterations.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        {foreign && projectMeta.error && (
          <span className="danger small">
            Could not load {node.projectName ?? node.projectId}: {projectMeta.error}
          </span>
        )}
        {hasCadence && !foreign && (

          <select
            value={node.piRootIteration ?? ""}
            disabled={readOnly}
            // Clearing the id lets the App resolve the new cadence root on the next load.
            onChange={(e) => set({ piRootIteration: e.target.value || undefined, piRootId: undefined })}
            aria-label="PI cadence"
            title="Where this unit's PIs live: inherit the parent's cadence or use its own PI root iteration"
          >
            <option value="">Inherit cadence</option>
            {props.iterations.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        {!readOnly &&
          childLevels(node.level).map((l) => (
            <button key={l} className="link small" onClick={() => add(l)}>
              <Icon name="Add" className="small" /> Add {LEVEL_LABEL[l]}
            </button>
          ))}
        <button
          className="link small"
          aria-expanded={showMembers}
          aria-label={`Members of ${node.name}`}
          onClick={() => setShowMembers(!showMembers)}
        >
          <Icon name={showMembers ? "ChevronDown" : "ChevronRight"} className="small" /> Members ({members.length})
        </button>
        {!props.isRoot && !readOnly && (
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
              {m.imageUrl && <img className="member-avatar" src={m.imageUrl} alt="" />}
              <input
                aria-label={`Member ${i + 1} name`}
                placeholder="Name"
                value={m.name}
                disabled={readOnly}
                // Typing a name makes it a free-text member: the picked identity no longer applies.
                onChange={(e) =>
                  updateMembers((list) =>
                    list.map((x, j) => (j === i ? { name: e.target.value, role: x.role, ...(x.safeRole ? { safeRole: x.safeRole } : {}) } : x))
                  )
                }
              />
              <select
                aria-label={`Member ${i + 1} role`}
                value={memberRole(m)}
                disabled={readOnly}
                onChange={(e) => updateMembers((list) => list.map((x, j) => (j === i ? withRole(x, e.target.value as SafeRole) : x)))}
              >
                {SAFE_ROLES.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
              {memberRole(m) === "other" && (
                // "Other" keeps a custom label (and older free-text roles that match no SAFe role).
                <input
                  aria-label={`Member ${i + 1} custom role`}
                  placeholder="Role name"
                  maxLength={MAX_ROLE_LENGTH}
                  value={m.role}
                  disabled={readOnly}
                  onChange={(e) =>
                    updateMembers((list) => list.map((x, j) => (j === i ? withRole(x, "other", e.target.value.slice(0, MAX_ROLE_LENGTH)) : x)))
                  }
                />
              )}
              {m.uniqueName && <span className="muted small member-identity">{m.uniqueName}</span>}
              {!readOnly && (
                <>
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
                    <Icon name="Cancel" className="small" />
                  </button>
                </>
              )}
            </div>
          ))}
          {!readOnly && (
            <div className="member-add">
              {node.teamId && (
                <select
                  aria-label={`Add a team member to ${node.name}`}
                  value=""
                  disabled={full || teamMembers.loading}
                  onChange={(e) => addIdentity(e.target.value)}
                >
                  <option value="">
                    {teamMembers.loading ? "Loading team members…" : pickable.length ? "Add from the team…" : "(no more team members)"}
                  </option>
                  {pickable.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.displayName} ({t.uniqueName})
                    </option>
                  ))}
                </select>
              )}
              <button className="link small" disabled={full} onClick={() => updateMembers((list) => [...list, { name: "", role: "" }])}>
                <Icon name="Add" className="small" /> Add member
              </button>
              {full && <span className="muted small"> A node can have at most {MAX_MEMBERS} members.</span>}
              {teamMembers.error && <span className="danger small"> Could not load team members: {teamMembers.error}</span>}
            </div>
          )}
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
