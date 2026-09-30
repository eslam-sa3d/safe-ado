import { createContext, useContext } from "react";
import { ALL_ALLOWED, Capabilities, dataCapabilities } from "../api/permissions";
import { OrgNode, ProgramIncrement, SafeConfig } from "../api/types";

export interface SafeContextValue {
  config: SafeConfig;
  saveConfig: (config: SafeConfig) => Promise<void>;
  node: OrgNode;
  selectNode: (id: string) => void;
  pis: ProgramIncrement[];
  pi: ProgramIncrement | undefined;
  reloadPis: () => void;
  /** Switches the shell to another view (e.g. "setup"). Absent outside the hub shell. */
  openView?: (view: string) => void;
  /** PI root iteration of the selected unit's cadence (its own, an ancestor's or the project's). */
  piRoot?: string;
  /** What the current user may change; views go read-only when a capability is missing. */
  can?: Capabilities;
  /** Runs the permission checks again (after one could not be answered). Absent outside the shell. */
  recheckPermissions?: () => void;
}

/** Capabilities with the "everything allowed" default used outside the shell (tests, previews). */
export function useCan(): Capabilities {
  return useSafe().can ?? ALL_ALLOWED;
}

/**
 * Capabilities for writes that go only to the Extension Data Service (objectives, risks,
 * milestones, capacity, votes, reviews, config): an unverified permission means read-only.
 */
export function useDataCan(): Capabilities {
  return dataCapabilities(useCan());
}

export const SafeContext = createContext<SafeContextValue | null>(null);

export function useSafe(): SafeContextValue {
  const ctx = useContext(SafeContext);
  if (!ctx) throw new Error("SafeContext missing");
  return ctx;
}
