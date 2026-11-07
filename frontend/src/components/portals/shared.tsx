"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback } from "react";
import { PageTitle } from "@/components/shell";
import { Badge, type Col, DataTable, ErrorBox, Loading, Outcome, Provenance, TokenStatus } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { fmtDate, fmtDateTime, fmtNum, fmtPct, fmtT, fmtTime, siteName } from "@/lib/format";

// The API returns SQLite timestamps without an offset. Rows stamped by the simulated clock hold East Africa Time
// and rows stamped by the server clock hold UTC, so each caller says which clock produced the value.
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;
export const asUtc = (iso?: string | null) => (iso && !HAS_OFFSET.test(iso) ? `${iso}Z` : iso);
export const asSim = (iso?: string | null) => (iso && !HAS_OFFSET.test(iso) ? `${iso}+03:00` : iso);

export interface EventRow {
  id: string; at: string; truck: string; plate: string; stream: string; site: string; stage: string; outcome: string; action: string; risk: number; confidence: number; explanation: string;
  checks: unknown; gross_kg: number | null; axle_loads_kg: number[] | null; token_id: string | null; fail_safe: boolean; offline: boolean; signed: boolean; origin: string;
}
export interface CaseRow {
  id: string; created_at: string; site: string; plate: string; truck_ref: string; measured_gross_kg: number; limit_kg: number; overload_kg: number; fee_usd: number | null; fee_note: string; reason: string;
  sealed_transit: boolean; status: string; release_order: string | null; officer: string | null; decided_at: string | null; signed: boolean; origin: string; truck_released?: boolean;
}
export interface TokenRow {
  token_id: string; status: string; status_reason: string | null; tractor_plate: string; trailer_plate: string | null; rfid_tag: string | null; container_number: string | null; eseal_id: string | null; source: string; trust_tier: number;
  origin_station: string | null; gross_kg: number; expected_gross_kg: number | null; variance_pct: number | null; issued_at: string; valid_until: string; origin: string; destination: string | null; release_snapshot?: ReleaseSnapshot | null;
}
export interface ReleaseSnapshot { adapter?: string; customs?: boolean; shipping_line?: boolean; kpa?: boolean; icms_ref?: string | null }
export interface CalRow { id: number; site: string; device: string; calibrator: string; certificate_no: string; performed_at: string; due_at: string; result: string; is_demo: boolean; overdue: boolean; days_left: number }
export interface DisputeRow { id: number; created_at: string; fleet_id: number | null; plate: string; event_id: string | null; reason: string; status: string; resolution: string | null; resolved_by: string | null }

export const textareaCls = "w-full px-2 py-1.5 rounded-sm bg-bg-2 border border-line-2 text-ink text-[12px] placeholder:text-ink-3 focus:border-accent outline-none resize-y";

function TokenLink({ id }: { id: string }) {
  const { has } = useAuth();
  if (!has("tokens")) return <span className="num text-[11.5px]">{id}</span>;
  return <Link href={`/tokens?id=${encodeURIComponent(id)}`} className="num text-[11.5px] text-accent hover:underline">{id}</Link>;
}

export function PortalFrame({ title, sub, note, actions, children }: { title: string; sub?: ReactNode; note?: string; actions?: ReactNode; children: ReactNode }) {
  const { has } = useAuth();
  return (
    <div className="p-3">
      <PageTitle title={title} sub={sub} actions={<>{actions}{has("portals") && <Link href="/portals" className="text-[12px] text-accent hover:underline">All portals</Link>}</>} />
      {note && (
        <div className="flex items-start gap-2 border border-line bg-bg-2 text-ink-2 text-[11.5px] leading-relaxed rounded-sm px-3 py-2 mb-2">
          <Provenance kind="MOCK" title="Synthetic records and mock adapters" />
          <span>{note}</span>
        </div>
      )}
      {children}
    </div>
  );
}

/** First-load state for a portal: the API's own message when it refuses, otherwise a spinner. */
export const Fetching = ({ error, text }: { error: string | null; text?: string }) => (error ? <ErrorBox text={error} /> : <Loading text={text} />);

/** A later refresh failed while older data stays on screen. */
export const StaleNote = ({ error }: { error: string | null }) => (error ? <div className="text-[11px] text-wait mb-2">Refresh failed, showing the last data received. {error}</div> : null);

export function useTabParam(fallback: string, name = "tab"): [string, (id: string) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const value = params.get(name) || fallback;
  const set = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      next.set(name, id);
      router.replace(`${path}?${next.toString()}`, { scroll: false });
    },
    [params, router, path, name],
  );
  return [value, set];
}

export const PlateLink = ({ plate }: { plate: string }) =>
  plate.startsWith("ANON-") ? <span className="num text-[11.5px] text-ink-3">{plate}</span> : <Link href={`/trucks/${encodeURIComponent(plate)}`} className="num text-[11.5px] text-accent hover:underline">{plate}</Link>;

export const Flag = ({ ok, yes, no, title }: { ok: boolean | null | undefined; yes: string; no: string; title?: string }) => <Badge tone={ok ? "go" : "stop"} title={title}>{ok ? yes : no}</Badge>;

