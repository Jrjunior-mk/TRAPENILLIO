"use client";
import { Activity, Clock, Gauge, Hourglass, Truck, Waypoints } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { LaneSchematic } from "@/components/sim/LaneSchematic";
import { STATION_OPTIONS } from "@/components/sim/common";
import { PageTitle } from "@/components/shell";
import { Badge, Button, CheckList, DataTable, Empty, ErrorBox, Kpi, KV, Loading, Meter, Note, Outcome, Panel, Provenance, Select } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtInt, fmtKg, fmtNum, fmtPct, fmtTime, fmtT } from "@/lib/format";
import { useLive } from "@/lib/live";

const SPEEDS = [1, 2, 5, 10, 20, 60];

function Measurement({ r }: { r: any }) {
  const wheels: { left_kg: number; right_kg: number }[] = r.wheels ?? [];
  const axles: number[] = r.axle_loads_kg ?? [];
  const groups: { group: string; load_kg: number; limit_kg: number }[] = r.groups ?? [];
  const d = r.dimensions ?? {};
  const dims = d.height != null ? `${fmtNum(d.height, 2)} high, ${fmtNum(d.width, 2)} wide, ${fmtNum(d.length, 1)} long (m)` : "Not measured";
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <Outcome value={r.outcome} size="lg" />
          <span className="num text-[13px] text-ink">{r.plate}</span>
          {r.fail_safe && <Badge tone="wait">Fail-safe</Badge>}
        </div>
        <KV
          items={[
            ["Measured gross", r.gross_kg != null ? fmtKg(r.gross_kg) : "No reading"],
            ["Speed", r.speed_kmh != null ? `${fmtNum(r.speed_kmh, 0)} km/h` : "-"],
            ["Dimensions", dims],
            ["Lifted axle", r.lifted_axle ? "Detected" : d.height != null ? "Not detected" : "Not checked"],
            ["Fail-safe applied", r.fail_safe ? "Yes" : "No"],
            ["Action", String(r.action ?? "-").replaceAll("_", " ").toLowerCase()],
            ["Time", fmtTime(r.at)],
          ]}
        />
        <div className="text-[11.5px] text-ink-2 mt-2 leading-relaxed">{r.explanation}</div>
      </div>
      <div className="min-w-0">
        <div className="text-[11px] text-ink-3 mb-1">Per-wheel and axle loads</div>
        {wheels.length ? (
          <table className="w-full text-[11.5px] num">
            <thead>
              <tr className="text-ink-3 text-[10.5px]"><th className="text-left font-normal py-0.5">Axle</th><th className="text-right font-normal">Left</th><th className="text-right font-normal">Right</th><th className="text-right font-normal">Axle kg</th></tr>
            </thead>
            <tbody>
              {wheels.map((w, i) => (
                <tr key={i} className="border-t border-line/60"><td className="py-0.5">{i + 1}</td><td className="text-right">{fmtInt(w.left_kg)}</td><td className="text-right">{fmtInt(w.right_kg)}</td><td className="text-right">{fmtInt(axles[i])}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <Empty text="No wheel readings: the scales did not produce a measurement." />}
        <div className="text-[11px] text-ink-3 mt-3 mb-1">Axle groups against limits</div>
        {groups.length ? (
          <ul className="flex flex-col gap-1.5">
            {groups.map((g, i) => {
              const ratio = g.limit_kg ? g.load_kg / g.limit_kg : 0;
              const over = ratio > 1;
              return (
                <li key={i} className="text-[11px]">
                  <div className="flex justify-between gap-2">
                    <span className="text-ink-2 truncate">{g.group}</span>
                    <span className={over ? "num text-stop" : "num text-ink"}>{fmtInt(g.load_kg)} of {fmtInt(g.limit_kg)} kg{over ? ", over limit" : ""}</span>
                  </div>
                  <Meter value={ratio} tone={over ? "var(--color-stop)" : "var(--color-accent)"} />
                </li>
              );
            })}
          </ul>
        ) : <div className="text-[11px] text-ink-3">{r.lifted_axle ? "Not computed for a lifted-axle pass: the axle count differs from the registered configuration." : "No group loads for this pass."}</div>}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] text-ink-3 mb-1">Checks</div>
        {r.checks?.length ? <CheckList checks={r.checks} /> : <Empty text="No checks recorded." />}
      </div>
    </div>
  );
}

function LaneInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const station = STATION_OPTIONS.some((s) => s.id === sp.get("station")) ? (sp.get("station") as string) : "mariakani";
  const { data: view, error, loading } = useApi<any>(`/lane/${station}`, 1000);
  const { can } = useAuth();
  const kpi = useLive((s) => s.kpi);
  const [followed, setFollowed] = useState<{ truck: string; plate: string; title: string; station: string } | null>(null);
  const [pinned, setPinned] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const last = view?.id === station ? view?.last_lane_result : null;
  useEffect(() => {
    if (followed && last?.truck === followed.truck) setPinned(last);
  }, [followed, last]);

  const inject = async (c: { id: string; title: string }) => {
    setBusy(c.id);
    setActionError(null);
    try {
      const r = await api(`/lane/${station}/inject`, { body: { case: c.id } });
      setFollowed({ truck: r.truck, plate: r.plate, title: r.title, station });
      setPinned(null);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const setSpeed = async (speed: number) => {
    setActionError(null);
    try {
      await api("/live/control", { body: { action: "speed", speed } });
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const speedOptions = useMemo(() => Array.from(new Set([...SPEEDS, ...(kpi ? [kpi.speed] : [])])).sort((a, b) => a - b), [kpi]);

  const selector = (
    <Select aria-label="Station" className="w-40" value={station} onChange={(e) => router.replace(`/lane?station=${e.target.value}`, { scroll: false })}>
      {STATION_OPTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
    </Select>
  );
  const title = <PageTitle title="Rolling Verification Lane" sub="Low-speed per-wheel verification beside the mainline. Readings come from the live simulation, not from physical scales." actions={<><Provenance kind="SIMULATED" title="Produced by the live engine" />{selector}</>} />;

  if (!view && loading) return <div className="p-3">{title}<Loading text="Loading the lane" /></div>;
  if (!view) return <div className="p-3">{title}<ErrorBox text={error || "The lane view is not available."} /></div>;

  const here = (view.lane_trucks ?? []) as { id: string; plate: string; state: string; part: string }[];
  const currentPlate = view.current_lane_truck ? here.find((t) => t.id === view.current_lane_truck)?.plate ?? view.current_lane_truck : null;
  const design = view.design ?? {};
  const followedHere = followed && followed.station === station;
  const followedTruck = followedHere ? here.find((t) => t.id === followed.truck) : undefined;
  const followedEvent = followedHere ? (view.recent ?? []).find((e: any) => e.truck === followed.truck) : undefined;
  const shown = pinned && followedHere ? pinned : view.last_lane_result;

  return (
    <div className="p-3">
      {title}
      {error && <div className="mb-2"><ErrorBox text={`Last refresh failed: ${error}. Showing the previous reading.`} /></div>}
      <div className="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6 mb-2">
        <Kpi label="Current truck" value={<span className="text-[17px]">{currentPlate ?? "None"}</span>} icon={Truck} tone="accent" sub={currentPlate ? "In the measuring zone" : "Measuring zone empty"} />
        <Kpi label="Queue length" value={fmtInt(view.lane_queue)} unit="trucks" icon={Hourglass} sub={`${fmtInt(view.lane_visits)} lane visits today`} />
        <Kpi label="Lane throughput" value={fmtInt(view.lane_throughput_h)} unit="per h" icon={Activity} sub={`Capacity ${fmtNum(view.lane_capacity_h, 0)} per h`} />
        <Kpi label="Lane utilization" value={fmtNum((view.lane_utilization ?? 0) * 100, 1)} unit="%" icon={Gauge} sub="Passes in the last simulated hour" />
        <Kpi label="Average verification time" value={view.avg_lane_min != null ? fmtNum(view.avg_lane_min, 2) : "-"} unit="min" icon={Clock} sub={view.avg_lane_min != null ? "Recent lane passes" : "No completed pass yet"} />
        <Kpi label="Last outcome" value={view.last_lane_result ? <Outcome value={view.last_lane_result.outcome} size="lg" /> : <span className="text-[17px]">None yet</span>} icon={Waypoints} sub={view.last_lane_result?.plate ?? "No lane result yet"} />
      </div>

      <Panel title={`Lane schematic, ${view.name}`} sub="updates every second" className="mb-2" actions={followedHere && followed ? <Badge tone="accent">Following {followed.plate}</Badge> : undefined}>
        <LaneSchematic view={view} followed={followedHere ? followed?.truck : null} />
      </Panel>

      <Panel
        title={pinned && followedHere ? `Measurement for the followed truck, ${pinned.plate}` : "Latest measurement"}
        sub={pinned && followedHere ? followed?.title : undefined}
        tag={<Provenance kind="SIMULATED" title="Simulated scale readings processed by the real decision engine" />}
        className="mb-2"
        actions={pinned && followedHere ? <Button size="sm" variant="ghost" onClick={() => { setPinned(null); setFollowed(null); }}>Back to latest</Button> : undefined}
      >
        {shown ? <Measurement r={shown} /> : <Empty text="No truck has finished the lane at this station yet. Inject a test case below or wait for a diverted truck." />}
      </Panel>

      <div className="grid gap-2 xl:grid-cols-3 mb-2">
        <Panel title="Test cases" sub="injects a real truck into the live twin">
          <div className="grid grid-cols-2 gap-1.5 mb-2">
            {(view.cases ?? []).map((c: { id: string; title: string }) => (
              <Button key={c.id} size="sm" className="justify-start" disabled={!can("lane.test") || !!busy} loading={busy === c.id} title={can("lane.test") ? undefined : "Your role cannot run lane tests"} onClick={() => inject(c)}>{c.title}</Button>
            ))}
          </div>
          {!can("lane.test") && <div className="text-[11px] text-ink-3 mb-2">Your role can watch the lane but cannot inject test trucks.</div>}
          {actionError && <div className="mb-2"><ErrorBox text={actionError} /></div>}
          {followedHere && followed && (
            <div className="text-[12px] text-ink mb-2">
              Injected <span className="num">{followed.plate}</span>, following it.{" "}
              <span className="text-ink-3 text-[11px]">
                {pinned ? "Lane result received." : followedTruck ? `Now on ${followedTruck.part.replace("_", " ")}.` : followedEvent ? "Lane decision recorded." : "On its way to the lane."}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2 border-t border-line pt-2">
            <span className="text-[11px] text-ink-2">Twin speed</span>
            <Select aria-label="Twin speed" className="w-24" disabled={!can("live.control") || !kpi} value={kpi?.speed ?? ""} onChange={(e) => setSpeed(Number(e.target.value))} title={can("live.control") ? undefined : "Your role cannot control the live twin"}>
              {speedOptions.map((s) => <option key={s} value={s}>{s}x</option>)}
            </Select>
            <span className="text-[11px] text-ink-3">A lower twin speed makes a truck easier to watch.</span>
          </div>
        </Panel>

        <Panel title="Design assumptions" tag={<Provenance kind="ASSUMED" title="Design values from RCS v2, not measured at a built lane" />}>
          <KV
            cols={2}
            items={[
              ["Target speed", `${fmtNum(design.target_speed_kmh, 0)} km/h`],
              ["Maximum speed", `${fmtNum(design.max_speed_kmh, 0)} km/h`],
              ["Headway", `${fmtNum(design.headway_m, 0)} m`],
              ["Lane pass", `${fmtNum(design.pass_min, 1)} min`],
              ["Capacity", `About ${fmtInt(design.capacity_per_h)} trucks per h`],
              ["Service per truck", `${fmtNum(design.service_s, 1)} s`],
              ["Static service", `About ${fmtNum(design.static_min_per_truck, 0)} min per truck`],
              ["Ratio to one static lane", `${fmtNum(design.ratio_to_static_lane, 1)} times`],
            ]}
          />
          <div className="mt-2 text-[11px] text-ink-3">One static lane handles about {fmtNum(design.static_capacity_per_h_per_lane, 0)} trucks per h at this service time. Values follow the current configuration.</div>
        </Panel>

        <Panel title="Station state" tag={<Provenance kind="SIMULATED" />}>
          <KV
            cols={2}
            items={[
              ["Cloud link", view.online ? "Online" : "Offline, using the edge cache"],
              ["Edge unit", view.edge_up ? "Running" : "Failed"],
              ["Records queued locally", fmtInt(view.outbox)],
              ["Availability", fmtPct(view.availability_pct, 2)],
              ["Audits today", fmtInt(view.audits)],
              ["Static visits today", fmtInt(view.static_visits)],
              ["Average static time", view.avg_static_min != null ? `${fmtNum(view.avg_static_min, 2)} min` : "-"],
              ["Failed sensors", view.sensors_failed?.length ? view.sensors_failed.join(", ") : "None"],
            ]}
          />
        </Panel>
      </div>

      <Panel title="Recent lane results" sub="latest 12 at this station" pad={false}>
        <DataTable<any>
          rows={view.recent ?? []}
          rowKey={(r) => r.id}
          empty="No lane decisions at this station yet."
          maxH="300px"
          cols={[
            { key: "at", label: "Time", mono: true, render: (r) => fmtTime(r.at) },
            { key: "plate", label: "Truck", mono: true, render: (r) => <span className="inline-flex items-center gap-1.5">{r.plate}{followed?.truck === r.truck && <Badge tone="accent">Followed</Badge>}</span> },
            { key: "gross", label: "Gross", align: "right", mono: true, render: (r) => fmtT(r.gross_kg) },
            { key: "outcome", label: "Outcome", render: (r) => <Outcome value={r.outcome} /> },
            { key: "fs", label: "Fail-safe", render: (r) => (r.fail_safe ? <Badge tone="wait">Yes</Badge> : <span className="text-ink-3">No</span>) },
            { key: "offline", label: "Link", render: (r) => <span className="text-ink-2">{r.offline ? "Offline" : "Online"}</span> },
            { key: "why", label: "Reason", render: (r) => <span className="text-ink-3 text-[11px] line-clamp-1" title={r.explanation}>{r.explanation}</span> },
          ]}
        />
      </Panel>
      <div className="mt-2"><Note>Every reading here is simulated. The decision logic, token checks and audit trail are the real application code, running on synthetic trucks.</Note></div>
    </div>
  );
}

export default function LanePage() {
  return (
    <Suspense fallback={<Loading text="Loading the lane" />}>
      <LaneInner />
    </Suspense>
  );
}
