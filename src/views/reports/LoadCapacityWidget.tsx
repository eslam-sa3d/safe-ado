import { capacitySettings, totalOrigin } from "../../api/capacity";
import { loadVsCapacity } from "../../api/reports";
import { CapacityBadge } from "../../components/CapacityBadge";
import { useSafe } from "../../components/context";
import { piCapacity, ReportData } from "./data";
import { Ratio, SelectPi, SnapshotInfo, Warning, Widget } from "./Widget";

/** Load vs. Capacity: planned SP in the PI ÷ capacity of the subtree's teams over the PI's iterations. */
export function LoadCapacityWidget({ data }: { data: ReportData }) {
  const { config, node, pi } = useSafe();
  if (!pi)
    return (
      <Widget title="Load vs. Capacity">
        <SelectPi />
      </Widget>
    );
  const total = piCapacity(config, data.capacity, data.derived, node, pi);
  const lc = data.snapshot?.load ?? loadVsCapacity(data.piStories, total.value);
  // The source marker describes the live value; a snapshot keeps the number recorded at PI end.
  const showSource = !data.snapshot && capacitySettings(config).source !== "manual";
  const tone = lc.pct === null ? undefined : lc.pct > 100 ? "bad" : lc.pct >= 80 ? "good" : "warn";
  return (
    <Widget title="Load vs. Capacity">
      <Ratio pct={lc.pct} tone={tone} caption={lc.capacity > 0 ? `${lc.load} SP of ${lc.capacity} SP capacity` : `${lc.load} SP · no capacity set`}>
        {showSource && (
          <div className="small muted cap-summary">
            Capacity <CapacityBadge origin={totalOrigin(total)} explanation={total.explanation} />
            {total.missing > 0 && ` · ${total.missing} of ${total.count} team iterations not set`}
          </div>
        )}
        {lc.unestimated > 0 && <Warning>{lc.unestimated} unestimated {lc.unestimated === 1 ? "story" : "stories"}</Warning>}
        <SnapshotInfo snapshot={data.snapshot} missing={data.snapshotMissing} />
      </Ratio>
    </Widget>
  );
}
