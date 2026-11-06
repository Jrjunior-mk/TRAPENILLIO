"use client";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { fmtDateTime, fmtKg, fmtNum, siteName } from "@/lib/format";
import { Button, CheckList, Drawer, Empty, KV, Meter, Outcome } from "./ui";

/** Helpers shared by the clearance, truck, token and decision pages. */

export interface CheckRow { code: string; label: string; status: string; detail?: string }

export interface ClearanceEvent {
  id: string; at: string; truck: string; plate: string; stream: string; site: string; stage: string; outcome: string; action: string; risk: number; confidence: number; explanation: string;
  checks: CheckRow[] | null; gross_kg: number | null; axle_loads_kg: number[] | null; token_id: string | null; fail_safe: boolean; offline: boolean; signed: boolean; origin: string;
}

export const truckHref = (plate: string) => `/trucks/${encodeURIComponent(plate)}`;
export const tokenHref = (id: string) => `/tokens?id=${encodeURIComponent(id)}`;

const ACTION_LABEL: Record<string, string> = {
  CONTINUE: "Continue on the corridor",
  DIVERT_LANE: "Divert to the verification lane",
  STATIC_SCALE: "Send to the static scale",
  PORT_REWEIGH: "Port re-weigh",
  HOLD_CORRECTIVE: "Hold for corrective action",
  OFFICER_REVIEW: "Officer review",
  DENY_TOKEN: "No token, verify in the lane",
};
export const actionLabel = (a?: string | null) => (a ? ACTION_LABEL[a] || a : "-");

export const truncate = (s?: string | null, keep = 14) => (!s ? "-" : s.length <= keep * 2 + 3 ? s : `${s.slice(0, keep)}...${s.slice(-keep)}`);

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** When total is unknown, pass count (rows on this page): next stays enabled while the page is full. */
export function Pager({ offset, limit, total, count, onChange }: { offset: number; limit: number; total?: number | null; count: number; onChange: (offset: number) => void }) {
  const hasNext = total !== undefined && total !== null ? offset + limit < total : count === limit;
  const from = count ? offset + 1 : 0;
  return (
    <div className="flex items-center gap-2 px-3 h-9 border-t border-line text-[11px] text-ink-3">
      <span className="num">{from}-{offset + count}{total !== undefined && total !== null ? ` of ${total.toLocaleString("en-US")}` : ""}</span>
      <div className="ml-auto flex gap-1.5">
        <Button type="button" size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</Button>
        <Button type="button" size="sm" disabled={!hasNext} onClick={() => onChange(offset + limit)}>Next</Button>
      </div>
    </div>
  );
}

export function Toggle({ label, checked, onChange, hint, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-[12px] text-ink cursor-pointer has-[:disabled]:opacity-50 has-[:disabled]:cursor-not-allowed">
      <input type="checkbox" className="mt-0.5 accent-[#38bdf8]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        {label}
        {hint && <span className="block text-[10.5px] text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

export function ScoreRow({ risk, confidence }: { risk?: number | null; confidence?: number | null }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <div className="flex justify-between text-[11px] mb-1"><span className="text-ink-3">Risk score</span><span className="num text-ink">{fmtNum(risk ?? 0, 1)} of 100</span></div>
        <Meter value={(risk ?? 0) / 100} />
      </div>
      <div>
        <div className="flex justify-between text-[11px] mb-1"><span className="text-ink-3">Confidence</span><span className="num text-ink">{fmtNum((confidence ?? 0) * 100, 0)}%</span></div>
        <Meter value={confidence ?? 0} tone="var(--color-accent)" />
      </div>
    </div>
  );
}

/** Row-click detail for one recorded clearance event. */
export function EventDrawer({ event, onClose }: { event: ClearanceEvent | null; onClose: () => void }) {
  return (
    <Drawer open={!!event} onClose={onClose} title={event ? `${event.plate} at ${siteName(event.site)}` : ""}>
      {event && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Outcome value={event.outcome} size="lg" />
            <span className="text-[12px] text-ink">{actionLabel(event.action)}</span>
          </div>
          <p className="text-[12px] text-ink-2 leading-relaxed">{event.explanation || "No explanation recorded."}</p>
          <ScoreRow risk={event.risk} confidence={event.confidence} />
          <KV
            items={[
              ["Time", <span key="t" className="num">{fmtDateTime(event.at)} EAT sim</span>],
              ["Stage", event.stage],
              ["Measured gross", <span key="g" className="num">{fmtKg(event.gross_kg)}</span>],
              ["Stream", event.stream],
              ["Truck", <Link key="p" className="text-accent hover:underline" href={truckHref(event.plate)}>{event.plate}</Link>],
              ["Token checked", event.token_id ? <Link key="k" className="text-accent hover:underline num" href={tokenHref(event.token_id)}>{event.token_id}</Link> : "None on this event"],
              ["Fail-safe", event.fail_safe ? "Yes, a fault defaulted this decision" : "No"],
              ["Recorded offline", event.offline ? "Yes" : "No"],
              ["Event signed", event.signed ? "Yes" : "No"],
              ["Event id", <span key="i" className="num">{event.id}</span>],
            ]}
          />
          <div>
            <div className="eyebrow mb-1">Checks</div>
            {event.checks?.length ? <CheckList checks={event.checks} /> : <Empty text="No checks were stored for this event." />}
          </div>
        </div>
      )}
    </Drawer>
  );
}
