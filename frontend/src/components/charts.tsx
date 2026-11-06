"use client";
import { type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ErrorBar, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// Categorical slots validated with the dataviz checker against the panel surface #101a27 (dark). Status colours are separate.
export const SERIES = { s1: "#3987e5", s2: "#d55181", s3: "#29a3b8", s4: "#9085e9" };
export const STATUS = { go: "#2fbf71", wait: "#e8a33d", stop: "#ef5350" };
export const NEUTRAL = "#5d6f86";

export const tooltipStyle = {
  contentStyle: { background: "#0b1420", border: "1px solid #2c3d53", borderRadius: 3, fontSize: 11, padding: "6px 8px" },
  labelStyle: { color: "#a9b6c6", marginBottom: 2 },
  itemStyle: { color: "#e8eef5", padding: 0 },
  cursor: { fill: "rgba(148,163,184,0.08)", stroke: "#2c3d53" },
};

export const axis = { tickLine: false, axisLine: { stroke: "#1f2d3f" }, tick: { fontSize: 11, fill: "#7686a0" } };

export interface LineSeries { key: string; label: string; color: string; dash?: string }

export function TimeLines({ data, x = "t", series, height = 190, unit, yDomain, refLine }: { data: any[]; x?: string; series: LineSeries[]; height?: number; unit?: string; yDomain?: [number | string, number | string]; refLine?: { y: number; label: string } }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} strokeDasharray="0" />
        <XAxis dataKey={x} {...axis} minTickGap={32} />
        <YAxis {...axis} axisLine={false} unit={unit} domain={yDomain} width={60} />
        <Tooltip {...tooltipStyle} cursor={{ stroke: "#2c3d53" }} />
        {series.length > 1 && <Legend iconType="plainline" height={20} />}
        {refLine && <ReferenceLine y={refLine.y} stroke="#7686a0" strokeDasharray="3 3" label={{ value: refLine.label, fill: "#7686a0", fontSize: 10, position: "insideTopRight" }} />}
        {series.map((s) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} dot={false} connectNulls isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function StackedAreas({ data, x = "t", series, height = 190 }: { data: any[]; x?: string; series: LineSeries[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey={x} {...axis} minTickGap={32} />
        <YAxis {...axis} axisLine={false} width={52} />
        <Tooltip {...tooltipStyle} cursor={{ stroke: "#2c3d53" }} />
        <Legend iconType="square" height={20} />
        {series.map((s) => (
          <Area key={s.key} type="monotone" stackId="a" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={1} fill={s.color} fillOpacity={0.85} isAnimationActive={false} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function Bars({ data, x, series, height = 190, stacked, layout = "vertical", unit, colorBy, xWidth = 120 }: { data: any[]; x: string; series: LineSeries[]; height?: number; stacked?: boolean; layout?: "vertical" | "horizontal"; unit?: string; colorBy?: (d: any) => string; xWidth?: number }) {
  const horizontal = layout === "horizontal";
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 6, right: 14, bottom: 0, left: horizontal ? 0 : 4 }} barCategoryGap="28%" barGap={2}>
        <CartesianGrid vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? <XAxis type="number" {...axis} unit={unit} /> : <XAxis dataKey={x} {...axis} interval={0} />}
        {horizontal ? <YAxis type="category" dataKey={x} {...axis} width={xWidth} axisLine={false} /> : <YAxis {...axis} axisLine={false} unit={unit} width={60} />}
        <Tooltip {...tooltipStyle} />
        {series.length > 1 && <Legend iconType="square" height={20} />}
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId={stacked ? "a" : undefined} fill={s.color} stroke="#101a27" strokeWidth={stacked ? 1 : 0} radius={stacked ? 0 : horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]} isAnimationActive={false}>
            {colorBy && data.map((d, i) => <Cell key={i} fill={colorBy(d)} />)}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Bars with 95% confidence intervals. `err` is a [low-delta, high-delta] pair per row. */
export function CIBars({ data, x = "label", y = "mean", height = 220, unit, color = SERIES.s1, xWidth = 170 }: { data: { [k: string]: any; err: [number, number] }[]; x?: string; y?: string; height?: number; unit?: string; color?: string; xWidth?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 6, right: 28, bottom: 0, left: 0 }} barCategoryGap="30%">
        <CartesianGrid horizontal={false} />
        <XAxis type="number" {...axis} unit={unit} />
        <YAxis type="category" dataKey={x} {...axis} width={xWidth} axisLine={false} />
        <Tooltip {...tooltipStyle} formatter={(v: any) => [typeof v === "number" ? v.toFixed(2) : v, "Mean"]} />
        <Bar dataKey={y} fill={color} radius={[0, 3, 3, 0]} isAnimationActive={false}>
          <ErrorBar dataKey="err" direction="x" stroke="#e8eef5" width={4} strokeWidth={1.2} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Sensitivity: one row per factor, showing output at the low and high input around the baseline. */
export function Tornado({ rows, base, unit, height }: { rows: { label: string; low: number; high: number; low_value: number; high_value: number; swing: number }[]; base: number; unit?: string; height?: number }) {
  const data = rows.map((r) => ({ label: r.label, range: [Math.min(r.low, r.high), Math.max(r.low, r.high)] as [number, number], low: r.low, high: r.high, low_value: r.low_value, high_value: r.high_value, swing: r.swing }));
  return (
    <ResponsiveContainer width="100%" height={height || Math.max(180, rows.length * 26 + 40)}>
      <BarChart data={data} layout="vertical" margin={{ top: 6, right: 20, bottom: 0, left: 0 }} barCategoryGap="28%">
        <CartesianGrid horizontal={false} />
        <XAxis type="number" {...axis} unit={unit} domain={["auto", "auto"]} />
        <YAxis type="category" dataKey="label" {...axis} width={150} axisLine={false} />
        <Tooltip
          {...tooltipStyle}
          content={({ active, payload }: any) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload;
            return (
              <div style={tooltipStyle.contentStyle}>
                <div style={tooltipStyle.labelStyle}>{p.label}</div>
                <div className="num">Input {p.low_value}: {p.low.toFixed(2)}{unit}</div>
                <div className="num">Input {p.high_value}: {p.high.toFixed(2)}{unit}</div>
              </div>
            );
          }}
        />
        <ReferenceLine x={base} stroke="#e8eef5" strokeWidth={1} label={{ value: `Base ${base.toFixed(1)}`, fill: "#a9b6c6", fontSize: 10, position: "top" }} />
        <Bar dataKey="range" fill={SERIES.s1} radius={3} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Sequential single-hue heatmap on canvas-free divs. Rows = cells along the road, columns = time. */
export function Heatmap({ matrix, xLabels, yLabel, max, height = 180 }: { matrix: number[][]; xLabels?: string[]; yLabel?: string; max?: number; height?: number }): ReactNode {
  if (!matrix.length) return null;
  const top = max ?? Math.max(1, ...matrix.flat());
  const cols = matrix.length;
  const rows = matrix[0].length;
  return (
    <div>
      <div role="img" aria-label="Density by time and position" className="grid gap-px bg-bg-2" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, height }}>
        {Array.from({ length: rows }).flatMap((_, r) =>
          matrix.map((col, c) => {
            const v = col[rows - 1 - r] ?? 0;
            const t = Math.min(1, v / top);
            return <div key={`${c}-${r}`} title={`${xLabels?.[c] ?? c}: ${v} veh/km`} style={{ background: t < 0.01 ? "#0f1a28" : `rgba(56,189,248,${0.12 + 0.88 * t})` }} />;
          }),
        )}
      </div>
      <div className="flex justify-between text-[10.5px] text-ink-3 mt-1">
        <span>{xLabels?.[0]}</span>
        <span>{yLabel}</span>
        <span>{xLabels?.[xLabels.length - 1]}</span>
      </div>
    </div>
  );
}
