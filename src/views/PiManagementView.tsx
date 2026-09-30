import { useEffect, useState } from "react";
import { flatten, pathTo } from "../api/org";
import { localToday } from "../api/rules";
import {
  addDays,
  dayOf,
  isIp,
  MAX_ITERATIONS,
  nameError,
  overlaps,
  piStatus,
  PiStatus,
  PlannedIteration,
  toIso,
  validateIteration,
  validatePi,
  validatePlan,
} from "../api/piRules";
import { localToday } from "../api/rules";
import { OrgNode, ProgramIncrement, Sprint } from "../api/types";
import {
  addTeamIteration,
  createIteration,
  deleteIteration,
  getIterationNodeId,
  getTeamIterations,
  removeTeamIteration,
  updateIteration,
} from "../api/wit";
import { ErrorBar, Field, fmtDate, Info, Spinner, useAsync } from "../components/common";
import { useCan, useSafe } from "../components/context";

const DAY = 86_400_000;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10) + "T00:00:00Z";
}

/** Builds the sprint schedule for a PI: N development iterations followed by an optional IP iteration. */
export function planSprints(piName: string, start: string, weeks: number, devSprints: number, withIp: boolean) {
  const first = new Date(start + "T00:00:00Z").getTime();
  const len = weeks * 7 * DAY;
  const total = devSprints + (withIp ? 1 : 0);
  return Array.from({ length: total }, (_, i) => {
    const s = new Date(first + i * len);
    const f = new Date(first + (i + 1) * len - DAY);
    const isIpSprint = withIp && i === total - 1;
    return { name: isIpSprint ? `${piName} IP` : `${piName} Sprint ${i + 1}`, start: iso(s), finish: iso(f) };
  });
}

const STATUS_LABEL: Record<PiStatus, string> = { planned: "Planned", current: "Current", completed: "Completed" };
const STATUS_ORDER: PiStatus[] = ["planned", "current", "completed"];

/** Iteration dates are calendar days: compare them with the user's local date, not UTC. */
const today = () => localToday();

