"use client";
import { type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { actionLabel, type ClearanceEvent, EventDrawer, Pager, ScoreRow, Toggle } from "@/components/clearance-bits";
import { PageTitle } from "@/components/shell";
import { Badge, Button, CheckList, DataTable, Empty, ErrorBox, Field, Input, KV, Loading, Note, Outcome, Panel, Provenance, Select, Slider, TokenStatus } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtDateTime, fmtKg, fmtNum, siteName } from "@/lib/format";

/* ---------------------------------------------------------------- decision console */

type Stage = "PORT" | "ORIGIN" | "ROAD" | "LANE" | "STATIC";
const STAGES: { id: Stage; label: string }[] = [
  { id: "PORT", label: "Port gate-out" },
  { id: "ORIGIN", label: "Loading site" },
  { id: "ROAD", label: "Road mainline" },
  { id: "LANE", label: "Verification lane" },
  { id: "STATIC", label: "Static scale" },
];
const USES_TOKEN: Stage[] = ["ROAD", "LANE"];
const USES_DIMS: Stage[] = ["PORT", "ROAD", "LANE", "STATIC"];
const USES_FLAG: Stage[] = ["PORT", "ROAD", "LANE"];
const USES_QUALITY: Stage[] = ["ROAD", "LANE"];
const USES_LIFT: Stage[] = ["LANE", "STATIC"];

interface Console {
  stage: Stage; config: string; hasGross: boolean; gross: number; height: string; width: string; length: string; axlesDetected: string; lifted: boolean; quality: string; sensorFault: string;
  plate: boolean; rfid: boolean; trailer: boolean; release: "ok" | "no" | "unknown"; expected: string; containerOk: boolean;
  hasToken: boolean; tokenGross: string; tokenSource: string; tokenStatus: string; tokenExpired: boolean; tokenSignature: boolean;
  audit: boolean; critical: string; demerits: string; scaleApproved: boolean; calibration: boolean; ticket: boolean; onboard: boolean;
}

const BASE: Console = {
  stage: "ROAD", config: "1-2-3", hasGross: true, gross: 40000, height: "4.1", width: "2.5", length: "17", axlesDetected: "", lifted: false, quality: "0.95", sensorFault: "",
  plate: true, rfid: true, trailer: true, release: "ok", expected: "40000", containerOk: true,
  hasToken: false, tokenGross: "40000", tokenSource: "port", tokenStatus: "ACTIVE", tokenExpired: false, tokenSignature: true,
  audit: false, critical: "", demerits: "0", scaleApproved: true, calibration: true, ticket: true, onboard: false,
};

const PRESETS: { id: string; label: string; form: Partial<Console> }[] = [
  { id: "ok", label: "Compliant with token", form: { stage: "ROAD", gross: 40000, hasToken: true, tokenGross: "40000" } },
  { id: "near", label: "Near limit, no token", form: { stage: "ROAD", gross: 49000, hasToken: false } },
  { id: "mismatch", label: "Token mismatch", form: { stage: "ROAD", gross: 48000, hasToken: true, tokenGross: "40000" } },
  { id: "lifted", label: "Lifted axle", form: { stage: "LANE", gross: 46000, lifted: true, hasToken: false } },
  { id: "over", label: "Overload", form: { stage: "LANE", gross: 56000, hasToken: false } },
  { id: "missing", label: "Missing data", form: { stage: "ROAD", hasGross: false, height: "", width: "", length: "", plate: false, trailer: false, hasToken: false, quality: "" } },
];

