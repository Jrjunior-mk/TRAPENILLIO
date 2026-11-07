"use client";
import { Crosshair, ExternalLink, Pause, Play, Rocket, RotateCcw, Square, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import type { CameraCommand, Network } from "@/components/twin/Scene";
import { Badge, Button, CheckList, ErrorBox, KV, Loading, Meter, Outcome, Select, TokenStatus } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtClock, fmtInt, fmtKg, fmtNum, fmtPct, STREAM_LABEL } from "@/lib/format";
import { useLive } from "@/lib/live";

const Scene = dynamic(() => import("@/components/twin/Scene"), { ssr: false, loading: () => <Loading text="Building the digital twin" /> });

const SPEEDS = [1, 5, 10, 20, 60, 120, 240];

function TruckPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { has } = useAuth();
  const { data, error } = useApi(`/twin/trucks/${id}`, 1000);
  if (error) return (
    <Card title="Truck" onClose={onClose}><div className="text-ink-3 text-[12px]">{error}</div></Card>
  );
  if (!data) return <Card title="Truck" onClose={onClose}><Loading /></Card>;
  return (
    <Card title={<span className="num">{data.tractor_plate}</span>} onClose={onClose} right={<Outcome value={data.state === "NEUTRAL" ? null : data.state} />}>
      <KV items={[
        ["Trailer registration", <span className="num" key="t">{data.trailer_plate || "None"}</span>],
        ["RFID identifier", <span className="num break-all" key="r">{data.rfid || "None"}</span>],
        ["Truck stream", STREAM_LABEL[data.stream] || data.stream],
        ["Container number", <span className="num" key="c">{data.container || "No container"}</span>],
        ["Gross weight (last reading)", <span className="num" key="g">{fmtKg(data.gross_measured_kg)}</span>],
        ["Axle configuration", <span className="num" key="a">{data.axle_config} ({data.axles_in_contact} in contact)</span>],
        ["Token status", data.token_id ? <TokenStatus key="s" value={data.token_status} /> : <Badge key="n">No token</Badge>],
        ["Clearance decision", data.decision],
        ["Current location", data.location],
        ["Next destination", data.next],
        ["Delay so far", `${fmtNum(data.delay_min)} min`],
        ["Fleet", data.fleet || "Unregistered"],
      ]} />
      {data.decision_text && <p className="text-[11.5px] text-ink-2 mt-3 leading-relaxed">{data.decision_text}</p>}
      {data.history?.length > 0 && (
        <div className="mt-3">
          <div className="eyebrow mb-1">Latest checks</div>
          <CheckList checks={data.history[data.history.length - 1].checks} />
        </div>
      )}
      <div className="flex gap-2 mt-3">
        {has("trucks") && <Link className="text-accent text-[11.5px] inline-flex items-center gap-1" href={`/trucks/${encodeURIComponent(data.tractor_plate)}`}>Full profile <ExternalLink size={11} /></Link>}
        {data.token_id && has("tokens") && <Link className="text-accent text-[11.5px] inline-flex items-center gap-1" href={`/tokens?id=${data.token_id}`}>Token <ExternalLink size={11} /></Link>}
      </div>
    </Card>
  );
}

function StationPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { has } = useAuth();
  const { data } = useApi(`/twin/stations/${id}`, 1500);
  const { can } = useAuth();
  if (!data) return <Card title="Station" onClose={onClose}><Loading /></Card>;
  const toggleLink = () => api(`/faults/${id}/network`, { body: { up: !data.online } });
  return (
    <Card title={data.name} onClose={onClose} right={!data.edge_up ? <Badge tone="stop">Edge down</Badge> : !data.online ? <Badge tone="wait">Offline</Badge> : data.syncing ? <Badge tone="accent">Syncing</Badge> : <Badge tone="go">Online</Badge>}>
      <KV items={[
        ["Decisions today", <span className="num" key="p">{fmtInt(data.processed)}</span>],
        ["Green / amber / red", <span className="num" key="d">{fmtInt(data.decisions.GREEN || 0)} / {fmtInt(data.decisions.AMBER || 0)} / {fmtInt(data.decisions.RED || 0)}</span>],
        [data.has_lane ? "Lane queue" : "Lane", data.has_lane ? <span className="num" key="l">{data.lane_queue}</span> : "None at this site"],
        [data.kind === "road" ? "Static queue" : "Re-weigh queue", <span className="num" key="s">{data.static_queue}</span>],
        ["Bays busy", <span className="num" key="b">{data.bays_busy} of {data.bays_total}</span>],
        ["Trucks held", <span className="num" key="h">{data.held}</span>],
        ["Records queued locally", <span className="num" key="o">{data.outbox}</span>],
        ["Link availability", fmtPct(data.availability_pct, 2)],
      ]} />
      <div className="mt-3 space-y-2">
        <div><div className="flex justify-between text-[11px] text-ink-3 mb-1"><span>Bay utilization</span><span className="num">{fmtPct(data.bay_utilization * 100)}</span></div><Meter value={data.bay_utilization} /></div>
        {data.has_lane && <div><div className="flex justify-between text-[11px] text-ink-3 mb-1"><span>Lane utilization ({data.lane_throughput_h}/h of {data.lane_capacity_h}/h)</span><span className="num">{fmtPct(data.lane_utilization * 100)}</span></div><Meter value={data.lane_utilization} /></div>}
      </div>
      {data.sensors_failed.length > 0 && <div className="mt-3 text-[11.5px] text-wait">Failed: {data.sensors_failed.join(", ")}</div>}
      <div className="flex flex-wrap gap-2 mt-3">
        {can("faults.inject") && <Button size="sm" variant={data.online ? "danger" : "primary"} onClick={toggleLink}>{data.online ? "Cut cloud link" : "Restore link"}</Button>}
        {has("sensors") && <Link href={`/sensors?site=${id}`} className="text-accent text-[11.5px] self-center">Sensors</Link>}
        {data.has_lane && has("lane") && <Link href={`/lane?station=${id}`} className="text-accent text-[11.5px] self-center">Verification lane</Link>}
      </div>
    </Card>
  );
}

