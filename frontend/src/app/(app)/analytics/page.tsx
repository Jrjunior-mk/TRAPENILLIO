"use client";
import { Download, Play, Zap } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Bars, CIBars, SERIES, STATUS, StackedAreas, TimeLines, Tornado } from "@/components/charts";
import { asUtc } from "@/components/portals/shared";
import { PageTitle } from "@/components/shell";
import { Badge, Button, DataTable, Empty, ErrorBox, Field, Input, KV, Loading, Meter, Note, Panel, Provenance, Select } from "@/components/ui";
import { useApi, useJob } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtDateTime, fmtInt, fmtNum, siteName } from "@/lib/format";
import { useLive } from "@/lib/live";

interface CI { mean: number; ci_low: number; ci_high: number; half_width: number; n: number }
interface McScenario { label: string; note: string; metrics: Record<string, CI> }
interface McResult {
  kind: string; config: Record<string, number>; scenarios: Record<string, McScenario>; conservation_ok: boolean;
  design: { replications: number; days: number; warmup_days: number; common_random_numbers: boolean; base_seed: number; trucks_simulated: number };
}
interface TornadoRow { factor: string; label: string; low_value: number; high_value: number; low: number; high: number; swing: number }
interface TornadoResult { kind: string; scenario: string; metric: string; base: Record<string, number>; tables: Record<string, TornadoRow[]>; design: { days: number; reps: number } }
interface ExpMeta { id: string; name: string; kind: string; status: string; progress: number; message: string | null; created_by: string; created_at: string; finished_at: string | null }
interface Exp<T> extends ExpMeta { result: T | null }
interface ScenarioOption { id: string; label: string; note: string }

const BASELINE = "as_is";
const SCENARIO_ORDER = [BASELINE, "rcs_v1", "v2_port", "v2_all", "v2_high_coverage", "v2_approved"];
const V2_KEYS = ["v2_all", "v2_port", "v2_high_coverage", "v2_approved"];
const MC_METRICS: { key: string; label: string; short: string; unit?: string; digits: number; note?: string }[] = [
  { key: "truck_hours_saved_per_day", label: "Truck-hours saved per day", short: "Hours saved/day", unit: " h", digits: 1, note: "paired against the existing process with common random numbers" },
  { key: "avg_delay_min", label: "Average delay", short: "Avg delay (min)", unit: " min", digits: 2 },
  { key: "p95_delay_min", label: "95th-percentile delay", short: "P95 delay (min)", unit: " min", digits: 2 },
  { key: "stops_per_1000", label: "Stops per 1,000 trucks", short: "Stops/1,000", digits: 1, note: "road static stops plus port re-weighs" },
  { key: "road_stops_per_1000", label: "Road stops per 1,000 trucks", short: "Road stops/1,000", digits: 1 },
  { key: "lane_per_1000", label: "Lane passes per 1,000 trucks", short: "Lane/1,000", digits: 1 },
  { key: "port_reweigh_pct", label: "Port re-weigh", short: "Port re-weigh %", unit: "%", digits: 2, note: "share of enrolled port trucks" },
  { key: "false_clear_pct", label: "False-clear rate", short: "False-clear %", unit: "%", digits: 3 },
  { key: "static_utilization_pct", label: "Static utilization", short: "Static util. %", unit: "%", digits: 1, note: "busiest station" },
  { key: "max_static_queue", label: "Maximum static queue", short: "Max static queue", digits: 1, note: "trucks, busiest station" },
];
const TORNADO_METRICS: Record<string, { label: string; unit?: string }> = {
  road_stops_per_1000: { label: "Road stops per 1,000 trucks" },
  delay_hours_per_day: { label: "Delay hours per day", unit: " h" },
  false_clear_pct: { label: "False-clear rate", unit: "%" },
  lane_per_1000: { label: "Lane passes per 1,000 trucks" },
  port_reweigh_pct: { label: "Port re-weigh share", unit: "%" },
  p95_delay_min: { label: "95th-percentile delay", unit: " min" },
};
const LIVE_SITES = ["port_node", "dongo_kundu", "mariakani", "mtwapa"];
const SITE_COLORS = [SERIES.s1, SERIES.s2, SERIES.s3, SERIES.s4];

