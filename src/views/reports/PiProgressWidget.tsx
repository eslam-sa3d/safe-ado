import { piProgress, piStatus } from "../../api/reports";
import { fmtDate } from "../../components/common";
import { useSafe } from "../../components/context";
import { plural, SelectPi, Widget } from "./Widget";

/** Semicircle gauge; `pct` 0..100. */
export function Gauge({ pct }: { pct: number }) {
  const len = Math.PI * 40;
  return (
    <svg className="gauge" viewBox="0 0 100 56" role="img" aria-label={`${pct}% elapsed`}>
      <path d="M10 50 A40 40 0 0 1 90 50" className="gauge-track" />
      <path d="M10 50 A40 40 0 0 1 90 50" className="gauge-fill" strokeDasharray={`${(len * pct) / 100} ${len}`} />
      <text x="50" y="48" textAnchor="middle" className="gauge-text">
        {pct}%
      </text>
    </svg>
  );
}

/** PI Progress: share of the PI's days that have elapsed, and days remaining. */
export function PiProgressWidget({ today }: { today: number }) {
  const { pi } = useSafe();
  const progress = pi && piProgress(pi, today);
  return (
    <Widget title="PI Progress">
      {!pi ? (
        <SelectPi />
      ) : !progress ? (
        <p className="muted widget-hint">{pi.name} has no start and finish dates.</p>
      ) : (
        <div className="kpi">
          <Gauge pct={progress.pct} />
          <div className="muted small">
            {piStatus(pi, today) === "planned" ? `Starts ${fmtDate(pi.start)}` : `${plural(progress.remainingDays, "day")} remaining`} ·{" "}
            {plural(progress.totalDays, "day")} total
          </div>
        </div>
      )}
    </Widget>
  );
}
