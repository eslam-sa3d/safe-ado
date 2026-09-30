import { loadVsCapacity } from "../../api/reports";
import { useSafe } from "../../components/context";
import { piCapacity, ReportData } from "./data";
import { Ratio, SelectPi, SnapshotNote, Warning, Widget } from "./Widget";

/** Load vs. Capacity: planned SP in the PI ÷ capacity of the subtree's teams over the PI's iterations. */
export function LoadCapacityWidget({ data }: { data: ReportData }) {
  const { node, pi } = useSafe();
  if (!pi)
    return (
      <Widget title="Load vs. Capacity">
        <SelectPi />
      </Widget>
    );
  const lc = data.snapshot?.load ?? loadVsCapacity(data.piStories, piCapacity(data.capacity, node, pi));
  const tone = lc.pct === null ? undefined : lc.pct > 100 ? "bad" : lc.pct >= 80 ? "good" : "warn";
  return (
    <Widget title="Load vs. Capacity">
      <Ratio pct={lc.pct} tone={tone} caption={lc.capacity > 0 ? `${lc.load} SP of ${lc.capacity} SP capacity` : `${lc.load} SP · no capacity set`}>
        {lc.unestimated > 0 && <Warning>{lc.unestimated} unestimated {lc.unestimated === 1 ? "story" : "stories"}</Warning>}
        {data.snapshot && <SnapshotNote createdAt={data.snapshot.createdAt} />}
      </Ratio>
    </Widget>
  );
}
