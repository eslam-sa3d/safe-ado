import { CapacityOrigin, EffectiveCapacity, ORIGIN_LABEL } from "../api/capacity";
import { openInNewTab } from "../api/urlState";

/**
 * Small marker next to a capacity value saying where it comes from (manual / derived /
 * override / mixed / not set); the tooltip explains the calculation.
 */
export function CapacityBadge({ origin, explanation }: { origin: CapacityOrigin | "mixed"; explanation: string }) {
  const label = origin === "mixed" ? "mixed" : ORIGIN_LABEL[origin];
  return (
    <span className={`pill cap-src cap-src-${origin}`} title={explanation} aria-label={`Capacity source: ${label}. ${explanation}`} data-origin={origin}>
      {label}
    </span>
  );
}

/** "Set up in Azure DevOps" link to the team's capacity page, shown when a derived value is missing. */
export function CapacitySetupLink({ capacity }: { capacity: EffectiveCapacity }) {
  if (capacity.origin !== "none" || capacity.source === "manual" || !capacity.capacityUrl) return null;
  const url = capacity.capacityUrl;
  return (
    <button className="link small cap-setup" title={capacity.explanation} onClick={() => void openInNewTab(url)}>
      Set up capacity in Azure DevOps
    </button>
  );
}
