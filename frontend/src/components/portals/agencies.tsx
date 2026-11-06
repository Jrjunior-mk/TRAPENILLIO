"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, DataTable, Empty, Input, Kpi, Panel } from "@/components/ui";
import { useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtDateTime, fmtInt, fmtKg, fmtPct } from "@/lib/format";
import { asSim, type CaseRow, CaseStatus, EventTable, type EventRow, Fetching, Flag, fmtVar, PlateLink, PortalFrame, type ReleaseSnapshot, ReleaseFlags, StaleNote, type TokenRow } from "./shared";

interface KpaData {
  note: string; reweigh_queue: number; kra_mock_down: boolean; events: EventRow[]; tokens: TokenRow[];
  station: { id: string; online: boolean; edge_up: boolean; processed: number; decisions: Record<string, number>; static_queue: number; bays_total: number; bays_busy: number; bay_utilization: number; availability_pct: number; outbox: number };
}

export function KpaPortal() {
  const q = useApi<KpaData>("/portals/kpa", 6000);
  const d = q.data;
  const reweigh = d?.events.filter((e) => e.action === "PORT_REWEIGH") ?? [];
  const exits = d?.events.filter((e) => e.action === "CONTINUE") ?? [];
  return (
    <PortalFrame
      title="KPA portal"
      sub="Port gate-out processing, the re-weigh queue, and container verification and release status."
      note={d?.note}
      actions={d && <Flag ok={!d.kra_mock_down} yes="Mock customs API available" no="Mock customs API unavailable" title="Mock adapter state. Without it, port trucks fail safe to the re-weigh lane." />}
    >
      {!d ? <Fetching error={q.error} text="Loading the KPA portal" /> : (
        <>
          <StaleNote error={q.error} />
          <div className="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6 mb-2">
            <Kpi label="Gate-out decisions today" value={fmtInt(d.station.processed)} sub={d.station.edge_up ? (d.station.online ? "Site online" : `Offline, ${d.station.outbox} queued`) : "Edge down"} />
            <Kpi label="Green" value={fmtInt(d.station.decisions.GREEN ?? 0)} tone="go" sub="Cleared at the gate" />
            <Kpi label="Amber" value={fmtInt(d.station.decisions.AMBER ?? 0)} tone="wait" sub="Sent to re-weigh" />
            <Kpi label="Red" value={fmtInt(d.station.decisions.RED ?? 0)} tone="stop" sub="Held for correction" />
            <Kpi label="Re-weigh queue" value={fmtInt(d.reweigh_queue)} unit="trucks" sub={`${d.station.bays_busy}/${d.station.bays_total} bays in use, ${fmtPct(d.station.bay_utilization * 100, 0)} utilization`} />
            <Kpi label="Site availability" value={fmtPct(d.station.availability_pct, 2)} sub="Simulated" />
          </div>
          <div className="grid gap-2 xl:grid-cols-2 mb-2">
            <Panel title="Port gate-out processing" sub="latest 40 decisions at the port node" pad={false}><EventTable rows={d.events} hideSite maxH="300px" empty="No gate-out decisions yet." /></Panel>
            <Panel title="Re-weigh referrals" sub={`${d.reweigh_queue} in queue now, recent referrals below`} pad={false}><EventTable rows={reweigh} hideSite maxH="300px" empty="No re-weigh referrals among the latest 40 decisions." /></Panel>
          </div>
          <div className="grid gap-2 xl:grid-cols-2">
            <Panel title="Container verification and release status" sub="latest 30 port tokens, release as captured when the token was issued" pad={false}>
              <DataTable<TokenRow>
                rows={d.tokens}
                rowKey={(r) => r.token_id}
                maxH="340px"
                empty="No port tokens issued yet."
                cols={[
                  { key: "container", label: "Container", mono: true, render: (r) => r.container_number || "-" },
                  { key: "plate", label: "Truck", render: (r) => <PlateLink plate={r.tractor_plate} /> },
                  { key: "seal", label: "E-seal", mono: true, render: (r) => r.eseal_id || "-" },
                  { key: "gross", label: "Measured", align: "right", mono: true, render: (r) => fmtKg(r.gross_kg) },
                  { key: "release", label: "Release", render: (r) => <ReleaseFlags release={r.release_snapshot} /> },
                ]}
              />
            </Panel>
            <Panel title="Exit clearance events" sub="trucks that left the port with no further action" pad={false}><EventTable rows={exits} hideSite maxH="340px" empty="No exit clearances among the latest 40 decisions." /></Panel>
          </div>
        </>
      )}
    </PortalFrame>
  );
}

