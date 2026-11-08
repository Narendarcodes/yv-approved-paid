/**
 * Tiny dependency-free charts for analytics (yv. teal on ink).
 */
import { useState } from 'react'
export const TEAL = '#035E5E'
export const INK = '#171310'

/** Teal ramp (light -> dark), shared by sparklines, bars and the heatmap. */
export const RAMP = ['#eef1ef', '#cfe5e1', '#9ccbc4', '#5fa69d', '#2a7f78', '#035e5e'] as const

/** Bucket a 0..1 value into ramp steps 1..5 (0 = no data). */
export function rampColor(t: number) {
  if (!(t > 0)) return RAMP[0]
  return RAMP[Math.min(5, 1 + Math.floor(t * 4.999))]
}

let sparkId = 0
export function Sparkline({
  values,
  width = 120,
  height = 32,
  stroke = TEAL,
  label,
}: {
  values: number[]
  width?: number
  height?: number
  stroke?: string
  label?: string
}) {
  const [gid] = useState(() => `spark-${++sparkId}`)
  if (!values.length) return <span className="text-xs text-umber">-</span>
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? width / (values.length - 1) : width
  const y = (v: number) => height - 2 - (v / max) * (height - 4)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`)
  const area = `0,${height} ${pts.join(' ')} ${((values.length - 1) * step).toFixed(1)},${height}`
  const last = values[values.length - 1]
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label || 'trend'}
      className="overflow-visible"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={RAMP[3]} stopOpacity={0.35} />
          <stop offset="100%" stopColor={RAMP[1]} stopOpacity={0.05} />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={(values.length - 1) * step} cy={y(last)} r={2.5} fill={stroke} />
    </svg>
  )
}

export function Delta({
  value,
  suffix = '%',
  testId,
}: {
  value: number | null | undefined
  suffix?: string
  testId?: string
}) {
  if (value === null || value === undefined)
    return (
      <span className="font-mono text-xs text-umber" data-testid={testId}>
        new
      </span>
    )
  const up = value > 0
  const flat = value === 0
  return (
    <span
      className={`font-mono text-xs font-medium ${flat ? 'text-umber' : up ? 'text-success' : 'text-danger'}`}
      data-testid={testId}
      title="vs previous period"
    >
      {flat ? '±0' : up ? '▲ ' : '▼ '}
      {flat ? '' : Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}
      {flat ? suffix : suffix}
    </span>
  )
}

/** Round a max up to a "nice" axis ceiling (1, 2, 2.5, 5 x 10^n). */
function niceCeil(v: number) {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const m = v / p
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return nice * p
}

function fmtAxis(n: number) {
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

/**
 * Daily bar chart with a y-axis (4 ticks + gridlines), sparse x-axis date
 * labels, a hover/focus tooltip and a minimum bar height so near-zero days
 * stay visible.
 */
export function BarTrend({
  data,
  height = 180,
  unit = 'views',
}: {
  data: { label: string; value: number; date?: string }[]
  height?: number
  unit?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const top = niceCeil(Math.max(...data.map((d) => d.value), 1))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => top * f)
  const every = data.length > 60 ? 14 : data.length > 20 ? 7 : data.length > 10 ? 2 : 1
  const h = hover !== null ? data[hover] : null
  return (
    <div className="relative" data-testid="bar-trend">
      <div className="flex gap-3">
        {/* y axis */}
        <div
          className="relative w-9 shrink-0 font-mono text-[11px] text-label"
          style={{ height }}
          aria-hidden="true"
        >
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 leading-none"
              style={{ top: `${100 - (t / top) * 100}%` }}
            >
              {fmtAxis(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {/* gridlines */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{ height }}
            aria-hidden="true"
          >
            {ticks.map((t) => (
              <span
                key={t}
                className={`absolute inset-x-0 border-t ${t === 0 ? 'border-line-strong' : 'border-dashed border-line'}`}
                style={{ top: `${100 - (t / top) * 100}%` }}
              />
            ))}
          </div>
          <div
            className="relative flex items-end gap-[3px]"
            style={{ height }}
            role="img"
            aria-label={`Daily ${unit}: ${data.map((d) => `${d.label} ${d.value}`).join(', ')}`}
            onMouseLeave={() => setHover(null)}
          >
            {data.map((d, i) => {
              const pct = (d.value / top) * 100
              const active = hover === i
              return (
                <div
                  key={i}
                  className="relative flex h-full flex-1 cursor-default items-end"
                  onMouseEnter={() => setHover(i)}
                  data-testid="bar"
                >
                  <div
                    className="w-full rounded-t-[3px] transition-[background-color,height] duration-200"
                    style={{
                      height: d.value > 0 ? `max(4px, ${pct}%)` : '2px',
                      background:
                        d.value > 0 ? (active ? RAMP[5] : RAMP[4]) : 'var(--color-line-strong)',
                      opacity: hover === null || active ? 1 : 0.55,
                    }}
                  />
                </div>
              )
            })}
          </div>
          {/* x axis */}
          <div className="relative mt-2 h-4 font-mono text-[11px] text-label" aria-hidden="true">
            {data.map((d, i) =>
              i % every === 0 || i === data.length - 1 ? (
                i === data.length - 1 && i % every !== 0 && i % every < every / 2 ? null : (
                  <span
                    key={i}
                    className="absolute -translate-x-1/2 whitespace-nowrap"
                    style={{ left: `${((i + 0.5) / data.length) * 100}%` }}
                  >
                    {d.label}
                  </span>
                )
              ) : null,
            )}
          </div>
          {/* tooltip */}
          {h && hover !== null && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md bg-ink px-2.5 py-1.5 text-white shadow-pop"
              style={{
                left: `clamp(48px, ${((hover + 0.5) / data.length) * 100}%, calc(100% - 48px))`,
                // 24px = x-axis row below the plot; +8px gap above the bar
                bottom: 24 + Math.max(4, (h.value / top) * height) + 8,
              }}
              role="tooltip"
              data-testid="bar-tooltip"
            >
              <p className="font-mono text-[11px] text-white/70">{h.date ?? h.label}</p>
              <p className="text-sm font-semibold">
                {h.value.toLocaleString()}{' '}
                <span className="text-xs font-normal text-white/80">{unit}</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Ramp legend: "Less [] [] [] [] [] More". */
export function RampLegend({
  low = 'Less',
  high = 'More',
  className = '',
}: {
  low?: string
  high?: string
  className?: string
}) {
  return (
    <div
      className={`flex items-center gap-1.5 font-mono text-[11px] text-label ${className}`}
      data-testid="ramp-legend"
    >
      <span>{low}</span>
      {RAMP.map((c) => (
        <span
          key={c}
          className="h-3 w-3 rounded-[3px]"
          style={{
            background: c,
            boxShadow: c === RAMP[0] ? 'inset 0 0 0 1px rgba(28,25,23,0.08)' : undefined,
          }}
        />
      ))}
      <span>{high}</span>
    </div>
  )
}

export function pctText(rate: number) {
  return `${(rate * 100).toFixed(1)}%`
}

export function SimulatedBadge({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-st-production/40 bg-st-production-bg px-2 py-0.5 text-[11px] font-medium text-st-production"
      title="Demo mode: these numbers are generated, not real platform data"
      data-testid="simulated-badge"
    >
      Simulated · demo mode
    </span>
  )
}
