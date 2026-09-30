import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { ReportsView } from "../../../src/views/ReportsView";
import { dataStore, fake, localDate } from "../../fakeAdo";
import { renderView } from "../../utils";

const DAY = 86_400_000;

/** YYYY-MM-DD, `offset` days from now (UTC), matching the fake's relative iteration dates. */
export const isoDay = (offset: number) => localDate(Date.now() + offset * DAY);

/** Seeds any extension-data collection (milestones, capacity, wimeta, objectives, risks). */
export function seed(name: string, docs: Record<string, unknown>[]) {
  dataStore.collections.set(`${name}-${fake.projectId}`, new Map(docs.map((d) => [String(d.id), { ...d, __etag: 1 }])));
}

export function userValue(key: string) {
  return dataStore.values.get(`${key}-${fake.projectId}`);
}

export async function renderReports(opts: Parameters<typeof renderView>[1] = {}) {
  const r = await renderView(<ReportsView />, opts);
  await waitFor(() => expect(document.querySelectorAll(".spinner")).toHaveLength(0));
  return r;
}

export const widget = (title: string) => screen.getByRole("region", { name: title });
export const widgetTitles = () => screen.queryAllByRole("region").map((r) => r.getAttribute("aria-label"));

export function objective(id: string, nodeId: string, committed: boolean, plannedBV: number, actualBV: number | null, piPath: string) {
  return { id, nodeId, committed, plannedBV, actualBV, piPath, title: id, featureIds: [] };
}
