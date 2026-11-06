"use client";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { axis, SERIES, tooltipStyle } from "@/components/charts";

/** Single-series histogram. `edges` has one more entry than `counts`. */
export function Histogram({ edges, counts, height = 180, unit = "%", color = SERIES.s1 }: { edges: number[]; counts: number[]; height?: number; unit?: string; color?: string }) {
  const data = counts.map((c, i) => ({ label: String(edges[i]), count: c, range: `${edges[i]} to ${edges[i + 1]}${unit}` }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: -12 }} barCategoryGap={1}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" {...axis} interval={3} unit={unit} />
        <YAxis {...axis} axisLine={false} width={52} allowDecimals={false} />
        <Tooltip {...tooltipStyle} labelFormatter={(_: any, p: any) => p?.[0]?.payload?.range ?? ""} formatter={(v: any) => [v, "Passes"]} />
        <Bar dataKey="count" name="Passes" fill={color} radius={[2, 2, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Raw and filtered sensor volts on a numeric time axis, with detected axle peaks as labelled verticals. */
export function TraceChart({ t, raw, filtered, peaks, height = 220 }: { t: number[]; raw: number[]; filtered: number[]; peaks: number[]; height?: number }) {
  const data = t.map((x, i) => ({ t: x, raw: raw[i], filtered: filtered[i] }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 14, right: 12, bottom: 0, left: -12 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} {...axis} unit=" ms" minTickGap={40} tickFormatter={(v: number) => String(Math.round(v))} />
        <YAxis {...axis} axisLine={false} unit=" V" width={56} />
        <Tooltip {...tooltipStyle} cursor={{ stroke: "#2c3d53" }} labelFormatter={(v: any) => `${v} ms`} />
        <Legend iconType="plainline" height={20} />
        {peaks.map((p, i) => (
          <ReferenceLine key={i} x={p} stroke="#a9b6c6" strokeDasharray="3 3" label={{ value: `A${i + 1}`, fill: "#a9b6c6", fontSize: 10, position: "top" }} />
        ))}
        <Line type="linear" dataKey="raw" name="Raw" stroke={SERIES.s1} strokeWidth={1} dot={false} isAnimationActive={false} />
        <Line type="linear" dataKey="filtered" name="Filtered" stroke={SERIES.s2} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Small live line with a hover tooltip and no axes. The panel title names the series. */
export function Sparkline({ data, dataKey = "v", label, height = 64, color = SERIES.s1 }: { data: any[]; dataKey?: string; label: string; height?: number; color?: string }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
        <XAxis dataKey="t" hide />
        <YAxis hide domain={[0, (max: number) => Math.max(5, max)]} />
        <Tooltip {...tooltipStyle} cursor={{ stroke: "#2c3d53" }} />
        <Line type="monotone" dataKey={dataKey} name={label} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
