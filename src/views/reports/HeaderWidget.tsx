import { LEVEL_COLOR } from "../../api/org";
import { currentIteration } from "../../api/reports";
import { LEVEL_LABEL } from "../../api/types";
import { fmtDate } from "../../components/common";
import { useSafe } from "../../components/context";

/** Unit name, layer, the PI and iteration running today, and the unit's members. */
export function HeaderWidget({ today }: { today: number }) {
  const { node, pis, openView } = useSafe();
  const { pi, sprint } = currentIteration(pis, today);
  const members = node.members ?? [];
  return (
    <section className="widget widget-wide report-header" aria-label="Unit">
      <div className="report-header-main">
        <h2>{node.name}</h2>
        <span className="report-level-badge" style={{ background: LEVEL_COLOR[node.level] }}>
          {LEVEL_LABEL[node.level]}
        </span>
      </div>
      <dl className="report-header-facts">
        <div>
          <dt>Current PI</dt>
          <dd>{pi ? `${pi.name} (${fmtDate(pi.start)} – ${fmtDate(pi.finish)})` : "None running"}</dd>
        </div>
        <div>
          <dt>Current iteration</dt>
          <dd>{sprint ? `${sprint.name} (${fmtDate(sprint.start)} – ${fmtDate(sprint.finish)})` : "None running"}</dd>
        </div>
      </dl>
      <div className="report-members" aria-label="Members">
        {members.length === 0 ? (
          <span className="muted small">
            No members.{" "}
            {openView && (
              <button className="link" onClick={() => openView("setup")}>
                Add members in Setup
              </button>
            )}
          </span>
        ) : (
          members.map((m, i) => (
            <span className="member-chip" key={`${m.name}-${i}`}>
              <span className="member-name">{m.name}</span>
              {m.role && <span className="member-role">{m.role}</span>}
            </span>
          ))
        )}
      </div>
    </section>
  );
}
