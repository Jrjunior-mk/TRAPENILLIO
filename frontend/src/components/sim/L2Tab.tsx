"use client";
import { FlaskConical } from "lucide-react";
import { useEffect, useState } from "react";
import { Bars, SERIES } from "@/components/charts";
import { Badge, Button, DataTable, Empty, ErrorBox, Field, Input, Note, Panel, Provenance, Select } from "@/components/ui";
import { useJob } from "@/lib/api";
import { siteName } from "@/lib/format";
import { JobStatus, n, NO_RUN, type OpenRequest, ScenarioChecks, type SimCtx, useScenarios } from "./common";

const DOC_VALUES = [
  { coverage: 30, lane: 17.3, stat: 10.0 },
  { coverage: 50, lane: 13.3, stat: 7.1 },
  { coverage: 70, lane: 9.3, stat: 4.3 },
  { coverage: 90, lane: 5.2, stat: 1.5 },
];
const DOC_BASELINE_STATIC = 20.9;
const VALIDATION_ZERO = { dimension_violation_pct: 0, lifted_axle_pct: 0, token_fraud_pct: 0, misdeclaration_pct: 0, outage_per_day: 0 };

const CHARTS: { key: string; title: string; unit?: string; d: number }[] = [
  { key: "stops_per_1000", title: "Stops per 1,000 trucks", d: 1 },
  { key: "road_stops_per_1000", title: "Road stops per 1,000 trucks", d: 1 },
  { key: "lane_per_1000", title: "Lane passes per 1,000 trucks", d: 1 },
  { key: "avg_delay_min", title: "Average delay", unit: " min", d: 2 },
  { key: "p95_delay_min", title: "p95 delay", unit: " min", d: 1 },
  { key: "truck_hours_saved_per_day", title: "Truck-hours saved per day", d: 0 },
];

const signed = (v: number, d = 1) => `${v > 0 ? "+" : ""}${n(v, d)}`;

function Validation({ rows, config, days, run, disabled }: { rows: any[]; config: any; days: number; run: (coverage: number) => void; disabled: boolean }) {
  const v2 = rows.find((r) => r.scenario === "v2_all");
  const asIs = rows.find((r) => r.scenario === "as_is");
  const coverage = config?.token_coverage_pct;
  const zeroed = config && Object.keys(VALIDATION_ZERO).every((k) => config[k] === 0);
  return (
    <Panel
      title="Validation against the RCS v2 document"
      sub="first-station shares, percent of trucks"
      tag={<Provenance kind="MODELLED" title="This run is modelled. The document values come from the RCS v2 analysis, also modelled." />}
      actions={zeroed ? <Badge tone="go">Rates set to zero</Badge> : <Badge tone="wait">Rates not zero</Badge>}
    >
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[11px] text-ink-3">
            <th className="text-left font-normal py-1">Coverage</th>
            <th className="text-right font-normal">Document lane</th>
            <th className="text-right font-normal">This run lane</th>
            <th className="text-right font-normal">Difference</th>
            <th className="text-right font-normal">Document static</th>
            <th className="text-right font-normal">This run static</th>
            <th className="text-right font-normal">Difference</th>
            <th className="text-right font-normal">Run</th>
          </tr>
        </thead>
        <tbody>
          {DOC_VALUES.map((d) => {
            const same = v2 && coverage === d.coverage;
            return (
              <tr key={d.coverage} className={`border-t border-line/60 ${same ? "bg-panel-2" : ""}`}>
                <td className="py-1 num">{d.coverage}%</td>
                <td className="text-right num">{n(d.lane)}</td>
                <td className="text-right num text-ink">{same ? n(v2.first_station_lane_pct) : "-"}</td>
                <td className="text-right num">{same ? signed(v2.first_station_lane_pct - d.lane) : "-"}</td>
                <td className="text-right num">{n(d.stat)}</td>
                <td className="text-right num text-ink">{same ? n(v2.first_station_static_pct) : "-"}</td>
                <td className="text-right num">{same ? signed(v2.first_station_static_pct - d.stat) : "-"}</td>
                <td className="text-right py-0.5"><Button size="sm" disabled={disabled} title={`Runs ${days} days at ${d.coverage}% coverage with the rates below at zero`} onClick={() => run(d.coverage)}>Run</Button></td>
              </tr>
            );
          })}
          <tr className="border-t border-line-2">
            <td className="py-1 text-ink-2">Baseline</td>
            <td className="text-right num">-</td><td className="text-right num">-</td><td className="text-right num">-</td>
            <td className="text-right num">{n(DOC_BASELINE_STATIC)}</td>
            <td className="text-right num text-ink">{asIs ? n(asIs.first_station_static_pct) : "-"}</td>
            <td className="text-right num">{asIs ? signed(asIs.first_station_static_pct - DOC_BASELINE_STATIC) : "-"}</td>
            <td />
          </tr>
        </tbody>
      </table>
      <div className="text-[11px] text-ink-3 mt-2">
        A matching comparison requires the violation, outage and fraud rates set to zero, because the document model does not include them.
        {v2 && !DOC_VALUES.some((d) => d.coverage === coverage) && ` This run used ${n(coverage, 0)}% coverage, which has no document value. `}
        {!v2 && " Run L2 with RCS v2, all three streams included to fill the lane and static columns, or use a Run button above."}
      </div>
    </Panel>
  );
}

