import { useEffect, useRef, useState } from "react";
import { queryUrl, teamBacklogUrl } from "../api/links";
import { boardType, scopeAreas } from "../api/org";
import { scopeQuery } from "../api/queries";
import { openInNewTab } from "../api/urlState";
import { F, OrgNode, ProgramIncrement, SafeConfig } from "../api/types";
import { getTeams, openNewWorkItem } from "../api/wit";
import { Icon } from "./common";

/** Where "Open in Azure Boards" goes: a team's backlog, else a query of the unit's board items. */
export async function boardsUrl(config: SafeConfig, node: OrgNode): Promise<string> {
  if (node.teamId) {
    const team = (await getTeams().catch(() => [])).find((t) => t.id === node.teamId);
    return teamBacklogUrl(team?.name ?? node.name);
  }
  const type = boardType(config, node.level) || config.types.story;
  return queryUrl(scopeQuery([type], scopeAreas(node)));
}

export function OpenInBoardsButton({ config, node }: { config: SafeConfig; node: OrgNode }) {
  const [error, setError] = useState<string>();
  const unavailable = !node.teamId && scopeAreas(node).length === 0;
  return (
    <button
      className="btn subtle"
      disabled={unavailable}
      title={error ?? (node.teamId ? "Open the team backlog in Azure Boards" : "Open this unit's work items as an Azure Boards query")}
      onClick={() =>
        boardsUrl(config, node)
          .then(openInNewTab)
          .then(() => setError(undefined))
          .catch((e) => setError(`Could not open Azure Boards: ${e?.message ?? e}`))
      }
    >
      <Icon name="OpenInNewTab" /> Open in Azure Boards
    </button>
  );
}

/** Whether a key event comes from somewhere that takes text (then shortcuts must not fire). */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable || el.getAttribute?.("contenteditable") === "true";
}

/** Fields for a new work item created from the shortcut: the unit's area, and the PI below portfolio level. */
export function newItemFields(node: OrgNode, pi: ProgramIncrement | undefined): Record<string, string> {
  const fields: Record<string, string> = {};
  const area = node.areaPath ?? scopeAreas(node)[0];
  if (area) fields[F.area] = area;
  if (node.level !== "portfolio" && pi) fields[F.iteration] = pi.path;
  return fields;
}

/** Keyboard shortcut "C": new work item of the unit's board type in the unit's area (and current PI). */
export function useNewItemShortcut(opts: { config: SafeConfig; node: OrgNode; pi?: ProgramIncrement; enabled: boolean }) {
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { config, node, pi, enabled } = latest.current;
      if (!enabled || e.key.toLowerCase() !== "c" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTyping(e.target) || document.querySelector(".modal-backdrop")) return;
      const type = boardType(config, node.level) || config.types.story;
      if (!type) return;
      e.preventDefault();
      void openNewWorkItem(type, newItemFields(node, pi)).catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
