import { flatten } from "../../api/org";
import { capacityTotal, loadVsCapacity } from "../../api/reports";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { Ratio, SelectPi, Warning, Widget } from "./Widget";

/** Load vs. Capacity: planned SP in the PI ÷ capacity of the subtree's teams over the PI's iterations. */
export function LoadCapacityWidget({ data }: { data: ReportData }) {
  const { node, pi } = useSafe();
  if (!pi)
    return (
      <Widget title="Load vs. Capacity">
        <SelectPi />
      </Widget>
    );
  const teams = new Set(flatten(node).filter((n) => n.level === "team").map((n) => n.id));
  const capacity = capacityTotal(data.capacity, teams, pi.sprints.map((s) => s.path));
  const lc = loadVsCapacity(data.piStories, capacity);
  const tone = lc.pct === null ? undefined : lc.pct > 100 ? "bad" : lc.pct >= 80 ? "good" : "warn";
  return (
    <Widget title="Load vs. Capacity">
      <Ratio pct={lc.pct} tone={tone} caption={capacity > 0 ? `${lc.load} SP of ${capacity} SP capacity` : `${lc.load} SP · no capacity set`}>
        {lc.unestimated > 0 && <Warning>{lc.unestimated} unestimated {lc.unestimated === 1 ? "story" : "stories"}</Warning>}
      </Ratio>
    </Widget>
  );
}
