import { useContext } from "react";
import { ALL_ALLOWED, Capabilities } from "../api/permissions";
import { SafeContext } from "./context";

/** Capabilities from the shell, or "everything allowed" when rendered outside it (e.g. the form panel). */
export function useCanSafe(): Capabilities {
  return useContext(SafeContext)?.can ?? ALL_ALLOWED;
}
