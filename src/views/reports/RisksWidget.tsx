import { useState } from "react";
import { newId, risksStore } from "../../api/data";
import { findNode, subtreeIds } from "../../api/org";
import { EXPOSURE_COLOR, Exposure } from "../../api/risk";
import { riskRows } from "../../api/reports";
import { Risk } from "../../api/types";
import { useCan, useSafe } from "../../components/context";
import { RiskDialog } from "./CreateDialogs";
import { ReportData } from "./data";
import { AddButton, SelectPi, Widget } from "./Widget";

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
  const can = useCan();
  const [created, setCreated] = useState<Risk[]>([]);
  const [adding, setAdding] = useState(false);
  if (!pi)
    return (
      <Widget title="PI Risks" size="medium">
        <SelectPi />
      </Widget>
    );
  const scope = subtreeIds(node);
  const all = [...data.risks.filter((r) => !created.some((c) => c.id === r.id)), ...created];
  const rows = riskRows(all.filter((r) => r.piPath === pi.path && scope.has(r.nodeId)));
  const actions = <AddButton label="Add risk" canPlan={can.plan} onClick={() => setAdding(true)} />;
  return (
    <Widget title="PI Risks" size="medium" actions={actions}>
      {adding && (
        <RiskDialog
          piName={pi.name}
          onClose={() => setAdding(false)}
          onSave={async (draft) => {
            const saved = await risksStore.save({
              id: newId(),
              piPath: pi.path,
              piId: pi.identifier,
              nodeId: node.id,
              impact: "Medium",
              status: "Unroamed",
              createdAt: new Date().toISOString(),
              ...draft,
            });
            setCreated((prev) => [...prev, saved]);
            setAdding(false);
          }}
        />
      )}
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