const CASE_TONE: Record<string, "wait" | "go" | "stop" | "muted"> = { PENDING: "wait", APPROVED: "go", REJECTED: "stop", AUTO_DEMO: "muted" };
export const CASE_LABEL: Record<string, string> = { PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected", AUTO_DEMO: "Closed by demo duty officer" };
export const CaseStatus = ({ value }: { value: string }) => <Badge tone={CASE_TONE[value] || "muted"}>{CASE_LABEL[value] || value}</Badge>;

export function EventTable({ rows, maxH = "340px", empty, hideSite }: { rows: EventRow[]; maxH?: string; empty?: string; hideSite?: boolean }) {
  const cols: Col<EventRow>[] = [
    { key: "at", label: "Time", mono: true, render: (r) => <span title={fmtDate(asSim(r.at))}>{fmtTime(asSim(r.at))}</span> },
    { key: "plate", label: "Truck", render: (r) => <PlateLink plate={r.plate} /> },
    ...(hideSite ? [] : [{ key: "site", label: "Site", render: (r: EventRow) => siteName(r.site) }]),
    { key: "gross", label: "Gross", align: "right", mono: true, render: (r) => fmtT(r.gross_kg) },
    { key: "outcome", label: "Outcome", render: (r) => <Outcome value={r.outcome} /> },
    { key: "action", label: "Action", render: (r) => <span className="text-ink-2 text-[11px]">{r.action.replace(/_/g, " ").toLowerCase()}</span> },
    { key: "flags", label: "Record", render: (r) => <span className="inline-flex gap-1">{r.signed ? <Badge>Signed</Badge> : <Badge>Unsigned</Badge>}{r.fail_safe && <Badge tone="wait">Fail-safe</Badge>}{r.offline && <Badge tone="wait">Offline</Badge>}</span> },
    { key: "why", label: "Reason", render: (r) => <span className="text-ink-3 text-[11px] line-clamp-1" title={r.explanation}>{r.explanation}</span> },
  ];
  return <DataTable<EventRow> rows={rows} rowKey={(r) => r.id} cols={cols} maxH={maxH} empty={empty || "No events recorded yet."} />;
}

export function TokenTable({ rows, maxH = "300px", empty }: { rows: TokenRow[]; maxH?: string; empty?: string }) {
  return (
    <DataTable<TokenRow>
      rows={rows}
      rowKey={(r) => r.token_id}
      maxH={maxH}
      empty={empty || "No tokens recorded yet."}
      cols={[
        { key: "id", label: "Token", render: (r) => <TokenLink id={r.token_id} /> },
        { key: "status", label: "Status", render: (r) => <TokenStatus value={r.status} /> },
        { key: "plate", label: "Truck", render: (r) => <PlateLink plate={r.tractor_plate} /> },
        { key: "gross", label: "Gross", align: "right", mono: true, render: (r) => fmtT(r.gross_kg) },
        { key: "variance", label: "Variance", align: "right", mono: true, render: (r) => fmtPct(r.variance_pct) },
        { key: "tier", label: "Trust tier", align: "right", mono: true, render: (r) => r.trust_tier },
        { key: "until", label: "Valid until", mono: true, render: (r) => fmtDateTime(asSim(r.valid_until)) },
      ]}
    />
  );
}

export function CalibrationTable({ rows, maxH = "380px" }: { rows: CalRow[]; maxH?: string }) {
  return (
    <DataTable<CalRow>
      rows={rows}
      rowKey={(r) => r.id}
      maxH={maxH}
      empty="No calibration records for this site."
      cols={[
        { key: "site", label: "Site", render: (r) => siteName(r.site) },
        { key: "device", label: "Device" },
        { key: "calibrator", label: "Calibrator" },
        { key: "cert", label: "Certificate", mono: true, render: (r) => r.certificate_no },
        { key: "done", label: "Performed", mono: true, render: (r) => fmtDate(asUtc(r.performed_at)) },
        { key: "due", label: "Due", mono: true, render: (r) => fmtDate(asUtc(r.due_at)) },
        { key: "result", label: "Result", render: (r) => <Flag ok={r.result === "PASS"} yes="Pass" no="Fail" /> },
        { key: "state", label: "State", render: (r) => (r.overdue ? <Badge tone="stop">Overdue by {Math.abs(r.days_left)} d</Badge> : <Badge tone={r.days_left <= 14 ? "wait" : "muted"}>{r.days_left} d left</Badge>) },
        { key: "demo", label: "Data", render: (r) => (r.is_demo ? <Provenance kind="DEMO DATA" /> : <span className="text-ink-3">-</span>) },
      ]}
    />
  );
}

export function ReleaseFlags({ release }: { release?: ReleaseSnapshot | null }) {
  if (!release) return <Badge tone="wait">No release snapshot</Badge>;
  return (
    <span className="inline-flex gap-1 flex-wrap">
      <Flag ok={release.customs} yes="Customs released" no="Customs hold" />
      <Flag ok={release.shipping_line} yes="Line released" no="Line hold" />
      <Flag ok={release.kpa} yes="KPA released" no="KPA hold" />
    </span>
  );
}

export const fmtVar = (v?: number | null) => (v === null || v === undefined ? "-" : `${v > 0 ? "+" : ""}${fmtNum(v, 2)}%`);
