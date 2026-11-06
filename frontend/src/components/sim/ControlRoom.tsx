"use client";
import { FlaskConical, Pause, Play, RefreshCw, RotateCcw, Send, Sigma, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CIBars, SERIES, Tornado } from "@/components/charts";
import { Badge, Button, DataTable, Empty, ErrorBox, Input, KV, Loading, Note, Panel, Provenance, Select } from "@/components/ui";
import { api, useApi, useJob } from "@/lib/api";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { useLive } from "@/lib/live";
import { ExportLinks, JobStatus, n, NO_CONTROL, NO_RUN, ScenarioChecks, type SimCtx, statusTone, Toggle, useScenarios } from "./common";

type F = { key: string; label: string; min: number; max: number; step: number; unit?: string };

const GROUPS: { title: string; fields: F[]; note?: string }[] = [
  {
    title: "Traffic",
    fields: [
      { key: "trucks_per_day", label: "Daily volume", min: 100, max: 40000, step: 100, unit: "trucks" },
      { key: "peak_factor", label: "Peak factor", min: 1, max: 3, step: 0.1 },
    ],
  },
  {
    title: "Stream mix",
    fields: [
      { key: "port_share_pct", label: "Port", min: 0, max: 100, step: 1, unit: "%" },
      { key: "origin_share_pct", label: "Industrial origin", min: 0, max: 100, step: 1, unit: "%" },
      { key: "untokened_share_pct", label: "Untokened", min: 0, max: 100, step: 1, unit: "%" },
    ],
  },
  {
    title: "Loading",
    fields: [
      { key: "avg_loading_pct", label: "Average loading", min: 40, max: 100, step: 1, unit: "%" },
      { key: "load_spread_pct", label: "Spread", min: 1, max: 30, step: 1, unit: "%" },
      { key: "overload_pct", label: "Overload share", min: 0, max: 30, step: 0.1, unit: "%" },
    ],
  },
  {
    title: "Tokens and audits",
    fields: [
      { key: "token_coverage_pct", label: "Token coverage", min: 0, max: 100, step: 1, unit: "%" },
      { key: "audit_pct", label: "Audit share", min: 0, max: 100, step: 0.5, unit: "%" },
    ],
  },
  {
    title: "Scale errors",
    fields: [
      { key: "port_error_pct", label: "Port scale", min: 0.05, max: 15, step: 0.05, unit: "%" },
      { key: "road_error_pct", label: "Road WIM", min: 0.05, max: 20, step: 0.05, unit: "%" },
      { key: "lane_error_pct", label: "Lane scale", min: 0.05, max: 15, step: 0.05, unit: "%" },
      { key: "origin_error_pct", label: "Loading-site scale", min: 0.05, max: 15, step: 0.05, unit: "%" },
      { key: "measurement_margin_k", label: "Measurement margin k", min: 0, max: 5, step: 0.1 },
    ],
  },
  {
    title: "Service",
    fields: [
      { key: "static_stop_min", label: "Static stop", min: 2.5, max: 60, step: 0.5, unit: "min" },
      { key: "static_lanes", label: "Static lanes", min: 1, max: 20, step: 1 },
      { key: "lane_pass_min", label: "Lane pass", min: 0.2, max: 15, step: 0.1, unit: "min" },
      { key: "lanes_per_station", label: "Lanes per station", min: 0, max: 4, step: 1 },
      { key: "lane_speed_kmh", label: "Lane speed", min: 3, max: 15, step: 1, unit: "km/h" },
      { key: "lane_headway_m", label: "Lane headway", min: 15, max: 60, step: 1, unit: "m" },
    ],
  },
  {
    title: "Network outages",
    fields: [
      { key: "outage_per_day", label: "Outages per day, per station", min: 0, max: 24, step: 0.1 },
      { key: "outage_duration_min", label: "Outage duration", min: 1, max: 720, step: 1, unit: "min" },
    ],
  },
  {
    title: "Violation rates",
    fields: [
      { key: "dimension_violation_pct", label: "Dimension breach", min: 0, max: 20, step: 0.1, unit: "%" },
      { key: "lifted_axle_pct", label: "Lifted axle", min: 0, max: 20, step: 0.1, unit: "%" },
      { key: "token_fraud_pct", label: "Token fraud", min: 0, max: 20, step: 0.1, unit: "%" },
      { key: "misdeclaration_pct", label: "Misdeclaration", min: 0, max: 30, step: 0.1, unit: "%" },
    ],
  },
];

