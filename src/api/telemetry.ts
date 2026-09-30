import * as SDK from "azure-devops-extension-sdk";

/**
 * Opt-in, anonymous usage telemetry. See docs/PRIVACY.md for exactly what is sent.
 *
 * Nothing is sent unless BOTH are true:
 *  1. the build set an endpoint (SAFE_ADO_TELEMETRY_URL at build time; empty by default, so the
 *     published default build sends nothing), and
 *  2. a project administrator switched on "Share anonymous usage data" in Setup
 *     (`SafeConfig.telemetryOptIn`).
 *
 * An event carries only: a fixed event name, the extension version and a salted SHA-256 hash of
 * the collection / organization id. Never titles, names, e-mails, ids of work items, area or
 * iteration paths, or any other planning data. `track` never throws and never blocks the UI.
 */

// Replaced at build time by webpack's DefinePlugin; undefined in tests and unconfigured builds.
declare const __SAFE_ADO_TELEMETRY_URL__: string | undefined;
declare const __SAFE_ADO_VERSION__: string | undefined;

/** Event names. Only these (optionally suffixed with a view id) can be sent. */
export const TelemetryEvents = {
  viewOpened: "view_opened",
  piCreated: "pi_created",
  boardReplanned: "board_replanned",
  objectiveCreated: "objective_created",
  riskCreated: "risk_created",
  configSaved: "config_saved",
} as const;
export type TelemetryEventName = (typeof TelemetryEvents)[keyof typeof TelemetryEvents];

const KNOWN = new Set<string>(Object.values(TelemetryEvents));
/** Detail is limited to a short lowercase identifier (a view id such as "reports"), never free text. */
const DETAIL = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Fixed salt. The hash is a stable pseudonym per collection, so installs can be counted, and it
 * does not match a plain SHA-256 of the id that some other system might log.
 */
export const TELEMETRY_SALT = "safe-ado-telemetry-v1";

export interface TelemetryPayload {
  /** Payload schema version. */
  schema: 1;
  /** Event name, e.g. "view_opened" or "view_opened.reports". */
  event: string;
  /** Extension version, e.g. "1.3.0". */
  version: string;
  /** First 32 hex characters of SHA-256(salt + collection id). */
  collection: string;
}

const state = {
  endpoint: typeof __SAFE_ADO_TELEMETRY_URL__ === "string" ? __SAFE_ADO_TELEMETRY_URL__ : "",
  version: typeof __SAFE_ADO_VERSION__ === "string" ? __SAFE_ADO_VERSION__ : "dev",
  optIn: false,
  collectionHash: undefined as Promise<string> | undefined,
};

/** Test / build hook: override the endpoint and version (the default comes from the build). */
export function setTelemetryBuild(opts: { endpoint?: string; version?: string }): void {
  if (opts.endpoint !== undefined) state.endpoint = opts.endpoint;
  if (opts.version !== undefined) state.version = opts.version;
  state.collectionHash = undefined;
}

/** Called by the App whenever the configuration loads or changes. */
export function setTelemetryOptIn(optIn: boolean | undefined): void {
  state.optIn = optIn === true;
}

/** Whether this build has an endpoint at all (Setup shows the toggle's effect accordingly). */
export function telemetryAvailable(): boolean {
  return /^https:\/\/[^\s]+$/i.test(state.endpoint);
}

/** Whether events are currently being sent. */
export function telemetryEnabled(): boolean {
  return state.optIn && telemetryAvailable();
}

/** Salted SHA-256 of an id, as hex (first 32 characters). */
export async function hashId(id: string, salt: string = TELEMETRY_SALT): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return "unavailable";
  const bytes = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${id}`)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function collectionId(): string {
  try {
    const host = (SDK as unknown as { getHost?: () => { id?: string } }).getHost?.();
    return host?.id || "unknown";
  } catch {
    return "unknown";
  }
}

/** Builds the payload, or undefined when the event name / detail is not allowed. */
export async function buildPayload(event: TelemetryEventName, detail?: string): Promise<TelemetryPayload | undefined> {
  if (!KNOWN.has(event)) return undefined;
  if (detail !== undefined && !DETAIL.test(detail)) return undefined;
  state.collectionHash ??= hashId(collectionId());
  return { schema: 1, event: detail ? `${event}.${detail}` : event, version: state.version, collection: await state.collectionHash };
}

function send(url: string, body: string): void {
  try {
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    if (nav && typeof nav.sendBeacon === "function" && nav.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return;
  } catch {
    /* fall back to fetch */
  }
  try {
    void Promise.resolve(
      fetch(url, { method: "POST", body, keepalive: true, mode: "no-cors", credentials: "omit", headers: { "Content-Type": "text/plain" } })
    ).catch(() => undefined);
  } catch {
    /* never throw */
  }
}

/**
 * Records an anonymous usage event (fire-and-forget). A no-op unless telemetry is enabled.
 * Returns the promise only so tests can await it; callers should ignore it.
 */
export function track(event: TelemetryEventName, detail?: string): Promise<void> {
  if (!telemetryEnabled()) return Promise.resolve();
  const url = state.endpoint;
  return buildPayload(event, detail)
    .then((payload) => {
      if (payload && telemetryEnabled()) send(url, JSON.stringify(payload));
    })
    .catch(() => undefined);
}
