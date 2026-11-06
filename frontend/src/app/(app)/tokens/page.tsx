"use client";
import { ExternalLink, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, type ReactNode, Suspense, useCallback, useEffect, useState } from "react";
import { Pager, truckHref, useDebounced } from "@/components/clearance-bits";
import { PageTitle } from "@/components/shell";
import { Badge, Button, CheckList, DataTable, Drawer, Empty, ErrorBox, Field, Input, Kpi, KV, Loading, Note, Panel, Provenance, Select, TokenStatus } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtDateTime, fmtInt, fmtKg, fmtNum, siteName } from "@/lib/format";

interface TokenRow {
  token_id: string; status: string; status_reason: string | null; tractor_plate: string; trailer_plate: string | null; rfid_tag: string | null; container_number: string | null; eseal_id: string | null; source: string; trust_tier: number; origin_station: string; gross_kg: number; expected_gross_kg: number | null; variance_pct: number | null; issued_at: string; valid_until: string; origin: string; destination: string | null;
}
interface ListResponse { total: number; items: TokenRow[]; counts: Record<string, number>; lifecycle: string[] }
interface Payload {
  token_id: string; v: number; tractor_plate: string; trailer_plate: string | null; rfid_tag: string | null; container_number: string | null; container_check_ok: boolean | null; eseal_id: string | null; measured_gross_kg: number; expected_gross_kg: number | null; variance_pct: number | null; axle_loads_kg: number[]; axle_group_loads_kg: number[]; dimensions_m: { height: number | null; width: number | null; length: number | null }; axle_config: string; permit_ref: string | null; origin_station: string; source: string; trust_tier: number; issued_at: string; valid_until: string; destination: string | null; route: string | null; driver_ref: string | null;
  release_snapshot: { customs?: boolean; shipping_line?: boolean; kpa?: boolean; icms_ref?: string | null } | null;
}
interface HistoryRow { at: string; kind: string; site: string | null; result: string | null; actor: string | null; detail: any }
interface Detail extends TokenRow { payload: Payload; signature: string; kid: string; history: HistoryRow[] }
interface SigCheck { valid: boolean; reason?: string; alg?: string; kid?: string; public_key?: string; signature?: string; tamper_test: { changed: string; valid: boolean } }
interface Options { sites: { id: string; name: string; kind: string }[] }
interface VerifyResult { honoured: boolean; checks: { code: string; label: string; status: string; detail?: string }[]; token_id: string | null; tolerance_note?: string }

const LIMIT = 50;
const KPI_TONE: Record<string, "go" | "wait" | "stop" | "accent" | undefined> = { ACTIVE: "go", ISSUED: "accent", SUSPENDED: "wait", FLAGGED: "wait", REVOKED: "stop" };
const STATUS_SENTENCE: Record<string, string> = { PENDING: "Pending", ISSUED: "Issued", ACTIVE: "Active", EXPIRED: "Expired", SUSPENDED: "Suspended", REVOKED: "Revoked", FLAGGED: "Flagged" };
const TIER_LABEL: Record<number, string> = { 1: "Tier 1, port", 2: "Tier 2, origin", 3: "Tier 3, road" };
const SOURCES = ["port", "origin", "road", "lane", "static"];

const Mono = ({ children }: { children: ReactNode }) => <span className="num">{children}</span>;
const Sec = ({ title, tag, children }: { title: string; tag?: ReactNode; children: ReactNode }) => (
  <section className="border border-line rounded-sm p-3">
    <div className="flex items-center gap-2 mb-2"><h3 className="eyebrow">{title}</h3>{tag}</div>
    {children}
  </section>
);
const yesNo = (v?: boolean | null, yes = "Released", no = "Not released") => (v === null || v === undefined ? "-" : v ? yes : no);

