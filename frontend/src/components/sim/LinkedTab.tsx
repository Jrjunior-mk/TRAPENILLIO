"use client";
import { ArrowRight, Play } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { SERIES, TimeLines } from "@/components/charts";
import { Button, DataTable, Empty, Field, Input, Kpi, KV, Panel, Provenance, Select } from "@/components/ui";
import { useJob } from "@/lib/api";
import { fmtInt } from "@/lib/format";
import { JobStatus, n, NO_RUN, type OpenRequest, ScenarioSelect, type SimCtx, STATION_OPTIONS, Toggle, useScenarios } from "./common";
import { queueSeries } from "./L3Tab";

function Step({ level, title, values, trace, muted }: { level: string; title: string; values: [string, string][]; trace?: string; muted?: boolean }) {
  return (
    <div className={`border border-line-2 bg-bg-2 rounded-sm p-2.5 flex-1 min-w-0 ${muted ? "opacity-60" : ""}`}>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="num text-[13px] font-semibold text-accent">{level}</span>
        <span className="text-[11.5px] text-ink-2 truncate">{title}</span>
      </div>
      <dl className="flex flex-col gap-1">
        {values.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 text-[11.5px]">
            <dt className="text-ink-3 truncate">{k}</dt>
            <dd className="num text-ink whitespace-nowrap">{v}</dd>
          </div>
        ))}
      </dl>
      {trace && <div className="text-[10.5px] text-ink-3 mt-1.5 border-t border-line pt-1">{trace}</div>}
    </div>
  );
}