const DEFAULTS = { trucks_per_day: 8000, avg_loading_pct: 85, token_coverage_pct: 90, audit_pct: 3, port_error_pct: 1, road_error_pct: 2.5, lane_error_pct: 1, static_stop_min: 6, lane_pass_min: 1.5 };
const SPEEDS = [1, 2, 5, 10, 20, 60, 120, 300, 600];

function ParamField({ f, value, onChange, note }: { f: F; value: number; onChange: (v: number) => void; note?: string }) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(value)), [value]);
  const parsed = Number(txt);
  const invalid = txt.trim() === "" || !Number.isFinite(parsed) || parsed < f.min || parsed > f.max;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 mb-0.5">
        <label htmlFor={`p-${f.key}`} className="text-[11px] text-ink-2 truncate flex-1" title={note}>{f.label}{f.unit ? ` (${f.unit})` : ""}</label>
        <input
          id={`p-${f.key}`}
          type="number"
          value={txt}
          min={f.min}
          max={f.max}
          step={f.step}
          title={`Range ${f.min} to ${f.max}`}
          aria-invalid={invalid}
          onChange={(e) => {
            setTxt(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= f.min && v <= f.max) onChange(v);
          }}
          onBlur={() => setTxt(String(value))}
          className={`num w-[68px] h-[22px] px-1 text-right text-[11.5px] rounded-sm bg-bg-2 border text-ink outline-none focus:border-accent ${invalid ? "border-stop" : "border-line-2"}`}
        />
      </div>
      <input type="range" aria-label={f.label} className="w-full accent-[#38bdf8] h-3.5 block" value={value} min={f.min} max={f.max} step={f.step} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="text-[10px] leading-tight text-ink-3 truncate" title={note}>{note ?? "No source recorded for this setting."}</div>
    </div>
  );
}