const numOr = (s: string) => {
  if (!s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function requestBody(f: Console) {
  return {
    stage: f.stage, config: f.config,
    gross_kg: f.hasGross ? f.gross : null,
    height_m: USES_DIMS.includes(f.stage) ? numOr(f.height) : 4.1,
    width_m: USES_DIMS.includes(f.stage) ? numOr(f.width) : 2.5,
    length_m: USES_DIMS.includes(f.stage) ? numOr(f.length) : 17,
    axles_detected: f.stage === "ROAD" ? numOr(f.axlesDetected) : null,
    lifted_axle: USES_LIFT.includes(f.stage) && f.lifted,
    quality: USES_QUALITY.includes(f.stage) ? numOr(f.quality) : null,
    sensor_fault: f.sensorFault.trim() || null,
    plate_ok: f.plate, rfid_ok: f.rfid, trailer_ok: f.trailer,
    release_ok: f.release === "ok" ? true : f.release === "no" ? false : null,
    expected_gross_kg: f.stage === "PORT" ? numOr(f.expected) : null,
    container_ok: f.containerOk,
    token_gross_kg: USES_TOKEN.includes(f.stage) && f.hasToken ? numOr(f.tokenGross) : null,
    token_source: f.tokenSource, token_status: f.tokenStatus, token_expired: f.tokenExpired, token_signature_valid: f.tokenSignature,
    audit_selected: f.stage === "ROAD" && f.audit,
    critical_flag: USES_FLAG.includes(f.stage) ? f.critical.trim() || null : null,
    demerits: numOr(f.demerits) ?? 0,
    scale_approved: f.scaleApproved, calibration_valid: f.calibration, ticket_signature_valid: f.ticket, onboard_only: f.onboard,
  };
}

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <div>
    <div className="eyebrow mb-1.5">{title}</div>
    {children}
  </div>
);

function DecisionConsole({ configs, policy, policyVersion }: { configs: string[]; policy: PolicyValues | null; policyVersion: number }) {
  const [f, setF] = useState<Console>({ ...BASE, hasToken: true });
  const [activePreset, setActivePreset] = useState<string | null>("ok");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const set = <K extends keyof Console>(k: K, v: Console[K]) => {
    setActivePreset(null);
    setF((p) => ({ ...p, [k]: v }));
  };
  const body = useMemo(() => JSON.stringify(requestBody(f)), [f]);
  useEffect(() => {
    const id = setTimeout(async () => {
      const mine = ++seq.current;
      setBusy(true);
      try {
        const r = await api("/decisions/evaluate", { body: JSON.parse(body) });
        if (mine === seq.current) {
          setResult(r);
          setError(null);
        }
      } catch (e) {
        if (mine === seq.current) setError((e as Error).message);
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 200);
    return () => clearTimeout(id);
  }, [body, policyVersion]);

  const s = f.stage;
  const legalGrade = policy && ((s === "PORT" && policy.port_legal_grade) || (s === "LANE" && policy.lane_legal_grade));
  return (
    <Panel title="Decision console" tag={<Provenance kind="SIMULATED" title="Runs the real decision functions on the inputs below" />} actions={busy ? <span className="text-[11px] text-ink-3">Evaluating</span> : undefined}>
      <div className="mb-2"><Note>Dry run. Nothing is recorded. The console uses the current clearance policy and a placeholder identity.</Note></div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {PRESETS.map((p) => (
          <Button key={p.id} size="sm" variant={activePreset === p.id ? "primary" : "default"} onClick={() => { setF({ ...BASE, ...p.form }); setActivePreset(p.id); }}>{p.label}</Button>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2 items-start">
        <div className="space-y-3 min-w-0">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Stage">
              <Select value={s} onChange={(e) => set("stage", e.target.value as Stage)}>
                {STAGES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </Select>
            </Field>
            <Field label="Axle configuration">
              <Select value={f.config} onChange={(e) => set("config", e.target.value)}>
                {(configs.length ? configs : [f.config]).map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
          </div>
          <Group title="Weight">
            <Slider label="Gross" value={f.gross} min={5000} max={70000} step={100} unit=" kg" onChange={(v) => set("gross", v)} />
            <div className="grid grid-cols-2 gap-2 items-center mt-1">
              <Input aria-label="Gross in kilograms" type="number" min={0} disabled={!f.hasGross} value={f.gross} onChange={(e) => set("gross", Number(e.target.value))} />
              <Toggle label="No scale reading" checked={!f.hasGross} onChange={(c) => set("hasGross", !c)} />
            </div>
            {s === "PORT" && <div className="mt-2"><Field label="Expected gross (kg)" hint="Blank means declared cargo or tare is missing"><Input type="number" value={f.expected} onChange={(e) => set("expected", e.target.value)} /></Field></div>}
          </Group>
          {USES_DIMS.includes(s) && (
            <Group title="Dimensions (blank means not scanned)">
              <div className="grid grid-cols-3 gap-2">
                <Field label="Height (m)"><Input type="number" step="any" value={f.height} onChange={(e) => set("height", e.target.value)} /></Field>
                <Field label="Width (m)"><Input type="number" step="any" value={f.width} onChange={(e) => set("width", e.target.value)} /></Field>
                <Field label="Length (m)"><Input type="number" step="any" value={f.length} onChange={(e) => set("length", e.target.value)} /></Field>
              </div>
            </Group>
          )}
          <Group title="Identity reads">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Toggle label="Plate read" checked={f.plate} onChange={(c) => set("plate", c)} />
              <Toggle label="RFID read" checked={f.rfid} onChange={(c) => set("rfid", c)} />
              <Toggle label="Trailer read" checked={f.trailer} onChange={(c) => set("trailer", c)} />
            </div>
          </Group>
          {USES_TOKEN.includes(s) && (
            <Group title="Token">
              <Toggle label="Token on record" checked={f.hasToken} onChange={(c) => set("hasToken", c)} />
              {f.hasToken && (
                <>
                  <div className="grid grid-cols-3 gap-2 mt-2">
                    <Field label="Token gross (kg)"><Input type="number" value={f.tokenGross} onChange={(e) => set("tokenGross", e.target.value)} /></Field>
                    <Field label="Source">
                      <Select value={f.tokenSource} onChange={(e) => set("tokenSource", e.target.value)}>
                        {["port", "origin", "road", "lane", "static"].map((x) => <option key={x} value={x}>{x}</option>)}
                      </Select>
                    </Field>
                    <Field label="Status">
                      <Select value={f.tokenStatus} onChange={(e) => set("tokenStatus", e.target.value)}>
                        {["ACTIVE", "ISSUED", "SUSPENDED", "FLAGGED", "REVOKED", "EXPIRED"].map((x) => <option key={x} value={x}>{x}</option>)}
                      </Select>
                    </Field>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                    <Toggle label="Past valid-until" checked={f.tokenExpired} onChange={(c) => set("tokenExpired", c)} />
                    <Toggle label="Signature valid" checked={f.tokenSignature} onChange={(c) => set("tokenSignature", c)} />
                  </div>
                </>
              )}
            </Group>
          )}
          {s === "PORT" && (
            <Group title="Port gate">
              <div className="grid grid-cols-2 gap-2 items-center">
                <Field label="Release status (mock)">
                  <Select value={f.release} onChange={(e) => set("release", e.target.value as Console["release"])}>
                    <option value="ok">Released</option>
                    <option value="no">Not released</option>
                    <option value="unknown">Unavailable</option>
                  </Select>
                </Field>
                <Toggle label="Container check digit valid" checked={f.containerOk} onChange={(c) => set("containerOk", c)} />
              </div>
            </Group>
          )}
          {s === "ORIGIN" && (
            <Group title="Loading site">
              <div className="grid grid-cols-2 gap-1">
                <Toggle label="Scale approved" checked={f.scaleApproved} onChange={(c) => set("scaleApproved", c)} />
                <Toggle label="Calibration valid" checked={f.calibration} onChange={(c) => set("calibration", c)} />
                <Toggle label="Ticket signature valid" checked={f.ticket} onChange={(c) => set("ticket", c)} />
                <Toggle label="On-board record only" checked={f.onboard} onChange={(c) => set("onboard", c)} />
              </div>
            </Group>
          )}
          <Group title="Risk and sensors">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Demerit points"><Input type="number" min={0} value={f.demerits} onChange={(e) => set("demerits", e.target.value)} /></Field>
              <Field label="Sensor fault" hint="Any text counts as a fault"><Input value={f.sensorFault} onChange={(e) => set("sensorFault", e.target.value)} placeholder="None" /></Field>
              {USES_QUALITY.includes(s) && <Field label="Data quality (0 to 1)"><Input type="number" step="0.01" value={f.quality} onChange={(e) => set("quality", e.target.value)} /></Field>}
              {s === "ROAD" && <Field label="Axles detected" hint="Blank uses the configuration"><Input type="number" value={f.axlesDetected} onChange={(e) => set("axlesDetected", e.target.value)} /></Field>}
              {USES_FLAG.includes(s) && <Field label="Critical flag" className="col-span-2"><Input value={f.critical} onChange={(e) => set("critical", e.target.value)} placeholder="None" /></Field>}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
              {s === "ROAD" && <Toggle label="Audit selected" checked={f.audit} onChange={(c) => set("audit", c)} />}
              {USES_LIFT.includes(s) && <Toggle label="Lifted axle" checked={f.lifted} onChange={(c) => set("lifted", c)} />}
            </div>
          </Group>
        </div>
        <div className="space-y-3 min-w-0 md:sticky md:top-0">
          {error && <ErrorBox text={error} />}
          {!result && !error && <Loading text="Evaluating" />}
          {result && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <Outcome value={result.outcome} size="lg" />
                <span className="text-[12px] text-ink font-medium">{actionLabel(result.action)}</span>
                {result.fail_safe && <Badge tone="wait">Fail-safe</Badge>}
                {result.issue_token && <Badge tone="accent">Would issue a token</Badge>}
                {result.requires_officer && <Badge tone="stop">Officer required</Badge>}
              </div>
              <p className="text-[12px] text-ink-2 leading-relaxed">{result.explanation}</p>
              <ScoreRow risk={result.risk_score} confidence={result.confidence} />
              <KV
                cols={3}
                items={[
                  ["Gross limit", <span key="l" className="num">{fmtKg(result.gross_limit_kg)}</span>],
                  ["Margin applied", <span key="m" className="num">{legalGrade ? "0.0% (legal grade)" : s === "STATIC" ? "None (legal reading)" : `${fmtNum(result.margin_pct)}%`}</span>],
                  ["Governing load", <span key="g" className="num">{result.governing_ratio !== null && result.governing_ratio !== undefined ? `${fmtNum(result.governing_ratio * 100)}%` : "-"}</span>],
                ]}
              />
              {f.lifted && USES_LIFT.includes(s) && <div className="text-[10.5px] text-ink-3">Gross limit shown is for the registered configuration. A lifted axle is assessed against the lower limit of the configuration it operates as.</div>}
              <div>
                <div className="eyebrow mb-1">Checks</div>
                <CheckList checks={result.checks} />
              </div>
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------- clearance policy */

type PolicyValues = Record<string, any>;
interface PolicyResponse { policy: PolicyValues; provenance: Record<string, { kind: string; ref: string }>; note: string }
interface FieldDef { key: string; label: string; unit?: string; min?: number; max?: number; above?: boolean; hint?: string }
interface GroupDef { title: string; fields: FieldDef[]; note?: string }

const POSITIVE = { min: 0, above: true };
const POLICY_GROUPS: GroupDef[] = [
  {
    title: "Legal limits",
    fields: [
      { key: "steering_axle_kg", label: "Steering axle", unit: "kg", ...POSITIVE },
      { key: "single_drive_axle_kg", label: "Single drive axle", unit: "kg", ...POSITIVE },
      { key: "tandem_group_kg", label: "Tandem group", unit: "kg", ...POSITIVE },
      { key: "tridem_group_kg", label: "Tridem group", unit: "kg", ...POSITIVE },
      { key: "container_limit_kg", label: "Container limit", unit: "kg", ...POSITIVE, hint: "Stored only. The decision functions do not read it yet." },
    ],
  },
  {
    title: "Dimension limits",
    fields: [
      { key: "max_height_m", label: "Maximum height", unit: "m", ...POSITIVE },
      { key: "max_width_m", label: "Maximum width", unit: "m", ...POSITIVE },
      { key: "max_length_m", label: "Maximum length", unit: "m", ...POSITIVE },
    ],
  },
  {
    title: "Scale errors and margin k",
    note: "Measurement margin = k x scale error.",
    fields: [
      { key: "port_error_pct", label: "Port scale error", unit: "%", min: 0 },
      { key: "origin_error_pct", label: "Origin scale error", unit: "%", min: 0 },
      { key: "road_error_pct", label: "Road WIM error", unit: "%", min: 0 },
      { key: "lane_error_pct", label: "Lane scale error", unit: "%", min: 0 },
      { key: "static_error_pct", label: "Static scale error", unit: "%", min: 0 },
      { key: "margin_k", label: "Margin k", min: 0 },
    ],
  },
  {
    title: "Consistency tolerances",
    fields: [
      { key: "tolerance_first_point_pct", label: "Token from first point", unit: "%", min: 0 },
      { key: "tolerance_road_token_pct", label: "Token from road", unit: "%", min: 0 },
      { key: "expected_variance_tolerance_pct", label: "Declared against measured", unit: "%", min: 0 },
      { key: "identity_min_confidence", label: "Minimum identity confidence", min: 0, max: 1 },
      { key: "min_quality_score", label: "Minimum data quality", min: 0, max: 1 },
    ],
  },
  {
    title: "Audit rates",
    note: "Percent of mainline greens selected for audit.",
    fields: [
      { key: "audit_rate_tier1_pct", label: "Tier 1, port", unit: "%", min: 0, max: 100 },
      { key: "audit_rate_tier2_pct", label: "Tier 2, origin", unit: "%", min: 0, max: 100 },
      { key: "audit_rate_tier3_pct", label: "Tier 3, road", unit: "%", min: 0, max: 100 },
    ],
  },
  {
    title: "Discretion allowance",
    fields: [
      { key: "allowance_pct", label: "Allowance", unit: "%", min: 0, max: 4.99, hint: "Off by default. Must stay below 5%." },
      { key: "fee_usd_per_kg_over", label: "Illustrative fee per kg over", unit: "USD", min: 0 },
    ],
  },
  {
    title: "Token validity",
    fields: [
      { key: "validity_port_h", label: "Port token", unit: "h", ...POSITIVE },
      { key: "validity_origin_h", label: "Origin token", unit: "h", ...POSITIVE },
      { key: "validity_road_h", label: "Road and lane token", unit: "h", ...POSITIVE },
    ],
  },
];
const BOOL_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "port_legal_grade", label: "Port scale is legal grade", hint: "Removes the measurement margin at the port. Requires approval that has not been given." },
  { key: "lane_legal_grade", label: "Lane scale is legal grade", hint: "Removes the measurement margin in the lane. Requires approval that has not been given." },
  { key: "apply_container_limit", label: "Apply the container limit", hint: "Stored only. The decision functions do not read it yet." },
];
const AXLE_COUNTS = ["2", "3", "4", "5", "6"];

function ProvenanceTag({ entry, forceAssumed }: { entry?: { kind: string; ref: string }; forceAssumed?: boolean }) {
  if (!entry) return <span className="text-[10.5px] text-ink-3">No source recorded</span>;
  const assumed = forceAssumed || entry.kind === "assumption";
  return (
    <span className="flex items-start gap-1.5 min-w-0">
      {assumed ? <Provenance kind="ASSUMED" title={entry.ref} /> : <Badge tone={entry.kind === "policy" ? "accent" : "muted"} title={entry.ref}>{entry.kind}</Badge>}
      <span className="text-[10.5px] text-ink-3 leading-snug min-w-0">{entry.ref}</span>
    </span>
  );
}

function PolicyPanel({ onSaved }: { onSaved: (p: PolicyValues) => void }) {
  const { can, me } = useAuth();
  const { data, error, loading, refresh } = useApi<PolicyResponse>("/decisions/policy");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [bools, setBools] = useState<Record<string, boolean>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allowed = can("policy.edit");

  useEffect(() => {
    if (!data) return;
    const d: Record<string, string> = {};
    for (const g of POLICY_GROUPS) for (const x of g.fields) d[x.key] = String(data.policy[x.key] ?? "");
    for (const n of AXLE_COUNTS) d[`gross_${n}`] = String(data.policy.gross_limits_kg?.[n] ?? "");
    setDraft(d);
    const b: Record<string, boolean> = {};
    for (const x of BOOL_FIELDS) b[x.key] = !!data.policy[x.key];
    setBools(b);
    setErrs({});
    onSaved(data.policy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const changes = useMemo(() => {
    if (!data || !Object.keys(draft).length) return {} as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const g of POLICY_GROUPS) for (const x of g.fields) if (Number(draft[x.key]) !== data.policy[x.key]) out[x.key] = Number(draft[x.key]);
    for (const x of BOOL_FIELDS) if (bools[x.key] !== data.policy[x.key]) out[x.key] = bools[x.key];
    if (AXLE_COUNTS.some((n) => Number(draft[`gross_${n}`]) !== data.policy.gross_limits_kg?.[n])) {
      out.gross_limits_kg = Object.fromEntries(AXLE_COUNTS.map((n) => [n, Number(draft[`gross_${n}`])]));
    }
    return out;
  }, [data, draft, bools]);
  const dirty = Object.keys(changes).length > 0;

  const save = async () => {
    const e: Record<string, string> = {};
    for (const g of POLICY_GROUPS) {
      for (const x of g.fields) {
        const raw = draft[x.key]?.trim();
        const n = Number(raw);
        if (!raw || !Number.isFinite(n)) e[x.key] = "Enter a number";
        else if (x.above && n <= (x.min ?? 0)) e[x.key] = `Must be above ${x.min ?? 0}`;
        else if (x.min !== undefined && n < x.min) e[x.key] = `Must be at least ${x.min}`;
        else if (x.max !== undefined && n > x.max) e[x.key] = `Must be at most ${x.max}`;
      }
    }
    for (const n of AXLE_COUNTS) {
      if (!(Number(draft[`gross_${n}`]) > 0)) e[`gross_${n}`] = "Must be above 0";
    }
    setErrs(e);
    setSaved(null);
    if (Object.keys(e).length) {
      setSaveError("Fix the highlighted fields before saving.");
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      await api("/decisions/policy", { method: "PUT", body: changes });
      setSaved(`Saved ${Object.keys(changes).length} change${Object.keys(changes).length > 1 ? "s" : ""}. The live engine now uses them.`);
      await refresh();
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const prov = data?.provenance ?? {};
  return (
    <Panel
      title="Clearance policy"
      actions={
        <>
          <Button size="sm" variant="ghost" disabled={!dirty || busy} onClick={() => { setSaved(null); setSaveError(null); refresh(); }}>Discard</Button>
          <Button size="sm" variant="primary" disabled={!allowed || !dirty} loading={busy} title={allowed ? undefined : "Only an RCS administrator can save the policy"} onClick={save}>Save policy</Button>
        </>
      }
      pad={false}
    >
      {!data && loading && <Loading text="Loading policy" />}
      {!data && error && <div className="p-3"><ErrorBox text={error} /></div>}
      {data && Object.keys(draft).length > 0 && (
        <div className="p-3 space-y-3 xl:max-h-[calc(100vh-130px)] overflow-auto">
          <Note>Limits come from the source documents and must be re-verified. Static weighing stays the legal authority until approved. Editing here changes demo behaviour only.</Note>
          {me && !allowed && <Note>Your role ({me.role_label}) can read this policy. An RCS administrator can edit it.</Note>}
          {saveError && <ErrorBox text={saveError} />}
          {saved && <div className="text-[11.5px] text-ink-2">{saved}</div>}
          {POLICY_GROUPS.map((g) => (
            <section key={g.title}>
              <div className="eyebrow mb-1">{g.title}</div>
              {g.note && <div className="text-[10.5px] text-ink-3 mb-1">{g.note}</div>}
              <div className="space-y-1.5">
                {g.fields.map((x) => (
                  <PolicyRow key={x.key} label={x.label} unit={x.unit} hint={x.hint} error={errs[x.key]} disabled={!allowed} value={draft[x.key] ?? ""} onChange={(v) => setDraft((d) => ({ ...d, [x.key]: v }))} tag={<ProvenanceTag entry={prov[x.key]} />} />
                ))}
                {g.title === "Legal limits" && AXLE_COUNTS.map((n) => (
                  <PolicyRow key={n} label={`Gross limit, ${n} axles`} unit="kg" error={errs[`gross_${n}`]} disabled={!allowed} value={draft[`gross_${n}`] ?? ""} onChange={(v) => setDraft((d) => ({ ...d, [`gross_${n}`]: v }))} tag={<ProvenanceTag entry={prov.gross_limits_kg} forceAssumed={n === "5"} />} />
                ))}
                {g.title === "Discretion allowance" && BOOL_FIELDS.map((x) => (
                  <div key={x.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 items-start">
                    <Toggle label={x.label} hint={x.hint} disabled={!allowed} checked={!!bools[x.key]} onChange={(c) => setBools((b) => ({ ...b, [x.key]: c }))} />
                    <ProvenanceTag entry={prov[x.key]} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

function PolicyRow({ label, unit, value, onChange, disabled, error, hint, tag }: { label: string; unit?: string; value: string; onChange: (v: string) => void; disabled: boolean; error?: string; hint?: string; tag: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_84px_minmax(0,1fr)] gap-2 items-start">
      <div className="min-w-0 pt-1.5">
        <div className="text-[11.5px] text-ink-2">{label}{unit ? <span className="text-ink-3"> ({unit})</span> : null}</div>
        {hint && <div className="text-[10.5px] text-ink-3">{hint}</div>}
        {error && <div className="text-[10.5px] text-stop">{error}</div>}
      </div>
      <Input aria-label={label} type="number" step="any" disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} className="num text-right" />
      <div className="pt-1 min-w-0">{tag}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- recent decisions */

function RecentDecisions() {
  const [outcome, setOutcome] = useState("");
  const [stage, setStage] = useState("");
  const [offset, setOffset] = useState(0);
  const [event, setEvent] = useState<ClearanceEvent | null>(null);
  const limit = 25;
  useEffect(() => setOffset(0), [outcome, stage]);
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (outcome) qs.set("outcome", outcome);
  if (stage) qs.set("stage", stage);
  const { data, error, loading } = useApi<{ items: ClearanceEvent[] }>(`/clearance/events?${qs}`, offset === 0 ? 6000 : undefined);
  return (
    <Panel
      title="Recent decisions"
      sub="recorded by the live engine and operators"
      pad={false}
      actions={
        <>
          <Select aria-label="Filter by outcome" className="w-[120px] !h-6 text-[11px]" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">All outcomes</option>
            {["GREEN", "AMBER", "RED"].map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
          <Select aria-label="Filter by stage" className="w-[140px] !h-6 text-[11px]" value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">All stages</option>
            {STAGES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </Select>
        </>
      }
    >
      {error && <div className="p-2"><ErrorBox text={error} /></div>}
      {!data && loading && <Loading text="Loading decisions" />}
      {data && (
        <>
          <DataTable<ClearanceEvent>
            rows={data.items}
            rowKey={(r) => r.id}
            maxH="340px"
            empty="No decisions match these filters."
            onRow={setEvent}
            cols={[
              { key: "at", label: "Time", mono: true, render: (r) => fmtDateTime(r.at) },
              { key: "plate", label: "Truck", mono: true, render: (r) => r.plate },
              { key: "site", label: "Site", render: (r) => siteName(r.site) },
              { key: "stage", label: "Stage", render: (r) => <span className="text-ink-2">{r.stage}</span> },
              { key: "gross", label: "Gross", align: "right", mono: true, render: (r) => fmtKg(r.gross_kg) },
              { key: "outcome", label: "Outcome", render: (r) => <Outcome value={r.outcome} /> },
              { key: "action", label: "Action", render: (r) => <span className="text-ink-2">{actionLabel(r.action)}</span> },
              { key: "risk", label: "Risk", align: "right", mono: true, render: (r) => fmtNum(r.risk, 1) },
              { key: "why", label: "Reason", render: (r) => <span className="text-ink-3 text-[11px] line-clamp-1" title={r.explanation}>{r.explanation}</span> },
            ]}
          />
          <Pager offset={offset} limit={limit} count={data.items.length} onChange={setOffset} />
        </>
      )}
      <EventDrawer event={event} onClose={() => setEvent(null)} />
    </Panel>
  );
}

function DecisionsInner() {
  const { data: options } = useApi<{ axle_configs: string[] }>("/trucks/options");
  const [policy, setPolicy] = useState<PolicyValues | null>(null);
  const [version, setVersion] = useState(0);
  return (
    <div className="p-3">
      <PageTitle
        title="Clearance Decision Engine"
        sub="Try the engine on any inputs, read the policy behind it and review what it has decided. Decisions support the operator. Static weighing stays the legal authority."
        actions={<Provenance kind="DEMO DATA" title="Demo policy and simulated decisions. Not a statement of current law." />}
      />
      <div className="grid gap-2 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-start mb-2">
        <DecisionConsole configs={options?.axle_configs ?? []} policy={policy} policyVersion={version} />
        <PolicyPanel onSaved={(p) => { setPolicy(p); setVersion((n) => n + 1); }} />
      </div>
      <RecentDecisions />
    </div>
  );
}

export default function DecisionsPage() {
  return (
    <Suspense fallback={<Loading text="Loading the decision engine" />}>
      <DecisionsInner />
    </Suspense>
  );
}
