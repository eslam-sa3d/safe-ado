import { render, screen, waitFor } from "@testing-library/react";
import { ReactElement, useState } from "react";
import { vi } from "vitest";
import { findNode } from "../src/api/org";
import { ProgramIncrement, SafeConfig } from "../src/api/types";
import { getProgramIncrements } from "../src/api/wit";
import { App } from "../src/components/App";
import { SafeContext, SafeContextValue } from "../src/components/context";
import { fake, makeConfig, seedConfig } from "./fakeAdo";

export const PREFS_KEY = () => `safe-ado-prefs-${fake.projectId}`;

/** Renders the whole hub with a saved config, starting on the given node/view. */
export async function renderApp(opts: { nodeId?: string; view?: string; piPath?: string; config?: SafeConfig | null } = {}) {
  if (opts.config !== null) seedConfig(opts.config ?? makeConfig());
  fake.hash = ""; // no deep link unless a test sets one
  localStorage.setItem(PREFS_KEY(), JSON.stringify({ nodeId: opts.nodeId ?? "", view: opts.view ?? "board", piPath: opts.piPath ?? "" }));
  const result = render(<App />);
  await waitFor(() => expect(screen.queryByText(/Loading SAFe configuration/)).not.toBeInTheDocument());
  return result;
}

/**
 * Renders a single view with an explicit context (no App shell). Like the App, saving the
 * config updates the context; `ctx.saveConfig` is a spy for assertions.
 */
export async function renderView(
  ui: ReactElement,
  opts: { nodeId?: string; config?: SafeConfig; pi?: ProgramIncrement | null; pis?: ProgramIncrement[] } = {}
) {
  const initial = opts.config ?? makeConfig();
  const pis = opts.pis ?? (await getProgramIncrements(initial.piRootIteration));
  const ctx = {
    saveConfig: vi.fn(async (_c: SafeConfig) => undefined),
    selectNode: vi.fn(),
    reloadPis: vi.fn(),
    pis,
  };

  function Harness() {
    const [config, setConfig] = useState(initial);
    const value: SafeContextValue = {
      config,
      saveConfig: async (next) => {
        await ctx.saveConfig(next);
        setConfig(next);
      },
      node: findNode(config.root, opts.nodeId ?? "n-arta") ?? config.root,
      selectNode: ctx.selectNode,
      pis,
      pi: opts.pi === null ? undefined : opts.pi ?? pis.find((p) => p.name === "PI 2"),
      reloadPis: ctx.reloadPis,
    };
    return <SafeContext.Provider value={value}>{ui}</SafeContext.Provider>;
  }

  const result = render(<Harness />);
  return { ...result, ctx };
}

/** DataTransfer stand-in for HTML5 drag-and-drop events in jsdom. */
export function dataTransfer(payload = "") {
  const store: Record<string, string> = { "text/plain": payload };
  return {
    setData: vi.fn((k: string, v: string) => (store[k] = v)),
    getData: vi.fn((k: string) => store[k] ?? ""),
  };
}
