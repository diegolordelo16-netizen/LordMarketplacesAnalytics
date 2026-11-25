/**
 * Gráficos do dashboard — SVG puro, sem biblioteca e sem dado inventado.
 *
 * Regra que vale para todos: ponto sem valor é LACUNA, não zero. A linha é
 * interrompida onde falta dado, e o gráfico diz quantos pontos ficaram de fora.
 * Nada de interpolar uma reta bonita por cima do que não foi medido.
 */
import { useMemo, useState } from "react";

export interface Point {
  label: string;
  value: number | null;
}

const nf = (v: number, digits = 0) =>
  v.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function formatAxis(v: number, kind: "money" | "count" | "percent"): string {
  if (kind === "money") {
    const reais = v / 100;
    if (Math.abs(reais) >= 1_000_000) return `R$ ${nf(reais / 1_000_000, 1)}M`;
    if (Math.abs(reais) >= 1_000) return `R$ ${nf(reais / 1_000, 1)}k`;
    return `R$ ${nf(reais, 0)}`;
  }
  if (kind === "percent") return `${nf(v, 1)}%`;
  if (Math.abs(v) >= 1_000) return `${nf(v / 1_000, 1)}k`;
  return nf(v);
}

// ---------------------------------------------------------------- área

/**
 * Linha de evolução com área em gradiente.
 * `height` fixo: o gráfico não "pula" quando chega dado novo.
 */
