import { useState } from "react";
import { flatten } from "../api/org";
import { ProgramIncrement } from "../api/types";
import { addTeamIteration, createIteration } from "../api/wit";
import { ErrorBar, Field, fmtDate, Info } from "../components/common";
import { useSafe } from "../components/context";

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
    const isIp = withIp && i === total - 1;
    return { name: isIp ? `${piName} IP` : `${piName} Sprint ${i + 1}`, start: iso(s), finish: iso(f) };
  });
}

export function PiManagementView() {
  const { config, pis, reloadPis } = useSafe();
  const teams = flatten(config.root).filter((n) => n.teamId);

  const [name, setName] = useState(suggestName(pis));
  const [start, setStart] = useState(nextStart(pis));
  const [weeks, setWeeks] = useState(2);
  const [sprints, setSprints] = useState(4);
  const [withIp, setWithIp] = useState(true);
  const [subscribe, setSubscribe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  const plan = start && name ? planSprints(name, start, weeks, sprints, withIp) : [];

  const create = async () => {
    setBusy(true);
    setError(undefined);
    setLog([]);
    const out: string[] = [];
    const push = (m: string) => {
      out.push(m);
      setLog([...out]);
    };
    try {
      await createIteration(config.piRootIteration, name, plan[0].start, plan[plan.length - 1].finish);
      push(`Created PI iteration "${name}"`);
      const piPath = `${config.piRootIteration}\\${name}`;
      const created = [];
      for (const s of plan) {
        created.push(await createIteration(piPath, s.name, s.start, s.finish));
        push(`Created ${s.name} (${fmtDate(s.start)} – ${fmtDate(s.finish)})`);
      }
      // Teams get the sprints only; the PI node itself would otherwise show up as a sprint.
      if (subscribe) await subscribeTeams(teams, created.map((c) => c.identifier), push);
      reloadPis();
      setName(suggestName([...pis, { name } as ProgramIncrement]));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const subscribeExisting = async (pi: ProgramIncrement) => {
    setBusy(true);
    setError(undefined);
    const out: string[] = [];
    try {
      await subscribeTeams(teams, pi.sprints.map((s) => s.identifier), (m) => {
        out.push(m);
        setLog([...out]);
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="two-col">
      <section className="panel">
        <div className="panel-header">
          <h3>Program Increments</h3>
          <span className="muted small">
            under <code>{config.piRootIteration}</code>
          </span>
        </div>
        {pis.length === 0 ? (
          <p className="muted pad">No PIs yet. Create one on the right.</p>
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
            <tbody>
              {[...pis].reverse().map((p) => (
                <tr key={p.path}>
                  <td>
                    <strong>{p.name}</strong>
                  </td>
                  <td className="muted">{p.start ? `${fmtDate(p.start)} – ${fmtDate(p.finish)}` : "No dates"}</td>
                  <td className="small">{p.sprints.map((s) => s.name.replace(p.name + " ", "")).join(", ") || "—"}</td>
                  <td>
                    <button
                      className="link small"
                      disabled={busy || !teams.length}
                      onClick={() => subscribeExisting(p)}
                      title="Add this PI's iterations to every team in the hierarchy"
                    >
                      Assign to teams
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Create a PI</h3>
        </div>
        <div className="pad form">
          <div className="field-row">
            <Field label="PI name">
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Start date">
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
          </div>
          <div className="field-row">
            <Field label="Iteration length (weeks)">
              <input type="number" min={1} max={6} value={weeks} onChange={(e) => setWeeks(Number(e.target.value) || 2)} />
            </Field>
            <Field label="Development iterations">
              <input type="number" min={1} max={12} value={sprints} onChange={(e) => setSprints(Number(e.target.value) || 4)} />
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
            <table className="grid compact">
              <tbody>
                {plan.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td className="muted">
                      {fmtDate(s.start)} – {fmtDate(s.finish)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button
            className="btn primary"
            disabled={busy || !name.trim() || !start || pis.some((p) => p.name === name)}
            onClick={create}
          >
            {busy ? "Working…" : "Create PI"}
          </button>
          {pis.some((p) => p.name === name) && <p className="danger small">A PI with this name already exists.</p>}
          <ErrorBar message={error} />
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
  const d = last ? new Date(new Date(last).getTime() + DAY) : new Date();
  return d.toISOString().slice(0, 10);
}
