import { LEVEL_COLOR } from "../../api/org";
import { currentIteration } from "../../api/reports";
import { LEVEL_LABEL, Member } from "../../api/types";
import { fmtDate, LevelPill } from "../../components/common";
import { useSafe } from "../../components/context";

/** Up to two initials of a display name ("Ada Lovelace" -> "AL"). */
export function initials(name: string): string {
  const words = name.replace(/<[^>]*>/g, "").trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/**
 * Contact link for an identity. Azure DevOps has no linkable profile page for other users, so
 * e-mail style unique names (Entra ID / Microsoft accounts) open a mail; domain accounts
 * (DOMAIN\user on Server) have no link.
 */
export function profileUrl(uniqueName?: string): string | undefined {
  return uniqueName && /^[^\s@\\]+@[^\s@]+$/.test(uniqueName) ? `mailto:${uniqueName}` : undefined;
}

function Avatar({ member }: { member: Member }) {
  return member.imageUrl ? (
    <img className="member-avatar" src={member.imageUrl} alt="" aria-hidden="true" />
  ) : (
    <span className="member-avatar member-initials" aria-hidden="true">
      {initials(member.name)}
    </span>
  );
}

/** Unit name, layer, the PI and iteration running today, and the unit's members. */
export function HeaderWidget({ today }: { today: number }) {
  const { node, pis, openView } = useSafe();
  const { pi, sprint } = currentIteration(pis, today);
  const members = node.members ?? [];
  return (
    <section className="widget widget-wide report-header" aria-label="Unit">
      <div className="report-header-main">
        <h2>{node.name}</h2>
        <LevelPill level={node.level} className="report-level-badge" />
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
              <Avatar member={m} />
              {profileUrl(m.uniqueName) ? (
                <a className="member-name" href={profileUrl(m.uniqueName)} target="_blank" rel="noopener noreferrer" title={m.uniqueName}>
                  {m.name}
                </a>
              ) : (
                <span className="member-name" title={m.uniqueName}>
                  {m.name}
                </span>
              )}
              {m.role && <span className="member-role">{m.role}</span>}
            </span>
          ))
        )}
      </div>
    </section>
  );
}