export function LinkedTab({ ctx, open }: { ctx: SimCtx; open?: OpenRequest }) {
  const { scenarios } = useScenarios();
  const job = useJob<any>();
  const [scenario, setScenario] = useState("v2_all");
  const [station, setStation] = useState("mariakani");
  const [days, setDays] = useState(2);
  const [applyL1, setApplyL1] = useState(true);

  useEffect(() => {
    if (open?.id) job.watch(open.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.n]);

  const r = job.job?.status === "DONE" ? (job.job as any).result : null;
  const trace: string[] = r?.trace ?? [];
  const line = (level: string) => trace.find((t) => t.startsWith(level));
  const chosen = r ? r.l2.scenarios[r.scenario] : null;
  const rows: any[] = r ? Object.values(r.l2.scenarios) : [];
  const v2 = r?.l3?.[r.scenario];
  const asIs = r?.l3?.as_is;
  const compare = r && v2 && asIs && r.scenario !== "as_is";
  const vs = compare ? queueSeries(v2) : [];
  const existing = compare ? queueSeries(asIs) : [];
  const joined = vs.map((s, i) => ({ t: s.t, v2lane: s.lane, v2static: s.static, aslane: existing[i]?.lane, asstatic: existing[i]?.static }));
  const chosenLabel = chosen?.label ?? r?.scenario;
  const l4 = r?.l4;
  const l1 = ctx.l1;

  return (
    <div className="flex flex-col gap-2 pt-2">
      <Panel title="Linked run" sub="L1 sets scale errors, L2 uses them, L3 and L4 take their demand from L2" tag={<Provenance kind="ASSUMED" title="All inputs are assumptions" />}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Scenario" className="w-56"><ScenarioSelect value={scenario} onChange={setScenario} scenarios={scenarios} /></Field>
          <Field label="L3 station" className="w-36">
            <Select value={station} onChange={(e) => setStation(e.target.value)}>
              {STATION_OPTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
          </Field>
          <Field label="L2 days" className="w-20"><Input type="number" min={1} max={10} value={days} onChange={(e) => setDays(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} /></Field>
          <div className="h-[30px] flex items-center"><Toggle label="L1 sets the scale errors" checked={applyL1} onChange={setApplyL1} title="When off, L2 uses the errors in the draft configuration" /></div>
          <Button variant="primary" icon={Play} disabled={!ctx.canRun || job.running || !ctx.config} title={ctx.canRun ? undefined : NO_RUN} onClick={() => job.start("/sim/linked/run", { config: ctx.config, l1: ctx.l1, apply_l1: applyL1, station, scenario, days })}>Run L1 to L4</Button>
          <div className="flex-1 min-w-[200px]"><JobStatus job={job.job} error={job.error} /></div>
        </div>
        <div className="text-[11px] text-ink-3 mt-2">
          L1 conditions come from the L1 tab: {l1.speed_kmh} km/h, {l1.sensor_rows} rows, {l1.sensor_error_pct}% sensor error, road class {l1.road_roughness}, {l1.calibration} calibration. L3 and L4 use their default parameters here, with service values taken from the configuration.
        </div>
      </Panel>

      {!r && !job.running && <Panel><Empty text="No linked result yet. Run it to carry one set of conditions through all four levels." /></Panel>}
      {r && (
        <>
          <Panel title="Trace" sub="values passed from level to level in this run" tag={<Provenance kind="MODELLED" />}>
            <div className="flex flex-col lg:flex-row items-stretch gap-1.5">
              {[
                <Step key="l1" level="L1" title="Sensor model" muted={!r.scale_errors} trace={line("L1") ?? "L1 not applied: L2 used the errors in the configuration."} values={[["Road error", `${n(r.config_used.road_error_pct, 2)}%`], ["Port error", `${n(r.config_used.port_error_pct, 2)}%`], ["Lane error", `${n(r.config_used.lane_error_pct, 2)}%`]]} />,
                <Step key="l2" level="L2" title={chosenLabel} trace={line("L2")} values={[["First-station lane", `${n(chosen?.first_station_lane_pct)}%`], ["First-station static", `${n(chosen?.first_station_static_pct)}%`], ["Avg delay", `${n(chosen?.avg_delay_min, 2)} min`]]} />,
                <Step key="l3" level="L3" title={`Road traffic at ${v2?.station ?? station}`} trace={line("L3")} values={[["Peak lane queue", `${n(v2?.max_lane_queue_veh)} trucks`], ["Peak static queue", `${n(v2?.max_static_queue_veh)} trucks`], ["Diverge blocking", `${n(v2?.spillback_minutes)} min`]]} />,
                <Step key="l4" level="L4" title="System model" trace={line("L4")} values={[["Events", fmtInt(l4?.events_generated)], ["p95 latency", `${n(l4?.api_latency_p95_ms)} ms`], ["Data integrity", `${n(l4?.data_integrity_pct, 3)}%`]]} />,
              ].map((el, i) => (
                <Fragment key={i}>
                  {i > 0 && <div className="flex items-center justify-center text-ink-3 shrink-0" aria-hidden><ArrowRight size={16} className="max-lg:rotate-90" /></div>}
                  {el}
                </Fragment>
              ))}
            </div>
          </Panel>

          <Panel title="L2 summary" sub="all six scenarios at the errors above" tag={<Provenance kind="MODELLED" />} pad={false}>
            <DataTable<any>
              rows={rows}
              rowKey={(x) => x.scenario}
              cols={[
                { key: "label", label: "Scenario", render: (x) => <span className={x.scenario === r.scenario ? "text-accent font-medium" : "text-ink"}>{x.label}</span> },
                { key: "s", label: "Road stops /1,000", align: "right", mono: true, render: (x) => n(x.road_stops_per_1000) },
                { key: "l", label: "Lane /1,000", align: "right", mono: true, render: (x) => n(x.lane_per_1000) },
                { key: "d", label: "Avg delay, min", align: "right", mono: true, render: (x) => n(x.avg_delay_min, 2) },
                { key: "p", label: "p95 delay, min", align: "right", mono: true, render: (x) => n(x.p95_delay_min) },
                { key: "h", label: "Truck-hours saved /day", align: "right", mono: true, render: (x) => n(x.truck_hours_saved_per_day, 0) },
                { key: "f", label: "False clear", align: "right", mono: true, render: (x) => `${n(x.false_clear_pct, 3)}%` },
              ]}
            />
          </Panel>

          {compare ? (
            <Panel title="L3 queues: existing process against the chosen scenario" sub={`${v2.station}, one average day`} tag={<Provenance kind="MODELLED" />}>
              <div className="grid gap-3 lg:grid-cols-2">
                <div>
                  <div className="text-[11px] text-ink-3 mb-1">Lane queue, trucks</div>
                  <TimeLines data={joined} series={[{ key: "aslane", label: "Existing process", color: SERIES.s1 }, { key: "v2lane", label: chosenLabel, color: SERIES.s2 }]} height={170} />
                </div>
                <div>
                  <div className="text-[11px] text-ink-3 mb-1">Static queue, trucks</div>
                  <TimeLines data={joined} series={[{ key: "asstatic", label: "Existing process", color: SERIES.s1 }, { key: "v2static", label: chosenLabel, color: SERIES.s2 }]} height={170} />
                </div>
              </div>
              <div className="grid gap-2 grid-cols-2 lg:grid-cols-4 mt-2">
                <Kpi label="Peak static queue, existing" value={n(asIs.max_static_queue_veh)} unit="trucks" />
                <Kpi label="Peak static queue, chosen" value={n(v2.max_static_queue_veh)} unit="trucks" />
                <Kpi label="Diverge blocking, existing" value={n(asIs.spillback_minutes)} unit="min" />
                <Kpi label="Diverge blocking, chosen" value={n(v2.spillback_minutes)} unit="min" />
              </div>
              <div className="text-[11px] text-ink-3 mt-2">{v2.scope}</div>
            </Panel>
          ) : (
            <Panel title="L3 queues"><Empty text="Choose a scenario other than the existing process to compare the queues." /></Panel>
          )}

          <Panel title="L4 summary" tag={<Provenance kind="MODELLED" />}>
            <KV
              cols={4}
              items={[
                ["API latency p50, p95, p99", `${n(l4.api_latency_p50_ms)}, ${n(l4.api_latency_p95_ms)}, ${n(l4.api_latency_p99_ms)} ms`],
                ["Event throughput", `${n(l4.event_throughput_per_s, 2)} per s`],
                ["Peak queue depth", `${fmtInt(l4.peak_queue_depth)} records`],
                ["Failed requests", fmtInt(l4.failed_requests)],
                ["Edge availability", `${n(l4.edge_availability_pct, 2)}%`],
                ["Cloud availability", `${n(l4.cloud_link_availability_pct, 2)}%`],
                ["Mean recovery", `${n(l4.mean_recovery_s, 0)} s`],
                ["Outages", fmtInt(l4.outages?.length ?? 0)],
              ]}
            />
            <div className="text-[11px] text-ink-3 mt-2">{l4.scope}</div>
          </Panel>
        </>
      )}
    </div>
  );
}