function SignaturePanel({ tokenId }: { tokenId: string }) {
  const { data, error, loading } = useApi<SigCheck>(`/tokens/${encodeURIComponent(tokenId)}/signature`);
  return (
    <Sec title="Signature" tag={<a href="/api/tokens/keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline ml-auto normal-case">Public keys<ExternalLink size={11} /></a>}>
      {!data && loading && <Loading text="Verifying" />}
      {error && <ErrorBox text={error} />}
      {data && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {data.valid ? <ShieldCheck size={15} className="text-go" /> : <ShieldOff size={15} className="text-stop" />}
            <Badge tone={data.valid ? "go" : "stop"}>{data.valid ? "Valid" : "Invalid"}</Badge>
            {data.reason && <span className="text-[11px] text-ink-3">{data.reason}</span>}
          </div>
          <KV items={[["Algorithm", data.alg || "-"], ["Key id", <Mono key="k">{data.kid || "-"}</Mono>]]} />
          <div>
            <div className="text-[10.5px] text-ink-3">Public key</div>
            <div className="num text-[11px] text-ink break-all">{data.public_key || "-"}</div>
          </div>
          <div>
            <div className="text-[10.5px] text-ink-3">Signature</div>
            <div className="num text-[11px] text-ink break-all">{data.signature || "-"}</div>
          </div>
          <div className="flex items-start gap-2 border border-line rounded-sm bg-bg-2 px-2 py-1.5">
            <ShieldAlert size={13} className={data.tamper_test.valid ? "text-stop mt-0.5 shrink-0" : "text-go mt-0.5 shrink-0"} />
            <div className="min-w-0 text-[11.5px]">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-ink font-medium">Tamper test</span>
                <Badge tone={data.tamper_test.valid ? "stop" : "go"}>{data.tamper_test.valid ? "Not detected" : "Detected"}</Badge>
              </div>
              <div className="text-ink-2 mt-0.5">Changed {data.tamper_test.changed}, then verified the same signature: {data.tamper_test.valid ? "it still verified, which should not happen." : "verification failed, so an edited weight cannot pass as signed."}</div>
            </div>
          </div>
        </div>
      )}
    </Sec>
  );
}

function historyDetail(h: HistoryRow): string {
  const d = h.detail;
  if (!d) return "";
  if (d.reason) return d.reason;
  if (d.source) return `Source ${d.source}${d.online === false ? ", issued offline" : ""}`;
  if (Array.isArray(d.checks)) {
    const failed = d.checks.filter((c: any) => c.status === "fail");
    return failed.length ? `Failed: ${failed.map((c: any) => c.label).join(", ")}` : `${d.checks.length} checks passed`;
  }
  return "";
}

function Timeline({ rows }: { rows: HistoryRow[] }) {
  if (!rows.length) return <Empty text="No verification or status events yet." />;
  return (
    <ol className="border-l border-line-2 ml-1 space-y-2 max-h-[280px] overflow-auto">
      {rows.map((h, i) => (
        <li key={i} className="pl-3 relative">
          <span className="absolute -left-[3.5px] top-1.5 w-1.5 h-1.5 rounded-full bg-ink-3" />
          <div className="flex items-center gap-2 flex-wrap text-[12px]">
            <span className="text-ink">{h.kind.replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}</span>
            {h.result && <Badge tone={h.result === "GREEN" || h.result === "HONOURED" || h.result === "ACTIVE" ? "go" : h.result === "AMBER" || h.result === "SUSPENDED" || h.result === "FLAGGED" ? "wait" : h.result === "RED" || h.result === "REJECTED" || h.result === "REVOKED" ? "stop" : "muted"}>{h.result}</Badge>}
          </div>
          <div className="text-[10.5px] text-ink-3"><span className="num">{fmtDateTime(h.at)}</span>{h.site ? `, ${siteName(h.site)}` : ""}{h.actor ? `, by ${h.actor}` : ""}</div>
          {historyDetail(h) && <div className="text-[11px] text-ink-2 break-words">{historyDetail(h)}</div>}
        </li>
      ))}
    </ol>
  );
}

