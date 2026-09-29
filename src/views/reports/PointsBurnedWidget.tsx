import { pointsSummary } from "../../api/reports";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { Ratio, SelectPi, Widget } from "./Widget";

/** Story Points Burned: done ÷ planned story points of the PI's team stories. */
export function PointsBurnedWidget({ data }: { data: ReportData }) {
  const { pi } = useSafe();
  const p = pointsSummary(data.piStories);
  return <Widget title="Story Points Burned">{!pi ? <SelectPi /> : <Ratio pct={p.pct} caption={`${p.done} of ${p.planned} SP done`} />}</Widget>;
}