interface KraRow { token_id: string; plate: string; container: string | null; eseal_id: string | null; expected_kg: number | null; measured_kg: number; variance_pct: number | null; release: ReleaseSnapshot | null; issued_at: string }
interface KraData { note: string; tolerance_pct: number; reconciliation: KraRow[]; misdeclaration_alerts: EventRow[]; sealed_overloads: CaseRow[] }

export function KraPortal() {
  const q = useApi<KraData>("/portals/kra", 8000);
  const [onlyOver, setOnlyOver] = useState(false);
  const d = q.data;
  const over = (r: KraRow) => r.variance_pct !== null && Math.abs(r.variance_pct) > (d?.tolerance_pct ?? Infinity);
  const rows = d ? (onlyOver ? d.reconciliation.filter(over) : d.reconciliation) : [];
  const overCount = d ? d.reconciliation.filter(over).length : 0;
  return (
    <PortalFrame title="KRA portal" sub="Expected against measured weight, e-seal and customs release, misdeclaration alerts and sealed overload cases." note={d?.note}>
      {!d ? <Fetching error={q.error} text="Loading the KRA portal" /> : (
        <>
          <StaleNote error={q.error} />
          <div className="grid gap-2 grid-cols-2 md:grid-cols-4 mb-2">
            <Kpi label="Tokens reconciled" value={fmtInt(d.reconciliation.length)} sub="Latest 60 port tokens" />
            <Kpi label="Variance tolerance" value={fmtPct(d.tolerance_pct)} sub="Active decision policy" />
            <Kpi label="Above tolerance" value={fmtInt(overCount)} tone={overCount ? "wait" : undefined} sub="Absolute variance" />
            <Kpi label="Sealed overload cases" value={fmtInt(d.sealed_overloads.filter((c) => c.status === "PENDING").length)} tone={d.sealed_overloads.some((c) => c.status === "PENDING") ? "stop" : undefined} sub={`Pending, of ${d.sealed_overloads.length} recorded`} />
          </div>
          <Panel
            title="Expected against measured"
            sub="declared cargo plus tare, against the port scale"
            pad={false}
            className="mb-2"
            actions={<label className="flex items-center gap-1.5 text-[11px] text-ink-2 cursor-pointer"><input type="checkbox" checked={onlyOver} onChange={(e) => setOnlyOver(e.target.checked)} className="accent-[#38bdf8]" />Above tolerance only</label>}
          >
            <DataTable<KraRow>
              rows={rows}
              rowKey={(r) => r.token_id}
              maxH="360px"
              empty={onlyOver ? "No token is above tolerance in this window." : "No port tokens issued yet."}
              cols={[
                { key: "token", label: "Token", render: (r) => <Link href={`/tokens?id=${encodeURIComponent(r.token_id)}`} className="num text-[11.5px] text-accent hover:underline">{r.token_id}</Link> },
                { key: "plate", label: "Truck", render: (r) => <PlateLink plate={r.plate} /> },
                { key: "container", label: "Container", mono: true, render: (r) => r.container || "-" },
                { key: "seal", label: "E-seal", mono: true, render: (r) => r.eseal_id || "-" },
                { key: "expected", label: "Expected", align: "right", mono: true, render: (r) => fmtKg(r.expected_kg) },
                { key: "measured", label: "Measured", align: "right", mono: true, render: (r) => fmtKg(r.measured_kg) },
                { key: "variance", label: "Variance", align: "right", mono: true, render: (r) => <span className={over(r) ? "text-wait font-semibold" : ""}>{fmtVar(r.variance_pct)}</span> },
                { key: "flag", label: "Check", render: (r) => (r.variance_pct === null ? <Badge>No expected weight</Badge> : over(r) ? <Badge tone="wait">Above tolerance</Badge> : <Badge>Within tolerance</Badge>) },
                { key: "release", label: "Customs release", render: (r) => <ReleaseFlags release={r.release} /> },
              ]}
            />
          </Panel>
          <div className="grid gap-2 xl:grid-cols-2">
            <Panel title="Misdeclaration alerts" sub="port decisions citing a misdeclaration" pad={false}><EventTable rows={d.misdeclaration_alerts} hideSite maxH="320px" empty="No misdeclaration alerts recorded." /></Panel>
            <Panel title="Sealed overload cases" sub="a customs officer must attend before the seal is broken" pad={false}>
              <DataTable<CaseRow>
                rows={d.sealed_overloads}
                rowKey={(r) => r.id}
                maxH="320px"
                empty="No overloaded sealed-transit trucks recorded."
                cols={[
                  { key: "at", label: "Opened", mono: true, render: (r) => fmtDateTime(asSim(r.created_at)) },
                  { key: "plate", label: "Truck", render: (r) => <PlateLink plate={r.plate} /> },
                  { key: "over", label: "Overload", align: "right", mono: true, render: (r) => fmtKg(r.overload_kg) },
                  { key: "need", label: "Customs officer", render: (r) => (r.status === "PENDING" ? <Badge tone="stop">Required now</Badge> : <Badge>Case closed</Badge>) },
                  { key: "status", label: "Case", render: (r) => <CaseStatus value={r.status} /> },
                ]}
              />
              <p className="text-[10.5px] text-ink-3 px-3 py-2 border-t border-line">Read only here. The ticket decision is made by a KeNHA officer.</p>
            </Panel>
          </div>
        </>
      )}
    </PortalFrame>
  );
}