function StatusActions({ detail, onChanged }: { detail: Detail; onChanged: () => void }) {
  const { can, me } = useAuth();
  const [reason, setReason] = useState("");
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const allowed = can("token.manage");
  const apply = async (status: string, verb: string) => {
    setDone(null);
    setError(null);
    if (reason.trim().length < 3) {
      setFieldErr("Give a reason of at least 3 characters");
      return;
    }
    setFieldErr(null);
    setBusy(status);
    try {
      await api(`/tokens/${encodeURIComponent(detail.token_id)}/status`, { body: { status, reason: reason.trim() } });
      setReason("");
      setDone(`${verb} recorded.`);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sec title="Actions">
      {me && !allowed && <div className="mb-2"><Note>Your role ({me.role_label}) can view tokens only. A KeNHA officer or RCS administrator can change a token's status.</Note></div>}
      <Field label="Reason (required, kept in the audit log)" error={fieldErr}>
        <Input maxLength={255} disabled={!allowed} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the status is changing" />
      </Field>
      <div className="flex flex-wrap gap-1.5 mt-2">
        <Button size="sm" disabled={!allowed || !!busy} loading={busy === "SUSPENDED"} onClick={() => apply("SUSPENDED", "Suspension")}>Suspend</Button>
        <Button size="sm" disabled={!allowed || !!busy} loading={busy === "FLAGGED"} onClick={() => apply("FLAGGED", "Flag")}>Flag</Button>
        <Button size="sm" variant="danger" disabled={!allowed || !!busy} loading={busy === "REVOKED"} onClick={() => apply("REVOKED", "Revocation")}>Revoke</Button>
        <Button size="sm" disabled={!allowed || !!busy || detail.status === "ACTIVE"} title={detail.status === "ACTIVE" ? "This token is already active" : undefined} loading={busy === "ACTIVE"} onClick={() => apply("ACTIVE", "Reinstatement")}>Reinstate</Button>
      </div>
      {error && <div className="mt-2"><ErrorBox text={error} /></div>}
      {done && <div className="text-[11px] text-ink-2 mt-2">{done}</div>}
    </Sec>
  );
}

function VerifyForm({ detail, sites, onDone }: { detail: Detail; sites: Options["sites"]; onDone: () => void }) {
  const road = sites.filter((s) => s.kind === "road");
  const [site, setSite] = useState("mariakani");
  const [plate, setPlate] = useState(detail.tractor_plate);
  const [rfid, setRfid] = useState(detail.rfid_tag || "");
  const [gross, setGross] = useState(String(detail.gross_kg));
  const [height, setHeight] = useState(detail.payload.dimensions_m?.height != null ? String(detail.payload.dimensions_m.height) : "");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (gross.trim() && !(Number(gross) > 0)) next.gross = "Gross must be a positive number";
    if (height.trim() && !(Number(height) > 0)) next.height = "Height must be a positive number";
    setErrs(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<VerifyResult>("/tokens/verify", { body: { token_id: detail.token_id, site, plate: plate.trim() || null, rfid: rfid.trim() || null, gross_kg: gross.trim() ? Number(gross) : null, height_m: height.trim() ? Number(height) : null } }));
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sec title="Verify at a station">
      <form onSubmit={onSubmit}>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Station">
            <Select value={site} onChange={(e) => setSite(e.target.value)}>
              {!road.length && <option value={site}>{siteName(site)}</option>}
              {road.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Plate read"><Input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} /></Field>
          <Field label="RFID read"><Input value={rfid} onChange={(e) => setRfid(e.target.value)} /></Field>
          <Field label="Gross here (kg)" error={errs.gross}><Input type="number" step="any" value={gross} onChange={(e) => setGross(e.target.value)} /></Field>
          <Field label="Height here (m)" error={errs.height}><Input type="number" step="any" value={height} onChange={(e) => setHeight(e.target.value)} /></Field>
          <div className="flex items-end"><Button type="submit" variant="primary" loading={busy} className="w-full">Verify token</Button></div>
        </div>
      </form>
      {error && <div className="mt-2"><ErrorBox text={error} /></div>}
      {result && (
        <div className="mt-2 border-t border-line pt-2">
          <div className="flex items-center gap-2 mb-1">
            <Badge tone={result.honoured ? "go" : "stop"}>{result.honoured ? "HONOURED" : "REJECTED"}</Badge>
            <span className="text-[11px] text-ink-3">{result.tolerance_note}</span>
          </div>
          <CheckList checks={result.checks} />
        </div>
      )}
    </Sec>
  );
}

function TokenDrawer({ id, sites, onClose, onChanged }: { id: string | null; sites: Options["sites"]; onClose: () => void; onChanged: () => void }) {
  const { data, error, loading, refresh } = useApi<Detail>(id ? `/tokens/${encodeURIComponent(id)}` : null);
  const current = data && data.token_id === id ? data : null;
  const changed = () => {
    refresh();
    onChanged();
  };
  const p = current?.payload;
  return (
    <Drawer open={!!id} onClose={onClose} title={id || ""} width={920}>
      {!current && loading && <Loading text="Loading token" />}
      {!current && error && <ErrorBox text={error} />}
      {current && p && (
        <div className="grid gap-3 lg:grid-cols-2 items-start">
          <div className="space-y-3 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <TokenStatus value={current.status} />
              <Badge>{TIER_LABEL[current.trust_tier] || `Tier ${current.trust_tier}`}</Badge>
              <Provenance kind="DEMO DATA" title="A demo record signed with demo keys" />
              {current.status_reason && <span className="text-[11px] text-ink-3">{current.status_reason}</span>}
            </div>
            <Sec title="Identity">
              <KV
                items={[
                  ["Tractor plate", <Link key="p" href={truckHref(p.tractor_plate)} className="num text-accent hover:underline">{p.tractor_plate}</Link>],
                  ["Trailer plate", <Mono key="t">{p.trailer_plate || "None"}</Mono>],
                  ["RFID tag", <Mono key="r">{p.rfid_tag || "None"}</Mono>],
                  ["Driver reference", <Mono key="d">{p.driver_ref || "-"}</Mono>],
                  ["Container", <Mono key="c">{p.container_number || "None"}</Mono>],
                  ["Container check digit", p.container_check_ok === null || p.container_check_ok === undefined ? "Not applicable" : p.container_check_ok ? "Valid" : "Invalid"],
                  ["E-seal", <Mono key="e">{p.eseal_id || "None"}</Mono>],
                  ["Payload version", <Mono key="v">{p.v}</Mono>],
                ]}
              />
            </Sec>
            <Sec title="Weights">
              <KV
                cols={3}
                items={[
                  ["Measured gross", <Mono key="m">{fmtKg(p.measured_gross_kg)}</Mono>],
                  ["Expected gross", <Mono key="x">{fmtKg(p.expected_gross_kg)}</Mono>],
                  ["Variance", <Mono key="v">{p.variance_pct === null || p.variance_pct === undefined ? "-" : `${p.variance_pct > 0 ? "+" : ""}${fmtNum(p.variance_pct, 2)}%`}</Mono>],
                ]}
              />
              <div className="mt-2">
                <div className="text-[10.5px] text-ink-3">Axle loads, front to back</div>
                {p.axle_loads_kg?.length ? <div className="flex flex-wrap gap-1 mt-0.5">{p.axle_loads_kg.map((a, i) => <span key={i} className="num text-[11px] border border-line rounded-sm px-1.5 py-0.5">{fmtInt(a)} kg</span>)}</div> : <div className="text-[12px] text-ink-3">Not recorded</div>}
              </div>
              <div className="mt-2">
                <div className="text-[10.5px] text-ink-3">Axle-group loads ({p.axle_config})</div>
                {p.axle_group_loads_kg?.length ? <div className="flex flex-wrap gap-1 mt-0.5">{p.axle_group_loads_kg.map((a, i) => <span key={i} className="num text-[11px] border border-line rounded-sm px-1.5 py-0.5">{fmtInt(a)} kg</span>)}</div> : <div className="text-[12px] text-ink-3">Not recorded</div>}
              </div>
            </Sec>
            <Sec title="Dimensions, axles and permit">
              <KV
                cols={3}
                items={[
                  ["Height", <Mono key="h">{p.dimensions_m?.height != null ? `${fmtNum(p.dimensions_m.height, 2)} m` : "-"}</Mono>],
                  ["Width", <Mono key="w">{p.dimensions_m?.width != null ? `${fmtNum(p.dimensions_m.width, 2)} m` : "-"}</Mono>],
                  ["Length", <Mono key="l">{p.dimensions_m?.length != null ? `${fmtNum(p.dimensions_m.length, 2)} m` : "-"}</Mono>],
                  ["Axle configuration", <Mono key="a">{p.axle_config}</Mono>],
                  ["Permit", <Mono key="r">{p.permit_ref || "None"}</Mono>],
                ]}
              />
            </Sec>
            <Sec title="Issue and journey">
              <KV
                items={[
                  ["Origin station", siteName(p.origin_station)],
                  ["Source", p.source],
                  ["Trust tier", TIER_LABEL[p.trust_tier] || p.trust_tier],
                  ["Issued", <Mono key="i">{fmtDateTime(p.issued_at)}</Mono>],
                  ["Valid until", <Mono key="u">{fmtDateTime(p.valid_until)}</Mono>],
                  ["Destination", p.destination || "-"],
                  ["Route", <Mono key="o">{p.route || "-"}</Mono>],
                ]}
              />
            </Sec>
            <Sec title="Release snapshot" tag={<Provenance kind="MOCK" title="Mock customs, shipping line and KPA responses. No agency system is connected." />}>
              {p.release_snapshot ? (
                <KV
                  items={[
                    ["Customs", yesNo(p.release_snapshot.customs)],
                    ["Shipping line", yesNo(p.release_snapshot.shipping_line)],
                    ["KPA", yesNo(p.release_snapshot.kpa)],
                    ["Mock ICMS reference", <Mono key="i">{p.release_snapshot.icms_ref || "-"}</Mono>],
                  ]}
                />
              ) : <div className="text-[12px] text-ink-3">No release snapshot on this token. Only port tokens carry one.</div>}
            </Sec>
          </div>
          <div className="space-y-3 min-w-0">
            <SignaturePanel tokenId={current.token_id} />
            <StatusActions key={current.token_id} detail={current} onChanged={changed} />
            <VerifyForm key={`v-${current.token_id}`} detail={current} sites={sites} onDone={refresh} />
            <Sec title="Verification history"><Timeline rows={current.history} /></Sec>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function TokensInner() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id");
  const [q, setQ] = useState(params.get("q") || "");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [tier, setTier] = useState("");
  const [station, setStation] = useState("");
  const [offset, setOffset] = useState(0);
  const dq = useDebounced(q.trim());
  useEffect(() => setOffset(0), [dq, status, source, tier, station]);
  const qs = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
  if (dq) qs.set("q", dq);
  if (status) qs.set("status", status);
  if (source) qs.set("source", source);
  if (tier) qs.set("tier", tier);
  if (station) qs.set("station", station);
  const { data, error, loading, refresh } = useApi<ListResponse>(`/tokens?${qs}`, offset === 0 ? 5000 : undefined);
  const { data: options } = useApi<Options>("/trucks/options");
  const sites = options?.sites ?? [];
  const lifecycle = data?.lifecycle ?? [];
  const close = useCallback(() => router.replace("/tokens", { scroll: false }), [router]);

  return (
    <div className="p-3">
      <PageTitle
        title="Load Compliance Token Registry"
        sub="Every token is signed with Ed25519 at the site that issued it, so any station can verify it offline. Records are demo data."
        actions={
          <>
            <Provenance kind="DEMO DATA" title="Tokens come from the simulation and from operator entries" />
            <a href="/api/tokens/keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline">Public keys<ExternalLink size={12} /></a>
          </>
        }
      />
      <div className="grid gap-2 grid-cols-3 md:grid-cols-4 xl:grid-cols-7 mb-2">
        {(lifecycle.length ? lifecycle : ["PENDING", "ISSUED", "ACTIVE", "EXPIRED", "SUSPENDED", "REVOKED", "FLAGGED"]).map((s) => (
          <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(status === s ? "" : s)} className={`text-left cursor-pointer rounded-md ${status === s ? "outline outline-1 outline-accent" : ""}`}>
            <Kpi label={STATUS_SENTENCE[s] || s} value={data ? fmtInt(data.counts[s] ?? 0) : "-"} tone={KPI_TONE[s]} sub={status === s ? "Filtering the table" : "All tokens"} />
          </button>
        ))}
      </div>
      <Panel title="Tokens" sub={data ? `${fmtInt(data.total)} match${offset === 0 ? ", refreshing every 5 s" : ""}` : undefined} pad={false}>
        <div className="grid gap-2 p-2 border-b border-line grid-cols-2 md:grid-cols-3 xl:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
          <Field label="Search"><Input placeholder="Token id, plate, container or tag" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {lifecycle.map((s) => <option key={s} value={s}>{STATUS_SENTENCE[s] || s}</option>)}
            </Select>
          </Field>
          <Field label="Source">
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">All sources</option>
              {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Trust tier">
            <Select value={tier} onChange={(e) => setTier(e.target.value)}>
              <option value="">All tiers</option>
              {[1, 2, 3].map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
            </Select>
          </Field>
          <Field label="Issuing station">
            <Select value={station} onChange={(e) => setStation(e.target.value)}>
              <option value="">All stations</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{siteName(s.id)}</option>)}
            </Select>
          </Field>
        </div>
        {error && <div className="p-2"><ErrorBox text={error} /></div>}
        {!data && loading && <Loading text="Loading tokens" />}
        {data && (
          <>
            <DataTable<TokenRow>
              rows={data.items}
              rowKey={(r) => r.token_id}
              maxH="calc(100vh - 340px)"
              empty="No tokens match these filters."
              onRow={(r) => router.push(`/tokens?id=${encodeURIComponent(r.token_id)}`, { scroll: false })}
              cols={[
                { key: "token_id", label: "Token", mono: true, render: (r) => <span className="text-ink">{r.token_id}</span> },
                { key: "status", label: "Status", render: (r) => <TokenStatus value={r.status} /> },
                { key: "plate", label: "Tractor", mono: true, render: (r) => r.tractor_plate },
                { key: "container", label: "Container", mono: true, render: (r) => r.container_number || "-" },
                { key: "source", label: "Source", render: (r) => <span className="text-ink-2">{r.source}</span> },
                { key: "tier", label: "Tier", align: "right", mono: true, render: (r) => r.trust_tier },
                { key: "station", label: "Station", render: (r) => <span className="text-ink-2">{siteName(r.origin_station)}</span> },
                { key: "gross", label: "Gross", align: "right", mono: true, render: (r) => fmtKg(r.gross_kg) },
                { key: "issued", label: "Issued", mono: true, render: (r) => fmtDateTime(r.issued_at) },
                { key: "until", label: "Valid until", mono: true, render: (r) => fmtDateTime(r.valid_until) },
              ]}
            />
            <Pager offset={offset} limit={LIMIT} total={data.total} count={data.items.length} onChange={setOffset} />
          </>
        )}
      </Panel>
      <TokenDrawer id={id} sites={sites} onClose={close} onChanged={refresh} />
    </div>
  );
}

export default function TokensPage() {
  return (
    <Suspense fallback={<Loading text="Loading tokens" />}>
      <TokensInner />
    </Suspense>
  );
}