export function AreaChart({
  points,
  kind = "money",
  height = 200,
  accent = "violet",
  emptyLabel = "Sem coleta no período",
}: {
  points: Point[];
  kind?: "money" | "count" | "percent";
  height?: number;
  accent?: "violet" | "teal" | "amber";
  emptyLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = height;
  const padL = 56;
  const padR = 12;
  const padT = 14;
  const padB = 26;

  const numeric = points.map((p) => p.value).filter((v): v is number => v !== null);
  const valid = numeric.length;
  if (points.length === 0 || valid === 0) {
    return (
      <div className="chart-empty" style={{ height }}>
        <span>{emptyLabel}</span>
      </div>
    );
  }

  const max = Math.max(...numeric);
  const min = Math.min(0, ...numeric);
  const span = max - min || 1;
  const stepX = points.length > 1 ? (W - padL - padR) / (points.length - 1) : 0;
  const x = (i: number) => padL + i * stepX;
  const y = (v: number) => padT + (1 - (v - min) / span) * (H - padT - padB);

  // Quebra a linha em segmentos contínuos: lacuna não vira reta.
  const segments: { i: number; v: number }[][] = [];
  let current: { i: number; v: number }[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push({ i, v: p.value });
    }
  });
  if (current.length > 0) segments.push(current);

  const path = (seg: { i: number; v: number }[]) =>
    seg.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  const firstSeg = segments[0] ?? [];
  const lastSeg = segments[segments.length - 1] ?? [];
  const areaPath =
    firstSeg.length > 0 && lastSeg.length > 0
      ? path([...firstSeg, ...lastSeg])
      : "";

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + span * t);
  const hoverPoint = hover !== null ? points[hover] : null;
  const gaps = points.length - valid;

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className={`chart-svg accent-${accent}`} role="img">
        <defs>
          <linearGradient id={`grad-${accent}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="grid-line" />
            <text x={padL - 8} y={y(t) + 4} className="axis-label" textAnchor="end">
              {formatAxis(t, kind)}
            </text>
          </g>
        ))}
        {areaPath && <path d={`${areaPath} L${x(lastSeg[lastSeg.length - 1].i)},${y(min)} L${x(firstSeg[0].i)},${y(min)} Z`} fill={`url(#grad-${accent})`} />}
        {segments.map((seg, k) => (
          <path key={k} d={path(seg)} className="chart-line" />
        ))}
        {segments.flat().map((p) => (
          <circle key={`${p.i}`} cx={x(p.i)} cy={y(p.v)} r={hover === p.i ? 5 : 3} className="chart-dot" />
        ))}
        {points.map((p, i) =>
          i % Math.max(1, Math.ceil(points.length / 8)) === 0 ? (
            <text key={i} x={x(i)} y={H - 8} className="axis-label" textAnchor="middle">
              {p.label}
            </text>
          ) : null,
        )}
        {points.map((_, i) => (
          <rect
            key={`hit-${i}`}
            x={x(i) - stepX / 2}
            y={padT}
            width={Math.max(stepX, 8)}
            height={H - padT - padB}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {hoverPoint && (
        <div className="chart-tip">
          <strong>{hoverPoint.label}</strong>
          <span>
            {hoverPoint.value === null
              ? "não coletado"
              : kind === "money"
                ? money(hoverPoint.value)
                : kind === "percent"
                  ? `${nf(hoverPoint.value, 1)}%`
                  : nf(hoverPoint.value)}
          </span>
        </div>
      )}
      {gaps > 0 && (
        <p className="chart-note">
          {gaps} {gaps === 1 ? "dia" : "dias"} sem coleta no período — a linha é interrompida onde falta dado.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- barras

export function BarChart({
  points,
  kind = "money",
  accent = "teal",
  height = 180,
}: {
  points: Point[];
  kind?: "money" | "count" | "percent";
  accent?: "violet" | "teal" | "amber";
  height?: number;
}) {
  const numeric = points.map((p) => p.value).filter((v): v is number => v !== null);
  const max = numeric.length > 0 ? Math.max(...numeric) : 0;
  if (points.length === 0 || max === 0) {
    return (
      <div className="chart-empty" style={{ height }}>
        <span>Sem dado para comparar</span>
      </div>
    );
  }
  return (
    <div className={`bars accent-${accent}`} style={{ height }}>
      {points.map((p) => (
        <div className="bar-row" key={p.label}>
          <span className="bar-label" title={p.label}>
            {p.label}
          </span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${((p.value ?? 0) / max) * 100}%` }} />
          </div>
          <span className="bar-value">{p.value === null ? "—" : kind === "money" ? money(p.value) : nf(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- rosca

export function Donut({ parts, total }: { parts: { label: string; value: number; tone: string }[]; total: number }) {
  const sum = parts.reduce((a, p) => a + p.value, 0);
  if (sum === 0) return <div className="chart-empty" style={{ height: 150 }}><span>Nenhum dado coletado</span></div>;
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" className="donut">
        <circle cx="70" cy="70" r={R} className="donut-track" />
        {parts.map((p) => {
          const len = (p.value / sum) * C;
          const el = (
            <circle
              key={p.label}
              cx="70"
              cy="70"
              r={R}
              className={`donut-part tone-${p.tone}`}
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-offset}
            />
          );
          offset += len;
          return el;
        })}
        <text x="70" y="66" className="donut-total" textAnchor="middle">
          {nf(total)}
        </text>
        <text x="70" y="84" className="donut-caption" textAnchor="middle">
          registros
        </text>
      </svg>
      <ul className="donut-legend">
        {parts.map((p) => (
          <li key={p.label}>
            <span className={`swatch tone-${p.tone}`} />
            {p.label}
            <b>{sum > 0 ? `${Math.round((p.value / sum) * 100)}%` : "—"}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- sparkline

export function Sparkline({ values, tone = "violet" }: { values: (number | null)[]; tone?: string }) {
  const nums = values.filter((v): v is number => v !== null);
  const path = useMemo(() => {
    if (nums.length < 2) return "";
    const max = Math.max(...nums);
    const min = Math.min(...nums);
    const span = max - min || 1;
    return values
      .map((v, i) => {
        if (v === null) return null;
        const x = (i / Math.max(1, values.length - 1)) * 100;
        const y = 24 - ((v - min) / span) * 20;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .filter((s): s is string => s !== null)
      .join(" ");
  }, [values, nums]);
  if (!path) return <span className="spark-empty">—</span>;
  return (
    <svg viewBox="0 0 100 28" className={`spark tone-${tone}`} preserveAspectRatio="none">
      <polyline points={path} />
    </svg>
  );
}
