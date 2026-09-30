import { subtreeIds } from "../../api/org";
import { businessValue, inPi } from "../../api/reports";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { plural, Ratio, SelectPi, Warning, Widget } from "./Widget";

export const bvTone = (pct: number | null) => (pct === null ? undefined : pct >= 80 ? "good" : pct >= 60 ? "warn" : "bad");

/** Business Value: actual BV ÷ planned BV (committed) of the PI objectives in the subtree. */
export function BusinessValueWidget({ data }: { data: ReportData }) {
  const { node, pi } = useSafe();
  if (!pi)
    return (
      <Widget title="Business Value">
        <SelectPi />
      </Widget>
    );
  const scope = subtreeIds(node);
  const bv = businessValue(data.objectives.filter((o) => inPi(o, pi) && scope.has(o.nodeId)));
  return (
    <Widget title="Business Value">
      <Ratio pct={bv.pct} tone={bvTone(bv.pct)} caption={`${bv.actual} of ${bv.planned} BV (committed)`}>
        {bv.missingActual > 0 && <Warning>{plural(bv.missingActual, "objective")} without actual BV</Warning>}
      </Ratio>
    </Widget>
  );
}
