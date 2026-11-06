"use client";
import { CloudOff, Play, RotateCcw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Sparkline, TraceChart } from "@/components/sim/charts";
import { Toggle } from "@/components/sim/common";
import { PageTitle } from "@/components/shell";
import { Badge, Button, DataTable, ErrorBox, Kpi, KV, Loading, Meter, Note, Outcome, Panel, Provenance, Select, Slider } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtDate, fmtInt, fmtKg, fmtNum, fmtTime, SITE_SHORT } from "@/lib/format";
import { useLive } from "@/lib/live";

const CONSEQUENCE: Record<string, string> = {
  wim: "WIM off: trucks at this station fail safe to the lane",
  loops: "Loops off: no speed, so road readings fail safe to the lane",
  adc: "ADC off: no usable weight signal, trucks fail safe",
  pavement_temp: "Probe off: road WIM quality is capped at 0.55",
  ambient: "Logger off: telemetry only, decisions do not use it in this model",
  anpr: "ANPR off: plates and trailers are not read at this point",
  rfid: "RFID off: tags are not read at this point",
  lidar: "LiDAR off: no dimension reading at this point",
  edge: "Edge off: the gantry defaults to amber and the static process applies",
  ups: "UPS off: telemetry only, decisions do not use it in this model",
  network: "Link off: the edge runs offline and records queue in the outbox",
  lane_scale: "Lane scales off: lane readings fail safe to the static scale",
  lane_lidar: "Lane LiDAR off: no dimensions or lifted-axle check in the lane",
  lane_anpr: "Lane ANPR off: plates are not read in the lane",
  lane_rfid: "Lane RFID off: tags are not read in the lane",
  static_scale: "Static scale off: no legal reading at this site",
  port_scale: "Port scale off: no gate-out reading, so no token from this scale",
  ocr: "OCR off: the container number check cannot pass at the gate",
  origin_scale: "Scale off: no first-point reading at this loading site",
};

const statusBadge = (s: string) => (s === "ok" ? <Badge tone="go">OK</Badge> : s === "fault" ? <Badge tone="stop">Fault</Badge> : <Badge tone="wait">Disabled</Badge>);

