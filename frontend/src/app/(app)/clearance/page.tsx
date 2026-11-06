"use client";
import { Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { actionLabel, Pager, ScoreRow, Toggle, tokenHref, truckHref, truncate, useDebounced } from "@/components/clearance-bits";
import { PageTitle } from "@/components/shell";
import { Badge, Button, CheckList, DataTable, Drawer, Empty, ErrorBox, Field, Input, KV, Loading, Note, Outcome, Panel, Provenance, Select, Tabs, TokenStatus } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtDateTime, fmtInt, fmtKg, fmtNum, siteName } from "@/lib/format";

type Vals = Record<string, string>;
type Errs = Record<string, string>;

interface Site { id: string; name: string; kind: string; origin_type: string | null }
interface Options { axle_configs: string[]; fleets: { id: number; name: string }[]; sites: Site[] }
interface Vehicle {
  id: number; plate: string; trailer: string | null; rfid: string | null; config: string; tractor_tare: number; trailer_tare: number; height: number; width: number; length: number; fleet: string | null; permit: string | null; demerits: number;
  mock_ntsa: { registration_valid: boolean; insurance_valid: boolean; roadworthy: boolean };
}
interface Profile { vehicle: Vehicle; gross_limit_kg: number; groups: { kind: string; axles: number; limit_kg: number }[] }

const TABS = [
  { id: "port", label: "A. Port trucks" },
  { id: "origin", label: "B. Industrial origin" },
  { id: "road", label: "C. Untokened (road)" },
  { id: "lane", label: "Verification lane" },
  { id: "fleet", label: "Registered fleet" },
];
const TAB_ALIAS: Record<string, string> = { untokened: "road", verification: "lane", trucks: "fleet" };

const WHO = {
  port: "A KPA gate operator or RCS administrator can clear port trucks.",
  origin: "A loading-site operator or RCS administrator can clear trucks at a loading site.",
  road: "A KeNHA officer or RCS administrator can clear trucks at road stations.",
};

const axleCount = (config: string) => config.split("-").reduce((a, p) => a + Number(p), 0);
const round100 = (n: number) => Math.round(n / 100) * 100;
const orNull = (s?: string) => (s && s.trim() ? s.trim() : null);
const numOrNull = (s?: string) => (s && s.trim() ? Number(s) : null);

// ISO 6346: the same check digit the backend applies.
function letterValues() {
  const out: Record<string, number> = {};
  let v = 10;
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (v % 11 === 0) v += 1;
    out[c] = v;
    v += 1;
  }
  return out;
}
const LETTERS = letterValues();
function checkDigit(code10: string) {
  let total = 0;
  for (let i = 0; i < code10.length; i++) {
    const c = code10[i];
    total += (LETTERS[c] ?? Number(c)) * 2 ** i;
  }
  return (total % 11) % 10;
}
const containerValid = (n: string) => /^[A-Z]{3}[UJZ]\d{7}$/.test(n) && checkDigit(n.slice(0, 10)) === Number(n[10]);
function sampleContainer() {
  const owner = ["CSQU", "MSCU", "MAEU", "TCLU", "CMAU"][Math.floor(Math.random() * 5)];
  const serial = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  return `${owner}${serial}${checkDigit(owner + serial)}`;
}

function checkNumber(errs: Errs, v: Vals, k: string, label: string, max?: number) {
  const raw = v[k]?.trim();
  if (!raw) return;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) errs[k] = `${label} must be a positive number`;
  else if (max !== undefined && n > max) errs[k] = `${label} cannot exceed ${max}`;
}

function parseAxles(raw?: string) {
  if (!raw?.trim()) return null;
  return raw.split(/[,\s]+/).filter(Boolean).map(Number);
}

function validateCommon(v: Vals, picked: Profile | null): Errs {
  const errs: Errs = {};
  if (!picked) errs.plate = "Choose a registered vehicle";
  checkNumber(errs, v, "gross_kg", "Gross weight", 200000);
  checkNumber(errs, v, "height_m", "Height", 10);
  checkNumber(errs, v, "width_m", "Width", 6);
  checkNumber(errs, v, "length_m", "Length", 40);
  const axles = parseAxles(v.axle_loads);
  if (axles) {
    if (axles.some((a) => !Number.isFinite(a) || a <= 0)) errs.axle_loads = "Axle loads must be positive numbers separated by commas";
    else if (picked) {
      const n = axleCount(picked.vehicle.config);
      if (axles.length !== n && axles.length !== n - 1) errs.axle_loads = `Expected ${n} axle loads for configuration ${picked.vehicle.config}`;
    }
  }
  return errs;
}

function commonBody(v: Vals, picked: Profile | null) {
  return {
    plate: picked?.vehicle.plate,
    plate_read: orNull(v.plate_read),
    rfid_read: orNull(v.rfid_read),
    trailer_read: orNull(v.trailer_read),
    gross_kg: numOrNull(v.gross_kg),
    axle_loads_kg: parseAxles(v.axle_loads),
    height_m: numOrNull(v.height_m),
    width_m: numOrNull(v.width_m),
    length_m: numOrNull(v.length_m),
  };
}

