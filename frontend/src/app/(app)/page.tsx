"use client";
import { AlertTriangle, Bell, CheckCircle2, Clock, Coins, Gauge, Hourglass, Network, ShieldCheck, Truck, Waypoints, Weight } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Bars, NEUTRAL, SERIES, STATUS, StackedAreas, TimeLines } from "@/components/charts";
import { PageTitle } from "@/components/shell";
import { Badge, DataTable, Kpi, Loading, Meter, Outcome, Panel, Provenance } from "@/components/ui";
import { useApi } from "@/lib/api";
import { fmtClock, fmtInt, fmtNum, fmtPct, fmtT, fmtTime, siteName, STREAM_LABEL } from "@/lib/format";
import { type LiveEvent, type StationKpi, useLive } from "@/lib/live";

export default function CommandCentre() {
  const kpi = useLive((s) => s.kpi);
  const events = useLive((s) => s.events);
  const liveAlerts = useLive((s) => s.alerts);
  const { data: seriesData } = useApi<{ series: any[] }>("/live/series", 4000);
  const { data: snap } = useApi<{ events: LiveEvent[]; alerts: any[] }>("/live/events", 15000);
  const series = useMemo(() => seriesData?.series ?? [], [seriesData]);
  const recent = events.length ? events : snap?.events ?? [];
  const alerts = liveAlerts.length ? liveAlerts : snap?.alerts ?? [];

  if (!kpi) return <Loading text="Connecting to the live stream" />;
  const decisions = [
    { outcome: "Green", value: kpi.green },
    { outcome: "Amber", value: kpi.amber },
    { outcome: "Red", value: kpi.red },
  ];
  const stations = kpi.stations.filter((s) => s.kind !== "origin");

  return (
    <div className="p-3">
      <PageTitle
        title="Command Centre"
        sub="Every number comes from the running simulation and any trucks processed by operators. Totals reset at simulated midnight."
        actions={<><Provenance kind="SIMULATED" title="Values are produced by the live engine, not by real infrastructure" /><Link href="/twin" className="text-[12px] text-accent hover:underline">Open the digital twin</Link></>}
      />
      <div className="grid gap-2 grid-cols-2 md:grid-cols-4 xl:grid-cols-6 mb-2">
        <Kpi label="Trucks processed today" value={fmtInt(kpi.trucks_processed)} icon={Truck} tone="accent" sub={`${fmtInt(kpi.trucks_active)} on the corridor now`} />
        <Kpi label="Cleared automatically" value={fmtInt(kpi.auto_cleared)} icon={CheckCircle2} tone="go" sub={kpi.exited ? `${fmtPct((kpi.auto_cleared / kpi.exited) * 100)} of completed journeys` : "No completed journeys yet"} />
        <Kpi label="Sent to verification lane" value={fmtInt(kpi.lane)} icon={Waypoints} tone="wait" href="/lane" sub={`${fmtInt(kpi.audits)} were random audits`} />
        <Kpi label="Referred to static weighing" value={fmtInt(kpi.static)} icon={Weight} tone="stop" sub={`${fmtInt(kpi.confirmed_overload)} confirmed by the static scale`} />
        <Kpi label="Active tokens" value={fmtInt(kpi.tokens_active)} icon={ShieldCheck} tone="accent" href="/tokens" sub={`${fmtInt(kpi.tokens_issued)} issued today`} />
        <Kpi label="Token coverage" value={fmtNum(kpi.token_coverage_pct)} unit="%" icon={Coins} sub="At first road station" />
        <Kpi label="Average clearance delay" value={fmtNum(kpi.avg_clearance_min, 2)} unit="min" icon={Clock} sub="Per completed journey" />
        <Kpi label="Average queue length" value={fmtNum(kpi.avg_queue, 2)} unit="trucks" icon={Hourglass} sub="Per site, lane and static" />
        <Kpi label="Truck-hours saved" value={fmtNum(kpi.truck_hours_saved)} unit="h" icon={Gauge} tone="go" sub="Against the modelled as-is rule" />
        <Kpi label="System uptime" value={fmtNum(kpi.uptime_pct, 2)} unit="%" icon={Network} sub="Port and road sites, cloud link" />
        <Kpi label="Current alerts" value={fmtInt(kpi.alerts_open)} icon={Bell} tone={kpi.alerts_open ? "wait" : undefined} href="/alerts" sub="Raised today" />
        <Kpi label="Fail-safe decisions" value={fmtInt(kpi.fail_safe)} icon={AlertTriangle} tone={kpi.fail_safe ? "wait" : undefined} href="/sensors" sub="Faults that defaulted to amber or static" />
      </div>

      <div className="grid gap-2 xl:grid-cols-3 mb-2">
        <Panel title="Truck arrivals by stream" sub="per 15 simulated minutes" className="xl:col-span-2">
          <StackedAreas data={series} series={[{ key: "port", label: "Port", color: SERIES.s1 }, { key: "origin", label: "Industrial origin", color: SERIES.s2 }, { key: "untokened", label: "Untokened", color: SERIES.s3 }]} height={200} />
        </Panel>
        <Panel title="Clearance decisions" sub="all stages, today">
          <Bars data={decisions} x="outcome" series={[{ key: "value", label: "Decisions", color: NEUTRAL }]} colorBy={(d) => (d.outcome === "Green" ? STATUS.go : d.outcome === "Amber" ? STATUS.wait : STATUS.stop)} height={146} />
          <div className="flex gap-3 mt-2 text-[11px]">
            {["port", "origin", "untokened"].map((k) => [k, kpi.streams[k] ?? 0] as const).map(([k, v]) => (
              <div key={k} className="min-w-0"><span className="text-ink-3">{STREAM_LABEL[k] || k}</span><div className="num text-ink">{fmtInt(v)}</div></div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid gap-2 xl:grid-cols-3 mb-2">
        <Panel title="Station performance" sub="queues update live" className="xl:col-span-2" pad={false}>
          <DataTable<StationKpi>
            rows={stations}
            rowKey={(r) => r.id}
            onRow={(r) => (window.location.href = `/twin?station=${r.id}`)}
            cols={[
              { key: "name", label: "Site", render: (r) => <span className="text-ink">{siteName(r.id)}</span> },
              { key: "processed", label: "Decisions", align: "right", mono: true, render: (r) => fmtInt(r.processed) },
              { key: "green", label: "Green", align: "right", mono: true, render: (r) => fmtPct(r.processed ? (r.green / r.processed) * 100 : 0, 0) },
              { key: "lane", label: "Lane queue", align: "right", mono: true, render: (r) => r.lane_queue },
              { key: "static", label: "Static queue", align: "right", mono: true, render: (r) => r.static_queue },
              { key: "bay", label: "Bay utilization", width: "130px", render: (r) => <div className="flex items-center gap-2"><Meter value={r.bay_utilization} /><span className="num text-[11px] text-ink-2 w-9 text-right">{fmtPct(r.bay_utilization * 100, 0)}</span></div> },
              { key: "health", label: "Health", render: (r) => (!r.edge_up ? <Badge tone="stop">Edge down</Badge> : !r.online ? <Badge tone="wait">Offline, {r.outbox} queued</Badge> : r.syncing ? <Badge tone="accent">Syncing {r.outbox}</Badge> : r.faults ? <Badge tone="wait">{r.faults} sensor fault{r.faults > 1 ? "s" : ""}</Badge> : <Badge tone="go">Online</Badge>) },
            ]}
          />
        </Panel>
        <Panel title="System components" sub="live layer">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
            <Comp label="Event bus messages" value={fmtInt(kpi.system.messages)} />
            <Comp label="Records queued at the edge" value={fmtInt(kpi.system.queue_depth)} />
            <Comp label="Decision latency p50" value={`${fmtNum(kpi.system.api_latency_p50_ms)} ms`} />
            <Comp label="Decision latency p95" value={`${fmtNum(kpi.system.api_latency_p95_ms)} ms`} />
            <Comp label="Token service" value={kpi.system.registry_down ? "Unavailable" : "Available"} bad={kpi.system.registry_down} />
            <Comp label="Mock customs API" value={kpi.system.kra_down ? "Unavailable" : "Available"} bad={kpi.system.kra_down} />
            <Comp label="Failed lookups" value={fmtInt(kpi.system.failed_requests)} />
            <Comp label="Truck conservation" value={kpi.conservation.balanced ? "Balanced" : "Check failed"} bad={!kpi.conservation.balanced} />
          </dl>
        </Panel>
      </div>

      <div className="grid gap-2 xl:grid-cols-3">
        <Panel title="Recent clearance events" className="xl:col-span-2" pad={false}>
          <DataTable<LiveEvent>
            rows={recent.slice(0, 12)}
            rowKey={(r) => r.id}
            maxH="310px"
            onRow={(r) => (window.location.href = `/twin?truck=${r.truck}`)}
            cols={[
              { key: "at", label: "Time", mono: true, render: (r) => fmtTime(r.at) },
              { key: "plate", label: "Truck", mono: true, render: (r) => r.plate },
              { key: "site", label: "Site", render: (r) => siteName(r.site) },
              { key: "stage", label: "Stage", render: (r) => <span className="text-ink-2">{r.stage}</span> },
              { key: "gross", label: "Gross", align: "right", mono: true, render: (r) => fmtT(r.gross_kg) },
              { key: "outcome", label: "Outcome", render: (r) => <Outcome value={r.outcome} /> },
              { key: "why", label: "Reason", render: (r) => <span className="text-ink-3 text-[11px] line-clamp-1" title={r.explanation}>{r.explanation}</span> },
            ]}
          />
        </Panel>
        <div className="flex flex-col gap-2">
          <Panel title="Token coverage" sub="share of trucks with a token at their first road station">
            <TimeLines data={series} series={[{ key: "coverage", label: "Coverage at first station", color: SERIES.s1 }]} unit="%" height={120} yDomain={[0, 100]} />
          </Panel>
          <Panel title="Current system alerts" pad={false} className="flex-1" actions={<Link href="/alerts" className="text-[11px] text-accent">All</Link>}>
            <ul className="max-h-[170px] overflow-auto">
              {alerts.slice(0, 8).map((a: any, i: number) => (
                <li key={i} className="px-3 py-1.5 border-b border-line/60 flex items-start gap-2">
                  <Badge tone={a.severity === "critical" ? "stop" : a.severity === "warning" ? "wait" : "accent"}>{a.severity}</Badge>
                  <div className="min-w-0"><div className="text-[12px] truncate">{a.title}</div><div className="text-[10.5px] text-ink-3 num">{fmtClock(a.at)} {siteName(a.site)}</div></div>
                </li>
              ))}
              {!alerts.length && <li className="px-3 py-3 text-ink-3 text-[12px]">No alerts yet today.</li>}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

const Comp = ({ label, value, bad }: { label: string; value: string; bad?: boolean }) => (
  <div className="min-w-0">
    <dt className="text-[10.5px] text-ink-3 truncate">{label}</dt>
    <dd className={bad ? "num text-stop" : "num text-ink"}>{value}</dd>
  </div>
);