const Card = ({ title, onClose, right, children }: { title: React.ReactNode; onClose?: () => void; right?: React.ReactNode; children: React.ReactNode }) => (
  <div className="bg-panel/95 border border-line-2 rounded-md backdrop-blur-sm">
    <div className="flex items-center gap-2 h-9 px-3 border-b border-line">
      <div className="font-semibold text-[12.5px] truncate">{title}</div>
      <div className="ml-auto flex items-center gap-2">{right}{onClose && <button aria-label="Close" onClick={onClose} className="text-ink-3 hover:text-ink cursor-pointer"><X size={14} /></button>}</div>
    </div>
    <div className="p-3 max-h-[calc(100vh-190px)] overflow-auto">{children}</div>
  </div>
);

function TwinInner() {
  const params = useSearchParams();
  const { data: network, error } = useApi<Network>("/twin/network");
  const { data: scen } = useApi<{ scenarios: { id: string; title: string; summary: string }[] }>("/twin/scenarios");
  const kpi = useLive((s) => s.kpi);
  const { can } = useAuth();
  const [truck, setTruck] = useState<string | null>(params.get("truck"));
  const [station, setStation] = useState<string | null>(params.get("station"));
  const [cmd, setCmd] = useState<CameraCommand | null>(null);
  const [follow, setFollow] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const flyTo = useCallback((id: string) => {
    const p = network?.plazas.find((x) => x.id === id);
    if (!p) return;
    setCmd({ kind: "station", x: (p.p[0] + p.q[0]) / 2, z: (p.p[1] + p.q[1]) / 2, nonce: Date.now() });
  }, [network]);

  const selectStation = useCallback((id: string) => {
    setStation(id);
    setTruck(null);
    setFollow(false);
    flyTo(id);
  }, [flyTo]);

  useEffect(() => {
    if (network && params.get("station")) flyTo(params.get("station")!);
    if (params.get("truck")) setFollow(true);
  }, [network]); // eslint-disable-line react-hooks/exhaustive-deps

  const control = async (body: object) => {
    setErr(null);
    try {
      await api("/live/control", { body });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const startScenario = async (id: string) => {
    if (!id) return;
    setErr(null);
    try {
      const v = await api(`/twin/scenarios/${id}/start`, { body: { speed: 6 } });
      setTruck(v.truck);
      setStation(null);
      setFollow(true);
      setCmd({ kind: "home", nonce: Date.now() });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (error) return <div className="p-3"><ErrorBox text={error} /></div>;
  if (!network) return <Loading text="Loading the corridor network" />;
  const sc = kpi?.scenario;
  const paused = kpi ? kpi.paused || !kpi.running : false;
  const canControl = can("live.control");
  return (
    <div className="relative h-full bg-[#050a11]">
      <div className="absolute inset-0"><Scene network={network} selectedTruck={truck} selectedStation={station} onTruck={(id) => { setTruck(id); setStation(null); }} onStation={selectStation} command={cmd} follow={follow} /></div>

      {/* Controls */}
      <div className="absolute top-2 left-2 flex flex-wrap items-center gap-1.5 bg-panel/90 border border-line-2 rounded-md p-1.5 backdrop-blur-sm max-w-[calc(100%-16px)]">
        <Button size="sm" icon={paused ? Play : Pause} disabled={!canControl} onClick={() => control({ action: paused ? "resume" : "pause" })}>{paused ? "Resume" : "Pause"}</Button>
        <label className="flex items-center gap-1 text-[11px] text-ink-3">Speed
          <Select className="!h-6 !w-[68px] !px-1 !text-[11px]" disabled={!canControl} value={SPEEDS.includes(kpi?.speed ?? 0) ? kpi?.speed : ""} onChange={(e) => control({ action: "speed", speed: Number(e.target.value) })}>
            {!SPEEDS.includes(kpi?.speed ?? 0) && <option value="">{kpi?.speed}x</option>}
            {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
          </Select>
        </label>
        <Button size="sm" icon={Crosshair} onClick={() => { setCmd({ kind: "home", nonce: Date.now() }); setFollow(false); }}>Reset camera</Button>
        <Button size="sm" variant={follow ? "primary" : "default"} onClick={() => setFollow(!follow)} disabled={!truck && !sc}>Follow</Button>
        <Select aria-label="Select station" className="!h-6 !w-[170px] !px-1 !text-[11px]" value={station || ""} onChange={(e) => e.target.value && selectStation(e.target.value)}>
          <option value="">Select a station</option>
          {network.plazas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select aria-label="Start a scenario" className="!h-6 !w-[190px] !px-1 !text-[11px]" disabled={!canControl} value="" onChange={(e) => startScenario(e.target.value)}>
          <option value="">Watch a scenario</option>
          {scen?.scenarios.map((s, i) => <option key={s.id} value={s.id}>{i + 1}. {s.title}</option>)}
        </Select>
        {canControl && <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => control({ action: "reset" })} title="Clears simulated records and restarts the corridor. Operator records are kept.">Reset sim</Button>}
      </div>
      {err && <div className="absolute top-14 left-2 w-[360px]"><ErrorBox text={err} /></div>}

      {/* Status strip */}
      <div className="absolute bottom-2 left-2 flex items-center gap-3 bg-panel/90 border border-line-2 rounded-md px-3 h-8 text-[11px] backdrop-blur-sm flex-wrap">
        <Legend color="bg-[#cdd7e3]" label="Awaiting decision" />
        <Legend color="bg-go" label="Green, cleared" />
        <Legend color="bg-wait" label="Amber, verifying" />
        <Legend color="bg-stop" label="Red, static or corrective" />
        <span className="text-ink-3 border-l border-line pl-3 num">{fmtInt(kpi?.trucks_active)} trucks, {fmtClock(kpi?.now)} EAT, {kpi?.speed}x</span>
        <span className="text-ink-3 border-l border-line pl-3">Schematic layout: highways compressed</span>
      </div>

      {/* Right column */}
      <div className="absolute top-2 right-2 w-[340px] max-w-[calc(100%-16px)] flex flex-col gap-2 max-h-[calc(100%-16px)]">
        {sc && (
          <Card title={<span className="flex items-center gap-1.5"><Rocket size={13} className="text-accent" />{sc.title}</span>} right={sc.status === "complete" ? <Badge tone="go">Complete</Badge> : <Badge tone="accent">Running</Badge>} onClose={() => api("/twin/scenarios/stop", { body: {} })}>
            <p className="text-[11.5px] text-ink-2 mb-2">{sc.summary}</p>
            <ol className="space-y-1.5 max-h-52 overflow-auto">
              {sc.log.slice(1).map((l, i) => (
                <li key={i} className="flex gap-2 text-[11px] leading-snug">
                  <span className="num text-ink-3 shrink-0">{fmtClock(l.at)}</span>
                  <span className={l.kind === "GREEN" ? "text-go" : l.kind === "AMBER" ? "text-wait" : l.kind === "RED" ? "text-stop" : l.kind === "TOKEN" ? "text-accent" : "text-ink-2"}>{l.text}</span>
                </li>
              ))}
            </ol>
            {sc.status !== "complete" && <Button size="sm" variant="ghost" icon={Square} className="mt-2" onClick={() => api("/twin/scenarios/stop", { body: {} })}>Stop</Button>}
          </Card>
        )}
        {truck && <TruckPanel id={truck} onClose={() => { setTruck(null); setFollow(false); }} />}
        {station && !truck && <StationPanel id={station} onClose={() => setStation(null)} />}
      </div>
    </div>
  );
}

const Legend = ({ color, label }: { color: string; label: string }) => <span className="flex items-center gap-1.5 text-ink-2"><i className={`w-2.5 h-2.5 rounded-[2px] ${color}`} />{label}</span>;

export default function TwinPage() {
  return <Suspense fallback={<Loading />}><TwinInner /></Suspense>;
}