function useClearForm(initial: Vals, initialPlate: string | null) {
  const [v, setV] = useState<Vals>(initial);
  const [errs, setErrs] = useState<Errs>({});
  const [picked, setPicked] = useState<Profile | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (o: Vals) => setV((p) => ({ ...p, ...o }));
  const set = (k: string, x: string) => {
    patch({ [k]: x });
    setErrs((e) => {
      if (!e[k]) return e;
      const next = { ...e };
      delete next[k];
      return next;
    });
  };
  const pick = async (plate: string): Promise<Profile | null> => {
    try {
      const p = await api<Profile>(`/trucks/${encodeURIComponent(plate)}`);
      setPicked(p);
      setError(null);
      setErrs({});
      const x = p.vehicle;
      patch({ plate_read: x.plate, rfid_read: x.rfid || "", trailer_read: x.trailer || "", height_m: String(x.height), width_m: String(x.width), length_m: String(x.length), axle_loads: "" });
      return p;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };
  /** The vehicle a sample applies to: the chosen one, or the first registered vehicle. */
  const sampleVehicle = async (): Promise<Profile | null> => {
    if (picked) return picked;
    try {
      const r = await api<{ items: Vehicle[] }>("/trucks?limit=1");
      if (!r.items.length) {
        setError("No vehicles are registered yet. Register one under Registered fleet.");
        return null;
      }
      return await pick(r.items[0].plate);
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };
  const submit = async (path: string, errors: Errs, body: unknown) => {
    setErrs(errors);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api(path, { body }));
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const first = useRef(initialPlate);
  useEffect(() => {
    if (first.current) pick(first.current);
    first.current = null;
    // Runs once for a ?plate= deep link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { v, errs, picked, result, error, busy, patch, set, pick, sampleVehicle, submit, clear: () => setPicked(null) };
}
type Form = ReturnType<typeof useClearForm>;

function F({ form, k, label, hint, type = "text", upper, placeholder, step, className }: { form: Form; k: string; label: string; hint?: ReactNode; type?: string; upper?: boolean; placeholder?: string; step?: string; className?: string }) {
  return (
    <Field label={label} hint={hint} error={form.errs[k]} className={className}>
      <Input
        type={type}
        step={type === "number" ? step || "any" : undefined}
        min={type === "number" ? 0 : undefined}
        placeholder={placeholder}
        value={form.v[k] ?? ""}
        onChange={(e) => form.set(k, upper ? e.target.value.toUpperCase() : e.target.value)}
      />
    </Field>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div>
    <div className="eyebrow mb-1.5">{title}</div>
    {children}
  </div>
);

function VehiclePicker({ form }: { form: Form }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Vehicle[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const dq = useDebounced(q.trim(), 200);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setItems(null);
    setErr(null);
    api<{ items: Vehicle[] }>(`/trucks?limit=8&q=${encodeURIComponent(dq)}`)
      .then((r) => { if (live) setItems(r.items); })
      .catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [dq, open]);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, []);
  const p = form.picked;
  return (
    <div ref={box} className="relative min-w-0">
      <span className="block text-[11px] text-ink-2 mb-1">Vehicle plate</span>
      {p ? (
        <div className="flex items-center gap-2 h-[30px] px-2 rounded-sm bg-bg-2 border border-line-2 text-[12px]">
          <Link href={truckHref(p.vehicle.plate)} className="num text-accent hover:underline">{p.vehicle.plate}</Link>
          <span className="text-ink-3 truncate">{p.vehicle.trailer || "No trailer"}, axles {p.vehicle.config}, limit {fmtKg(p.gross_limit_kg)}</span>
          <button type="button" aria-label="Change vehicle" onClick={() => { form.clear(); setQ(""); }} className="ml-auto text-ink-3 hover:text-ink cursor-pointer disabled:cursor-not-allowed"><X size={13} /></button>
        </div>
      ) : (
        <div className="relative">
          <Search size={13} className="absolute left-2 top-2 text-ink-3" />
          <Input className="pl-7" aria-label="Search registered vehicles" placeholder="Search plate, trailer or tag" value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} />
        </div>
      )}
      {form.errs.plate && <span className="block text-[10.5px] text-stop mt-0.5">{form.errs.plate}</span>}
      {open && !p && (
        <div className="absolute top-full mt-1 left-0 right-0 bg-panel-2 border border-line-2 rounded-sm z-30 max-h-64 overflow-auto shadow-xl">
          {err && <div className="px-3 py-2 text-stop text-[12px]">{err}</div>}
          {!err && !items && <div className="px-3 py-2 text-ink-3 text-[12px]">Searching</div>}
          {items && !items.length && <div className="px-3 py-2 text-ink-3 text-[12px]">No registered vehicle matches. Register it under Registered fleet.</div>}
          {items?.map((x) => (
            <button key={x.id} type="button" onClick={() => { setOpen(false); form.pick(x.plate); }} className="w-full text-left flex items-center gap-3 px-3 py-1.5 hover:bg-line text-[12px] cursor-pointer">
              <span className="num text-ink w-20 shrink-0">{x.plate}</span>
              <span className="text-ink-3 num w-16 shrink-0">{x.trailer || "-"}</span>
              <span className="text-ink-3 num w-12 shrink-0">{x.config}</span>
              <span className="text-ink-3 truncate">{x.fleet || "No fleet"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IdentityFields({ form }: { form: Form }) {
  return (
    <div className="grid grid-cols-3 gap-2 mt-2">
      <F form={form} k="plate_read" label="ANPR plate read" upper placeholder="KDA 123A" />
      <F form={form} k="rfid_read" label="RFID read" placeholder="E200..." />
      <F form={form} k="trailer_read" label="Trailer read" upper placeholder="ZD 1234" />
    </div>
  );
}

function DimensionFields({ form }: { form: Form }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <F form={form} k="height_m" label="Height (m)" type="number" />
      <F form={form} k="width_m" label="Width (m)" type="number" />
      <F form={form} k="length_m" label="Length (m)" type="number" />
    </div>
  );
}

function ResultPanel({ form, what }: { form: Form; what: string }) {
  const r = form.result;
  const d = r?.decision;
  return (
    <Panel title="Decision" sub={what} tag={r ? <Provenance kind="DEMO DATA" title="Recorded in the demo database only" /> : undefined} actions={r?.plate ? <Link className="text-[11px] text-accent hover:underline" href={truckHref(r.plate)}>Truck profile</Link> : undefined}>
      {form.busy && <Loading text="Evaluating" />}
      {!form.busy && form.error && <ErrorBox text={form.error} />}
      {!form.busy && !form.error && !r && <Empty text="Submit the form to see the decision, its checks and any token issued." />}
      {!form.busy && d && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Outcome value={d.outcome} size="lg" />
            <span className="text-[12px] text-ink font-medium">{actionLabel(d.action)}</span>
            {d.fail_safe && <Badge tone="wait">Fail-safe</Badge>}
            {d.requires_officer && <Badge tone="stop">Officer required</Badge>}
            {r.offline && <Badge tone="wait">Site offline</Badge>}
          </div>
          <p className="text-[12px] text-ink-2 leading-relaxed">{d.explanation}</p>
          <ScoreRow risk={d.risk_score} confidence={d.confidence} />
          <KV
            cols={3}
            items={[
              ["Measured gross", <span key="g" className="num">{fmtKg(r.gross_kg)}</span>],
              ["Expected gross", <span key="e" className="num">{r.expected_gross_kg !== undefined ? fmtKg(r.expected_gross_kg) : "Not applicable"}</span>],
              ["Governing load", <span key="o" className="num">{d.governing_ratio !== null && d.governing_ratio !== undefined ? `${fmtNum(d.governing_ratio * 100)}% of limit` : "-"}</span>],
            ]}
          />
          <div>
            <div className="eyebrow mb-1">Load Compliance Token</div>
            {r.token ? (
              <div className="border border-line rounded-sm p-2">
                <KV
                  items={[
                    ["Token", <Link key="t" href={tokenHref(r.token.token_id)} className="num text-accent hover:underline break-all">{r.token.token_id}</Link>],
                    ["Status", <TokenStatus key="s" value={r.token.status} />],
                    ["Source", r.token.source],
                    ["Valid until", <span key="v" className="num">{fmtDateTime(r.token.valid_until)} EAT sim</span>],
                    ["Signing key", <span key="k" className="num">{r.token.kid}</span>],
                    ["Signature (Ed25519)", <span key="x" className="num text-[11px]" title={r.token.signature}>{truncate(r.token.signature)}</span>],
                  ]}
                />
              </div>
            ) : (
              <div className="text-[12px] text-ink-3">
                No new token issued.
                {r.token_checked && <> Existing token checked: <Link href={tokenHref(r.token_checked)} className="num text-accent hover:underline">{r.token_checked}</Link></>}
              </div>
            )}
          </div>
          {"release" in r && (
            <div className="border border-line rounded-sm p-2">
              <div className="flex items-center gap-2 mb-1.5"><span className="eyebrow">Adapter responses</span><Provenance kind="MOCK" title="Mock customs, port and e-seal responses. No agency system is connected." /></div>
              <KV
                items={[
                  ["Customs release", r.release ? (r.release.customs ? "Released" : "Held") : "Mock service unavailable"],
                  ["Shipping line release", r.release ? (r.release.shipping_line ? "Released" : "Not released") : "-"],
                  ["KPA release", r.release ? (r.release.kpa ? "Released" : "Not released") : "-"],
                  ["Mock ICMS reference", <span key="i" className="num">{r.release?.icms_ref || "-"}</span>],
                  ["E-seal", <span key="e" className="num">{r.eseal?.eseal_id || "None"}</span>],
                  ["E-seal status", r.eseal?.status || "-"],
                  ["Container check digit", r.container_check_ok ? "Valid" : "Missing or invalid"],
                ]}
              />
            </div>
          )}
          <div>
            <div className="eyebrow mb-1">Checks</div>
            <CheckList checks={d.checks} />
          </div>
        </div>
      )}
    </Panel>
  );
}

function Gate({ allowed, who, children }: { allowed: boolean; who: string; children: ReactNode }) {
  const { me } = useAuth();
  return (
    <>
      {me && !allowed && <div className="mb-2"><Note>Your role ({me.role_label}) cannot submit this form. {who}</Note></div>}
      <fieldset disabled={!allowed} className="space-y-3 min-w-0 disabled:opacity-60">{children}</fieldset>
    </>
  );
}

function PortTab({ plate }: { plate: string | null }) {
  const { can } = useAuth();
  const form = useClearForm({ container: "", declared_cargo_kg: "", container_tare_kg: "3800", gross_kg: "" }, plate);
  const { v, picked } = form;

  const loadSample = async (over: boolean) => {
    const p = await form.sampleVehicle();
    if (!p) return;
    const x = p.vehicle;
    const containerTare = 3800;
    const gross = round100(p.gross_limit_kg * (over ? 1.12 : 0.88));
    form.patch({
      plate_read: x.plate, rfid_read: x.rfid || "", trailer_read: x.trailer || "", height_m: String(x.height), width_m: String(x.width), length_m: String(x.length), axle_loads: "",
      container: sampleContainer(), container_tare_kg: String(containerTare), gross_kg: String(gross), declared_cargo_kg: String(Math.max(0, gross - x.tractor_tare - x.trailer_tare - containerTare)),
    });
  };

  const declared = numOrNull(v.declared_cargo_kg);
  const containerTare = numOrNull(v.container_tare_kg) ?? 0;
  const measured = numOrNull(v.gross_kg);
  const expected = picked && declared !== null && Number.isFinite(declared) ? picked.vehicle.tractor_tare + picked.vehicle.trailer_tare + containerTare + declared : null;
  const variance = expected && measured ? ((measured - expected) / expected) * 100 : null;
  const containerText = v.container?.trim();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validateCommon(v, picked);
    if (v.declared_cargo_kg?.trim() && !(Number(v.declared_cargo_kg) >= 0)) errs.declared_cargo_kg = "Declared cargo cannot be negative";
    if (v.container_tare_kg?.trim() && !(Number(v.container_tare_kg) >= 0)) errs.container_tare_kg = "Container tare cannot be negative";
    form.submit("/clearance/port", errs, { ...commonBody(v, picked), container: orNull(containerText), declared_cargo_kg: declared, container_tare_kg: numOrNull(v.container_tare_kg) });
  };

  return (
    <TwoCol
      form={
        <Panel title="Port gate-out" sub="Mombasa Port Gate-Out Node" actions={<SampleButtons disabled={!can("clear.port")} onSample={loadSample} over />}>
          <form onSubmit={onSubmit}>
            <Gate allowed={can("clear.port")} who={WHO.port}>
              <Section title="Identity">
                <VehiclePicker form={form} />
                <IdentityFields form={form} />
              </Section>
              <Section title="Cargo">
                <div className="grid grid-cols-3 gap-2">
                  <F form={form} k="container" label="Container number" upper placeholder="CSQU3054383" hint={containerText ? (containerValid(containerText) ? "ISO 6346 check digit valid" : "Fails ISO 6346: the decision will be amber") : "Blank or invalid goes to amber"} />
                  <F form={form} k="declared_cargo_kg" label="Declared cargo (kg)" type="number" />
                  <F form={form} k="container_tare_kg" label="Container tare (kg)" type="number" />
                </div>
              </Section>
              <Section title="Weighing">
                <div className="grid grid-cols-2 gap-2">
                  <F form={form} k="gross_kg" label="Measured gross (kg)" type="number" hint="Blank tests the fail-safe to re-weigh" />
                  <F form={form} k="axle_loads" label="Axle loads (kg, optional)" placeholder="6800, 8500, 8500, 6000, 6000, 6000" hint={picked ? `${axleCount(picked.vehicle.config)} values, front to back. Blank spreads gross by group limits.` : "Comma separated, front to back"} />
                </div>
              </Section>
              <div className="border border-line rounded-sm bg-bg-2 px-3 py-2">
                <KV
                  cols={4}
                  items={[
                    ["Tractor and trailer tare", <span key="t" className="num">{picked ? fmtKg(picked.vehicle.tractor_tare + picked.vehicle.trailer_tare) : "Choose a vehicle"}</span>],
                    ["Expected gross", <span key="e" className="num text-[14px] font-medium">{expected !== null ? fmtKg(expected) : "-"}</span>],
                    ["Measured against expected", <span key="v" className="num">{variance !== null ? `${variance > 0 ? "+" : ""}${fmtNum(variance)}%` : "-"}</span>],
                    ["Gross limit", <span key="l" className="num">{picked ? fmtKg(picked.gross_limit_kg) : "-"}</span>],
                  ]}
                />
                <div className="text-[10.5px] text-ink-3 mt-1.5">Expected gross = tractor tare + trailer tare + container tare + declared cargo.</div>
              </div>
              <Section title="Dimensions"><DimensionFields form={form} /></Section>
              <SubmitRow busy={form.busy} label="Clear at the port" />
            </Gate>
          </form>
        </Panel>
      }
      result={<ResultPanel form={form} what="Port stage" />}
    />
  );
}

function OriginTab({ options, plate }: { options: Options | null; plate: string | null }) {
  const { can, me } = useAuth();
  const form = useClearForm({ site: "", gross_kg: "", cargo: "", ticket: "1", scale: "1", calibration: "1", onboard: "" }, plate);
  const { v, picked } = form;
  const origins = options?.sites.filter((s) => s.kind === "origin") ?? [];
  useEffect(() => {
    // Waits for the signed-in user so a loading-site operator starts on their own site.
    if (me && !v.site && origins.length) form.set("site", origins.find((s) => s.id === me.site_id)?.id || origins[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origins.length, me?.site_id]);

  const loadSample = async () => {
    const p = await form.sampleVehicle();
    if (!p) return;
    const x = p.vehicle;
    form.patch({ plate_read: x.plate, rfid_read: x.rfid || "", trailer_read: x.trailer || "", height_m: String(x.height), width_m: String(x.width), length_m: String(x.length), axle_loads: "", gross_kg: String(round100(p.gross_limit_kg * 0.86)), cargo: "Ballast", ticket: "1", scale: "1", calibration: "1", onboard: "" });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validateCommon(v, picked);
    if (!v.site) errs.site = "Choose a loading site";
    form.submit("/clearance/origin", errs, {
      ...commonBody(v, picked),
      site: v.site,
      ticket_signature_valid: v.ticket === "1",
      // Ticked sends no override, so the site's recorded status applies.
      scale_approved: v.scale === "1" ? null : false,
      calibration_valid: v.calibration === "1" ? null : false,
      onboard_only: v.onboard === "1",
      cargo: orNull(v.cargo),
    });
  };

  return (
    <TwoCol
      form={
        <Panel title="Loading site weighing" sub="Approved scale at an industrial origin" actions={<SampleButtons disabled={!can("clear.origin")} onSample={loadSample} />}>
          <form onSubmit={onSubmit}>
            <Gate allowed={can("clear.origin")} who={WHO.origin}>
              <Section title="Identity">
                <VehiclePicker form={form} />
                <IdentityFields form={form} />
              </Section>
              <Section title="Loading">
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Loading site" error={form.errs.site}>
                    <Select value={v.site} onChange={(e) => form.set("site", e.target.value)}>
                      {!origins.length && <option value="">Loading sites</option>}
                      {origins.map((s) => <option key={s.id} value={s.id}>{s.name}{s.origin_type ? `, ${s.origin_type}` : ""}</option>)}
                    </Select>
                  </Field>
                  <F form={form} k="gross_kg" label="Scale gross (kg)" type="number" hint={picked ? `Limit ${fmtKg(picked.gross_limit_kg)}` : "Blank tests the fail-safe"} />
                  <F form={form} k="cargo" label="Cargo" placeholder="Ballast" />
                </div>
              </Section>
              <Section title="Scale and ticket">
                <div className="grid grid-cols-2 gap-2">
                  <Toggle label="Weighing ticket signed" checked={v.ticket === "1"} onChange={(c) => form.set("ticket", c ? "1" : "")} />
                  <Toggle label="On-board record only" hint="Informs risk but can never issue a token" checked={v.onboard === "1"} onChange={(c) => form.set("onboard", c ? "1" : "")} />
                  <Toggle label="Scale approved" hint="Ticked uses the site's recorded status. Unticked records it as not approved." checked={v.scale === "1"} onChange={(c) => form.set("scale", c ? "1" : "")} />
                  <Toggle label="Calibration valid" hint="Ticked uses the site's recorded status. Unticked records it as expired." checked={v.calibration === "1"} onChange={(c) => form.set("calibration", c ? "1" : "")} />
                </div>
              </Section>
              <Section title="Dimensions"><DimensionFields form={form} /></Section>
              <SubmitRow busy={form.busy} label="Weigh and clear" />
            </Gate>
          </form>
        </Panel>
      }
      result={<ResultPanel form={form} what="Origin stage" />}
    />
  );
}

function StationSelect({ form, options }: { form: Form; options: Options | null }) {
  const road = options?.sites.filter((s) => s.kind === "road") ?? [];
  return (
    <Field label="Station" error={form.errs.site}>
      <Select value={form.v.site} onChange={(e) => form.set("site", e.target.value)}>
        {!road.length && <option value={form.v.site}>{siteName(form.v.site)}</option>}
        {road.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </Select>
    </Field>
  );
}

function RoadTab({ options, plate }: { options: Options | null; plate: string | null }) {
  const { can } = useAuth();
  const form = useClearForm({ site: "mariakani", gross_kg: "", axles_detected: "", quality: "0.95", audit: "auto" }, plate);
  const { v, picked } = form;

  const loadSample = async () => {
    const p = await form.sampleVehicle();
    if (!p) return;
    const x = p.vehicle;
    form.patch({ plate_read: x.plate, rfid_read: x.rfid || "", trailer_read: x.trailer || "", height_m: String(x.height), width_m: String(x.width), length_m: String(x.length), axle_loads: "", gross_kg: String(round100(p.gross_limit_kg * 0.78)), axles_detected: String(axleCount(x.config)), quality: "0.95", audit: "no" });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validateCommon(v, picked);
    const axles = v.axles_detected?.trim();
    if (axles && !(Number.isInteger(Number(axles)) && Number(axles) >= 0)) errs.axles_detected = "Axles detected must be a whole number";
    const q = v.quality?.trim();
    if (q && !(Number(q) >= 0 && Number(q) <= 1)) errs.quality = "Quality must be between 0 and 1";
    form.submit("/clearance/road", errs, { ...commonBody(v, picked), site: v.site, axles_detected: numOrNull(axles), quality: numOrNull(q), audit: v.audit === "auto" ? null : v.audit === "yes" });
  };

  return (
    <TwoCol
      form={
        <Panel title="Road mainline" sub="High-speed WIM at a road station" actions={<SampleButtons disabled={!can("clear.road")} onSample={loadSample} />}>
          <form onSubmit={onSubmit}>
            <Gate allowed={can("clear.road")} who={WHO.road}>
              <Section title="Identity">
                <VehiclePicker form={form} />
                <IdentityFields form={form} />
              </Section>
              <Section title="Reading">
                <div className="grid grid-cols-3 gap-2">
                  <StationSelect form={form} options={options} />
                  <F form={form} k="gross_kg" label="WIM gross (kg)" type="number" hint={picked ? `Limit ${fmtKg(picked.gross_limit_kg)}` : "Blank tests the fail-safe"} />
                  <F form={form} k="axles_detected" label="Axles detected" type="number" step="1" hint={picked ? `${axleCount(picked.vehicle.config)} registered` : "Blank assumes the registered count"} />
                  <F form={form} k="quality" label="Data quality (0 to 1)" type="number" step="0.01" />
                  <F form={form} k="axle_loads" label="Axle loads (kg, optional)" placeholder="Comma separated" className="col-span-2" />
                </div>
              </Section>
              <Section title="Random audit">
                <Field label="Audit selection">
                  <Select value={v.audit} onChange={(e) => form.set("audit", e.target.value)}>
                    <option value="auto">By the policy audit rate</option>
                    <option value="yes">Select for audit</option>
                    <option value="no">Do not select</option>
                  </Select>
                </Field>
              </Section>
              <Section title="Dimensions"><DimensionFields form={form} /></Section>
              <SubmitRow busy={form.busy} label="Process at the station" />
            </Gate>
          </form>
        </Panel>
      }
      result={<ResultPanel form={form} what="Road stage" />}
    />
  );
}

function LaneTab({ options, plate }: { options: Options | null; plate: string | null }) {
  const { can } = useAuth();
  const form = useClearForm({ site: "mariakani", gross_kg: "", quality: "0.95", lifted: "" }, plate);
  const { v, picked } = form;

  const loadSample = async () => {
    const p = await form.sampleVehicle();
    if (!p) return;
    const x = p.vehicle;
    form.patch({ plate_read: x.plate, rfid_read: x.rfid || "", trailer_read: x.trailer || "", height_m: String(x.height), width_m: String(x.width), length_m: String(x.length), axle_loads: "", gross_kg: String(round100(p.gross_limit_kg * 0.8)), quality: "0.95", lifted: "" });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validateCommon(v, picked);
    const q = v.quality?.trim();
    if (q && !(Number(q) >= 0 && Number(q) <= 1)) errs.quality = "Quality must be between 0 and 1";
    form.submit("/clearance/lane", errs, { ...commonBody(v, picked), site: v.site, quality: numOrNull(q), lifted_axle: v.lifted === "1" });
  };

  return (
    <TwoCol
      form={
        <Panel title="Rolling Verification Lane" sub="Per-wheel scales and LiDAR portal" actions={<SampleButtons disabled={!can("clear.road")} onSample={loadSample} />}>
          <form onSubmit={onSubmit}>
            <Gate allowed={can("clear.road")} who={WHO.road}>
              <Section title="Identity">
                <VehiclePicker form={form} />
                <IdentityFields form={form} />
              </Section>
              <Section title="Lane reading">
                <div className="grid grid-cols-3 gap-2">
                  <StationSelect form={form} options={options} />
                  <F form={form} k="gross_kg" label="Lane gross (kg)" type="number" hint={picked ? `Limit ${fmtKg(picked.gross_limit_kg)}` : "Blank means inconclusive"} />
                  <F form={form} k="quality" label="Data quality (0 to 1)" type="number" step="0.01" />
                  <F form={form} k="axle_loads" label="Axle loads (kg, optional)" placeholder="Comma separated" className="col-span-3" />
                </div>
                <div className="mt-2"><Toggle label="Lifted axle seen by side LiDAR" hint="Weights are then assessed against the configuration the truck is really operating as" checked={v.lifted === "1"} onChange={(c) => form.set("lifted", c ? "1" : "")} /></div>
              </Section>
              <Section title="Dimensions"><DimensionFields form={form} /></Section>
              <SubmitRow busy={form.busy} label="Record lane verification" />
            </Gate>
          </form>
        </Panel>
      }
      result={<ResultPanel form={form} what="Lane stage" />}
    />
  );
}

const TwoCol = ({ form, result }: { form: ReactNode; result: ReactNode }) => (
  <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,440px)] items-start">
    {form}
    {result}
  </div>
);

function SampleButtons({ onSample, over, disabled }: { onSample: (over: boolean) => void; over?: boolean; disabled?: boolean }) {
  return (
    <>
      <Button type="button" size="sm" disabled={disabled} onClick={() => onSample(false)} title="Fills realistic values for the chosen vehicle, or the first registered vehicle">Load sample</Button>
      {over && <Button type="button" size="sm" disabled={disabled} onClick={() => onSample(true)} title="Gross is set above the vehicle's limit">Load overloaded sample</Button>}
    </>
  );
}

const SubmitRow = ({ busy, label }: { busy: boolean; label: string }) => (
  <div className="flex items-center gap-3 pt-1">
    <Button type="submit" variant="primary" loading={busy}>{label}</Button>
    <span className="text-[11px] text-ink-3">Uses the same decision functions as the live engine. Demo record only.</span>
  </div>
);

const PLATE_RE = /^[A-Z]{3} ?\d{3}[A-Z]$/;
const TRAILER_RE = /^Z[A-Z] ?\d{4}$/;
const spaced = (s: string, at: number) => (s.includes(" ") ? s : `${s.slice(0, at)} ${s.slice(at)}`);
const EMPTY_VEHICLE: Vals = { tractor_plate: "", trailer_plate: "", rfid_tag: "", axle_config: "1-2-3", tractor_tare_kg: "8200", trailer_tare_kg: "6500", height_m: "4.1", width_m: "2.5", length_m: "17", fleet_id: "", permit_ref: "", driver_name: "" };

function RegisterDrawer({ open, onClose, options, onDone }: { open: boolean; onClose: () => void; options: Options | null; onDone: (plate: string) => void }) {
  const { me } = useAuth();
  const [v, setV] = useState<Vals>(EMPTY_VEHICLE);
  const [errs, setErrs] = useState<Errs>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, x: string) => setV((p) => ({ ...p, [k]: x }));
  const transporter = me?.role === "transporter";

  const range = (e: Errs, k: string, label: string, low: number, high: number, lowOpen = true, highOpen = false) => {
    const n = Number(v[k]);
    const ok = v[k]?.trim() !== "" && Number.isFinite(n) && (lowOpen ? n > low : n >= low) && (highOpen ? n < high : n <= high);
    if (!ok) e[k] = `${label} must be ${lowOpen ? "above" : "at least"} ${low} and ${highOpen ? "below" : "at most"} ${high}`;
  };

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e: Errs = {};
    const plate = v.tractor_plate.trim();
    const trailer = v.trailer_plate.trim();
    const rfid = v.rfid_tag.trim();
    if (!PLATE_RE.test(plate)) e.tractor_plate = "Use the format KDA 123A";
    if (trailer && !TRAILER_RE.test(trailer)) e.trailer_plate = "Use the format ZD 1234";
    if (rfid && (rfid.length < 6 || rfid.length > 32)) e.rfid_tag = "RFID tag must be 6 to 32 characters";
    range(e, "tractor_tare_kg", "Tractor tare", 1000, 20000, true, true);
    range(e, "trailer_tare_kg", "Trailer tare", 0, 20000, false, true);
    range(e, "height_m", "Height", 1, 6);
    range(e, "width_m", "Width", 1, 4);
    range(e, "length_m", "Length", 3, 40);
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Vehicle>("/trucks", {
        body: {
          tractor_plate: plate, trailer_plate: trailer ? spaced(trailer, 2) : null, rfid_tag: rfid || null, axle_config: v.axle_config,
          tractor_tare_kg: Number(v.tractor_tare_kg), trailer_tare_kg: Number(v.trailer_tare_kg), height_m: Number(v.height_m), width_m: Number(v.width_m), length_m: Number(v.length_m),
          fleet_id: v.fleet_id ? Number(v.fleet_id) : null, permit_ref: orNull(v.permit_ref), driver_name: orNull(v.driver_name),
        },
      });
      setV(EMPTY_VEHICLE);
      onDone(r.plate);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const T = ({ k, label, hint, upper, type = "text", placeholder }: { k: string; label: string; hint?: string; upper?: boolean; type?: string; placeholder?: string }) => (
    <Field label={label} hint={hint} error={errs[k]}>
      <Input type={type} step={type === "number" ? "any" : undefined} placeholder={placeholder} value={v[k]} onChange={(e) => set(k, upper ? e.target.value.toUpperCase() : e.target.value)} />
    </Field>
  );

  return (
    <Drawer open={open} onClose={onClose} title="Register vehicle" width={500}>
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {T({ k: "tractor_plate", label: "Tractor plate", upper: true, placeholder: "KDA 123A" })}
          {T({ k: "trailer_plate", label: "Trailer plate", upper: true, placeholder: "ZD 1234", hint: "Leave blank if there is no trailer" })}
          {T({ k: "rfid_tag", label: "RFID tag", placeholder: "E2000000ABCD", hint: "Without a tag the truck cannot reach the identity threshold for green" })}
          <Field label="Axle configuration" hint="Axles per group, front to back">
            <Select value={v.axle_config} onChange={(e) => set("axle_config", e.target.value)}>
              {(options?.axle_configs ?? [v.axle_config]).map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          {T({ k: "tractor_tare_kg", label: "Tractor tare (kg)", type: "number" })}
          {T({ k: "trailer_tare_kg", label: "Trailer tare (kg)", type: "number" })}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {T({ k: "height_m", label: "Height (m)", type: "number" })}
          {T({ k: "width_m", label: "Width (m)", type: "number" })}
          {T({ k: "length_m", label: "Length (m)", type: "number" })}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Fleet" hint={transporter ? "Your own fleet is applied automatically" : undefined}>
            <Select value={v.fleet_id} disabled={transporter} onChange={(e) => set("fleet_id", e.target.value)}>
              <option value="">No fleet</option>
              {options?.fleets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </Field>
          {T({ k: "permit_ref", label: "Permit reference (optional)" })}
          {T({ k: "driver_name", label: "Driver name (optional)", hint: "Stored encrypted. Use demo names only." })}
        </div>
        {error && <ErrorBox text={error} />}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy}>Register vehicle</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Drawer>
  );
}

function FleetTab({ options }: { options: Options | null }) {
  const router = useRouter();
  const { can, me } = useAuth();
  const [q, setQ] = useState("");
  const [fleet, setFleet] = useState("");
  const [offset, setOffset] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const dq = useDebounced(q.trim());
  const limit = 25;
  useEffect(() => setOffset(0), [dq, fleet]);
  const { data, error, loading, refresh } = useApi<{ total: number; items: Vehicle[] }>(`/trucks?limit=${limit}&offset=${offset}${dq ? `&q=${encodeURIComponent(dq)}` : ""}${fleet ? `&fleet_id=${fleet}` : ""}`);
  const allowed = can("truck.register");
  return (
    <Panel
      title="Registered fleet"
      sub={data ? `${fmtInt(data.total)} vehicles` : undefined}
      pad={false}
      tag={<Provenance kind="DEMO DATA" title="Seeded synthetic vehicles" />}
      actions={<Button size="sm" variant="primary" icon={Plus} disabled={!allowed} title={allowed ? undefined : "Your role cannot register vehicles"} onClick={() => setDrawer(true)}>Register vehicle</Button>}
    >
      <div className="flex flex-wrap items-end gap-2 p-2 border-b border-line">
        <Field label="Search" className="w-[260px]"><Input placeholder="Plate, trailer or tag" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Field label="Fleet" className="w-[220px]">
          <Select value={fleet} onChange={(e) => setFleet(e.target.value)}>
            <option value="">All fleets</option>
            {options?.fleets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </Field>
        {me && !allowed && <span className="text-[11px] text-ink-3 pb-2">A KeNHA, KPA, transporter, loading-site or administrator account can register vehicles.</span>}
        {done && <span className="text-[11px] text-ink-2 pb-2">Registered <Link className="num text-accent hover:underline" href={truckHref(done)}>{done}</Link>. It can now be cleared.</span>}
      </div>
      {error && <div className="p-2"><ErrorBox text={error} /></div>}
      {!data && loading && <Loading text="Loading vehicles" />}
      {data && (
        <>
          <DataTable<Vehicle>
            rows={data.items}
            rowKey={(r) => r.id}
            onRow={(r) => router.push(truckHref(r.plate))}
            empty={dq ? "No vehicle matches that search." : "No vehicles are registered yet."}
            cols={[
              { key: "plate", label: "Tractor", mono: true, render: (r) => <span className="text-ink">{r.plate}</span> },
              { key: "trailer", label: "Trailer", mono: true, render: (r) => r.trailer || "-" },
              { key: "rfid", label: "RFID tag", mono: true, render: (r) => r.rfid || "-" },
              { key: "config", label: "Axles", mono: true },
              { key: "tare", label: "Tare", align: "right", mono: true, render: (r) => fmtKg(r.tractor_tare + r.trailer_tare) },
              { key: "dims", label: "H x W x L (m)", mono: true, render: (r) => `${fmtNum(r.height, 2)} x ${fmtNum(r.width, 2)} x ${fmtNum(r.length, 1)}` },
              { key: "fleet", label: "Fleet", render: (r) => <span className="text-ink-2">{r.fleet || "No fleet"}</span> },
              { key: "permit", label: "Permit", mono: true, render: (r) => r.permit || "-" },
              { key: "demerits", label: "Demerits", align: "right", mono: true },
            ]}
          />
          <Pager offset={offset} limit={limit} total={data.total} count={data.items.length} onChange={setOffset} />
        </>
      )}
      <RegisterDrawer open={drawer} onClose={() => setDrawer(false)} options={options} onDone={(p) => { setDrawer(false); setDone(p); refresh(); }} />
    </Panel>
  );
}

function ClearanceInner() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("tab") || "port";
  const tab = TAB_ALIAS[raw] || (TABS.some((t) => t.id === raw) ? raw : "port");
  const plate = params.get("plate");
  const { data: options, error } = useApi<Options>("/trucks/options");
  return (
    <div className="p-3">
      <PageTitle
        title="Truck Clearance"
        sub="Process a truck by hand at any stage of the corridor. Every result is a demo record, and customs, port and e-seal responses are mock data."
        actions={<Provenance kind="DEMO DATA" title="No real agency system is connected" />}
      />
      <Tabs tabs={TABS} value={tab} onChange={(id) => router.replace(`/clearance?tab=${id}`, { scroll: false })} />
      <div className="mt-2">
        {error && <div className="mb-2"><ErrorBox text={`Could not load sites and options: ${error}`} /></div>}
        {/* Forms stay mounted so switching tabs keeps what was typed. */}
        <div className={tab === "port" ? "" : "hidden"}><PortTab plate={tab === "port" ? plate : null} /></div>
        <div className={tab === "origin" ? "" : "hidden"}><OriginTab options={options} plate={tab === "origin" ? plate : null} /></div>
        <div className={tab === "road" ? "" : "hidden"}><RoadTab options={options} plate={tab === "road" ? plate : null} /></div>
        <div className={tab === "lane" ? "" : "hidden"}><LaneTab options={options} plate={tab === "lane" ? plate : null} /></div>
        {tab === "fleet" && <FleetTab options={options} />}
      </div>
    </div>
  );
}

export default function ClearancePage() {
  return (
    <Suspense fallback={<Loading text="Loading clearance" />}>
      <ClearanceInner />
    </Suspense>
  );
}