const intIn = (raw: string, min: number, max: number) => {
  const v = Number(raw);
  return raw.trim() !== "" && Number.isInteger(v) && v >= min && v <= max ? v : null;
};
const scenarioKeys = (r: McResult) => Object.keys(r.scenarios).sort((a, b) => (SCENARIO_ORDER.indexOf(a) + 100) % 100 - (SCENARIO_ORDER.indexOf(b) + 100) % 100);

/** List, selection, detail and job for one experiment kind. The newest finished result loads by itself. */
function useExperiments<T>(kind: string) {
  const list = useApi<{ items: ExpMeta[] }>(`/sim/experiments?kind=${kind}&limit=40`, 20000);
  const job = useJob<T>();
  const [picked, setPicked] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const tried = useRef(false);
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const newestDone = items.find((e) => e.status === "DONE")?.id ?? null;
  const { watch } = job;

  useEffect(() => {
    if (!picked && newestDone) setPicked(newestDone);
  }, [picked, newestDone]);

  // Pick up a run that was started before this page opened
  useEffect(() => {
    if (tried.current || !list.data) return;
    tried.current = true;
    const live = list.data.items.find((e) => e.status === "RUNNING");
    if (live) {
      setAttached(true);
      watch(live.id);
    }
  }, [list.data, watch]);

  const jobId = job.job?.id;
  const jobStatus = job.job?.status;
  const refreshList = list.refresh;
  useEffect(() => {
    if (!jobId || !jobStatus || jobStatus === "RUNNING") return;
    if (jobStatus === "DONE") setPicked(jobId);
    setAttached(false);
    refreshList();
  }, [jobId, jobStatus, refreshList]);

  const detail = useApi<Exp<T>>(picked ? `/sim/experiments/${picked}` : null);
  const current = detail.data && detail.data.id === picked ? detail.data : null;
  const start = (path: string, body: unknown) => {
    setAttached(false);
    return job.start(path, body);
  };
  return { list, items, picked, setPicked, current, detailError: picked && !current ? detail.error : null, job, start, newestDone, busy: job.running && !attached, attached };
}

