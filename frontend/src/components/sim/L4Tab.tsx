"use client";
import { CloudOff, Play, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { SERIES, TimeLines } from "@/components/charts";
import { Badge, Button, DataTable, Empty, ErrorBox, Field, Kpi, KV, Loading, Panel, Provenance, Slider } from "@/components/ui";
import { api, useApi, useJob } from "@/lib/api";
import { fmtInt, fmtNum, siteName } from "@/lib/format";
import { useLive } from "@/lib/live";
import { clockLabel, JobStatus, n, NO_FAULT, NO_RUN, type OpenRequest, ScenarioSelect, type SimCtx, Toggle, useScenarios } from "./common";

function LiveSystem({ ctx }: { ctx: SimCtx }) {
  const kpi = useLive((s) => s.kpi);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const can = ctx.canFault;
  const title = can ? undefined : NO_FAULT;
  const act = async (key: string, path: string, body: unknown) => {
    setBusy(key);
    setErr(null);
    try {
      await api(path, { body });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!kpi) return <Panel title="Live system"><Loading text="Connecting to the live stream" /></Panel>;
  const sys = kpi.system;
  const sites = kpi.stations.filter((s) => s.kind !== "origin");
  return (
    <Panel title="Live system" sub="These act on the live twin." tag={<Provenance kind="SIMULATED" title="Telemetry from the running twin" />}>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <KV
            cols={3}
            items={[
              ["Event bus messages", <span key="m" className="num">{fmtInt(sys.messages)}</span>],
              ["Events generated", <span key="g" className="num">{fmtInt(sys.events_generated)}</span>],
              ["Events delivered", <span key="d" className="num">{fmtInt(sys.events_delivered)}</span>],
              ["Records queued at the edge", <span key="q" className="num">{fmtInt(sys.queue_depth)}</span>],
              ["Decision latency p50", <span key="p5" className="num">{fmtNum(sys.api_latency_p50_ms)} ms</span>],
              ["Decision latency p95", <span key="p9" className="num">{fmtNum(sys.api_latency_p95_ms)} ms</span>],
              ["Failed lookups", <span key="f" className="num">{fmtInt(sys.failed_requests)}</span>],
              ["Engine step", <span key="s" className="num">{fmtNum(sys.step_ms)} ms</span>],
              ["Write-behind errors", <span key="w" className="num">{fmtInt(sys.write_behind_errors)}</span>],
            ]}
          />
          <div className="flex flex-col gap-1.5 mt-3 border-t border-line pt-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px]">Token service {sys.registry_down ? <Badge tone="stop">Unavailable</Badge> : <Badge tone="go">Available</Badge>}</span>
              <Button size="sm" variant={sys.registry_down ? "primary" : "danger"} disabled={!can} loading={busy === "reg"} title={title} onClick={() => act("reg", "/faults/global", { registry_down: !sys.registry_down })}>{sys.registry_down ? "Restore" : "Take down"}</Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px]">Mock customs API {sys.kra_down ? <Badge tone="stop">Unavailable</Badge> : <Badge tone="go">Available</Badge>}</span>
              <Button size="sm" variant={sys.kra_down ? "primary" : "danger"} disabled={!can} loading={busy === "agency"} title={title} onClick={() => act("agency", "/faults/global", { agency_down: !sys.kra_down })}>{sys.kra_down ? "Restore" : "Take down"}</Button>
            </div>
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] text-ink-3">Cloud link per site</span>
            <Toggle label="Auto-restore after 30 min" checked={auto} onChange={setAuto} title="Simulated minutes" />
          </div>
          <DataTable<any>
            rows={sites}
            rowKey={(s) => s.id}
            cols={[
              { key: "n", label: "Site", render: (s) => siteName(s.id) },
              { key: "o", label: "Link", render: (s) => (s.online ? <Badge tone="go">Online</Badge> : <Badge tone="wait">Offline</Badge>) },
              { key: "q", label: "Queued", align: "right", mono: true, render: (s) => fmtInt(s.outbox) },
              { key: "y", label: "Syncing", render: (s) => <span className="text-ink-2">{s.syncing ? "Yes" : "No"}</span> },
              {
                key: "a",
                label: "",
                align: "right",
                render: (s) => s.online ? (
                  <Button size="sm" variant="danger" icon={CloudOff} disabled={!can} loading={busy === s.id} title={title} onClick={() => act(s.id, `/faults/${s.id}/network`, auto ? { up: false, duration_min: 30 } : { up: false })}>Cut link</Button>
                ) : (
                  <Button size="sm" icon={RotateCcw} disabled={!can} loading={busy === s.id} title={title} onClick={() => act(s.id, `/faults/${s.id}/network`, { up: true })}>Restore</Button>
                ),
              },
            ]}
          />
        </div>
      </div>
      {!can && <div className="text-[11px] text-ink-3 mt-2">{NO_FAULT}</div>}
      {err && <div className="mt-2"><ErrorBox text={err} /></div>}
    </Panel>
  );
}

