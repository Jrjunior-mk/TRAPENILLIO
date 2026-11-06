"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, DataTable, ErrorBox, Field, Kpi, Panel, Select } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtDateTime, fmtInt, fmtT, siteName } from "@/lib/format";
import { asSim, asUtc, type DisputeRow, EventTable, type EventRow, Fetching, Flag, PlateLink, PortalFrame, StaleNote, textareaCls, TokenTable, type TokenRow } from "./shared";

interface Vehicle { id: number; plate: string; trailer: string | null; config: string; enrolled: boolean; demerits: number; mock_ntsa: { registration_valid: boolean; insurance_valid: boolean; roadworthy: boolean } }
interface OnRoad { id: string; plate: string; state: string; next: string | null }
interface Data { note: string; fleet: { id: number; name: string; demerits: number; clean_record: boolean }; vehicles: Vehicle[]; tokens: TokenRow[]; events: EventRow[]; disputes: DisputeRow[]; on_road: OnRoad[]; outcomes: Record<string, number> }

export function TransporterPortal() {
  const { me, can } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const scoped = me?.role === "transporter";
  const fleetParam = params.get("fleet");
  // The API ignores fleet_id for a transporter, and the selector and parameter are not offered to one either
  const path = !me ? null : scoped || !fleetParam ? "/portals/transporter" : `/portals/transporter?fleet_id=${encodeURIComponent(fleetParam)}`;
  const q = useApi<Data>(path, 8000);
  const canPick = !!me && !scoped && can("truck.view_all");
  const options = useApi<{ fleets: { id: number; name: string }[] }>(canPick ? "/trucks/options" : null);
  const d = q.data;
  const selector = canPick && (
    <label className="flex items-center gap-1.5 text-[11px] text-ink-3">Fleet
      <Select aria-label="Select a fleet" value={d?.fleet.id ?? ""} onChange={(e) => router.replace(`/portals/transporter?fleet=${e.target.value}`, { scroll: false })} className="!h-7 !w-52">
        {(options.data?.fleets ?? (d ? [d.fleet] : [])).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </Select>
    </label>
  );
  const axleRows = d?.events.filter((e) => e.axle_loads_kg && e.axle_loads_kg.length > 0) ?? [];
  return (
    <PortalFrame
      title={d ? `Transporter portal: ${d.fleet.name}` : "Transporter portal"}
      sub={scoped ? "Your fleet only: registered trucks, trucks on the road, tokens, clearance history, axle loads and disputes." : "Viewing one fleet at a time with your agency access."}
      note={d?.note}
      actions={selector}
    >
      {!d ? <Fetching error={q.error} text="Loading the fleet" /> : (
        <>
          <StaleNote error={q.error} />
          <div className="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6 mb-2">
            <Kpi label="Registered trucks" value={fmtInt(d.vehicles.length)} sub={`${d.vehicles.filter((v) => v.enrolled).length} enrolled`} />
            <Kpi label="On the road now" value={fmtInt(d.on_road.length)} tone="accent" sub="In the live simulation" />
            <Kpi label="Fleet demerits" value={fmtInt(d.fleet.demerits)} sub={d.fleet.clean_record ? "Clean record" : "Record not clean"} tone={d.fleet.clean_record ? undefined : "wait"} />
            <Kpi label="Green decisions" value={fmtInt(d.outcomes.GREEN ?? 0)} tone="go" sub="All recorded events" />
            <Kpi label="Amber decisions" value={fmtInt(d.outcomes.AMBER ?? 0)} tone="wait" sub="All recorded events" />
            <Kpi label="Red decisions" value={fmtInt(d.outcomes.RED ?? 0)} tone="stop" sub="All recorded events" />
          </div>
          <div className="grid gap-2 xl:grid-cols-2 mb-2">
            <Panel title="Registered fleet" sub="mock agency flags" pad={false}>
              <DataTable<Vehicle>
                rows={d.vehicles}
                rowKey={(r) => r.id}
                maxH="300px"
                empty="This fleet has no registered trucks."
                cols={[
                  { key: "plate", label: "Truck", render: (r) => <PlateLink plate={r.plate} /> },
                  { key: "trailer", label: "Trailer", mono: true, render: (r) => r.trailer || "-" },
                  { key: "config", label: "Axles", mono: true, render: (r) => r.config },
                  { key: "enrolled", label: "Enrolled", render: (r) => (r.enrolled ? <Badge>Yes</Badge> : <Badge tone="wait">No</Badge>) },
                  { key: "agency", label: "Mock records", render: (r) => (r.mock_ntsa.registration_valid && r.mock_ntsa.insurance_valid && r.mock_ntsa.roadworthy ? <Badge>All valid</Badge> : <Badge tone="wait">Check records</Badge>) },
                  { key: "demerits", label: "Demerits", align: "right", mono: true, render: (r) => r.demerits },
                ]}
              />
            </Panel>
            <Panel title="Trucks on the road now" sub="open one in the digital twin" pad={false}>
              <DataTable<OnRoad>
                rows={d.on_road}
                rowKey={(r) => r.id}
                maxH="300px"
                empty="No truck from this fleet is on the corridor right now."
                cols={[
                  { key: "plate", label: "Truck", render: (r) => <Link href={`/twin?truck=${encodeURIComponent(r.id)}`} className="num text-[11.5px] text-accent hover:underline">{r.plate}</Link> },
                  { key: "state", label: "State", render: (r) => <span className="text-ink-2">{r.state.replace(/_/g, " ").toLowerCase()}</span> },
                  { key: "next", label: "Next", render: (r) => <span className="text-ink-2">{r.next ? siteName(r.next) : "-"}</span> },
                ]}
              />
            </Panel>
          </div>
          <div className="grid gap-2 xl:grid-cols-2 mb-2">
            <Panel title="Tokens" sub="latest 40" pad={false}><TokenTable rows={d.tokens} /></Panel>
            <Panel title="Clearance history" sub="latest 50 decisions" pad={false}><EventTable rows={d.events} maxH="300px" empty="No clearance events for this fleet yet." /></Panel>
          </div>
          <div className="grid gap-2 xl:grid-cols-2">
            <Panel title="Axle load report" sub="events in the history above that carry axle readings" pad={false}>
              <DataTable<EventRow>
                rows={axleRows}
                rowKey={(r) => r.id}
                maxH="320px"
                empty="No axle readings recorded for this fleet yet."
                cols={[
                  { key: "at", label: "Time", mono: true, render: (r) => fmtDateTime(asSim(r.at)) },
                  { key: "plate", label: "Truck", render: (r) => <PlateLink plate={r.plate} /> },
                  { key: "site", label: "Site", render: (r) => siteName(r.site) },
                  { key: "stage", label: "Stage", render: (r) => <span className="text-ink-2">{r.stage}</span> },
                  { key: "gross", label: "Gross", align: "right", mono: true, render: (r) => fmtT(r.gross_kg) },
                  { key: "axles", label: "Axle loads, first to last (t)", mono: true, render: (r) => r.axle_loads_kg!.map((a) => (a / 1000).toFixed(1)).join(" / ") },
                ]}
              />
            </Panel>
            <DisputesPanel disputes={d.disputes} vehicles={d.vehicles} events={d.events} refresh={q.refresh} canCreate={can("dispute.create")} />
          </div>
        </>
      )}
    </PortalFrame>
  );
}

function DisputesPanel({ disputes, vehicles, events, refresh, canCreate }: { disputes: DisputeRow[]; vehicles: Vehicle[]; events: EventRow[]; refresh: () => void; canCreate: boolean }) {
  const [plate, setPlate] = useState("");
  const [eventId, setEventId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const chosen = plate || vehicles[0]?.plate || "";
  const plateEvents = events.filter((e) => e.plate === chosen);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const r = await api<DisputeRow>("/disputes", { body: { plate: chosen, event_id: eventId || null, reason: reason.trim() } });
      setSaved(r.id);
      setReason("");
      setEventId("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Disputes" sub={`${disputes.filter((d) => d.status === "OPEN").length} open of ${disputes.length}`} pad={false}>
      <DataTable<DisputeRow>
        rows={disputes}
        rowKey={(r) => r.id}
        maxH="170px"
        empty="No disputes filed for this fleet."
        cols={[
          { key: "at", label: "Filed", mono: true, render: (r) => fmtDateTime(asUtc(r.created_at)) },
          { key: "plate", label: "Truck", render: (r) => <PlateLink plate={r.plate} /> },
          { key: "reason", label: "Reason", render: (r) => <span className="text-[11px] text-ink-2 line-clamp-1" title={r.reason}>{r.reason}</span> },
          { key: "status", label: "Status", render: (r) => (r.status === "OPEN" ? <Badge tone="wait">Open</Badge> : <Flag ok={r.status === "UPHELD"} yes="Upheld" no="Rejected" />) },
          { key: "res", label: "Resolution", render: (r) => <span className="text-[11px] text-ink-3 line-clamp-1" title={r.resolution ?? undefined}>{r.resolution || "-"}</span> },
        ]}
      />
      <div className="p-3 border-t border-line">
        {!canCreate ? <p className="text-[11.5px] text-ink-3">Your role does not include dispute.create. Transporters and administrators file disputes.</p> : !vehicles.length ? <p className="text-[11.5px] text-ink-3">Register a truck before filing a dispute.</p> : (
          <form onSubmit={submit} className="grid gap-2 md:grid-cols-2">
            <Field label="Truck"><Select value={chosen} onChange={(e) => { setPlate(e.target.value); setEventId(""); }}>{vehicles.map((v) => <option key={v.id} value={v.plate}>{v.plate}</option>)}</Select></Field>
            <Field label="Clearance event (optional)">
              <Select value={eventId} onChange={(e) => setEventId(e.target.value)}>
                <option value="">None</option>
                {plateEvents.map((ev) => <option key={ev.id} value={ev.id}>{fmtDateTime(asSim(ev.at))}, {siteName(ev.site)}, {ev.outcome}</option>)}
              </Select>
            </Field>
            <Field label="Reason" className="md:col-span-2" hint="At least 5 characters. Reviewed by a KeNHA officer.">
              <textarea rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} className={textareaCls} />
            </Field>
            {error && <div className="md:col-span-2"><ErrorBox text={error} /></div>}
            <div className="md:col-span-2 flex items-center gap-2">
              <Button type="submit" variant="primary" loading={busy} disabled={reason.trim().length < 5}>File dispute</Button>
              {saved !== null && <span className="text-[11.5px] text-ink-2">Dispute {saved} filed.</span>}
            </div>
          </form>
        )}
      </div>
    </Panel>
  );
}
