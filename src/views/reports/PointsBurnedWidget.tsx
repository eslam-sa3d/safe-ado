import { pointsSummary } from "../../api/reports";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { Ratio, SelectPi, SnapshotInfo, Widget } from "./Widget";

/** Story Points Burned: done ÷ planned story points of the PI's team stories (from the PI snapshot when stored). */
export function PointsBurnedWidget({ data }: { data: ReportData }) {
  const { pi } = useSafe();
  const p = data.snapshot?.points ?? pointsSummary(data.piStories);
  return (
    <Widget title="Story Points Burned">
      {!pi ? (
        <SelectPi />
      ) : (
        <Ratio pct={p.pct} caption={`${p.done} of ${p.planned} SP done`}>
          <SnapshotInfo snapshot={data.snapshot} missing={data.snapshotMissing} />
        </Ratio>
      )}
    </Widget>
  );
}