export function PiManagementView() {
  const { config, pis, reloadPis, piRoot: cadenceRoot, node } = useSafe();
  const readOnly = !useCan().managePis;
  // PIs belong to the selected unit's cadence (its own, an ancestor's, or the project's).
  const piRoot = cadenceRoot ?? config.piRootIteration;
  const cadenceOwner = [...pathTo(config.root, node.id)].reverse().find((n) => n.piRootIteration);
  const cadenceLabel =
    cadenceOwner && cadenceOwner.piRootIteration === piRoot ? `PIs of ${cadenceOwner.name}'s cadence` : "PIs of the project cadence";
  const teams = flatten(config.root).filter((n) => n.teamId);

  const [name, setName] = useState(suggestName(pis));
  const [start, setStart] = useState(nextStart(pis));
  const [edited, setEdited] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // PIs load asynchronously; keep the suggestions in step with them until the user edits the form.
  useEffect(() => {
    if (edited) return;
    setName(suggestName(pis));
    setStart(nextStart(pis));
  }, [pis, edited]);
  const [weeks, setWeeks] = useState(2);
  const [sprints, setSprints] = useState(4);
  const [withIp, setWithIp] = useState(true);
  const [subscribe, setSubscribe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  // Hand-edited plan; it applies only while the settings it was made from are unchanged.
  const [custom, setCustom] = useState<{ key: string; rows: PlannedIteration[] }>();

  const generated = start && name ? planSprints(name, start, weeks, sprints, withIp) : [];
  const genKey = [name, start, weeks, sprints, withIp].join("|");
  const customized = custom?.key === genKey;
  const plan: PlannedIteration[] = customized
    ? custom!.rows
    : generated.map((g) => ({ name: g.name, start: dayOf(g.start), finish: dayOf(g.finish) }));
  const piRange = generated.length ? { start: dayOf(generated[0].start), finish: dayOf(generated[generated.length - 1].finish) } : undefined;
  const check = validatePlan(plan, { name, start: piRange?.start ?? "", finish: piRange?.finish ?? "" });
  const planInvalid = check.errors.length > 0 || check.rows.some((r) => r.length > 0);
  const invalidName = nameError(name);
  const duplicate = pis.some((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  const clash = piRange ? pis.find((p) => overlaps(piRange, p)) : undefined;
  const selected = pis.find((p) => p.path === selectedPath);
  const now = today();

  const editRow = (i: number, patch: Partial<PlannedIteration>) =>
    setCustom({ key: genKey, rows: plan.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  /** Removes a partially created PI (its iterations go with it) so a retry starts clean. */
  const rollback = async (piPath: string, failure: string, iterations: number, push: (m: string) => void) => {
    try {
      const reclassifyId = await getIterationNodeId(piRoot);
      if (reclassifyId === undefined) throw new Error(`Could not find the iteration ${piRoot}.`);
      await deleteIteration(piPath, reclassifyId);
      push(`Rolled back: removed the PI and ${iterations} created iteration${iterations === 1 ? "" : "s"}`);
      setError(`Could not create the PI: ${failure}. Nothing was left behind; fix the problem and try again.`);
    } catch (e: any) {
      setError(`Could not create the PI: ${failure}. Rolling back failed too (${e.message}); delete "${piPath}" manually.`);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(undefined);
    setLog([]);
    const out: string[] = [];
    const push = (m: string) => {
      out.push(m);
      setLog([...out]);
    };
    const piName = name.trim();
    const piPath = `${piRoot}\\${piName}`;
    let piCreated = false;
    const created: { identifier: string }[] = [];
    try {
      await createIteration(piRoot, piName, toIso(piRange!.start), toIso(piRange!.finish));
      piCreated = true;
      push(`Created PI iteration "${piName}"`);
      for (const r of plan) {
        const rowName = r.name.trim();
        created.push(await createIteration(piPath, rowName, r.start ? toIso(r.start) : undefined, r.finish ? toIso(r.finish) : undefined));
        push(r.start ? `Created ${rowName} (${fmtDate(r.start)} – ${fmtDate(r.finish)})` : `Created ${rowName}`);
      }
    } catch (e: any) {
      if (piCreated) {
        await rollback(piPath, e.message, created.length, push);
        reloadPis();
      } else setError(e.message);
      setBusy(false);
      return;
    }
    // Teams get the sprints only; the PI node itself would otherwise show up as a sprint.
    if (subscribe) await subscribeTeams(teams, created.map((c) => c.identifier), push);
    reloadPis();
    setCustom(undefined);
    setName(suggestName([...pis, { name: piName } as ProgramIncrement]));
    setBusy(false);
  };

  const subscribeExisting = async (pi: ProgramIncrement) => {
    setBusy(true);
    setError(undefined);
    const out: string[] = [];
    await subscribeTeams(teams, pi.sprints.map((s) => s.identifier), (m) => {
      out.push(m);
      setLog([...out]);
    });
    setBusy(false);
  };

  const groups = STATUS_ORDER.map((status) => ({
    status,
    pis: [...pis].reverse().filter((p) => piStatus(p, now) === status),
  })).filter((g) => g.pis.length > 0);

  return (
    <div className="pi-management">
      {readOnly && (
        <div className="msg msg-info readonly-banner" role="note">
          Read-only: you can view PIs and iterations, but changing them needs the “Create child nodes” permission on the iteration
          root.
        </div>
      )}
      <div className="two-col">
        <section className="panel">
          <div className="panel-header">
            <h3>Program Increments</h3>
            <span className="muted small pi-cadence">
              {cadenceLabel} · under <code>{piRoot}</code>
            </span>
          </div>
          {pis.length === 0 ? (
            <p className="muted pad">{readOnly ? "No PIs yet." : "No PIs yet. Create one on the right."}</p>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>PI</th>
                  <th>Dates</th>
                  <th>Iterations</th>
                  <th />
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.status} aria-label={`${STATUS_LABEL[g.status]} PIs`}>
                  <tr className="pi-group-row">
                    <th colSpan={4}>
                      <span className={`pi-status pi-status-${g.status}`}>{STATUS_LABEL[g.status]}</span>{" "}
                      <span className="muted small">({g.pis.length})</span>
                    </th>
                  </tr>
                  {g.pis.map((p) => (
                    <tr key={p.path} className={"pi-row" + (p.path === selectedPath ? " selected" : "")}>
                      <td>
                        <strong>{p.name}</strong>
                      </td>
                      <td className="muted">{p.start ? `${fmtDate(p.start)} – ${fmtDate(p.finish)}` : "No dates"}</td>
                      <td className="small">
                        {p.sprints.length
                          ? p.sprints.map((s, i) => (
                              <span key={s.path}>
                                {i > 0 && ", "}
                                <span className={isIp(s.name) ? "ip-iteration" : undefined} title={isIp(s.name) ? "Innovation & Planning iteration" : undefined}>
                                  {s.name.replace(p.name + " ", "")}
                                </span>
                              </span>
                            ))
                          : "—"}
                      </td>
                      <td className="actions">
                        <button className="link small" onClick={() => setSelectedPath(p.path === selectedPath ? null : p.path)}>
                          {p.path === selectedPath ? "Close" : readOnly ? "View" : "Manage"}
                        </button>
                        <button
                          className="link small"
                          disabled={busy || !teams.length || readOnly}
                          onClick={() => subscribeExisting(p)}
                          title="Add this PI's iterations to every team in the hierarchy"
                        >
                          Assign to teams
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>Create a PI</h3>
          </div>
          <fieldset className="pad form plain-fieldset" disabled={readOnly}>
            <div className="field-row">
              <Field label="PI name">
                <input
                  value={name}
                  onChange={(e) => {
                    setEdited(true);
                    setName(e.target.value);
                  }}
                />
              </Field>
              <Field label="Start date">
                <input
                  type="date"
                  value={start}
                  onChange={(e) => {
                    setEdited(true);
                    setStart(e.target.value);
                  }}
                />
              </Field>
            </div>
            <div className="field-row">
              <Field label="Iteration length (weeks)">
                <input type="number" min={1} max={6} value={weeks} onChange={(e) => setWeeks(Number(e.target.value) || 2)} />
              </Field>
              <Field label="Development iterations">
                <input
                  type="number"
                  min={1}
                  max={MAX_ITERATIONS}
                  value={sprints}
                  onChange={(e) => setSprints(Number(e.target.value) || 4)}
                />
              </Field>
            </div>
            <label className="check">
              <input type="checkbox" checked={withIp} onChange={(e) => setWithIp(e.target.checked)} /> Add Innovation &amp; Planning
              (IP) iteration
            </label>
            <label className="check">
              <input type="checkbox" checked={subscribe} onChange={(e) => setSubscribe(e.target.checked)} /> Assign iterations to{" "}
              {teams.length} mapped team{teams.length === 1 ? "" : "s"}
            </label>

            {plan.length > 0 && (
              <div className="pi-plan">
                <div className="pi-plan-header">
                  <span className="muted small">
                    PI {fmtDate(piRange!.start)} – {fmtDate(piRange!.finish)}. Adjust the planned iterations before creating.
                  </span>
                  <span className="spacer" />
                  {customized && (
                    <button type="button" className="link small" onClick={() => setCustom(undefined)}>
                      Reset plan
                    </button>
                  )}
                </div>
                <table className="grid compact pi-plan-table">
                  <tbody>
                    {plan.map((r, i) => (
                      <PlanRow key={i} index={i} row={r} errors={check.rows[i]} onChange={(patch) => editRow(i, patch)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div>
              <button
                className="btn primary"
                disabled={busy || !name.trim() || !start || !!invalidName || duplicate || planInvalid || !!clash}
                onClick={create}
              >
                {busy ? "Working…" : "Create PI"}
              </button>
            </div>
            {invalidName && <p className="danger small">{invalidName}</p>}
            {duplicate && <p className="danger small">A PI with this name already exists.</p>}
            {check.errors.map((e) => (
              <p key={e} className="danger small">
                {e}
              </p>
            ))}
            {clash && <p className="danger small">The dates overlap {clash.name}.</p>}
          </fieldset>
          <div className="pad-x pi-create-result">
            <ErrorBar message={error} onClose={() => setError(undefined)} />
            {log.length > 0 && (
              <Info>
                {log.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </Info>
            )}
          </div>
        </section>
      </div>

      {selected && (
        <PiDetails
          key={selected.path}
          pi={selected}
          pis={pis}
          teams={teams}
          piRoot={piRoot}
          readOnly={readOnly}
          onRenamed={(path) => setSelectedPath(path)}
          onDeleted={() => setSelectedPath(null)}
          reloadPis={reloadPis}
        />
      )}
    </div>
  );
}

/** One editable row of the create form's iteration plan. */
function PlanRow(props: { index: number; row: PlannedIteration; errors: string[]; onChange: (patch: Partial<PlannedIteration>) => void }) {
  const { row, errors, onChange } = props;
  const n = props.index + 1;
  return (
    <>
      <tr className={isIp(row.name) ? "ip-iteration-row" : undefined}>
        <td>
          <input aria-label={`Planned iteration ${n} name`} value={row.name} onChange={(e) => onChange({ name: e.target.value })} />
        </td>
        <td>
          <input aria-label={`Planned iteration ${n} start`} type="date" value={row.start} onChange={(e) => onChange({ start: e.target.value })} />
        </td>
        <td>
          <input aria-label={`Planned iteration ${n} finish`} type="date" value={row.finish} onChange={(e) => onChange({ finish: e.target.value })} />
        </td>
      </tr>
      {errors.length > 0 && (
        <tr>
          <td colSpan={3} className="danger small" data-plan-error={n}>
            {errors.join(" ")}
          </td>
        </tr>
      )}
    </>
  );
}

function PiDetails(props: {
  pi: ProgramIncrement;
  pis: ProgramIncrement[];
  teams: OrgNode[];
  piRoot: string;
  readOnly: boolean;
  onRenamed: (path: string) => void;
  onDeleted: () => void;
  reloadPis: () => void;
}) {
  const { pi, pis, readOnly } = props;
  const [values, setValues] = useState({ name: pi.name, start: dayOf(pi.start), finish: dayOf(pi.finish) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const errors = validatePi(values, pi, pis);
  const changed = values.name.trim() !== pi.name || values.start !== dayOf(pi.start) || values.finish !== dayOf(pi.finish);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const done = await fn();
      if (done) setMessage(done);
      props.reloadPis();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const savePi = () =>
    run(async () => {
      const name = values.name.trim();
      await updateIteration(pi.path, {
        name: name !== pi.name ? name : undefined,
        startDate: values.start ? toIso(values.start) : undefined,
        finishDate: values.finish ? toIso(values.finish) : undefined,
      });
      if (name !== pi.name) props.onRenamed(pi.path.replace(/[^\\]+$/, name));
      return `Updated ${name}`;
    });

  const deletePi = async () => {
    if (!window.confirm(`Delete ${pi.name} and its ${pi.sprints.length} iterations? Work items in them move to ${props.piRoot}.`)) return;
    await run(async () => {
      const reclassifyId = await getIterationNodeId(props.piRoot);
      if (reclassifyId === undefined) throw new Error(`Could not find the iteration ${props.piRoot}.`);
      await deleteIteration(pi.path, reclassifyId);
      props.onDeleted();
    });
  };

  return (
    <section className="panel pi-details" aria-label={`${pi.name} details`}>
      <div className="panel-header">
        <h3>{pi.name}</h3>
        <span className={`pi-status pi-status-${piStatus(pi, today())}`}>{STATUS_LABEL[piStatus(pi, today())]}</span>
        <span className="spacer" />
        {!readOnly && (
          <button className="btn danger" disabled={busy} onClick={deletePi}>
            Delete PI
          </button>
        )}
      </div>
      <div className="pad form">
        <fieldset className="plain-fieldset form" disabled={readOnly}>
          <div className="field-row">
            <Field label="Name">
              <input value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} />
            </Field>
            <Field label="Start">
              <input type="date" value={values.start} onChange={(e) => setValues({ ...values, start: e.target.value })} />
            </Field>
            <Field label="Finish">
              <input type="date" value={values.finish} onChange={(e) => setValues({ ...values, finish: e.target.value })} />
            </Field>
          </div>
          {changed &&
            errors.map((e) => (
              <p key={e} className="danger small">
                {e}
              </p>
            ))}
          {!readOnly && (
            <div>
              <button className="btn primary" disabled={busy || !changed || errors.length > 0} onClick={savePi}>
                Save PI
              </button>
            </div>
          )}
        </fieldset>
        <ErrorBar message={error} onClose={() => setError(undefined)} />
        {message && <Info>{message}</Info>}

        <h4>Iterations</h4>
        <table className="grid compact pi-iterations">
          <thead>
            <tr>
              <th>Iteration</th>
              <th>Start</th>
              <th>Finish</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pi.sprints.map((s) => (
              <IterationRow key={s.path} pi={pi} sprint={s} busy={busy} readOnly={readOnly} run={run} />
            ))}
          </tbody>
        </table>
        {!readOnly && <AddIteration pi={pi} busy={busy} run={run} />}
      </div>
      <SprintMapping pi={pi} teams={props.teams} readOnly={readOnly} />
    </section>
  );
}

type Run = (fn: () => Promise<string | void>) => Promise<void>;

function IterationRow(props: { pi: ProgramIncrement; sprint: Sprint; busy: boolean; readOnly: boolean; run: Run }) {
  const { pi, sprint, busy, run } = props;
  const initial = { name: sprint.name, start: dayOf(sprint.start), finish: dayOf(sprint.finish) };
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(initial);
  const errors = validateIteration(values, pi, sprint);
  const ip = isIp(sprint.name);

  const remove = async () => {
    if (!window.confirm(`Delete ${sprint.name}? Work items in it move to ${pi.name}.`)) return;
    await run(async () => {
      const reclassifyId = await getIterationNodeId(pi.path);
      if (reclassifyId === undefined) throw new Error(`Could not find the iteration ${pi.path}.`);
      await deleteIteration(sprint.path, reclassifyId);
      return `Deleted ${sprint.name}`;
    });
  };

  if (!editing) {
    return (
      <tr className={ip ? "ip-iteration-row" : undefined}>
        <td>
          {sprint.name} {ip && <span className="pill ip-badge">IP</span>}
        </td>
        <td className="muted">{sprint.start ? fmtDate(sprint.start) : "—"}</td>
        <td className="muted">{sprint.finish ? fmtDate(sprint.finish) : "—"}</td>
        <td className="actions">
          {!props.readOnly && (
            <>
              <button
                className="link small"
                aria-label={`Edit ${sprint.name}`}
                disabled={busy}
                onClick={() => {
                  setValues(initial);
                  setEditing(true);
                }}
              >
                Edit
              </button>{" "}
              <button className="link small danger" aria-label={`Delete ${sprint.name}`} disabled={busy} onClick={remove}>
                Delete
              </button>
            </>
          )}
        </td>
      </tr>
    );
  }
  const save = () =>
    run(async () => {
      const name = values.name.trim();
      await updateIteration(sprint.path, {
        name: name !== sprint.name ? name : undefined,
        startDate: values.start ? toIso(values.start) : undefined,
        finishDate: values.finish ? toIso(values.finish) : undefined,
      });
      setEditing(false);
      return `Updated ${name}`;
    });
  return (
    <>
      <tr>
        <td>
          <input aria-label="Iteration name" value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} />
        </td>
        <td>
          <input aria-label="Iteration start" type="date" value={values.start} onChange={(e) => setValues({ ...values, start: e.target.value })} />
        </td>
        <td>
          <input aria-label="Iteration finish" type="date" value={values.finish} onChange={(e) => setValues({ ...values, finish: e.target.value })} />
        </td>
        <td>
          <button className="link small" disabled={busy || errors.length > 0} onClick={save}>
            Save
          </button>{" "}
          <button className="link small" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </td>
      </tr>
      {errors.length > 0 && (
        <tr>
          <td colSpan={4} className="danger small">
            {errors.join(" ")}
          </td>
        </tr>
      )}
    </>
  );
}

function AddIteration({ pi, busy, run }: { pi: ProgramIncrement; busy: boolean; run: Run }) {
  const last = pi.sprints[pi.sprints.length - 1];
  const suggestedStart = last?.finish ? addDays(dayOf(last.finish), 1) : dayOf(pi.start);
  const [values, setValues] = useState({
    name: `${pi.name} Sprint ${pi.sprints.length + 1}`,
    start: suggestedStart,
    finish: suggestedStart ? addDays(suggestedStart, 13) : "",
  });
  const errors = validateIteration(values, pi, null);
  const full = pi.sprints.length >= MAX_ITERATIONS;

  const add = () =>
    run(async () => {
      const name = values.name.trim();
      await createIteration(pi.path, name, values.start ? toIso(values.start) : undefined, values.finish ? toIso(values.finish) : undefined);
      return `Added ${name}`;
    });

  return (
    <div className="add-iteration">
      <h4>Add iteration</h4>
      <div className="field-row">
        <Field label="New iteration name">
          <input value={values.name} disabled={full} onChange={(e) => setValues({ ...values, name: e.target.value })} />
        </Field>
        <Field label="New iteration start">
          <input type="date" value={values.start} disabled={full} onChange={(e) => setValues({ ...values, start: e.target.value })} />
        </Field>
        <Field label="New iteration finish">
          <input type="date" value={values.finish} disabled={full} onChange={(e) => setValues({ ...values, finish: e.target.value })} />
        </Field>
      </div>
      {errors.map((e) => (
        <p key={e} className="danger small">
          {e}
        </p>
      ))}
      <button className="btn" disabled={busy || errors.length > 0} onClick={add}>
        Add iteration
      </button>
    </div>
  );
}

/** Agile Hive sprint mapping: which of the PI's iterations a team is subscribed to. */
function SprintMapping({ pi, teams, readOnly }: { pi: ProgramIncrement; teams: OrgNode[]; readOnly: boolean }) {
  const [teamId, setTeamId] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const subscribed = useAsync(async () => {
    if (!teamId) return new Set<string>();
    const list = await getTeamIterations(teamId);
    const keys = new Set<string>();
    list.forEach((t) => {
      keys.add(t.id.toLowerCase());
      keys.add(t.path.toLowerCase());
    });
    return keys;
  }, [teamId]);
  const isSubscribed = (s: Sprint) => !!subscribed.data && (subscribed.data.has(s.identifier.toLowerCase()) || subscribed.data.has(s.path.toLowerCase()));

  const toggle = async (s: Sprint, on: boolean) => {
    setPending(s.path);
    setError(undefined);
    try {
      if (on) await addTeamIteration(teamId, s.identifier);
      else await removeTeamIteration(teamId, s.identifier);
      subscribed.reload(true);
    } catch (e: any) {
      setError(`Could not ${on ? "subscribe to" : "unsubscribe from"} ${s.name}: ${e.message}`);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="pad sprint-mapping">
      <h4>Sprint mapping</h4>
      {teams.length === 0 ? (
        <p className="muted small">Link hierarchy nodes to Azure DevOps teams in Setup to map sprints.</p>
      ) : (
        <>
          <Field label="Team">
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">(choose a team)</option>
              {teams.map((t) => (
                <option key={t.id} value={t.teamId}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <ErrorBar message={subscribed.error ?? error} onClose={() => setError(undefined)} />
          {teamId && subscribed.loading ? (
            <Spinner label="Loading team iterations…" />
          ) : teamId && subscribed.data ? (
            <ul className="sprint-map-list">
              {pi.sprints.map((s) => (
                <li key={s.path}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={isSubscribed(s)}
                      disabled={pending !== null || readOnly}
                      onChange={(e) => toggle(s, e.target.checked)}
                    />{" "}
                    {s.name}
                    {isIp(s.name) && <span className="pill ip-badge">IP</span>}
                  </label>
                </li>
              ))}
              {pi.sprints.length === 0 && <li className="muted small">This PI has no iterations.</li>}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

async function subscribeTeams(teams: { name: string; teamId?: string }[], iterationIds: string[], log: (m: string) => void) {
  for (const t of teams) {
    let ok = 0;
    let lastError = "";
    for (const id of iterationIds) {
      try {
        await addTeamIteration(t.teamId!, id);
        ok++;
      } catch (e: any) {
        // Usually the iteration is outside the team's backlog iteration, or already assigned.
        lastError = e.message;
      }
    }
    log(`${t.name}: assigned ${ok}/${iterationIds.length} iterations${lastError && ok < iterationIds.length ? ` (${lastError})` : ""}`);
  }
}

function suggestName(pis: { name: string }[]): string {
  const nums = pis.map((p) => /(\d+)\s*$/.exec(p.name)?.[1]).filter(Boolean).map(Number);
  return `PI ${nums.length ? Math.max(...nums) + 1 : 1}`;
}

function nextStart(pis: ProgramIncrement[]): string {
  const last = pis[pis.length - 1]?.finish;
  return last ? new Date(new Date(last).getTime() + DAY).toISOString().slice(0, 10) : localToday();
}