function LiveControls({ ctx }: { ctx: SimCtx }) {
  const kpi = useLive((s) => s.kpi);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (action: string, speed?: number) => {
    setBusy(action);
    setErr(null);
    try {
      await api("/live/control", { body: { action, speed } });
      if (action === "reset") ctx.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const off = !ctx.canControl;
  const title = off ? NO_CONTROL : undefined;
  const opts = Array.from(new Set([...SPEEDS, ...(kpi ? [kpi.speed] : [])])).sort((a, b) => a - b);
  return (
    <Panel title="Live twin" sub={kpi ? (kpi.paused ? "paused" : kpi.running ? "running" : "stopped") : "connecting"} tag={<Provenance kind="SIMULATED" />}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" icon={Play} disabled={off || !!kpi?.running} loading={busy === "start"} title={title} onClick={() => act("start")}>Start</Button>
        <Button size="sm" icon={Pause} disabled={off || !kpi?.running} loading={busy === "pause"} title={title} onClick={() => act("pause")}>Pause</Button>
        <Button size="sm" icon={Play} disabled={off || !kpi?.paused} loading={busy === "resume"} title={title} onClick={() => act("resume")}>Resume</Button>
        <Button size="sm" variant="danger" icon={RotateCcw} disabled={off} loading={busy === "reset"} title={title} onClick={() => { if (window.confirm("Reset the live twin? Today's simulated trucks and totals are cleared.")) act("reset"); }}>Reset</Button>
        <label className="flex items-center gap-1.5 text-[11px] text-ink-2 ml-1">
          Speed
          <Select aria-label="Twin speed" className="!h-6 w-20 !text-[11px]" disabled={off || !kpi} value={kpi?.speed ?? ""} title={title} onChange={(e) => act("speed", Number(e.target.value))}>
            {opts.map((s) => <option key={s} value={s}>{s}x</option>)}
          </Select>
        </label>
      </div>
      {off && <div className="text-[11px] text-ink-3 mt-1.5">{NO_CONTROL}</div>}
      {err && <div className="mt-2"><ErrorBox text={err} /></div>}
    </Panel>
  );
}

function L2Summary({ result, onOpen }: { result: any; onOpen?: () => void }) {
  const rows = Object.values(result.scenarios ?? {}) as any[];
  return (
    <div>
      <DataTable<any>
        rows={rows}
        rowKey={(r) => r.scenario}
        cols={[
          { key: "label", label: "Scenario", render: (r) => <span className="text-ink">{r.label}</span> },
          { key: "s", label: "Road stops per 1,000", align: "right", mono: true, render: (r) => n(r.road_stops_per_1000) },
          { key: "d", label: "Avg delay, min", align: "right", mono: true, render: (r) => n(r.avg_delay_min, 2) },
          { key: "h", label: "Truck-hours saved per day", align: "right", mono: true, render: (r) => n(r.truck_hours_saved_per_day, 0) },
        ]}
      />
      {onOpen && <Button size="sm" className="mt-2" onClick={onOpen}>Open in the L2 tab</Button>}
    </div>
  );
}

function MonteCarloResult({ result }: { result: any }) {
  const rows = Object.entries(result.scenarios ?? {}).map(([k, v]: [string, any]) => ({ key: k, ...v }));
  const ci = (m: any, d = 1) => (m ? `${n(m.mean, d)} (${n(m.ci_low, d)} to ${n(m.ci_high, d)})` : "-");
  const bars = (metric: string) => rows.map((r: any) => ({ label: r.label, mean: r.metrics[metric].mean, err: [r.metrics[metric].mean - r.metrics[metric].ci_low, r.metrics[metric].ci_high - r.metrics[metric].mean] as [number, number] }));
  const d = result.design ?? {};
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-ink-2 mb-2">
        <span className="num">{d.replications} replications x {d.days} days, {d.warmup_days} warm-up</span>
        <span className="num">{fmtInt(d.trucks_simulated)} trucks simulated</span>
        <span>Common random numbers across scenarios</span>
        {result.conservation_ok ? <Badge tone="go">Truck conservation holds</Badge> : <Badge tone="stop">Truck conservation failed</Badge>}
      </div>
      <DataTable<any>
        rows={rows}
        rowKey={(r) => r.key}
        cols={[
          { key: "label", label: "Scenario, mean and 95% CI", render: (r) => <span className="text-ink" title={r.note}>{r.label}</span> },
          { key: "s", label: "Road stops per 1,000", align: "right", mono: true, render: (r) => ci(r.metrics.road_stops_per_1000) },
          { key: "l", label: "Lane per 1,000", align: "right", mono: true, render: (r) => ci(r.metrics.lane_per_1000) },
          { key: "d", label: "Avg delay, min", align: "right", mono: true, render: (r) => ci(r.metrics.avg_delay_min, 2) },
          { key: "h", label: "Truck-hours saved per day", align: "right", mono: true, render: (r) => ci(r.metrics.truck_hours_saved_per_day, 0) },
          { key: "f", label: "False clear %", align: "right", mono: true, render: (r) => ci(r.metrics.false_clear_pct, 3) },
        ]}
      />
      <div className="grid gap-3 lg:grid-cols-2 mt-3">
        <div><div className="text-[11px] text-ink-3 mb-1">Road stops per 1,000 trucks, with 95% CI</div><CIBars data={bars("road_stops_per_1000")} height={200} color={SERIES.s1} /></div>
        <div><div className="text-[11px] text-ink-3 mb-1">Truck-hours saved per day against the existing process, with 95% CI</div><CIBars data={bars("truck_hours_saved_per_day")} height={200} color={SERIES.s1} /></div>
      </div>
    </div>
  );
}

const TORNADO_LABEL: Record<string, string> = { road_stops_per_1000: "Road stops per 1,000", delay_hours_per_day: "Delay hours per day", false_clear_pct: "False clear %", lane_per_1000: "Lane per 1,000", port_reweigh_pct: "Port re-weigh %", p95_delay_min: "p95 delay, min" };

function TornadoResult({ result }: { result: any }) {
  const [metric, setMetric] = useState("road_stops_per_1000");
  return (
    <div>
      <Select aria-label="Metric" className="w-56 mb-2" value={metric} onChange={(e) => setMetric(e.target.value)}>
        {Object.keys(result.tables ?? {}).map((k) => <option key={k} value={k}>{TORNADO_LABEL[k] ?? k}</option>)}
      </Select>
      <Tornado rows={result.tables?.[metric] ?? []} base={result.base?.[metric] ?? 0} />
    </div>
  );
}

const configSummary = (c: any) => {
  if (!c) return "-";
  const bits: string[] = [];
  if (c.station) bits.push(c.station);
  if (c.scenario) bits.push(c.scenario);
  if (c.trucks_per_day != null) bits.push(`${fmtInt(c.trucks_per_day)} trucks/day`);
  if (c.token_coverage_pct != null) bits.push(`${c.token_coverage_pct}% coverage`);
  if (c.road_error_pct != null) bits.push(`${c.road_error_pct}% road error`);
  if (c.replications != null) bits.push(`${c.replications} x ${c.days} d`);
  if (c.load_multiplier != null) bits.push(`${c.load_multiplier}x load`);
  return bits.join(", ") || "-";
};

const TAB_FOR: Record<string, string> = { l2: "l2", l3: "l3", l4: "l4", linked: "linked" };

export function ControlRoom({ ctx, onOpen }: { ctx: SimCtx; onOpen: (tab: string, id: string) => void }) {
  const { scenarios, error: scenErr } = useScenarios();
  const job = useJob<any>();
  const [days, setDays] = useState(2);
  const [engine, setEngine] = useState("fast");
  const [picked, setPicked] = useState<string[]>(["as_is", "v2_all"]);
  const [mc, setMc] = useState({ replications: 30, days: 30, warmup_days: 2 });
  const [msg, setMsg] = useState<string | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const { data: expData, error: expErr, loading: expLoading, refresh: refreshExp } = useApi<{ items: any[] }>("/sim/experiments?limit=25", 3000);
  const c = ctx.config;

  const dirty = useMemo(() => (c && ctx.live ? Object.keys(c).filter((k) => c[k] !== ctx.live![k]) : []), [c, ctx.live]);

  useEffect(() => {
    if (job.job?.status && job.job.status !== "RUNNING") refreshExp();
  }, [job.job?.status, refreshExp]);

  if (ctx.error && !c) return <div className="pt-2"><ErrorBox text={ctx.error} /></div>;
  if (!c) return <Loading text="Loading the configuration" />;

  const apply = async () => {
    setApplying(true);
    setCfgErr(null);
    setMsg(null);
    try {
      await api("/live/config", { method: "PUT", body: c });
      ctx.refresh();
      setMsg("Applied to the live twin. Trucks from now on use this configuration.");
    } catch (e) {
      setCfgErr((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const shareTotal = c.port_share_pct + c.origin_share_pct + c.untokened_share_pct;
  const canRun = ctx.canRun;
  const runTitle = canRun ? undefined : NO_RUN;
  const result = job.job?.status === "DONE" ? (job.job as any).result : null;
  const kind = (job.job as any)?.kind as string | undefined;
  const jobId = job.job?.id;

  return (
    <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_400px] pt-2">
      <div className="flex flex-col gap-2 min-w-0">
        <Panel
          title="Configuration"
          sub={dirty.length ? `${dirty.length} setting${dirty.length > 1 ? "s" : ""} differ from the live twin` : "matches the live twin"}
          tag={<Provenance kind="ASSUMED" title="Inputs are assumptions unless the note under a field says otherwise" />}
          actions={
            <>
              <Button size="sm" icon={SlidersHorizontal} onClick={() => ctx.patch(DEFAULTS)}>Load defaults</Button>
              <Button size="sm" icon={RefreshCw} disabled={!dirty.length} onClick={() => ctx.live && ctx.patch(ctx.live)}>Revert to live</Button>
              <Button size="sm" variant="primary" icon={Send} loading={applying} disabled={!ctx.canControl || !dirty.length} title={ctx.canControl ? undefined : NO_CONTROL} onClick={apply}>Apply to live twin</Button>
            </>
          }
        >
          <div className="text-[11px] text-ink-3 mb-2">
            These values are a draft. Experiments in every tab run on them. The live twin changes only when you apply them. Load defaults sets 8,000 trucks/day, 85% loading, 90% coverage, 3% audit, 1% port, 2.5% road and 1% lane error, a 6 min static stop and a 1.5 min lane pass.
          </div>
          {msg && <div className="mb-2"><Note>{msg}</Note></div>}
          {cfgErr && <div className="mb-2"><ErrorBox text={cfgErr} /></div>}
          <div className="grid gap-x-5 gap-y-3 md:grid-cols-2 2xl:grid-cols-3">
            {GROUPS.map((g) => (
              <fieldset key={g.title} className="min-w-0 border-t border-line pt-1.5">
                <legend className="flex items-center gap-1.5 pr-2 text-[11.5px] font-semibold text-ink">{g.title}</legend>
                <div className="flex flex-col gap-1.5">
                  {g.title === "Traffic" && (
                    <div>
                      <label htmlFor="p-arrival" className="text-[11px] text-ink-2 block mb-0.5">Arrival distribution</label>
                      <Select id="p-arrival" className="!h-[22px] !text-[11.5px]" value={c.arrival_distribution} onChange={(e) => ctx.patch({ arrival_distribution: e.target.value })}>
                        <option value="time_of_day">Time of day</option>
                        <option value="uniform">Uniform</option>
                        <option value="vessel_bursts">Vessel bursts</option>
                      </Select>
                      <div className="text-[10px] text-ink-3">Shape is an assumption of the L2 model.</div>
                    </div>
                  )}
                  {g.fields.map((f) => <ParamField key={f.key} f={f} value={c[f.key]} note={ctx.provenance[f.key]} onChange={(v) => ctx.patch({ [f.key]: v })} />)}
                  {g.title === "Stream mix" && <div className="text-[10.5px] text-ink-3">Shares total {n(shareTotal, 0)}%. The model rescales them to 100%.</div>}
                </div>
              </fieldset>
            ))}
            <fieldset className="min-w-0 border-t border-line pt-1.5">
              <legend className="pr-2 text-[11.5px] font-semibold text-ink">Policy toggles</legend>
              <div className="flex flex-col gap-1.5">
                <Toggle label="Apply the 5% discretion allowance" checked={c.allowance_pct > 0} onChange={(v) => ctx.patch({ allowance_pct: v ? 5 : 0 })} title="A policy assumption" />
                <Toggle label="Port scale is legal grade (no margin)" checked={!!c.port_legal_grade} onChange={(v) => ctx.patch({ port_legal_grade: v })} title="A policy assumption" />
                <Toggle label="Lane scale is legal grade (no margin)" checked={!!c.lane_legal_grade} onChange={(v) => ctx.patch({ lane_legal_grade: v })} title="A policy assumption" />
                <div className="text-[10.5px] text-ink-3">Policy assumptions, not current law.</div>
              </div>
            </fieldset>
          </div>
        </Panel>

        {job.job?.status === "DONE" && result && (
          <Panel title={`Result: ${(job.job as any).name ?? jobId}`} tag={<Provenance kind="MODELLED" title="Results from assumed inputs, not measured data" />} actions={jobId ? <ExportLinks id={jobId} /> : undefined}>
            {kind === "l2" && <L2Summary result={result} onOpen={jobId ? () => onOpen("l2", jobId) : undefined} />}
            {kind === "monte_carlo" && <MonteCarloResult result={result} />}
            {kind === "tornado" && <TornadoResult result={result} />}
          </Panel>
        )}
      </div>

      <div className="flex flex-col gap-2 min-w-0">
        <LiveControls ctx={ctx} />
        <Panel title="Experiments" sub="on the draft configuration" tag={<Provenance kind="MODELLED" />}>
          {!canRun && <div className="text-[11px] text-ink-3 mb-2">{NO_RUN}</div>}
          <div className="grid grid-cols-2 gap-2 mb-2">
            <label className="text-[11px] text-ink-2">Days
              <Input type="number" min={1} max={30} value={days} onChange={(e) => setDays(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} />
            </label>
            <label className="text-[11px] text-ink-2">Engine
              <Select value={engine} onChange={(e) => setEngine(e.target.value)}>
                <option value="fast">Fast heap kernel</option>
                <option value="simpy">SimPy</option>
              </Select>
            </label>
          </div>
          <Button variant="primary" className="w-full mb-3" icon={FlaskConical} disabled={!canRun || job.running} title={runTitle} onClick={() => job.start("/sim/l2/run", { config: c, days, engine })}>Run experiment, all six scenarios</Button>

          <div className="border-t border-line pt-2 mb-3">
            <div className="text-[11px] text-ink-3 mb-1">Scenarios to compare</div>
            {scenErr && <ErrorBox text={scenErr} />}
            <ScenarioChecks value={picked} onChange={setPicked} scenarios={scenarios} />
            <Button className="w-full mt-2" disabled={!canRun || job.running || !picked.length} title={runTitle} onClick={() => job.start("/sim/l2/run", { config: c, days, engine, scenarios: picked })}>Compare scenarios ({picked.length})</Button>
          </div>

          <div className="border-t border-line pt-2">
            <div className="grid grid-cols-3 gap-2 mb-1.5">
              <label className="text-[11px] text-ink-2">Replications<Input type="number" min={2} max={100} value={mc.replications} onChange={(e) => setMc({ ...mc, replications: Math.max(2, Math.min(100, Number(e.target.value) || 2)) })} /></label>
              <label className="text-[11px] text-ink-2">Days<Input type="number" min={1} max={60} value={mc.days} onChange={(e) => setMc({ ...mc, days: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })} /></label>
              <label className="text-[11px] text-ink-2">Warm-up<Input type="number" min={0} max={10} value={mc.warmup_days} onChange={(e) => setMc({ ...mc, warmup_days: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })} /></label>
            </div>
            <div className="text-[10.5px] text-wait mb-1.5">The full design (30 replications of 30 days) takes a few minutes. Lower the replications for a quick look.</div>
            <Button className="w-full" icon={Sigma} disabled={!canRun || job.running} title={runTitle} onClick={() => job.start("/sim/monte-carlo", { config: c, ...mc })}>Monte Carlo, all six scenarios</Button>
          </div>
          {(job.job || job.error) && <div className="border-t border-line pt-2 mt-3"><JobStatus job={job.job} error={job.error} /></div>}
        </Panel>

        <Panel title="Saved experiments" pad={false} actions={<Button size="sm" variant="ghost" icon={RefreshCw} onClick={refreshExp}>Refresh</Button>}>
          {expErr && <div className="p-2"><ErrorBox text={expErr} /></div>}
          {!expData && expLoading ? <Loading text="Loading experiments" /> : !expData?.items.length ? <Empty text="No experiments yet. Run one above." /> : (
            <ul className="max-h-[420px] overflow-auto divide-y divide-line/60">
              {expData.items.map((e) => (
                <li key={e.id} className="px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[12px] text-ink truncate flex-1" title={e.name}>{e.name}</span>
                    <Badge tone={statusTone(e.status)}>{e.status === "DONE" ? "Finished" : e.status === "FAILED" ? "Failed" : `Running ${Math.round((e.progress || 0) * 100)}%`}</Badge>
                  </div>
                  <div className="text-[10.5px] text-ink-3 truncate" title={configSummary(e.config)}>{configSummary(e.config)}</div>
                  {e.status === "FAILED" && e.message && <div className="text-[10.5px] text-stop truncate" title={e.message}>{e.message}</div>}
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10.5px] text-ink-3 num">{fmtDateTime(e.created_at)}, {e.created_by}</span>
                    <span className="ml-auto flex items-center gap-2">
                      {e.status === "DONE" && <ExportLinks id={e.id} />}
                      <button
                        className="text-[11px] text-accent hover:underline cursor-pointer disabled:opacity-50"
                        disabled={e.status === "FAILED"}
                        onClick={() => (TAB_FOR[e.kind] ? onOpen(TAB_FOR[e.kind], e.id) : job.watch(e.id))}
                      >
                        Open
                      </button>
                      <button
                        aria-label={`Delete ${e.name}`}
                        title={canRun ? "Delete" : NO_RUN}
                        disabled={!canRun}
                        className="text-ink-3 hover:text-stop cursor-pointer disabled:opacity-50"
                        onClick={async () => {
                          if (!window.confirm(`Delete ${e.name}?`)) return;
                          try {
                            await api(`/sim/experiments/${e.id}`, { method: "DELETE" });
                            refreshExp();
                          } catch (err) {
                            window.alert((err as Error).message);
                          }
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <KVNote ctx={ctx} />
      </div>
    </div>
  );
}

function KVNote({ ctx }: { ctx: SimCtx }) {
  const c = ctx.config;
  if (!c) return null;
  const service = c.lane_headway_m / (c.lane_speed_kmh / 3.6);
  return (
    <Panel title="What this draft implies" tag={<Provenance kind="ASSUMED" />}>
      <KV
        items={[
          ["Lane capacity", `${n(3600 / service, 0)} trucks per h`],
          ["Lane service", `${n(service, 1)} s per truck`],
          ["Static service", `${n(Math.max(0.5, c.static_stop_min - c.stop_overhead_min), 1)} min, after ${n(c.stop_overhead_min, 1)} min overhead`],
          ["Road margin", `${n(c.measurement_margin_k * c.road_error_pct, 2)}% (k x error)`],
        ]}
      />
    </Panel>
  );
}