function Section({ title, sub, tag, actions, children }: { title: string; sub?: ReactNode; tag?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-4">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {tag}
        {sub && <span className="text-[11.5px] text-ink-3">{sub}</span>}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function Legend() {
  return (
    <div className="border border-line bg-bg-2 rounded-sm px-3 py-2 grid gap-2 md:grid-cols-3 text-[11.5px] text-ink-2">
      <div className="flex items-start gap-2"><Provenance kind="MODELLED" /><span>Simulation results. Computed by the models from the inputs below.</span></div>
      <div className="flex items-start gap-2"><Provenance kind="ASSUMED" /><span>Inputs to those models that have not been measured in the field.</span></div>
      <div className="flex items-start gap-2"><Provenance kind="MEASURED" /><span>Real timings on this machine only. There is no field data.</span></div>
    </div>
  );
}

function LiveSection() {
  const kpi = useLive((s) => s.kpi);
  const q = useApi<{ series: Record<string, number | string | null>[] }>("/live/series", 5000);
  const series = useMemo(() => q.data?.series ?? [], [q.data]);
  const [samples, setSamples] = useState<Record<string, number | string>[]>([]);
  useEffect(() => {
    const take = () => {
      const k = useLive.getState().kpi;
      if (!k) return;
      const row: Record<string, number | string> = { t: new Date(k.now).toLocaleTimeString("en-GB", { timeZone: "Africa/Nairobi", hour12: false, hour: "2-digit", minute: "2-digit" }) };
      for (const id of LIVE_SITES) {
        const s = k.stations.find((x) => x.id === id);
        row[id] = s ? s.lane_queue + s.static_queue : 0;
      }
      setSamples((prev) => [...prev.slice(-179), row]);
    };
    take();
    const id = setInterval(take, 5000);
    return () => clearInterval(id);
  }, []);
  const stations = (kpi?.stations ?? []).filter((s) => s.kind !== "origin").map((s) => ({ name: siteName(s.id), util: Math.round(s.bay_utilization * 1000) / 10 }));

  const chart = (node: ReactNode) => (!q.data ? (q.error ? <ErrorBox text={q.error} /> : <Loading />) : series.length ? node : <Empty text="No samples yet for today." />);
  return (
    <Section title="Live operations today" tag={<Provenance kind="SIMULATED" title="Produced by the live engine, not real infrastructure" />} sub="15-minute bins of the simulated day, refreshing every 5 s">
      <div className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-4">
        <Panel title="Clearance outcomes" sub="decisions per bin">
          {chart(<StackedAreas data={series} height={170} series={[{ key: "green", label: "Green", color: STATUS.go }, { key: "amber", label: "Amber", color: STATUS.wait }, { key: "red", label: "Red", color: STATUS.stop }]} />)}
        </Panel>
        <Panel title="Truck throughput" sub="trucks entering per bin">
          {chart(<TimeLines data={series} height={170} series={[{ key: "arrivals", label: "Trucks entering", color: SERIES.s1 }]} />)}
        </Panel>
        <Panel title="Token coverage" sub="at the first road station">
          {chart(<TimeLines data={series} height={170} unit="%" yDomain={[0, 100]} series={[{ key: "coverage", label: "Coverage", color: SERIES.s1 }]} />)}
        </Panel>
        <Panel title="Average waiting time" sub="clearance delay of trucks leaving in the bin">
          {chart(<TimeLines data={series} height={170} unit=" min" series={[{ key: "avg_delay_min", label: "Average delay", color: SERIES.s1 }]} />)}
        </Panel>
        <Panel title="Station utilization" sub="bay busy share so far today">
          {!kpi ? <Loading text="Connecting to the live stream" /> : stations.length ? <Bars data={stations} x="name" layout="horizontal" xWidth={84} unit="%" height={170} series={[{ key: "util", label: "Bay utilization", color: SERIES.s1 }]} /> : <Empty text="No stations reported." />}
        </Panel>
        <Panel title="Average queue over time" sub="trucks per site, lane and static">
          {chart(<TimeLines data={series} height={170} series={[{ key: "queue", label: "Average queue", color: SERIES.s1 }]} />)}
        </Panel>
        <Panel title="Queue by site" sub="lane plus static, sampled every 5 s since this page opened">
          {samples.length ? <StackedAreas data={samples} height={170} series={LIVE_SITES.map((id, i) => ({ key: id, label: siteName(id), color: SITE_COLORS[i] }))} /> : <Loading text="Connecting to the live stream" />}
        </Panel>
        <Panel title="Availability" sub="port and road sites, cloud link">
          {chart(<TimeLines data={series} height={170} unit="%" yDomain={[0, 100]} series={[{ key: "availability", label: "Availability", color: SERIES.s1 }]} />)}
        </Panel>
      </div>
    </Section>
  );
}

function JobStatus({ job, error, attached }: { job: { progress: number; message?: string | null; status: string; id: string } | null; error: string | null; attached: boolean }) {
  return (
    <>
      {job?.status === "RUNNING" && (
        <div className="mt-3">
          <div className="flex justify-between text-[11px] mb-1"><span className="text-ink-2 truncate">{job.message || "Starting"}</span><span className="num text-ink">{Math.round(job.progress * 100)}%</span></div>
          <Meter value={job.progress} tone="var(--color-accent)" />
          {attached && <p className="text-[10.5px] text-ink-3 mt-1">Following {job.id}, started earlier. If the backend restarted since then, this run will not finish and you can start a new one.</p>}
        </div>
      )}
      {error && <div className="mt-3"><ErrorBox text={error} /></div>}
    </>
  );
}

function ExperimentSelect({ items, value, onChange, label }: { items: ExpMeta[]; value: string | null; onChange: (id: string) => void; label: string }) {
  return (
    <Select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value)} className="!h-7 !w-[340px] max-w-full" disabled={!items.length}>
      {!items.length && <option value="">No experiments yet</option>}
      {items.map((e) => (
        <option key={e.id} value={e.id} disabled={e.status !== "DONE"}>
          {e.name}, {fmtDateTime(asUtc(e.created_at))}{e.status !== "DONE" ? ` (${e.status.toLowerCase()})` : ""}
        </option>
      ))}
    </Select>
  );
}

