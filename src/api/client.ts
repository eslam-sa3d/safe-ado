import * as SDK from "azure-devops-extension-sdk";
import type { ILocationService } from "azure-devops-extension-api/Common/CommonServices";

/**
 * Host service ids. azure-devops-extension-api ships AMD modules, so we import only its
 * types and keep the handful of runtime ids here.
 */
export const ServiceIds = {
  location: "ms.vss-features.location-service",
  extensionData: "ms.vss-features.extension-data-service",
  hostNavigation: "ms.vss-features.host-navigation-service",
  workItemForm: "ms.vss-work-web.work-item-form-navigation-service",
} as const;

/**
 * Azure DevOps Server 2022.1 supports REST api-version up to 7.0, so every call is pinned
 * to 7.0. That version is also accepted by Azure DevOps Services, which keeps one code path
 * for cloud and on-prem. The typed clients in azure-devops-extension-api request newer
 * (often -preview) versions that Server 2022.1 rejects, so we use plain fetch instead.
 */
export const API_VERSION = "7.0";

// Resource area id of the Core service; resolves to the collection/organization URL on both hosts.
const CORE_AREA_ID = "79134c72-4a58-4b42-976c-04e7115f32bf";

let baseUrlPromise: Promise<string> | undefined;

export function getBaseUrl(): Promise<string> {
  if (!baseUrlPromise) {
    baseUrlPromise = (async () => {
      const loc = await SDK.getService<ILocationService>(ServiceIds.location);
      const url = await loc.getResourceAreaLocation(CORE_AREA_ID);
      return url.endsWith("/") ? url : url + "/";
    })();
  }
  return baseUrlPromise;
}

export function getProject(): { id: string; name: string } {
  const project = SDK.getWebContext().project;
  return { id: project.id, name: project.name };
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  contentType?: string;
}

/**
 * Retry policy for throttled requests. Azure DevOps answers 429 (and sometimes 503) with a
 * Retry-After header when a user exceeds their TSTU budget; we honour it, else back off.
 */
export const retryPolicy = { retries: 3, baseDelayMs: 1000, maxDelayMs: 30000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelay(response: Response, attempt: number): number {
  const header = Number(response.headers.get("Retry-After"));
  const ms = Number.isFinite(header) && header >= 0 && response.headers.has("Retry-After") ? header * 1000 : retryPolicy.baseDelayMs * 2 ** attempt;
  return Math.min(ms, retryPolicy.maxDelayMs);
}

/** Calls `{collectionUrl}/{path}` with api-version 7.0 and the extension's access token. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const base = await getBaseUrl();
  const sep = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${sep}api-version=${API_VERSION}`;

  let response: Response;
  for (let attempt = 0; ; attempt++) {
    const token = await SDK.getAccessToken();
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": options.contentType ?? "application/json",
        "X-TFS-FedAuthRedirect": "Suppress",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    // 429 means the request was not processed, so any method may be retried. A 503 may come
    // after a write was applied, so only safe (GET) requests are retried on 503.
    const method = options.method ?? "GET";
    const throttled = response.status === 429 || (response.status === 503 && method === "GET");
    if (!throttled || attempt >= retryPolicy.retries) break;
    await sleep(retryDelay(response, attempt));
  }

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const err = await response.json();
      if (err?.message) message = err.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Escapes a value for use inside a single-quoted WIQL string literal. */
export function wiqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Runs `fn` over `items` with at most `limit` calls in flight, preserving result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
