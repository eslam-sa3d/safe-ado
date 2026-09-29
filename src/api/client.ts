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

/** Calls `{collectionUrl}/{path}` with api-version 7.0 and the extension's access token. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const base = await getBaseUrl();
  const sep = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${sep}api-version=${API_VERSION}`;
  const token = await SDK.getAccessToken();

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": options.contentType ?? "application/json",
      "X-TFS-FedAuthRedirect": "Suppress",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

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
