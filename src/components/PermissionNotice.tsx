import { CapabilityKey } from "../api/permissions";
import { Icon } from "./common";
import { useCan, useSafe } from "./context";

/**
 * Shown when a permission check could not be answered. SAFe Ado's own data has no server-side
 * protection, so it stays read-only until the check succeeds (fail closed); work item edits are
 * still checked by Azure DevOps itself.
 */
export function PermissionNotice({ needs }: { needs: CapabilityKey }) {
  const { recheckPermissions } = useSafe();
  const unverified = useCan().unverified ?? [];
  if (!unverified.includes(needs)) return null;
  return (
    <div className="msg msg-warning permission-notice" role="status">
      <span>
        Your permissions could not be verified, so this is read-only for now. Azure DevOps cannot protect SAFe Ado's own data
        (objectives, risks, milestones, capacity, votes, reviews, settings) on the server, so SAFe Ado only allows changes it has
        confirmed you may make.
      </span>
      {recheckPermissions && (
        <button className="btn" onClick={recheckPermissions}>
          <Icon name="Refresh" /> Retry
        </button>
      )}
    </div>
  );
}
