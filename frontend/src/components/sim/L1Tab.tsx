"use client";
import { Check, LineChart, Play, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SERIES, TimeLines } from "@/components/charts";
import { Button, Empty, ErrorBox, Field, Kpi, Loading, Note, Panel, Provenance, Select, Slider } from "@/components/ui";
import { api } from "@/lib/api";
import { Histogram } from "./charts";
import { n, NO_CONTROL, NO_RUN, type SimCtx } from "./common";

const ERRORS: [string, string][] = [["road_error_pct", "Road WIM"], ["port_error_pct", "Port scale"], ["lane_error_pct", "Lane scale"], ["origin_error_pct", "Loading-site scale"]];

export function L1Tab({ ctx }: { ctx: SimCtx }) {
  const p = ctx.l1;
  const set = (k: string, v: number | string) => ctx.setL1((x) => ({ ...x, [k]: v }));
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [curves, setCurves] = useState<any>(null);
  const [curvesBusy, setCurvesBusy] = useState(false);
  const [curvesErr, setCurvesErr] = useState<string | null>(null);
  const [derived, setDerived] = useState<any>(null);
  const [applied, setApplied] = useState<{ before: any; after: any; note: string } | null>(null);
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const seq = useRef(0);

  const run = async () => {
    if (!ctx.canRun) return;
    const id = ++seq.current;
    setBusy(true);
    setErr(null);
    try {
      const r = await api("/sim/l1/run", { body: p });
      if (id === seq.current) setRes(r);
    } catch (e) {
      if (id === seq.current) setErr((e as Error).message);
    } finally {
      if (id === seq.current) setBusy(false);
    }
  };

  // Re-runs shortly after a control stops moving. A stale response is dropped by the sequence check above.
  useEffect(() => {
    if (!ctx.canRun) return;
    const t = setTimeout(run, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, ctx.canRun]);

  const loadCurves = async () => {
    setCurvesBusy(true);
    setCurvesErr(null);
    try {
      setCurves(await api("/sim/l1/curves", { body: p }));
    } catch (e) {
      setCurvesErr((e as Error).message);
    } finally {
      setCurvesBusy(false);
    }
  };

  const derive = async () => {
    setLinkBusy("derive");
    setLinkErr(null);
    setApplied(null);
    try {
      setDerived((await api("/sim/l1/derive", { body: p })).errors);
    } catch (e) {
      setLinkErr((e as Error).message);
    } finally {
      setLinkBusy(null);
    }
  };

  const apply = async () => {
    setLinkBusy("apply");
    setLinkErr(null);
    try {
      const before = ctx.live ?? ctx.config;
      const r = await api("/sim/l1/apply", { body: p });
      setApplied({ before, after: r.errors, note: r.note });
      setDerived(r.errors);
      ctx.patch(r.errors);
      ctx.refresh();
    } catch (e) {
      setLinkErr((e as Error).message);
    } finally {
      setLinkBusy(null);
    }
  };

  const base = applied?.before ?? ctx.config;

  return (
    <div className="grid gap-2 xl:grid-cols-[250px_minmax(0,1fr)] pt-2">
      <Panel title="Sensor conditions" tag={<Provenance kind="ASSUMED" title="Quarter-car and sensor coefficients are assumptions" />}>
        <div className="flex flex-col gap-2">
          <Slider label="Average loading" value={p.avg_loading_pct} min={30} max={120} unit="%" onChange={(v) => set("avg_loading_pct", v)} />
          <Slider label="Speed" value={p.speed_kmh} min={5} max={100} unit=" km/h" onChange={(v) => set("speed_kmh", v)} />
          <Slider label="Temperature" value={p.temperature_c} min={-5} max={70} unit=" C" onChange={(v) => set("temperature_c", v)} />
          <Slider label="Sensor error, per row" value={p.sensor_error_pct} min={0} max={15} step={0.1} unit="%" onChange={(v) => set("sensor_error_pct", v)} />
          <Slider label="Electrical noise" value={p.noise_pct} min={0} max={10} step={0.1} unit="%" onChange={(v) => set("noise_pct", v)} />
          <Slider label="Sensor rows" value={p.sensor_rows} min={1} max={16} onChange={(v) => set("sensor_rows", v)} />
          <Slider label="Sampling" value={p.sampling_khz} min={0.5} max={20} step={0.5} unit=" kHz" onChange={(v) => set("sampling_khz", v)} />
          <Field label="Calibration condition">
            <Select value={p.calibration} onChange={(e) => set("calibration", e.target.value)}>
              <option value="good">Good</option>
              <option value="aged">Aged</option>
              <option value="overdue">Overdue</option>
            </Select>
          </Field>
          <Field label="Road roughness, ISO 8608 class">
            <Select value={p.road_roughness} onChange={(e) => set("road_roughness", e.target.value)}>
              {["A", "B", "C", "D"].map((c) => <option key={c} value={c}>Class {c}</option>)}
            </Select>
          </Field>
          <Button variant="primary" icon={Play} loading={busy} disabled={!ctx.canRun} title={ctx.canRun ? undefined : NO_RUN} onClick={run}>Run L1</Button>
          <div className="text-[10.5px] text-ink-3">Also runs by itself shortly after a change.</div>
        </div>
      </Panel>

      <div className="flex flex-col gap-2 min-w-0">
        {!ctx.canRun && <Note>{NO_RUN}</Note>}
        {err && <ErrorBox text={err} />}
        {!res && busy && <Loading text="Running truck passes" />}
        {res && (
          <>
            <div className="grid gap-2 grid-cols-2 md:grid-cols-3 2xl:grid-cols-6">
              <Kpi label="Bias" value={n(res.bias_pct, 2)} unit="%" />
              <Kpi label="Sigma" value={n(res.sigma_pct, 2)} unit="%" />
              <Kpi label="Expanded, 95%" value={n(res.expanded_95_pct, 2)} unit="%" sub={`k=2 margin ${n(res.margin_k2_pct, 2)}%`} />
              <Kpi label="Confidence score" value={n(res.confidence_score, 3)} />
              <Kpi label="Within 5%" value={n(res.within_5pct, 1)} unit="%" sub="Share of passes" />
              <Kpi label="Samples per footprint" value={n(res.samples_per_footprint, 1)} sub={`Dynamic load ${n(res.dynamic_load_coefficient, 3)}`} />
            </div>
            <Panel title="Gross-weight error" sub={`${res.params.passes} simulated passes`} tag={<Provenance kind="MODELLED" title="Must be replaced by OIML R134 and COST 323 tests with pre-weighed reference trucks" />} actions={busy ? <span className="text-[11px] text-ink-3">Updating</span> : undefined}>
              <Histogram edges={res.histogram.edges} counts={res.histogram.counts} height={190} />
              <div className="text-[11.5px] text-ink-2 mt-1">OIML hint: {res.oiml_class_hint}</div>
            </Panel>
          </>
        )}

        <Panel
          title="Accuracy curves"
          sub="total error around this operating point"
          tag={<Provenance kind="MODELLED" />}
          actions={<Button size="sm" icon={LineChart} loading={curvesBusy} disabled={!ctx.canRun} title={ctx.canRun ? undefined : NO_RUN} onClick={loadCurves}>{curves ? "Recompute" : "Compute curves"}</Button>}
        >
          {curvesErr && <div className="mb-2"><ErrorBox text={curvesErr} /></div>}
          {curves ? (
            <div className="grid gap-3 lg:grid-cols-3">
              {([["speed", "By speed (km/h)"], ["temperature", "By temperature (C)"], ["load", "By load (% of limit)"]] as const).map(([k, title]) => (
                <div key={k}>
                  <div className="text-[11px] text-ink-3 mb-1">{title}</div>
                  <TimeLines data={curves[k]} x="x" series={[{ key: "sigma_pct", label: "Total error", color: SERIES.s1 }]} unit="%" height={160} yDomain={[0, "auto"]} />
                </div>
              ))}
            </div>
          ) : curvesBusy ? <Loading text="Sweeping speed, temperature and load" /> : <Empty text="Compute the curves to see how error moves with speed, temperature and load. Takes a few seconds." />}
        </Panel>

        <Panel
          title="L1 to L2 link"
          sub="scale errors from these conditions"
          tag={<Provenance kind="MODELLED" />}
          actions={
            <>
              <Button size="sm" icon={Wand2} loading={linkBusy === "derive"} disabled={!ctx.canRun || !!linkBusy} title={ctx.canRun ? undefined : NO_RUN} onClick={derive}>Derive scale errors</Button>
              <Button size="sm" variant="primary" icon={Check} loading={linkBusy === "apply"} disabled={!ctx.canControl || !!linkBusy} title={ctx.canControl ? undefined : NO_CONTROL} onClick={apply}>Apply to L2 and the live twin</Button>
            </>
          }
        >
          {linkErr && <div className="mb-2"><ErrorBox text={linkErr} /></div>}
          {derived && base ? (
            <table className="text-[12px] w-full max-w-[520px]">
              <thead><tr className="text-[11px] text-ink-3"><th className="text-left font-normal py-1">Scale</th><th className="text-right font-normal">{applied ? "Old" : "Current"}</th><th className="text-right font-normal">{applied ? "New" : "Derived"}</th></tr></thead>
              <tbody>
                {ERRORS.map(([k, label]) => (
                  <tr key={k} className="border-t border-line/60">
                    <td className="py-1 text-ink-2">{label}</td>
                    <td className="text-right num">{n(base[k], 2)}%</td>
                    <td className="text-right num text-ink">{n(derived[k], 2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty text="Derive to compare these conditions with the errors now in use. Nothing changes until you apply." />}
          {applied && <div className="mt-2"><Note>{applied.note}</Note></div>}
        </Panel>
      </div>
    </div>
  );
}
