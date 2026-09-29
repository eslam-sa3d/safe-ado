import { findNode, subtreeIds } from "../../api/org";
import { EXPOSURE_COLOR, Exposure } from "../../api/risk";
import { riskRows } from "../../api/reports";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { SelectPi, Widget } from "./Widget";

export function ExposureChip({ value }: { value: Exposure }) {
  return (
    <span className="exposure-chip" style={{ background: EXPOSURE_COLOR[value] }}>
      {value}
    </span>
  );
}

/** PI Risks with ROAM status, exposure and residual exposure, highest exposure first. */
export function RisksWidget({ data }: { data: ReportData }) {
  const { config, node, pi } = useSafe();
  if (!pi)
    return (
      <Widget title="PI Risks" size="medium">
        <SelectPi />
      </Widget>
    );
  const scope = subtreeIds(node);
  const rows = riskRows(data.risks.filter((r) => r.piPath === pi.path && scope.has(r.nodeId)));
  return (
    <Widget title="PI Risks" size="medium">
      {rows.length === 0 ? (
        <p className="muted widget-hint">No risks in {pi.name}.</p>
      ) : (
        <table className="grid compact risk-table">
          <thead>
            <tr>
              <th>Risk</th>
              <th>ROAM</th>
              <th>Exposure</th>
              <th>Residual</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.risk.id}>
                <td>
                  {r.risk.title}
                  {r.risk.nodeId !== node.id && <span className="muted small"> · {findNode(config.root, r.risk.nodeId)?.name}</span>}
                </td>
                <td>
                  <span className={"roam-chip roam-" + r.risk.status.toLowerCase()}>{r.risk.status}</span>
                </td>
                <td>
                  <ExposureChip value={r.exposure} />
                </td>
                <td>
                  <ExposureChip value={r.residual} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Widget>
  );
}
