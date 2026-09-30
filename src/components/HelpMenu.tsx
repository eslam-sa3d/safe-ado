import * as SDK from "azure-devops-extension-sdk";
import { useEffect, useRef, useState } from "react";
import { getBaseUrl, getProject } from "../api/client";
import { openInNewTab } from "../api/urlState";
import { Icon } from "./common";

export const REPO_URL = "https://github.com/eslam-sa3d/safe-ado";
export const DOCS_URL = `${REPO_URL}#readme`;
export const RELEASES_URL = `${REPO_URL}/releases`;

/** The installed extension version (from the manifest), or "dev" outside a published package. */
export function extensionVersion(): string {
  try {
    return (SDK.getExtensionContext() as { version?: string }).version || "dev";
  } catch {
    return "dev";
  }
}

/**
 * "Report an issue" link with a prefilled body. Only technical context goes in: version,
 * the host origin (organization / server) and the project id — no names or e-mail addresses.
 */
export async function issueUrl(version: string = extensionVersion()): Promise<string> {
  let origin = "unknown";
  try {
    origin = new URL(await getBaseUrl()).origin;
  } catch {
    /* location service unavailable */
  }
  const body = [
    "**What happened?**",
    "",
    "**What did you expect?**",
    "",
    "**Steps to reproduce**",
    "1. ",
    "",
    "---",
    `SAFe Ado version: ${version}`,
    `Host: ${origin}`,
    `Project id: ${getProject().id}`,
  ].join("\n");
  return `${REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}

/** Header help menu: docs, release notes, issue reporting, version, shortcuts and the tour. */
export function HelpMenu({ onRestartTour }: { onRestartTour: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const version = extensionVersion();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const go = (url: string | Promise<string>) => {
    setOpen(false);
    void Promise.resolve(url).then(openInNewTab).catch(() => undefined);
  };

  return (
    <div className="help-wrap" ref={wrap}>
      <button className="btn subtle" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Help">
        <Icon name="Lightbulb" /> Help
      </button>
      {open && (
        <div className="help-menu" role="menu" aria-label="Help">
          <button role="menuitem" onClick={() => go(DOCS_URL)}>
            <Icon name="OpenInNewTab" /> Documentation
          </button>
          <button role="menuitem" onClick={() => go(RELEASES_URL)}>
            <Icon name="Rocket" /> What's new
          </button>
          <button role="menuitem" onClick={() => go(issueUrl(version))}>
            <Icon name="Flag" /> Report an issue
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onRestartTour();
            }}
          >
            <Icon name="Lightbulb" /> Restart tour
          </button>
          <div className="help-sep" role="separator" />
          <div className="help-note" role="note">
            <span>New work item</span> <kbd>C</kbd>
          </div>
          <div className="help-note muted" role="note">
            Version {version}
          </div>
        </div>
      )}
    </div>
  );
}
