import { createContext, useContext } from "react";
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
}

export const SafeContext = createContext<SafeContextValue | null>(null);

export function useSafe(): SafeContextValue {
  const ctx = useContext(SafeContext);
  if (!ctx) throw new Error("SafeContext missing");
  return ctx;
}
