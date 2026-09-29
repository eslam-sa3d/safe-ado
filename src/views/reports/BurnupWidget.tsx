import { burnup, BurnupDay } from "../../api/reports";
import { fmtDate } from "../../components/common";
import { useSafe } from "../../components/context";
import { ReportData } from "./data";
import { SelectPi, Widget } from "./Widget";

const W = 720;
const H = 240;
const PAD = { left: 40, right: 12, top: 22, bottom: 24 };

const SERIES: { key: keyof Pick<BurnupDay, "scope" | "burned" | "ideal" | "forecast">; label: string }[] = [
  { key: "scope", label: "Total scope" },
  { key: "burned", label: "Burned" },
  { key: "ideal", label: "Ideal" },
  { key: "forecast", label: "Forecast" },
];

/** Burnup of the PI's story points with iteration bands, a Today marker and a forecast. */
export function BurnupWidget({ data, today }: { data: ReportData; today: number }) {
  const { pi } = useSafe();
  const chart = pi && burnup(pi, data.piStories, today);
  return (
    <Widget title="Burnup" size="wide">
      {!pi ? <SelectPi /> : !chart ? <p className="muted widget-hint">{pi.name} has no start and finish dates.</p> : <Chart chart={chart} />}
    </Widget>
  );
}

function Chart({ chart }: { chart: NonNullable<ReturnType<typeof burnup>> }) {
  const n = chart.days.length;
  const max = Math.max(1, chart.scope, ...chart.days.map((d) => d.burned ?? 0));
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const step = n > 1 ? iw / (n - 1) : iw;
  const x = (i: number) => PAD.left + i * step;
  const y = (v: number) => PAD.top + ih - (v / max) * ih;
  const line = (key: (typeof SERIES)[number]["key"]) =>
    chart.days
      .map((d, i) => (d[key] === null ? null : `${x(i).toFixed(1)},${y(d[key] as number).toFixed(1)}`))
      .filter(Boolean)
      .join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));

  return (
    <div className="burnup">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Burnup chart" className="burnup-svg">
        {chart.bands.map((b, i) => (
          <g key={b.name} className={"burnup-band" + (b.ip ? " ip" : i % 2 ? " odd" : "")}>
            <rect x={x(b.from) - step / 2} y={PAD.top} width={Math.max(step, (b.to - b.from + 1) * step)} height={ih} />
            <text x={x(b.from) + 2} y={PAD.top - 6} className="burnup-band-label">
              {b.name}
            </text>
          </g>
        ))}
        {Array.from(new Set(ticks)).map((t) => (
          <g key={t} className="burnup-tick">
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 6} className="burnup-axis">
          {fmtDate(chart.days[0].date)}
        </text>
        <text x={W - PAD.right} y={H - 6} textAnchor="end" className="burnup-axis">
          {fmtDate(chart.days[n - 1].date)}
        </text>
        {SERIES.map((s) => (
          <polyline key={s.key} className={`burnup-line line-${s.key}`} points={line(s.key)} data-series={s.key} />
        ))}
        {chart.todayIndex >= 0 && (
          <g className="burnup-today">
            <line x1={x(chart.todayIndex)} x2={x(chart.todayIndex)} y1={PAD.top} y2={PAD.top + ih} />
            <text x={x(chart.todayIndex) + 3} y={PAD.top + 10}>
              Today
            </text>
          </g>
        )}
        {chart.days.map((d, i) => (
          <rect key={d.day} className="burnup-hover" x={x(i) - step / 2} y={PAD.top} width={step} height={ih} data-date={d.date}>
            <title>
              {[
                fmtDate(d.date),
                `Scope ${d.scope}`,
                d.burned !== null ? `Burned ${d.burned}` : "",
                `Ideal ${d.ideal}`,
                d.forecast !== null ? `Forecast ${d.forecast}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </title>
          </rect>
        ))}
      </svg>
      <div className="legend-bar burnup-legend">
        {SERIES.map((s) => (
          <span key={s.key}>
            <span className={`swatch line-${s.key}`} />
            {s.label}
          </span>
        ))}
        <span className="muted small">Forecast at {chart.dailyRate} SP/day</span>
      </div>
    </div>
  );
}