function SensorTable({ site, sensors, can, refresh }: { site: string; sensors: any[]; can: boolean; refresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = async (id: string, status: string) => {
    setBusy(id);
    setErr(null);
    try {
      await api(`/faults/${site}/sensor/${id}`, { body: { status } });
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {err && <div className="p-2"><ErrorBox text={err} /></div>}
      <DataTable<any>
        rows={sensors}
        rowKey={(s) => s.id}
        empty="This site reports no sensors."
        cols={[
          { key: "name", label: "Sensor", render: (s) => <div className="min-w-[210px]"><div className="text-ink">{s.name}</div><div className="text-[10.5px] text-ink-3">{CONSEQUENCE[s.id] ?? "Readings that depend on it fail safe"}</div></div> },
          { key: "status", label: "Status", render: (s) => statusBadge(s.status) },
          { key: "kind", label: "Kind", render: (s) => <span className="text-ink-2">{s.kind}</span> },
          { key: "khz", label: "kHz", align: "right", mono: true, render: (s) => (s.sampling_khz == null ? "-" : s.sampling_khz) },
          { key: "q", label: "Signal quality", width: "110px", render: (s) => <div className="flex items-center gap-1.5"><Meter value={s.signal_quality} tone="var(--color-accent)" /><span className="num text-[11px] text-ink-2 w-8 text-right">{fmtNum(s.signal_quality * 100, 0)}%</span></div> },
          { key: "temp", label: "Temp C", align: "right", mono: true, render: (s) => fmtNum(s.temperature_c, 1) },
          { key: "drift", label: "Drift %", align: "right", mono: true, render: (s) => <span className="whitespace-nowrap" title={Math.abs(s.drift_pct) > 1 ? "Above the 1% recalibration alert" : undefined}>{s.drift_pct > 0 ? "+" : ""}{fmtNum(s.drift_pct, 3)}{Math.abs(s.drift_pct) > 1 && <span className="text-wait"> recalibrate</span>}</span> },
          { key: "cal", label: "Calibration due", mono: true, render: (s) => (s.calibration_due ? fmtDate(s.calibration_due) : <span className="text-ink-3">Not set</span>) },
          { key: "comm", label: "Comms", render: (s) => (s.comm_ok ? <Badge tone="go">OK</Badge> : <Badge tone="stop">Lost</Badge>) },
          { key: "lat", label: "Latency", align: "right", mono: true, render: (s) => `${fmtNum(s.latency_ms, 1)} ms` },
          { key: "val", label: "Latest", align: "right", mono: true, render: (s) => <span className="whitespace-nowrap">{typeof s.value === "number" ? fmtNum(s.value, 2) : "-"} {s.unit}</span> },
          { key: "last", label: "Last good", mono: true, render: (s) => fmtTime(s.last_ok) },
          {
            key: "act",
            label: "Actions",
            render: (s) => (
              <div className="flex gap-1">
                {s.status === "ok" ? (
                  <>
                    <Button size="sm" disabled={!can || busy === s.id} onClick={() => set(s.id, "disabled")} title={can ? undefined : "Your role cannot inject faults"}>Disable</Button>
                    <Button size="sm" variant="danger" disabled={!can || busy === s.id} onClick={() => set(s.id, "fault")} title={can ? undefined : "Your role cannot inject faults"}>Fault</Button>
                  </>
                ) : (
                  <Button size="sm" variant="primary" disabled={!can || busy === s.id} onClick={() => set(s.id, "ok")} title={can ? undefined : "Your role cannot inject faults"}>Restore</Button>
                )}
              </div>
            ),
          },
        ]}
      />
    </>
  );
}

function EdgePanel({ site, view, can, refresh }: { site: string; view: any; can: boolean; refresh: () => void }) {
  const kpi = useLive((s) => s.kpi);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hist, setHist] = useState<{ t: string; v: number }[]>([]);
  const [restoreNote, setRestoreNote] = useState<string | null>(null);

  useEffect(() => setHist([]), [site]);
  useEffect(() => {
    if (view?.id === site) setHist((h) => [...h, { t: new Date().toLocaleTimeString("en-GB"), v: view.outbox }].slice(-200));
  }, [view, site]);

  const run = async (path: string, body: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      await api(path, { body });
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const registryDown = !!kpi?.system.registry_down;
  const agencyDown = !!kpi?.system.kra_down;
  const noPerm = can ? undefined : "Your role cannot inject faults";

  return (
    <Panel title="Edge unit" sub={SITE_SHORT[site] ?? site} tag={<Provenance kind="SIMULATED" title="Simulated edge state" />} actions={view.online ? <Badge tone="go">Online</Badge> : <Badge tone="wait">Offline</Badge>}>
      <KV
        cols={2}
        items={[
          ["Edge unit", view.edge_up ? "Running" : "Failed"],
          ["Records queued locally", <span key="o" className="num">{fmtInt(view.outbox)}</span>],
          ["Syncing", view.syncing ? "Yes, draining the outbox" : "No"],
          ["Last recovery", view.last_recovery_s != null ? `${fmtNum(view.last_recovery_s, 0)} s of simulated time` : "None yet"],
        ]}
      />
      <div className="mt-2">
        <div className="text-[11px] text-ink-3 mb-0.5">Outbox depth since you opened this site (records)</div>
        {hist.length > 1 ? <Sparkline data={hist} label="Records queued" /> : <div className="h-16 flex items-center text-[11px] text-ink-3">Collecting readings</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <Button variant="danger" icon={CloudOff} loading={busy} disabled={!can || !view.online} title={noPerm} onClick={() => { setRestoreNote(auto ? "Auto-restore requested after 30 simulated minutes." : null); run(`/faults/${site}/network`, auto ? { up: false, duration_min: 30 } : { up: false }); }}>Cut cloud link</Button>
        <Button icon={RotateCcw} loading={busy} disabled={!can || view.online} title={noPerm} onClick={() => { setRestoreNote(null); run(`/faults/${site}/network`, { up: true }); }}>Restore</Button>
        <Toggle label="Auto-restore after 30 min" checked={auto} onChange={setAuto} title="Simulated minutes" />
      </div>
      {restoreNote && !view.online && <div className="text-[11px] text-ink-3 mt-1">{restoreNote}</div>}
      {err && <div className="mt-2"><ErrorBox text={err} /></div>}
      <div className="border-t border-line mt-3 pt-2">
        <div className="text-[11px] text-ink-3 mb-1.5">Global faults, acting on every site in the live twin</div>
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="min-w-0 text-[12px]">Token service <span className="ml-1">{registryDown ? <Badge tone="stop">Unavailable</Badge> : <Badge tone="go">Available</Badge>}</span></div>
          <Button size="sm" variant={registryDown ? "primary" : "danger"} disabled={!can || !kpi} title={noPerm} onClick={() => run("/faults/global", { registry_down: !registryDown })}>{registryDown ? "Restore" : "Take down"}</Button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 text-[12px]">Mock customs API <span className="ml-1">{agencyDown ? <Badge tone="stop">Unavailable</Badge> : <Badge tone="go">Available</Badge>}</span></div>
          <Button size="sm" variant={agencyDown ? "primary" : "danger"} disabled={!can || !kpi} title={noPerm} onClick={() => run("/faults/global", { agency_down: !agencyDown })}>{agencyDown ? "Restore" : "Take down"}</Button>
        </div>
      </div>
    </Panel>
  );
}

function Pipeline() {
  const [p, setP] = useState({ speed_kmh: 80, sampling_khz: 5, noise_pct: 0.6, temperature_c: 35, load_ratio: 0.85, lifted: false });
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: number | boolean) => setP((x) => ({ ...x, [k]: v }));
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api("/sensors/pipeline/run", { body: p }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const maxMs = res ? Math.max(...res.stages.map((s: any) => s.ms), 1e-6) : 1;
  return (
    <Panel title="Edge pipeline" sub="one truck pass through the ten stages" tag={<Badge tone="accent">SIMULATED signal, real processing</Badge>}>
      <div className="grid gap-3 xl:grid-cols-[230px_260px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <Slider label="Speed" value={p.speed_kmh} min={5} max={100} unit=" km/h" onChange={(v) => set("speed_kmh", v)} />
          <div>
            <Slider label="Sampling" value={p.sampling_khz} min={0.5} max={10} step={0.5} unit=" kHz" onChange={(v) => set("sampling_khz", v)} />
            <div className="text-[10.5px] text-ink-3">The design range is 5-10 kHz. Lower rates show what under-sampling does.</div>
          </div>
          <Slider label="Noise" value={p.noise_pct} min={0} max={10} step={0.1} unit="%" onChange={(v) => set("noise_pct", v)} />
          <Slider label="Temperature" value={p.temperature_c} min={-5} max={70} unit=" C" onChange={(v) => set("temperature_c", v)} />
          <Slider label="Load, share of limit" value={p.load_ratio} min={0.2} max={1.3} step={0.01} onChange={(v) => set("load_ratio", v)} />
          <Toggle label="Lifted axle" checked={p.lifted} onChange={(v) => set("lifted", v)} />
          <Button variant="primary" icon={Play} loading={busy} onClick={run}>Run pipeline</Button>
          {err && <ErrorBox text={err} />}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] text-ink-3">Stage timing</span>
            <Provenance kind="MEASURED" title="Real timings of this code on this machine, on a simulated signal" />
          </div>
          {res ? (
            <>
              <ol className="flex flex-col gap-1">
                {res.stages.map((s: any, i: number) => (
                  <li key={s.name} className="text-[11px]">
                    <div className="flex justify-between gap-2"><span className="text-ink-2 truncate"><span className="num text-ink-3 mr-1">{i + 1}</span>{s.name}</span><span className="num text-ink">{fmtNum(s.ms, 3)} ms</span></div>
                    <Meter value={s.ms / maxMs} tone="var(--color-s1)" />
                  </li>
                ))}
              </ol>
              <div className="flex justify-between text-[12px] border-t border-line mt-2 pt-1"><span className="text-ink-2">Total</span><span className="num text-ink">{fmtNum(res.total_ms, 3)} ms</span></div>
            </>
          ) : <div className="text-[12px] text-ink-3 py-6">Run the pipeline to time each stage.</div>}
        </div>
        <div className="min-w-0">
          {res ? (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-2">
                <Kpi label="Axles detected" value={res.axles_detected} sub={p.lifted ? "6 registered, 1 lifted" : "6 registered"} />
                <Kpi label="Gross estimate" value={fmtNum(res.gross_estimate_kg / 1000, 2)} unit="t" sub={`True ${fmtKg(res.true_gross_kg)}`} />
                <Kpi label="Estimate error" value={`${res.error_pct > 0 ? "+" : ""}${fmtNum(res.error_pct, 2)}`} unit="%" sub="Against the true gross" />
                <Kpi label="Signal quality" value={fmtNum(res.quality, 3)} sub={`Identity ${fmtNum(res.identity_confidence, 2)}`} />
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[12px] mb-1">
                <span className="text-ink-2">Classification: <span className="text-ink">{res.classification}</span></span>
                <span className="flex items-center gap-1.5 text-ink-2">Decision preview <Outcome value={res.decision_preview} /></span>
                <span className="text-ink-3 text-[11px]">Sampled at {fmtNum(res.sample_rate_khz, 1)} kHz. Dashed lines mark detected axle peaks.</span>
              </div>
              <TraceChart t={res.trace.t_ms} raw={res.trace.raw_v} filtered={res.trace.filtered_v} peaks={res.trace.peaks_ms} height={210} />
              <div className="flex flex-wrap gap-x-3 text-[11px] text-ink-3 mt-1">
                {res.axle_estimates_kg.map((a: number, i: number) => <span key={i} className="num">A{i + 1} {fmtInt(a)} kg</span>)}
              </div>
            </>
          ) : <div className="text-[12px] text-ink-3 py-6 text-center">The trace, the estimate and the decision preview appear here after a run.</div>}
        </div>
      </div>
    </Panel>
  );
}

function SensorsInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const { can } = useAuth();
  const site = sp.get("site") && SITE_SHORT[sp.get("site") as string] ? (sp.get("site") as string) : "mariakani";
  const { data: view, error, loading, refresh } = useApi<any>(`/sensors/${site}`, 1500);
  const allowed = can("faults.inject");
  const current = view?.id === site ? view : null;
  const failing = current ? current.sensors.filter((s: any) => s.status !== "ok").length : 0;

  return (
    <div className="p-3">
      <PageTitle
        title="Sensors and Edge Computing"
        sub="Device health, local queueing and fault injection for each site. Faults act on the live twin."
        actions={
          <>
            <Provenance kind="SIMULATED" title="Simulated sensor stream" />
            <Select aria-label="Site" className="w-40" value={site} onChange={(e) => router.replace(`/sensors?site=${e.target.value}`, { scroll: false })}>
              {Object.entries(SITE_SHORT).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
          </>
        }
      />
      <div className="mb-2"><Note>No physical devices are attached. This is a simulated sensor stream. Faults you inject here change how the live twin decides.</Note></div>
      {error && <div className="mb-2"><ErrorBox text={current ? `Last refresh failed: ${error}. Showing the previous reading.` : error} /></div>}
      {!current && loading && <Loading text="Loading sensors" />}
      {current && (
        <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_330px] mb-2">
          <Panel title={`Sensors at ${current.name}`} sub={failing ? `${failing} not operating` : "all operating"} pad={false}>
            <SensorTable site={site} sensors={current.sensors} can={allowed} refresh={refresh} />
          </Panel>
          <EdgePanel site={site} view={current} can={allowed} refresh={refresh} />
        </div>
      )}
      <Pipeline />
    </div>
  );
}

export default function SensorsPage() {
  return (
    <Suspense fallback={<Loading text="Loading sensors" />}>
      <SensorsInner />
    </Suspense>
  );
}