function ExportLinks({ id }: { id: string }) {
  const cls = "inline-flex items-center gap-1.5 h-7 px-2 rounded-sm border border-line-2 bg-panel-2 text-ink text-[11px] font-medium hover:bg-line";
  return (
    <>
      <a className={cls} href={`/api/sim/experiments/${id}/export.csv`}><Download size={12} />CSV</a>
      <a className={cls} href={`/api/sim/experiments/${id}/export.pdf`}><Download size={12} />PDF</a>
    </>
  );
}

function MonteCarloSection({ exp, options, optionsError }: { exp: ReturnType<typeof useExperiments<McResult>>; options: ScenarioOption[]; optionsError: string | null }) {
  const { can } = useAuth();
  const [reps, setReps] = useState("30");
  const [days, setDays] = useState("30");
  const [warm, setWarm] = useState("2");
  const [chosen, setChosen] = useState<string[] | null>(null);
  const allowed = can("sim.run");
  const selected = chosen ?? options.map((o) => o.id);
  const repsN = intIn(reps, 2, 100);
  const daysN = intIn(days, 1, 60);
  const warmN = intIn(warm, 0, 10);
  const valid = repsN !== null && daysN !== null && warmN !== null;
  const toggle = (id: string) => setChosen(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const scenarios = selected.length ? Array.from(new Set([BASELINE, ...selected])) : [BASELINE];
  const run = (r: number, d: number, w: number) => exp.start("/sim/monte-carlo", { replications: r, days: d, warmup_days: w, scenarios });
  const result = exp.current?.status === "DONE" ? exp.current.result : null;
  const noneDone = !!exp.list.data && !exp.newestDone;
  const runCount = valid ? scenarios.length * repsN : null;

  return (
    <Section title="Monte Carlo experiment" tag={<Provenance kind="MODELLED" />} sub="replications per scenario with common random numbers and 95% confidence intervals">
      <Panel>
        <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
          <div className="grid grid-cols-3 gap-2 content-start">
            <Field label="Replications" error={repsN === null ? "2 to 100" : null}><Input type="number" min={2} max={100} value={reps} onChange={(e) => setReps(e.target.value)} /></Field>
            <Field label="Days" error={daysN === null ? "1 to 60" : null}><Input type="number" min={1} max={60} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
            <Field label="Warm-up days" error={warmN === null ? "0 to 10" : null}><Input type="number" min={0} max={10} value={warm} onChange={(e) => setWarm(e.target.value)} /></Field>
          </div>
          <div>
            <div className="text-[11px] text-ink-2 mb-1">Scenarios</div>
            {optionsError && <ErrorBox text={optionsError} />}
            {!options.length && !optionsError && <Loading text="Loading scenarios" />}
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {options.map((o) => (
                <label key={o.id} title={o.note} className="flex items-center gap-1.5 text-[11.5px] text-ink cursor-pointer">
                  <input type="checkbox" className="accent-[#38bdf8]" checked={o.id === BASELINE || selected.includes(o.id)} disabled={o.id === BASELINE} onChange={() => toggle(o.id)} />
                  {o.label}{o.id === BASELINE && <span className="text-ink-3">(baseline, always included)</span>}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap mt-3">
          <Button variant="primary" icon={Play} loading={exp.job.running && !exp.attached} disabled={!valid || !allowed || exp.busy} onClick={() => valid && run(repsN, daysN, warmN)}>Run experiment</Button>
          <Button icon={Zap} disabled={!allowed || exp.busy} onClick={() => run(5, 5, 2)}>Quick run (5 replications, 5 days)</Button>
          {runCount !== null && <span className="text-[11px] text-ink-3 num">{fmtInt(runCount)} simulation runs for this form. Long experiments keep running if you leave the page.</span>}
          {!allowed && <span className="text-[11px] text-wait">Your role does not include sim.run. You can still read results.</span>}
          <span className="ml-auto flex items-center gap-2">
            <ExperimentSelect label="Past Monte Carlo experiments" items={exp.items} value={exp.picked} onChange={exp.setPicked} />
            {result && exp.picked && <ExportLinks id={exp.picked} />}
          </span>
        </div>
        <JobStatus job={exp.job.job} error={exp.job.error} attached={exp.attached} />
        {exp.list.error && !exp.list.data && <div className="mt-3"><ErrorBox text={exp.list.error} /></div>}
      </Panel>

      {noneDone && exp.job.job?.status !== "RUNNING" && (
        <Panel className="mt-2">
          <div className="text-center py-5">
            <p className="text-[12px] text-ink">No Monte Carlo experiment has finished yet.</p>
            <p className="text-[11.5px] text-ink-3 mt-1 max-w-[70ch] mx-auto">Choose the scenarios and the replications, days and warm-up above, then press Run experiment. Results appear here when it finishes. For a first look, a small run takes far less time, though its intervals will be wide.</p>
            <Button className="mt-3" icon={Zap} disabled={!allowed || exp.busy} onClick={() => run(5, 5, 2)}>Quick run (5 replications, 5 days)</Button>
          </div>
        </Panel>
      )}
      {exp.detailError && <div className="mt-2"><ErrorBox text={exp.detailError} /></div>}
      {exp.picked && !exp.current && !exp.detailError && <Panel className="mt-2"><Loading text="Loading the experiment" /></Panel>}
      {exp.current && !result && <Panel className="mt-2"><Empty text={exp.current.message || "This experiment has no result."} /></Panel>}
      {result && <McResults result={result} />}
    </Section>
  );
}

function McResults({ result }: { result: McResult }) {
  const keys = scenarioKeys(result);
  const rows = keys.map((k) => ({ key: k, ...result.scenarios[k] }));
  return (
    <>
      <Panel className="mt-2" title="Experiment design">
        <KV
          cols={6}
          items={[
            ["Replications per scenario", <span key="r" className="num">{result.design.replications}</span>],
            ["Days per replication", <span key="d" className="num">{result.design.days}</span>],
            ["Warm-up days", <span key="w" className="num">{result.design.warmup_days}</span>],
            ["Common random numbers", result.design.common_random_numbers ? "Yes, paired across scenarios" : "No"],
            ["Trucks simulated", <span key="t" className="num">{fmtInt(result.design.trucks_simulated)}</span>],
            ["Truck conservation", result.conservation_ok ? "Every truck that entered also left" : <Badge key="c" tone="stop">Check failed</Badge>],
          ]}
        />
      </Panel>
      <div className="grid gap-2 mt-2 lg:grid-cols-2 2xl:grid-cols-3">
        {MC_METRICS.map((m) => (
          <Panel key={m.key} title={m.label} sub={m.note}>
            <CIBars
              height={Math.max(150, rows.length * 30 + 34)}
              unit={m.unit}
              xWidth={150}
              data={rows.map((r) => {
                const v = r.metrics[m.key] ?? { mean: 0, ci_low: 0, ci_high: 0 };
                return { label: r.label, mean: v.mean, err: [v.mean - v.ci_low, v.ci_high - v.mean] as [number, number] };
              })}
            />
          </Panel>
        ))}
      </div>
      <Panel className="mt-2" title="Results" sub="mean ± 95% half width. Modelled, not measured." pad={false}>
        <DataTable<(typeof rows)[number]>
          rows={rows}
          rowKey={(r) => r.key}
          cols={[
            { key: "label", label: "Scenario", render: (r) => <span className="flex items-center gap-1.5 text-ink whitespace-nowrap">{r.label}{r.key === BASELINE && <Badge tone="accent">Baseline</Badge>}</span> },
            ...MC_METRICS.map((m) => ({
              key: m.key,
              label: m.short,
              align: "right" as const,
              mono: true,
              render: (r: (typeof rows)[number]) => {
                const v = r.metrics[m.key];
                return v ? <span className="whitespace-nowrap">{fmtNum(v.mean, m.digits)} <span className="text-ink-3">± {fmtNum(v.half_width, m.digits)}</span></span> : "-";
              },
            })),
          ]}
        />
      </Panel>
    </>
  );
}

function SensitivitySection({ options }: { options: ScenarioOption[] }) {
  const { can } = useAuth();
  const exp = useExperiments<TornadoResult>("tornado");
  const [scenario, setScenario] = useState("v2_all");
  const [days, setDays] = useState("5");
  const [reps, setReps] = useState("4");
  const [metric, setMetric] = useState("road_stops_per_1000");
  const daysN = intIn(days, 1, 30);
  const repsN = intIn(reps, 1, 30);
  const allowed = can("sim.run");
  const result = exp.current?.status === "DONE" ? exp.current.result : null;
  const table = result?.tables[metric] ?? [];
  const base = result?.base[metric];
  const unit = TORNADO_METRICS[metric]?.unit;
  const top = table[0];
  const scenarioLabel = result ? options.find((o) => o.id === result.scenario)?.label ?? result.scenario : "";
  return (
    <Section title="Sensitivity" tag={<Provenance kind="MODELLED" />} sub="one factor at a time over the RCS v2 s10.4 ranges, with common random numbers across levels">
      <Panel>
        <div className="flex items-end gap-2 flex-wrap">
          <Field label="Scenario" className="w-64"><Select value={scenario} onChange={(e) => setScenario(e.target.value)}>{options.length ? options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>) : <option value="v2_all">RCS v2, all three streams</option>}</Select></Field>
          <Field label="Days" className="w-20" error={daysN === null ? "1 to 30" : null}><Input type="number" min={1} max={30} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
          <Field label="Replications" className="w-24" error={repsN === null ? "1 to 30" : null}><Input type="number" min={1} max={30} value={reps} onChange={(e) => setReps(e.target.value)} /></Field>
          <Button variant="primary" icon={Play} loading={exp.job.running && !exp.attached} disabled={daysN === null || repsN === null || !allowed || exp.busy} onClick={() => exp.start("/sim/tornado", { scenario, days: daysN, reps: repsN })}>Run sensitivity</Button>
          {!allowed && <span className="text-[11px] text-wait">Your role does not include sim.run. You can still read results.</span>}
          <span className="ml-auto flex items-center gap-2">
            <ExperimentSelect label="Past sensitivity experiments" items={exp.items} value={exp.picked} onChange={exp.setPicked} />
            {result && exp.picked && <ExportLinks id={exp.picked} />}
          </span>
        </div>
        <JobStatus job={exp.job.job} error={exp.job.error} attached={exp.attached} />
        {exp.list.error && !exp.list.data && <div className="mt-3"><ErrorBox text={exp.list.error} /></div>}
      </Panel>
      {!!exp.list.data && !exp.newestDone && exp.job.job?.status !== "RUNNING" && <Panel className="mt-2"><Empty text="No sensitivity experiment has finished yet. Choose a scenario and press Run sensitivity." /></Panel>}
      {exp.detailError && <div className="mt-2"><ErrorBox text={exp.detailError} /></div>}
      {exp.picked && !exp.current && !exp.detailError && <Panel className="mt-2"><Loading text="Loading the experiment" /></Panel>}
      {exp.current && !result && <Panel className="mt-2"><Empty text={exp.current.message || "This experiment has no result."} /></Panel>}
      {result && (
        <Panel
          className="mt-2"
          title="Tornado"
          sub={`${scenarioLabel}, ${result.design.days} days, ${result.design.reps} replications`}
          actions={<Select aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value)} className="!h-6 !w-56 !text-[11px]">{Object.entries(TORNADO_METRICS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>}
        >
          {table.length && base !== undefined ? (
            <>
              <p className="text-[12px] text-ink mb-2">
                {top.swing > 0
                  ? <>The top factor is <span className="font-semibold">{top.label}</span>: moving it from {top.low_value} to {top.high_value} takes {TORNADO_METRICS[metric]?.label.toLowerCase()} from {fmtNum(top.low, 2)}{unit} to {fmtNum(top.high, 2)}{unit}, against a base of {fmtNum(base, 2)}{unit}.</>
                  : <>None of the factors moved {TORNADO_METRICS[metric]?.label.toLowerCase()} in this run.</>}
              </p>
              <Tornado rows={table} base={base} unit={unit} />
            </>
          ) : <Empty text="This experiment has no table for the selected metric." />}
        </Panel>
      )}
    </Section>
  );
}

function GateSection({ newestDone }: { newestDone: string | null }) {
  const q = useApi<Exp<McResult>>(newestDone ? `/sim/experiments/${newestDone}` : null);
  const exp = q.data && q.data.id === newestDone ? q.data : null;
  const r = exp?.result ?? null;
  const base = r?.scenarios[BASELINE]?.metrics;
  const rows = r && base
    ? V2_KEYS.filter((k) => r.scenarios[k]).map((k) => {
        const m = r.scenarios[k].metrics;
        const b = base.first_station_static_pct;
        const v = m.first_station_static_pct;
        const cut = b.mean - v.mean;
        const cutLow = b.ci_low - v.ci_high;
        const fc = m.false_clear_pct;
        const reweighPer1000 = m.stops_per_1000.mean - m.road_stops_per_1000.mean;
        return { key: k, label: r.scenarios[k].label, b, v, cut, cutLow, fc, road: m.road_stops_per_1000, baseRoad: base.road_stops_per_1000, reweigh: m.port_reweigh_pct, reweighPerDay: (reweighPer1000 / 1000) * (r.config.trucks_per_day ?? 0), pass: cut >= 10 && fc.mean <= 1, robust: cutLow >= 10 && fc.ci_high <= 1 };
      })
    : [];
  const lead = rows[0];
  const capacityPerH = r && r.config.port_reweigh_min ? (r.config.port_reweigh_lanes * 60) / r.config.port_reweigh_min : null;
  return (
    <Section title="Go/no-go gate" tag={<Provenance kind="MODELLED" title="Computed from simulation results, not field data" />} sub="RCS v2 s10.9, against the latest finished Monte Carlo">
      <Panel>
        <div className="border border-wait/40 bg-wait/10 text-ink text-[11.5px] rounded-sm px-3 py-2 mb-3">This check is modelled. The document requires a validated model with measured baselines before a go decision. Neither exists here, so a pass below shows what the assumed inputs imply and is not a go decision.</div>
        {!newestDone ? <Empty text="The gate needs a finished Monte Carlo experiment. Run one above." />
          : !exp ? (q.error ? <ErrorBox text={q.error} /> : <Loading text="Loading the latest experiment" />)
          : !lead ? <Empty text="The latest experiment has no RCS v2 scenario to test. Run one that includes an RCS v2 scenario." />
          : (
            <>
              <p className="text-[12px] text-ink mb-1 flex items-center gap-2 flex-wrap">
                <span>{lead.label} {lead.pass ? "meets" : "does not meet"} the test on modelled means: {fmtNum(lead.cut, 1)} points cut in road stop share against a 10-point test, false-clear rate {fmtNum(lead.fc.mean, 3)}% against a 1% ceiling.</span>
                <Badge tone={lead.pass ? "go" : "stop"}>{lead.pass ? "Model passes" : "Model fails"}</Badge>
              </p>
              <p className="text-[11px] text-ink-3 mb-2">Road stop share is the share of trucks sent to static weighing at their first station. Source: {exp.name}, {fmtDateTime(asUtc(exp.created_at))}. {r!.design.replications < 30 && "This experiment has fewer than 30 replications, so its intervals are wide."}</p>
              <DataTable
                rows={rows}
                rowKey={(x) => x.key}
                cols={[
                  { key: "label", label: "Scenario", render: (x) => <span className="text-ink whitespace-nowrap">{x.label}</span> },
                  { key: "share", label: "Road stop share", align: "right", mono: true, render: (x) => `${fmtNum(x.b.mean, 1)}% to ${fmtNum(x.v.mean, 1)}%` },
                  { key: "cut", label: "Points cut (test: 10 or more)", align: "right", mono: true, render: (x) => fmtNum(x.cut, 1) },
                  { key: "stops", label: "Road stops/1,000", align: "right", mono: true, render: (x) => `${fmtNum(x.baseRoad.mean, 0)} to ${fmtNum(x.road.mean, 0)}` },
                  { key: "fc", label: "False-clear (test: 1% or less)", align: "right", mono: true, render: (x) => `${fmtNum(x.fc.mean, 3)}% ± ${fmtNum(x.fc.half_width, 3)}` },
                  { key: "verdict", label: "On means", render: (x) => <Badge tone={x.pass ? "go" : "stop"}>{x.pass ? "Model passes" : "Model fails"}</Badge> },
                  { key: "robust", label: "At 95% interval bounds", render: (x) => (x.robust ? <Badge tone="go">Still passes</Badge> : <Badge tone="wait">Not at the bounds</Badge>) },
                ]}
              />
              <div className="mt-3 pt-3 border-t border-line">
                <div className="text-[12px] font-semibold text-ink mb-1">Port re-weigh load for KPA</div>
                <DataTable
                  rows={rows}
                  rowKey={(x) => x.key}
                  cols={[
                    { key: "label", label: "Scenario", render: (x) => <span className="text-ink whitespace-nowrap">{x.label}</span> },
                    { key: "pct", label: "Share of enrolled port trucks", align: "right", mono: true, render: (x) => `${fmtNum(x.reweigh.mean, 2)}% ± ${fmtNum(x.reweigh.half_width, 2)}` },
                    { key: "day", label: "Re-weighs per day", align: "right", mono: true, render: (x) => fmtInt(x.reweighPerDay) },
                  ]}
                />
                <p className="text-[11px] text-ink-3 mt-1.5">Re-weighs per day are all stops less road stops, per 1,000 trucks, at the assumed {fmtInt(r!.config.trucks_per_day)} trucks per day.{capacityPerH !== null && ` Assumed re-weigh capacity is ${fmtNum(capacityPerH, 0)} trucks per hour. KPA would need to confirm both.`}</p>
              </div>
            </>
          )}
      </Panel>
    </Section>
  );
}

const paramLabel = (k: string) => {
  const s = k.replace(/_pct$/, " (%)").replace(/_min$/, " (min)").replace(/_kmh$/, " (km/h)").replace(/_m$/, " (m)").replace(/_/g, " ");
  return s[0].toUpperCase() + s.slice(1);
};

function InputsSection() {
  const q = useApi<{ config: Record<string, unknown>; provenance: Record<string, string> }>("/live/config");
  const rows = useMemo(() => Object.entries(q.data?.provenance ?? {}).filter(([, v]) => v.startsWith("ASSUMED")).map(([k, v]) => ({ key: k, note: v.replace(/^ASSUMED[,:]?\s*/, ""), value: q.data?.config[k] })), [q.data]);
  const other = Object.keys(q.data?.provenance ?? {}).length - rows.length;
  return (
    <Section title="Inputs still needing real-world measurement" tag={<Provenance kind="ASSUMED" />} sub="every modelled result above depends on these">
      <Panel pad={false}>
        {!q.data ? <div className="p-3">{q.error ? <ErrorBox text={q.error} /> : <Loading text="Loading inputs" />}</div> : (
          <>
            <DataTable
              rows={rows}
              rowKey={(r) => r.key}
              empty="No inputs are labelled as assumed."
              cols={[
                { key: "name", label: "Input", render: (r) => <span className="text-ink">{paramLabel(r.key)}</span> },
                { key: "value", label: "Current value", align: "right", mono: true, render: (r) => String(r.value ?? "-") },
                { key: "tag", label: "Label", render: () => <Provenance kind="ASSUMED" /> },
                { key: "note", label: "Basis", render: (r) => <span className="text-ink-2 text-[11.5px]">{r.note}</span> },
              ]}
            />
            <div className="px-3 py-2 border-t border-line text-[11px] text-ink-3">{other} further inputs carry other labels (source, derived, proposed, target or design) and are not listed here.</div>
          </>
        )}
      </Panel>
    </Section>
  );
}

export default function AnalyticsPage() {
  const mc = useExperiments<McResult>("monte_carlo");
  const scen = useApi<{ scenarios: ScenarioOption[] }>("/sim/l2/scenarios");
  const options = useMemo(() => {
    const list = scen.data?.scenarios ?? [];
    return [...list].sort((a, b) => (SCENARIO_ORDER.indexOf(a.id) + 100) % 100 - (SCENARIO_ORDER.indexOf(b.id) + 100) % 100);
  }, [scen.data]);
  return (
    <div className="p-3">
      <PageTitle title="Analytics and performance" sub="Today's simulated operations, repeatable experiments with confidence intervals, sensitivity and the RCS v2 go/no-go test." />
      <Legend />
      <LiveSection />
      <MonteCarloSection exp={mc} options={options} optionsError={scen.data ? null : scen.error} />
      <SensitivitySection options={options} />
      <GateSection newestDone={mc.newestDone} />
      <InputsSection />
      <div className="mt-4"><Note>Exports carry the experiment id and state that results are modelled from assumed inputs. No figure on this page comes from field measurement.</Note></div>
    </div>
  );
}