interface NtsaVehicle { id: number; plate: string; trailer: string | null; config: string; fleet: string | null; fleet_id: number | null; enrolled: boolean; demerits: number; mock_ntsa: { registration_valid: boolean; insurance_valid: boolean; roadworthy: boolean } }
interface NtsaFleet { id: number; name: string; demerits: number; clean_record: boolean }
interface NtsaData { note: string; vehicles: NtsaVehicle[]; fleets: NtsaFleet[] }

export function NtsaPortal() {
  const { me } = useAuth();
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setTerm(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  const q = useApi<NtsaData>(`/portals/ntsa${term ? `?q=${encodeURIComponent(term)}` : ""}`, 15000);
  const d = q.data;
  // A transporter only ever works with their own fleet on screen
  const own = me?.role === "transporter";
  const vehicles = d ? (own ? d.vehicles.filter((v) => v.fleet_id === me?.fleet_id) : d.vehicles) : [];
  const fleets = d ? (own ? d.fleets.filter((f) => f.id === me?.fleet_id) : d.fleets) : [];
  return (
    <PortalFrame title="NTSA portal" sub="Vehicle records with mock registration, insurance and roadworthiness flags, and demerits by truck and fleet." note={d?.note}>
      {!d ? <Fetching error={q.error} text="Loading the NTSA portal" /> : (
        <div className="grid gap-2 xl:grid-cols-[1fr_340px]">
          <Panel
            title="Vehicle records"
            sub="up to 60, highest demerits first"
            pad={false}
            actions={<Input aria-label="Search by plate" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search plate" className="!h-6 !w-44 !text-[11px]" />}
          >
            <StaleNote error={q.error} />
            <DataTable<NtsaVehicle>
              rows={vehicles}
              rowKey={(r) => r.id}
              maxH="620px"
              empty={term ? `No vehicle plate contains "${term}".` : "No vehicles registered."}
              cols={[
                { key: "plate", label: "Truck", render: (r) => <PlateLink plate={r.plate} /> },
                { key: "fleet", label: "Fleet", render: (r) => r.fleet || "-" },
                { key: "config", label: "Axles", mono: true, render: (r) => r.config },
                { key: "reg", label: "Registration", render: (r) => <Flag ok={r.mock_ntsa.registration_valid} yes="Valid" no="Invalid" /> },
                { key: "ins", label: "Insurance", render: (r) => <Flag ok={r.mock_ntsa.insurance_valid} yes="Valid" no="Lapsed" /> },
                { key: "rw", label: "Roadworthy", render: (r) => <Flag ok={r.mock_ntsa.roadworthy} yes="Yes" no="No" /> },
                { key: "demerits", label: "Demerits", align: "right", mono: true, render: (r) => r.demerits },
              ]}
            />
          </Panel>
          <Panel title="Fleet demerits" sub="highest first" pad={false}>
            <DataTable<NtsaFleet>
              rows={fleets}
              rowKey={(r) => r.id}
              maxH="620px"
              empty="No fleets registered."
              cols={[
                { key: "name", label: "Fleet", render: (r) => (own ? r.name : <Link href={`/portals/transporter?fleet=${r.id}`} className="text-accent hover:underline">{r.name}</Link>) },
                { key: "demerits", label: "Demerits", align: "right", mono: true, render: (r) => r.demerits },
                { key: "clean", label: "Record", render: (r) => (r.clean_record ? <Badge>Clean</Badge> : <Badge tone="wait">Not clean</Badge>) },
              ]}
            />
            {!fleets.length && <Empty text="No fleet data." />}
          </Panel>
        </div>
      )}
    </PortalFrame>
  );
}
