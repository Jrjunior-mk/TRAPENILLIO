"use client";
import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { Heatmap, SERIES, TimeLines } from "@/components/charts";
import { Button, Empty, Field, Kpi, KV, Note, Panel, Provenance, Select, Slider } from "@/components/ui";
import { useJob } from "@/lib/api";
import { clockLabel, JobStatus, n, NO_RUN, type OpenRequest, ScenarioSelect, type SimCtx, STATION_OPTIONS, useScenarios } from "./common";

const SCOPE = "Built-in cell-transmission model, SUMO not installed";

export const queueSeries = (r: any) => {
  const step = r.time_step_min || 15;
  return (r.lane_queue as number[]).map((v, i) => ({ t: clockLabel(i, step), lane: v, static: r.static_queue[i], entry: r.entry_queue[i], speed: r.mean_speed_kmh[i] }));
};

export function L3Tab({ ctx, open }: { ctx: SimCtx; open?: OpenRequest }) {
  const { scenarios } = useScenarios();
  const job = useJob<any>();
  const [p, setP] = useState({ station: "mariakani", volume_factor: 1, peak_multiplier: 1, background_veh_per_h: 0, mainline_capacity_veh_per_h: 1100, lane_capacity_per_h: 370, static_lanes: 8, static_service_min: 4, divert_storage_m: 150, static_storage_m: 300 });
  const [scenario, setScenario] = useState("v2_all");
  const [synced, setSynced] = useState(false);
  const set = (k: string, v: number | string) => setP((x) => ({ ...x, [k]: v }));
  const c = ctx.config;

  // The first time a configuration arrives, start from the service values it implies.
  useEffect(() => {
    if (!c || synced) return;
    setSynced(true);
    setP((x) => ({
      ...x,
      static_lanes: c.static_lanes,
      static_service_min: Math.max(0.5, c.static_stop_min - c.stop_overhead_min),
      lane_capacity_per_h: Math.min(1000, Math.round(3600 / (c.lane_headway_m / (c.lane_speed_kmh / 3.6)))),
    }));
  }, [c, synced]);

  useEffect(() => {
    if (open?.id) job.watch(open.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.n]);

  const r = job.job?.status === "DONE" ? (job.job as any).result : null;
  const series = r ? queueSeries(r) : [];
  const xLabels = series.map((s) => s.t);
  const link = r?.l2_link;

  return (
    <div className="grid gap-2 xl:grid-cols-[250px_minmax(0,1fr)] pt-2">
      <Panel title="Road conditions" tag={<Provenance kind="ASSUMED" />}>
        <div className="flex flex-col gap-2">
          <Field label="Station">
            <Select value={p.station} onChange={(e) => set("station", e.target.value)}>
              {STATION_OPTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
          </Field>
          <Field label="L2 scenario"><ScenarioSelect value={scenario} onChange={setScenario} scenarios={scenarios} /></Field>
          <Slider label="Volume factor" value={p.volume_factor} min={0.1} max={5} step={0.1} unit="x" onChange={(v) => set("volume_factor", v)} />
          <Slider label="Peak multiplier" value={p.peak_multiplier} min={0.5} max={3} step={0.1} unit="x" onChange={(v) => set("peak_multiplier", v)} />
          <Slider label="Background traffic" value={p.background_veh_per_h} min={0} max={2000} step={50} unit=" veh/h" onChange={(v) => set("background_veh_per_h", v)} />
          <Slider label="Mainline capacity" value={p.mainline_capacity_veh_per_h} min={200} max={2400} step={50} unit=" veh/h" onChange={(v) => set("mainline_capacity_veh_per_h", v)} />
          <Slider label="Lane capacity" value={p.lane_capacity_per_h} min={10} max={1000} step={10} unit=" per h" onChange={(v) => set("lane_capacity_per_h", v)} />
          <Slider label="Static lanes" value={p.static_lanes} min={1} max={20} onChange={(v) => set("static_lanes", v)} />
          <Slider label="Static service" value={p.static_service_min} min={0.5} max={60} step={0.5} unit=" min" onChange={(v) => set("static_service_min", v)} />
          <Slider label="Divert storage" value={p.divert_storage_m} min={50} max={1000} step={10} unit=" m" onChange={(v) => set("divert_storage_m", v)} />
          <Slider label="Static storage" value={p.static_storage_m} min={50} max={2000} step={10} unit=" m" onChange={(v) => set("static_storage_m", v)} />
          <Button variant="primary" icon={Play} disabled={!ctx.canRun || job.running || !c} title={ctx.canRun ? undefined : NO_RUN} onClick={() => job.start("/sim/l3/run", { params: p, config: c, scenario })}>Run L3</Button>
          <JobStatus job={job.job} error={job.error} />
        </div>
      </Panel>

      <div className="flex flex-col gap-2 min-w-0">
        <div className="border border-accent/40 bg-accent/10 rounded-sm px-3 py-2 text-[12px] text-ink flex items-center gap-2 flex-wrap">
          <span className="font-semibold">{SCOPE}</span>
          {r?.scope && <span className="text-ink-2 text-[11.5px]">{r.scope}</span>}
          <Provenance kind="MODELLED" />
        </div>
        {!r && !job.running && <Panel><Empty text="No L3 result yet. Run L3 to route L2 demand through this station." /></Panel>}
        {r && (
          <>
            <div className="grid gap-2 grid-cols-2 md:grid-cols-4 2xl:grid-cols-7">
              <Kpi label="Max lane queue" value={n(r.max_lane_queue_veh, 1)} unit="trucks" />
              <Kpi label="Max static queue" value={n(r.max_static_queue_veh, 1)} unit="trucks" />
              <Kpi label="Max entry queue" value={n(r.max_entry_queue_veh, 1)} unit="veh" />
              <Kpi label="Spillback" value={n(r.spillback_minutes, 1)} unit="min" sub="Diverge blocked" />
              <Kpi label="Congested" value={n(r.congested_minutes, 1)} unit="min" sub="Approach above half jam" />
              <Kpi label="Required divert storage" value={n(r.required_divert_storage_m, 0)} unit="m" sub={`Modelled ${n(r.params.divert_storage_m, 0)} m`} />
              <Kpi label="Required static storage" value={n(r.required_static_storage_m, 0)} unit="m" sub={`Modelled ${n(r.params.static_storage_m, 0)} m`} />
            </div>
            <Panel title="Space-time density" sub={`vehicles per km, ${n(r.cell_m, 0)} m cells, ${n(r.time_step_min, 0)} min steps`} tag={<Provenance kind="MODELLED" />}>
              <Heatmap matrix={r.heatmap_density_veh_km} xLabels={xLabels} yLabel="Top row: downstream. Bottom row: upstream. Brighter is denser." max={r.params.jam_density_veh_per_km} height={200} />
              <div className="text-[10.5px] text-ink-3 mt-0.5">Full brightness is the jam density of {n(r.params.jam_density_veh_per_km, 0)} veh/km. Hover a cell for its value.</div>
            </Panel>
            <div className="grid gap-2 lg:grid-cols-2">
              <Panel title="Queues" sub="trucks or vehicles" tag={<Provenance kind="MODELLED" />}>
                <TimeLines data={series} series={[{ key: "lane", label: "Lane", color: SERIES.s1 }, { key: "static", label: "Static", color: SERIES.s2 }, { key: "entry", label: "Entry", color: SERIES.s3 }]} height={190} />
              </Panel>
              <Panel title="Mean speed" sub="across all cells" tag={<Provenance kind="MODELLED" />}>
                <TimeLines data={series} series={[{ key: "speed", label: "Mean speed", color: SERIES.s1 }]} unit=" km/h" height={190} yDomain={[0, "auto"]} />
              </Panel>
            </div>
            <Panel title="Link from L2 and values used" tag={<Provenance kind="MODELLED" />}>
              <KV
                cols={4}
                items={[
                  ["L2 scenario", scenarios.find((s) => s.id === link?.scenario)?.label ?? link?.scenario],
                  ["First-station lane share", `${n(link?.first_station_lane_pct)}%`],
                  ["First-station static share", `${n(link?.first_station_static_pct)}%`],
                  ["Road error from configuration", `${n(link?.road_error_pct, 2)}%`],
                  ["Peak mainline demand", `${n(r.main_peak_per_h, 0)} per h`],
                  ["Peak lane demand", `${n(r.lane_peak_per_h, 0)} per h`],
                  ["Peak static demand", `${n(r.static_peak_per_h, 0)} per h`],
                  ["Average speed", `${n(r.avg_speed_kmh)} km/h`],
                  ["Lane capacity used", `${n(r.params.lane_capacity_per_h, 0)} per h`],
                  ["Static lanes used", n(r.params.static_lanes, 0)],
                  ["Static service used", `${n(r.params.static_service_min, 1)} min`],
                  ["Vehicles served of demand", `${n(r.served_veh, 0)} of ${n(r.demand_veh, 0)}`],
                ]}
              />
            </Panel>
            <Note>Lane lengths and storage are design assumptions from RCS v2 s5.1. The model is macroscopic: it shows queues, densities and diverge blocking, not individual lane changes.</Note>
          </>
        )}
      </div>
    </div>
  );
}