export function L4Tab({ ctx, open }: { ctx: SimCtx; open?: OpenRequest }) {
  const { scenarios } = useScenarios();
  const job = useJob<any>();
  const [p, setP] = useState({ hours: 24, load_multiplier: 1, messages_per_truck: 3, token_service_workers: 4, token_service_ms: 6, registry_write_ms: 4, agency_api_ms: 180, agency_failure_pct: 1, outage_per_day: 0.5, outage_duration_min: 30, device_failures_per_day: 0.2, device_repair_min: 60, sync_rate_per_s: 50 });
  const [scenario, setScenario] = useState("v2_all");
  const set = (k: string, v: number) => setP((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (open?.id) job.watch(open.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.n]);

  const r = job.job?.status === "DONE" ? (job.job as any).result : null;
  const step = r?.series?.bucket_min ?? 15;
  const series = r ? (r.series.throughput_per_s as number[]).map((v, i) => ({ t: clockLabel(i, step), throughput: v, depth: r.series.queue_depth[i], latency: r.series.latency_ms[i], failed: r.series.failed[i] })) : [];

  return (
    <div className="grid gap-2 xl:grid-cols-[250px_minmax(0,1fr)] pt-2">
      <Panel title="System conditions" tag={<Provenance kind="ASSUMED" title="Latency distributions are assumptions, except the measured crypto cost" />}>
        <div className="flex flex-col gap-2">
          <Field label="L2 scenario for offered load"><ScenarioSelect value={scenario} onChange={setScenario} scenarios={scenarios} /></Field>
          <Slider label="Load multiplier" value={p.load_multiplier} min={0.1} max={50} step={0.1} unit="x" onChange={(v) => set("load_multiplier", v)} />
          <Slider label="Modelled hours" value={p.hours} min={1} max={72} unit=" h" onChange={(v) => set("hours", v)} />
          <Slider label="Messages per truck" value={p.messages_per_truck} min={1} max={20} onChange={(v) => set("messages_per_truck", v)} />
          <Slider label="Token service workers" value={p.token_service_workers} min={1} max={64} onChange={(v) => set("token_service_workers", v)} />
          <Slider label="Token service time" value={p.token_service_ms} min={0.5} max={500} step={0.5} unit=" ms" onChange={(v) => set("token_service_ms", v)} />
          <Slider label="Registry write time" value={p.registry_write_ms} min={0.5} max={500} step={0.5} unit=" ms" onChange={(v) => set("registry_write_ms", v)} />
          <Slider label="Agency API time" value={p.agency_api_ms} min={1} max={5000} step={10} unit=" ms" onChange={(v) => set("agency_api_ms", v)} />
          <Slider label="Agency failure rate" value={p.agency_failure_pct} min={0} max={100} step={0.5} unit="%" onChange={(v) => set("agency_failure_pct", v)} />
          <Slider label="Outages per day, per site" value={p.outage_per_day} min={0} max={48} step={0.1} onChange={(v) => set("outage_per_day", v)} />
          <Slider label="Outage duration" value={p.outage_duration_min} min={1} max={720} unit=" min" onChange={(v) => set("outage_duration_min", v)} />
          <Slider label="Device failures per day, per site" value={p.device_failures_per_day} min={0} max={48} step={0.1} onChange={(v) => set("device_failures_per_day", v)} />
          <Slider label="Device repair time" value={p.device_repair_min} min={1} max={1440} step={5} unit=" min" onChange={(v) => set("device_repair_min", v)} />
          <Slider label="Sync rate after an outage" value={p.sync_rate_per_s} min={1} max={5000} step={1} unit=" per s" onChange={(v) => set("sync_rate_per_s", v)} />
          <Button variant="primary" icon={Play} disabled={!ctx.canRun || job.running || !ctx.config} title={ctx.canRun ? undefined : NO_RUN} onClick={() => job.start("/sim/l4/run", { params: p, config: ctx.config, scenario })}>Run L4</Button>
          <JobStatus job={job.job} error={job.error} />
        </div>
      </Panel>

      <div className="flex flex-col gap-2 min-w-0">
        <div className="border border-accent/40 bg-accent/10 rounded-sm px-3 py-2 text-[12px] text-ink flex items-center gap-2 flex-wrap">
          <span className="font-semibold">Software-in-the-loop model, no physical hardware.</span>
          <span className="text-ink-2 text-[11.5px]">{r?.scope ?? "A SimPy model of the edge units, broker, token service and agency APIs. Real hardware replay is left to Phase 3 of the RCS v2 plan."}</span>
          <Provenance kind="MODELLED" />
        </div>
        {!r && !job.running && <Panel><Empty text="No L4 result yet. Run L4 to load the system model with trucks from L2." /></Panel>}
        {r && (
          <>
            <div className="grid gap-2 grid-cols-2 md:grid-cols-5">
              <Kpi label="API latency p50" value={n(r.api_latency_p50_ms)} unit="ms" />
              <Kpi label="API latency p95" value={n(r.api_latency_p95_ms)} unit="ms" />
              <Kpi label="API latency p99" value={n(r.api_latency_p99_ms)} unit="ms" />
              <Kpi label="Event throughput" value={n(r.event_throughput_per_s, 2)} unit="per s" sub={`${fmtInt(r.events_generated)} generated`} />
              <Kpi label="Failed requests" value={fmtInt(r.failed_requests)} sub={`${fmtInt(r.agency_failures)} from agency APIs`} />
              <Kpi label="Peak queue depth" value={fmtInt(r.peak_queue_depth)} unit="records" sub={`${fmtInt(r.events_lost)} lost, ${fmtInt(r.events_pending)} pending`} />
              <Kpi label="Edge availability" value={n(r.edge_availability_pct, 2)} unit="%" />
              <Kpi label="Cloud availability" value={n(r.cloud_link_availability_pct, 2)} unit="%" />
              <Kpi label="Recovery, mean and max" value={`${n(r.mean_recovery_s, 0)} / ${n(r.max_recovery_s, 0)}`} unit="s" />
              <Kpi label="Data integrity" value={n(r.data_integrity_pct, 3)} unit="%" sub={`${fmtInt(r.duplicates_removed)} duplicates removed`} />
            </div>
            <div className="text-[11px] text-ink-3 flex items-center gap-1.5"><Provenance kind="MODELLED" /> All figures above come from the model, run in {n(r.wall_seconds, 1)} s of wall time.</div>
            <div className="grid gap-2 md:grid-cols-2">
              <Panel title="Throughput" sub="events per s" tag={<Provenance kind="MODELLED" />}><TimeLines data={series} series={[{ key: "throughput", label: "Events per s", color: SERIES.s1 }]} height={150} /></Panel>
              <Panel title="Queue depth" sub="records held at the edge" tag={<Provenance kind="MODELLED" />}><TimeLines data={series} series={[{ key: "depth", label: "Records", color: SERIES.s1 }]} height={150} /></Panel>
              <Panel title="Latency" sub="mean per 15 min, including records delayed by outages" tag={<Provenance kind="MODELLED" />}><TimeLines data={series} series={[{ key: "latency", label: "Latency", color: SERIES.s1 }]} unit=" ms" height={150} /></Panel>
              <Panel title="Failed requests" sub="per 15 min" tag={<Provenance kind="MODELLED" />}><TimeLines data={series} series={[{ key: "failed", label: "Failed", color: SERIES.s1 }]} height={150} /></Panel>
            </div>
            <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_280px]">
              <Panel title="Outage log" tag={<Provenance kind="MODELLED" />} pad={false}>
                <DataTable<any>
                  rows={r.outages ?? []}
                  rowKey={(o) => `${o.site}-${o.start_h}`}
                  maxH="220px"
                  empty="No outages occurred in this run."
                  cols={[
                    { key: "site", label: "Site", render: (o) => siteName(o.site) },
                    { key: "s", label: "Start, h", align: "right", mono: true, render: (o) => n(o.start_h, 2) },
                    { key: "d", label: "Duration, min", align: "right", mono: true, render: (o) => n(o.duration_min) },
                    { key: "b", label: "Backlog", align: "right", mono: true, render: (o) => fmtInt(o.backlog) },
                    { key: "r", label: "Recovery, s", align: "right", mono: true, render: (o) => n(o.recovery_s) },
                  ]}
                />
              </Panel>
              <Panel title="Crypto timing" tag={<Provenance kind="MEASURED" title="Measured on this machine at run time and added to the modelled service time" />}>
                <KV
                  items={[
                    ["Token sign", <span key="s" className="num">{n(r.crypto_measured_here?.sign_ms, 3)} ms</span>],
                    ["Token verify", <span key="v" className="num">{n(r.crypto_measured_here?.verify_ms, 3)} ms</span>],
                    ["Signatures verified", r.crypto_measured_here?.verified ? "Yes" : "No"],
                  ]}
                />
                <div className="text-[10.5px] text-ink-3 mt-2">Measured on this machine during the run. Everything else on this tab is modelled.</div>
              </Panel>
            </div>
          </>
        )}
        <LiveSystem ctx={ctx} />
      </div>
    </div>
  );
}
