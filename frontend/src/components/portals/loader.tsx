"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, ErrorBox, Kpi, Panel, Select } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtInt, fmtPct } from "@/lib/format";
import { CalibrationTable, type CalRow, EventTable, type EventRow, Fetching, Flag, PortalFrame, StaleNote, TokenTable, type TokenRow } from "./shared";

interface Data {
  note: string; site: { id: string; name: string; origin_type: string | null; approved: boolean; suspended: boolean; calibration_valid: boolean; trust_tier: number };
  tokens: TokenRow[]; events: EventRow[]; calibration: CalRow[]; avg_variance_pct: number | null; sites: { id: string; name: string }[];
}

export function LoaderPortal() {
  const { me, can } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const siteParam = params.get("site");
  const locked = me?.role === "loader" && !!me.site_id;
  const q = useApi<Data>(!me ? null : !locked && siteParam ? `/portals/loader?site=${encodeURIComponent(siteParam)}` : "/portals/loader", 8000);
  const d = q.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flip = async (field: "scale_approved" | "calibration_valid" | "suspended", value: boolean) => {
    if (!d) return;
    setBusy(field);
    setError(null);
    try {
      await api(`/portals/loader/${encodeURIComponent(d.site.id)}/flags`, { body: { [field]: value } });
      await q.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const blocked = d ? !d.site.approved || !d.site.calibration_valid || d.site.suspended : false;
  return (
    <PortalFrame
      title={d ? `Loading site portal: ${d.site.name}` : "Loading site portal"}
      sub="Origin tokens, weighing tickets and calibration for one approved loading site."
      note={d?.note}
      actions={
        <>
          {d && !locked && (
            <label className="flex items-center gap-1.5 text-[11px] text-ink-3">Site
              <Select aria-label="Select a site" value={d.site.id} onChange={(e) => router.replace(`/portals/loader?site=${e.target.value}`, { scroll: false })} className="!h-7 !w-44">
                {d.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </label>
          )}
          <Link href="/clearance?tab=origin" className="text-[12px] text-accent hover:underline">Weigh a truck at origin</Link>
        </>
      }
    >
      {!d ? <Fetching error={q.error} text="Loading the site" /> : (
        <>
          <StaleNote error={q.error} />
          <div className="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6 mb-2">
            <Kpi label="Trust tier" value={d.site.trust_tier} sub="Fixed for origin scales in this demo" />
            <Kpi label="Origin tokens" value={fmtInt(d.tokens.length)} sub="Latest 40" />
            <Kpi label="Weighing tickets" value={fmtInt(d.events.length)} sub="Latest 30" />
            <Kpi label="Average variance" value={d.avg_variance_pct === null ? "-" : fmtPct(d.avg_variance_pct, 2)} sub="Across these tokens" />
            <Kpi label="Site type" value={<span className="text-[14px]">{d.site.origin_type || "-"}</span>} sub={d.site.id} />
            <Kpi label="Token issue" value={<span className="text-[14px]">{blocked ? "Blocked" : "Allowed"}</span>} tone={blocked ? "stop" : "go"} sub={blocked ? "A site control is off" : "All site controls are on"} />
          </div>
          <Panel title="Site controls" className="mb-2">
            <div className="grid gap-3 md:grid-cols-3">
              <Control label="Scale approval" state={<Flag ok={d.site.approved} yes="Approved" no="Not approved" />} action={d.site.approved ? "Withdraw approval" : "Approve scale"} consequence="Without an approved scale no token can be issued here (Reg 5). Trucks loaded here go to the road stations without an origin token." allowed={can("token.manage")} busy={busy === "scale_approved"} onClick={() => flip("scale_approved", !d.site.approved)} />
              <Control label="Calibration" state={<Flag ok={d.site.calibration_valid} yes="Valid" no="Expired" />} action={d.site.calibration_valid ? "Mark expired" : "Mark valid"} consequence="Expired calibration blocks token issue and raises an alert until it is renewed (Reg 6). A passing calibration record also restores it." allowed={can("token.manage")} busy={busy === "calibration_valid"} onClick={() => flip("calibration_valid", !d.site.calibration_valid)} />
              <Control label="Suspension" state={d.site.suspended ? <Badge tone="stop">Suspended</Badge> : <Badge tone="go">Not suspended</Badge>} action={d.site.suspended ? "Lift suspension" : "Suspend site"} consequence="A suspended site cannot issue origin tokens, whatever its scale and calibration state." allowed={can("token.manage")} busy={busy === "suspended"} onClick={() => flip("suspended", !d.site.suspended)} />
            </div>
            {error && <div className="mt-2"><ErrorBox text={error} /></div>}
            {!can("token.manage") && <p className="text-[11px] text-ink-3 mt-2">Changing these needs token.manage, held by KeNHA officers and administrators.</p>}
          </Panel>
          <div className="grid gap-2 xl:grid-cols-2 mb-2">
            <Panel title="Origin tokens" sub="issued at this site" pad={false}><TokenTable rows={d.tokens} empty="No origin tokens issued at this site yet." /></Panel>
            <Panel title="Weighing tickets" sub="decisions recorded at this site" pad={false}><EventTable rows={d.events} hideSite maxH="300px" empty="No weighing tickets at this site yet." /></Panel>
          </div>
          <Panel title="Calibration" pad={false}><CalibrationTable rows={d.calibration} maxH="220px" /></Panel>
        </>
      )}
    </PortalFrame>
  );
}

function Control({ label, state, action, consequence, allowed, busy, onClick }: { label: string; state: React.ReactNode; action: string; consequence: string; allowed: boolean; busy: boolean; onClick: () => void }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 mb-1"><span className="text-[11px] text-ink-2">{label}</span>{state}{allowed && <Button size="sm" className="ml-auto" loading={busy} onClick={onClick}>{action}</Button>}</div>
      <p className="text-[11px] text-ink-3 leading-snug">{consequence}</p>
    </div>
  );
}
