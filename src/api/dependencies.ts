import { Criticality, LINK, WorkItem } from "./types";
import { relationTargetId } from "./wit";

/**
 * Dependency engine shared by the boards and reports, following Agile Hive's rules.
 * A dependency is provider -> consumer: the consumer (successor) needs the provider (predecessor).
 */
export interface Dependency {
  provider: number;
  consumer: number;
}

/** Extracts unique provider->consumer pairs from Successor and Predecessor links of `items`. */
export function dependenciesOf(items: WorkItem[]): Dependency[] {
  const seen = new Set<string>();
  const out: Dependency[] = [];
  const add = (provider: number, consumer: number) => {
    const key = `${provider}>${consumer}`;
    if (provider === consumer || seen.has(key)) return;
    seen.add(key);
    out.push({ provider, consumer });
  };
  for (const item of items) {
    for (const rel of item.relations ?? []) {
      const other = relationTargetId(rel.url);
      if (other === null) continue;
      if (rel.rel === LINK.successor) add(item.id, other);
      else if (rel.rel === LINK.predecessor) add(other, item.id);
    }
  }
  return out;
}

/**
 * Criticality by iteration index (Team / ART planning boards):
 * provider before consumer = healthy, same iteration = at risk, after = critical.
 * Unknown placement (-1) on either side is at risk. Done providers are resolved.
 */
export function criticalityByIteration(providerIndex: number, consumerIndex: number, providerDone = false): Criticality {
  if (providerDone) return "resolved";
  if (providerIndex < 0 || consumerIndex < 0) return "atRisk";
  if (providerIndex < consumerIndex) return "healthy";
  if (providerIndex === consumerIndex) return "atRisk";
  return "critical";
}

/**
 * Criticality by planned date ranges (Roadmap): provider ends before the consumer starts =
 * healthy, ends within the consumer's span = at risk, ends after the consumer ends = critical.
 */
export function criticalityByDates(
  provider: { end?: string },
  consumer: { start?: string; end?: string },
  providerDone = false
): Criticality {
  if (providerDone) return "resolved";
  if (!provider.end || !consumer.start || !consumer.end) return "atRisk";
  if (provider.end < consumer.start) return "healthy";
  if (provider.end <= consumer.end) return "atRisk";
  return "critical";
}

export const CRITICALITY_LABEL: Record<Criticality, string> = {
  healthy: "Healthy",
  atRisk: "At risk",
  critical: "Critical",
  resolved: "Resolved",
};

export const CRITICALITY_COLOR: Record<Criticality, string> = {
  healthy: "#339933",
  atRisk: "#d67f3c",
  critical: "#cd4a45",
  resolved: "#8a8886",
};

/** Index of the sprint containing `iterationPath` (UNDER semantics), or -1. */
export function sprintIndex(iterationPath: string | undefined, sprintPaths: string[]): number {
  if (!iterationPath) return -1;
  const p = iterationPath.toLowerCase();
  return sprintPaths.findIndex((s) => p === s.toLowerCase() || p.startsWith(s.toLowerCase() + "\\"));
}

/**
 * Agile Hive's calculated placement for ART-level items: the latest sprint of any planned
 * child; falls back to the item's own sprint. Returns -1 when nothing is planned.
 */
export function calculatedSprintIndex(ownIteration: string | undefined, childIterations: (string | undefined)[], sprintPaths: string[]): number {
  const childMax = Math.max(-1, ...childIterations.map((c) => sprintIndex(c, sprintPaths)));
  return childMax >= 0 ? childMax : sprintIndex(ownIteration, sprintPaths);
}
