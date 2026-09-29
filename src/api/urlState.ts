import * as SDK from "azure-devops-extension-sdk";
import type { IHostNavigationService } from "azure-devops-extension-api/Common/CommonServices";
import { ServiceIds } from "./client";

/**
 * Deep links: the selected unit, view and PI live in the host page's URL hash
 * (#node=...&view=...&pi=<iteration id>), so a view can be bookmarked and shared.
 */
export interface UrlState {
  node?: string;
  view?: string;
  pi?: string;
}

export function parseHash(hash: string): UrlState {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const out: UrlState = {};
  for (const k of ["node", "view", "pi"] as const) {
    const v = params.get(k);
    if (v) out[k] = v;
  }
  return out;
}

export function formatHash(state: UrlState): string {
  const params = new URLSearchParams();
  for (const k of ["node", "view", "pi"] as const) if (state[k]) params.set(k, state[k]!);
  return params.toString();
}

async function nav(): Promise<IHostNavigationService | undefined> {
  try {
    return await SDK.getService<IHostNavigationService>(ServiceIds.hostNavigation);
  } catch {
    return undefined;
  }
}

export async function readUrlState(): Promise<UrlState> {
  try {
    return parseHash((await (await nav())?.getHash()) ?? "");
  } catch {
    return {};
  }
}

export async function writeUrlState(state: UrlState): Promise<void> {
  try {
    (await nav())?.replaceHash(formatHash(state));
  } catch {
    /* host without navigation service */
  }
}

/** Opens a URL in a new browser tab through the host (the extension iframe can't open windows itself). */
export async function openInNewTab(url: string): Promise<void> {
  const service = await nav();
  if (service) service.openNewWindow(url, "");
  else window.open(url, "_blank", "noopener");
}