function Stations({ rows }: { rows: any[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const row = rows.find((r) => r.scenario === sel) ?? rows.find((r) => r.scenario === "v2_all") ?? rows[0];
  const stations = Object.entries(row.stations ?? {}).map(([id, s]: [string, any]) => ({ id, ...s }));
  return (
    <Panel title="Station breakdown" tag={<Provenance kind="MODELLED" />} pad={false} actions={
      <Select aria-label="Scenario" className="!h-6 w-60 !text-[11px]" value={row.scenario} onChange={(e) => setSel(e.target.value)}>
        {rows.map((r) => <option key={r.scenario} value={r.scenario}>{r.label}</option>)}
      </Select>
    }>
      <DataTable<any>
        rows={stations}
        rowKey={(s) => s.id}
        cols={[
          { key: "id", label: "Station", render: (s) => <span className="text-ink">{siteName(s.id)}</span> },
          { key: "t", label: "Trucks per day", align: "right", mono: true, render: (s) => n(s.trucks_per_day, 0) },
          { key: "lv", label: "Lane visits", align: "right", mono: true, render: (s) => n(s.lane.visits, 0) },
          { key: "lw", label: "Lane wait, min", align: "right", mono: true, render: (s) => n(s.lane.mean_wait_min, 2) },
          { key: "lq", label: "Lane max queue", align: "right", mono: true, render: (s) => n(s.lane.max_queue, 0) },
          { key: "lu", label: "Lane utilization", align: "right", mono: true, render: (s) => `${n(s.lane.utilization * 100, 1)}%` },
          { key: "sv", label: "Static visits", align: "right", mono: true, render: (s) => n(s.static.visits, 0) },
          { key: "sw", label: "Static wait, min", align: "right", mono: true, render: (s) => n(s.static.mean_wait_min, 2) },
          { key: "sp", label: "Static p95 wait", align: "right", mono: true, render: (s) => n(s.static.p95_wait_min, 1) },
          { key: "sq", label: "Static max queue", align: "right", mono: true, render: (s) => n(s.static.max_queue, 0) },
          { key: "su", label: "Static utilization", align: "right", mono: true, render: (s) => `${n(s.static.utilization * 100, 1)}%` },
        ]}
      />
    </Panel>
  );
}

export function L2Tab({ ctx, open }: { ctx: SimCtx; open?: OpenRequest }) {
  const { scenarios, error: scenErr } = useScenarios();
  const job = useJob<any>();
  const [days, setDays] = useState(2);
  const [engine, setEngine] = useState("fast");
  const [picked, setPicked] = useState<string[] | null>(null);
  const selected = picked ?? scenarios.map((s) => s.id);

  useEffect(() => {
    if (open?.id) job.watch(open.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.n]);

  const result = job.job?.status === "DONE" ? (job.job as any).result : null;
  const rows: any[] = result ? Object.values(result.scenarios ?? {}) : [];
  const runDisabled = !ctx.canRun || job.running || !ctx.config;

  const validate = (coverage: number) => job.start("/sim/l2/run", { config: { ...ctx.config, token_coverage_pct: coverage, ...VALIDATION_ZERO }, days, engine, scenarios: ["as_is", "v2_all"], name: `L2 validation at ${coverage}% coverage (${days} d)` });

  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="Run L2" sub="uses the draft configuration from the Control Room" tag={<Provenance kind="ASSUMED" title="All inputs except the 8,000 trucks/day are assumptions" />}>
          <div className="grid gap-3 md:grid-cols-[150px_minmax(0,1fr)]">
            <div className="flex flex-col gap-2">
              <Field label="Days"><Input type="number" min={1} max={30} value={days} onChange={(e) => setDays(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} /></Field>
              <Field label="Engine">
                <Select value={engine} onChange={(e) => setEngine(e.target.value)}>
                  <option value="fast">Fast</option>
                  <option value="simpy">SimPy</option>
                </Select>
              </Field>
              <Button variant="primary" icon={FlaskConical} disabled={runDisabled || !selected.length} title={ctx.canRun ? undefined : NO_RUN} onClick={() => job.start("/sim/l2/run", { config: ctx.config, days, engine, scenarios: selected })}>Run L2</Button>
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-ink-2 mb-1">Scenarios</div>
              {scenErr && <ErrorBox text={scenErr} />}
              <ScenarioChecks value={selected} onChange={setPicked} scenarios={scenarios} />
              <div className="mt-2"><JobStatus job={job.job} error={job.error} /></div>
            </div>
          </div>
        </Panel>
        <Panel title="Scenario notes">
          {scenarios.length ? (
            <ul className="flex flex-col gap-1.5">
              {scenarios.map((s) => <li key={s.id} className="text-[11.5px]"><span className="text-ink">{s.label}.</span> <span className="text-ink-3">{s.note}</span></li>)}
            </ul>
          ) : <Empty text="Loading scenario notes." />}
        </Panel>
      </div>

      {!result && !job.running && <Panel><Empty text="No L2 result yet. Run L2, or open a saved experiment from the Control Room." /></Panel>}
      {result && (
        <>
          <Panel title="Scenario comparison" sub={`${result.engine ?? "fast"} engine, one replication, ${rows[0]?.days ?? "-"} days`} tag={<Provenance kind="MODELLED" title="Results from assumed inputs, not measured data. Use Monte Carlo for confidence intervals." />} pad={false}>
            <DataTable<any>
              rows={rows}
              rowKey={(r) => r.scenario}
              cols={[
                { key: "label", label: "Scenario", render: (r) => <span className="text-ink">{r.label}</span> },
                { key: "ts", label: "Total stops", align: "right", mono: true, render: (r) => n(r.total_stops, 0) },
                { key: "s", label: "Stops /1,000", align: "right", mono: true, render: (r) => n(r.stops_per_1000) },
                { key: "rs", label: "Road stops /1,000", align: "right", mono: true, render: (r) => n(r.road_stops_per_1000) },
                { key: "l", label: "Lane /1,000", align: "right", mono: true, render: (r) => n(r.lane_per_1000) },
                { key: "d", label: "Avg delay, min", align: "right", mono: true, render: (r) => n(r.avg_delay_min, 2) },
                { key: "p", label: "p95 delay, min", align: "right", mono: true, render: (r) => n(r.p95_delay_min) },
                { key: "h", label: "Truck-hours saved /day", align: "right", mono: true, render: (r) => n(r.truck_hours_saved_per_day, 0) },
                { key: "q", label: "Max static queue", align: "right", mono: true, render: (r) => n(r.max_static_queue, 0) },
                { key: "u", label: "Static utilization", align: "right", mono: true, render: (r) => `${n(r.static_utilization_pct)}%` },
                { key: "pr", label: "Port re-weigh", align: "right", mono: true, render: (r) => `${n(r.port_reweigh_pct)}%` },
                { key: "f", label: "False clear", align: "right", mono: true, render: (r) => `${n(r.false_clear_pct, 3)}%` },
                { key: "c", label: "Token coverage", align: "right", mono: true, render: (r) => `${n(r.token_coverage_pct)}%` },
              ]}
            />
          </Panel>
          <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
            {CHARTS.map((c) => (
              <Panel key={c.key} title={c.title} tag={<Provenance kind="MODELLED" />}>
                <Bars data={rows.map((r) => ({ label: r.label, value: Number((r[c.key] ?? 0).toFixed(c.d)) }))} x="label" series={[{ key: "value", label: c.title, color: SERIES.s1 }]} layout="horizontal" unit={c.unit} xWidth={170} height={Math.max(120, rows.length * 32 + 30)} />
              </Panel>
            ))}
          </div>
          <Stations rows={rows} />
          <Note>Each result is one replication at one seed, so small differences between scenarios may be noise. Monte Carlo in the Control Room gives confidence intervals.</Note>
        </>
      )}
      <Validation rows={rows} config={result?.config ?? ctx.config} days={days} run={validate} disabled={runDisabled} />
    </div>
  );
}
