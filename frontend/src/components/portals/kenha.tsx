"use client";
import { useMemo, useState } from "react";
import { Badge, Button, DataTable, Drawer, ErrorBox, Field, Input, KV, Meter, Panel, Select, Tabs } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtDateTime, fmtInt, fmtKg, fmtNum, fmtPct, siteName, SITE_SHORT } from "@/lib/format";
import { asSim, asUtc, CalibrationTable, type CalRow, CASE_LABEL, type CaseRow, CaseStatus, type DisputeRow, EventTable, type EventRow, Fetching, Flag, PlateLink, PortalFrame, StaleNote, textareaCls, useTabParam } from "./shared";

interface KenhaData {
  note: string; legal_note: string; cases: CaseRow[]; wim_events: EventRow[]; lane_events: EventRow[]; static_events: EventRow[]; calibration: CalRow[];
  stations: { id: string; online: boolean; edge_up: boolean; processed: number; decisions: Record<string, number>; lane_queue: number; static_queue: number; held: number; bays_total: number; bays_busy: number; bay_utilization: number; lane_utilization: number; availability_pct: number; sensors_failed: string[] }[];
}

const TABS = [
  { id: "cases", label: "Officer approvals" },
  { id: "wim", label: "Road screening and WIM" },
  { id: "lane", label: "Rolling verification" },
  { id: "static", label: "Static referrals" },
  { id: "calibration", label: "Calibration" },
  { id: "disputes", label: "Disputes" },
];

export function KenhaPortal() {
  const q = useApi<KenhaData>("/portals/kenha", 8000);
  const [tab, setTab] = useTabParam("cases");
  const d = q.data;
  return (
    <PortalFrame title="KeNHA portal" sub="Officer approvals, road screening, rolling verification, static referrals, calibration and disputes." note={d?.note}>
      {!d ? <Fetching error={q.error} text="Loading the KeNHA portal" /> : (
        <>
          <StaleNote error={q.error} />
          <div className="border border-accent/40 bg-accent/10 text-ink text-[12px] rounded-sm px-3 py-2 mb-2"><span className="font-semibold">Legal position. </span>{d.legal_note}</div>
          <Panel title="Station summary" sub="road stations, simulated" pad={false} className="mb-2">
            <DataTable
              rows={d.stations}
              rowKey={(r) => r.id}
              empty="No road stations reported."
              cols={[
                { key: "name", label: "Station", render: (r) => <span className="text-ink">{siteName(r.id)}</span> },
                { key: "state", label: "State", render: (r) => (!r.edge_up ? <Badge tone="stop">Edge down</Badge> : !r.online ? <Badge tone="wait">Offline</Badge> : r.sensors_failed.length ? <Badge tone="wait">{r.sensors_failed.length} sensor fault{r.sensors_failed.length > 1 ? "s" : ""}</Badge> : <Badge tone="go">Online</Badge>) },
                { key: "processed", label: "Decisions", align: "right", mono: true, render: (r) => fmtInt(r.processed) },
                { key: "green", label: "Green", align: "right", mono: true, render: (r) => fmtInt(r.decisions.GREEN ?? 0) },
                { key: "amber", label: "Amber", align: "right", mono: true, render: (r) => fmtInt(r.decisions.AMBER ?? 0) },
                { key: "red", label: "Red", align: "right", mono: true, render: (r) => fmtInt(r.decisions.RED ?? 0) },
                { key: "laneq", label: "Lane queue", align: "right", mono: true, render: (r) => r.lane_queue },
                { key: "staticq", label: "Static queue", align: "right", mono: true, render: (r) => r.static_queue },
                { key: "held", label: "Held", align: "right", mono: true, render: (r) => r.held },
                { key: "bays", label: "Bays in use", align: "right", mono: true, render: (r) => `${r.bays_busy}/${r.bays_total}` },
                { key: "util", label: "Bay utilization", width: "130px", render: (r) => <div className="flex items-center gap-2"><Meter value={r.bay_utilization} /><span className="num text-[11px] text-ink-2 w-9 text-right">{fmtPct(r.bay_utilization * 100, 0)}</span></div> },
                { key: "avail", label: "Availability", align: "right", mono: true, render: (r) => fmtPct(r.availability_pct, 2) },
              ]}
            />
          </Panel>
          <Tabs tabs={TABS} value={tab} onChange={setTab} />
          <div className="mt-2">
            {tab === "cases" && <CasesTab cases={d.cases} legal={d.legal_note} refresh={q.refresh} />}
            {tab === "wim" && <Panel title="Road screening and WIM" sub="latest 30 road decisions" pad={false}><EventTable rows={d.wim_events} maxH="480px" empty="No road screening events yet." /></Panel>}
            {tab === "lane" && <Panel title="Rolling verification" sub="latest 20 lane decisions" pad={false}><EventTable rows={d.lane_events} maxH="480px" empty="No rolling verification events yet." /></Panel>}
            {tab === "static" && <Panel title="Static referrals" sub="latest 20 static scale results" pad={false}><EventTable rows={d.static_events} maxH="480px" empty="No static referrals yet." /></Panel>}
            {tab === "calibration" && <CalibrationTab rows={d.calibration} refresh={q.refresh} />}
            {tab === "disputes" && <DisputesTab />}
          </div>
        </>
      )}
    </PortalFrame>
  );
}

function CasesTab({ cases, legal, refresh }: { cases: CaseRow[]; legal: string; refresh: () => void }) {
  const [status, setStatus] = useState("ALL");
  const [selected, setSelected] = useState<CaseRow | null>(null);
  const rows = useMemo(() => {
    const filtered = status === "ALL" ? cases : cases.filter((c) => c.status === status);
    // The API returns newest first and sort is stable, so this keeps that order inside each group
    return [...filtered].sort((a, b) => Number(b.status === "PENDING") - Number(a.status === "PENDING"));
  }, [cases, status]);
  const pending = cases.filter((c) => c.status === "PENDING").length;
  const current = selected ? cases.find((c) => c.id === selected.id) ?? selected : null;
  return (
    <Panel
      title="Officer approvals"
      sub={`${pending} pending among the latest ${cases.length} cases`}
      pad={false}
      actions={
        <label className="flex items-center gap-1.5 text-[11px] text-ink-3">Status
          <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="!h-6 !w-auto !text-[11px]">
            <option value="ALL">All</option>
            {Object.entries(CASE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </label>
      }
    >
      <DataTable<CaseRow>
        rows={rows}
        rowKey={(r) => r.id}
        onRow={setSelected}
        maxH="480px"
        empty={status === "ALL" ? "No officer cases yet. A case opens when a static scale confirms an overload." : "No cases with this status among the latest 40."}
        cols={[
          { key: "at", label: "Opened", mono: true, render: (r) => fmtDateTime(asSim(r.created_at)) },
          { key: "plate", label: "Truck", mono: true, render: (r) => r.plate },
          { key: "site", label: "Site", render: (r) => siteName(r.site) },
          { key: "measured", label: "Measured", align: "right", mono: true, render: (r) => fmtKg(r.measured_gross_kg) },
          { key: "limit", label: "Limit", align: "right", mono: true, render: (r) => fmtKg(r.limit_kg) },
          { key: "over", label: "Overload", align: "right", mono: true, render: (r) => fmtKg(r.overload_kg) },
          { key: "sealed", label: "Sealed transit", render: (r) => (r.sealed_transit ? <Badge tone="wait">Sealed</Badge> : <span className="text-ink-3">No</span>) },
          { key: "status", label: "Status", render: (r) => <CaseStatus value={r.status} /> },
          { key: "ro", label: "Release order", mono: true, render: (r) => r.release_order || "-" },
        ]}
      />
      <Drawer open={!!current} onClose={() => setSelected(null)} title={current ? `Case ${current.id}` : ""}>
        {current && <CaseDetail key={current.id} initial={current} legal={legal} refresh={refresh} />}
      </Drawer>
    </Panel>
  );
}

function CaseDetail({ initial, legal, refresh }: { initial: CaseRow; legal: string; refresh: () => void }) {
  const { can } = useAuth();
  const [decided, setDecided] = useState<CaseRow | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const c = decided ?? initial;
  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "reject");
    setError(null);
    try {
      setDecided(await api<CaseRow>(`/cases/${encodeURIComponent(c.id)}/decide`, { body: { approve, note: note.trim() || null } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="border border-accent/40 bg-accent/10 text-ink text-[11.5px] rounded-sm px-3 py-2">{legal}</div>
      <div className="flex items-center gap-2 flex-wrap"><CaseStatus value={c.status} />{c.sealed_transit && <Badge tone="wait">Sealed transit: a customs officer must attend</Badge>}</div>
      <KV
        items={[
          ["Truck", <PlateLink key="p" plate={c.plate} />],
          ["Site", siteName(c.site)],
          ["Measured gross", <span key="m" className="num">{fmtKg(c.measured_gross_kg)}</span>],
          ["Limit", <span key="l" className="num">{fmtKg(c.limit_kg)}</span>],
          ["Overload", <span key="o" className="num">{fmtKg(c.overload_kg)}</span>],
          ["Fee (illustrative)", <span key="f"><span className="num">{c.fee_usd === null ? "-" : `USD ${fmtNum(c.fee_usd, 0)}`}</span><span className="block text-[10.5px] text-ink-3">{c.fee_note}</span></span>],
          ["Opened", <span key="a" className="num">{fmtDateTime(asSim(c.created_at))}</span>],
          ["Sealed transit", c.sealed_transit ? "Yes" : "No"],
        ]}
      />
      <div><div className="text-[10.5px] text-ink-3">Reason</div><p className="text-[12px] text-ink mt-0.5">{c.reason}</p></div>
      {c.status !== "PENDING" && (
        <div className="border border-line bg-bg-2 rounded-sm p-3">
          <KV
            items={[
              ["Decided by", c.officer],
              ["Decided at", c.decided_at ? <span key="d" className="num">{fmtDateTime(asSim(c.decided_at))}</span> : "-"],
              ["Release order", c.release_order ? <span key="r" className="num">{c.release_order}</span> : "None issued"],
              ["Signature", c.signed ? <Badge key="s" tone="go">Signed with the site key</Badge> : <Badge key="s" tone={c.status === "AUTO_DEMO" ? "muted" : "wait"}>{c.status === "AUTO_DEMO" ? "Demo record, not signed" : "Not signed"}</Badge>],
            ]}
          />
          {c.truck_released !== undefined && <p className="text-[11.5px] text-ink-2 mt-2">{c.truck_released ? "The held truck was released in the live simulation." : "No truck is held for this case in the live simulation, so nothing was released."}</p>}
        </div>
      )}
      {error && <ErrorBox text={error} />}
      {c.status === "PENDING" && (
        can("case.decide") ? (
          <div className="flex flex-col gap-2">
            <Field label="Officer note (optional)" hint={`${note.length}/500 characters. Stored with the decision and in the audit log.`}>
              <textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={textareaCls} />
            </Field>
            <div className="flex gap-2">
              <Button variant="primary" loading={busy === "approve"} disabled={!!busy} onClick={() => decide(true)}>Approve and issue release order</Button>
              <Button variant="danger" loading={busy === "reject"} disabled={!!busy} onClick={() => decide(false)}>Reject</Button>
            </div>
          </div>
        ) : <p className="text-[11.5px] text-ink-3">Your role does not include case.decide, so this case is read only.</p>
      )}
    </div>
  );
}

function CalibrationTab({ rows, refresh }: { rows: CalRow[]; refresh: () => void }) {
  const { can } = useAuth();
  const blank = { site: "mariakani", device: "", calibrator: "", certificate_no: "", result: "PASS" };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CalRow | null>(null);
  const overdue = rows.filter((r) => r.overdue).length;
  const valid = form.device.trim().length >= 2 && form.calibrator.trim().length >= 2 && form.certificate_no.trim().length >= 2;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone(await api<CalRow>("/calibration", { body: { ...form, device: form.device.trim(), calibrator: form.calibrator.trim(), certificate_no: form.certificate_no.trim() } }));
      setForm(blank);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-2 xl:grid-cols-[1fr_300px]">
      <Panel title="Calibration records" sub={`${overdue} overdue of ${rows.length}, soonest due first`} pad={false}><CalibrationTable rows={rows} maxH="480px" /></Panel>
      <Panel title="Record a calibration">
        {can("calibration.edit") ? (
          <form onSubmit={submit} className="flex flex-col gap-2">
            <Field label="Site"><Select value={form.site} onChange={(e) => setForm({ ...form, site: e.target.value })}>{Object.entries(SITE_SHORT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Device"><Input value={form.device} maxLength={60} onChange={(e) => setForm({ ...form, device: e.target.value })} placeholder="Lane scale 1" /></Field>
            <Field label="Calibrator"><Input value={form.calibrator} maxLength={120} onChange={(e) => setForm({ ...form, calibrator: e.target.value })} /></Field>
            <Field label="Certificate number"><Input value={form.certificate_no} maxLength={40} onChange={(e) => setForm({ ...form, certificate_no: e.target.value })} /></Field>
            <Field label="Result"><Select value={form.result} onChange={(e) => setForm({ ...form, result: e.target.value })}><option value="PASS">Pass</option><option value="FAIL">Fail</option></Select></Field>
            {error && <ErrorBox text={error} />}
            {done && <div className="text-[11.5px] text-ink-2">Saved {done.certificate_no} for {siteName(done.site)}. Next due {fmtDateTime(asUtc(done.due_at))}.</div>}
            <Button type="submit" variant="primary" loading={busy} disabled={!valid}>Save record</Button>
            <p className="text-[10.5px] text-ink-3">Dated now and due again in 91 days. A pass clears simulated sensor drift at the site and, at an origin node, restores calibration validity.</p>
          </form>
        ) : <p className="text-[12px] text-ink-3">Your role does not include calibration.edit.</p>}
      </Panel>
    </div>
  );
}

function DisputesTab() {
  const { can } = useAuth();
  const q = useApi<{ items: DisputeRow[] }>("/disputes", 8000);
  const [selected, setSelected] = useState<DisputeRow | null>(null);
  if (!q.data) return <Fetching error={q.error} text="Loading disputes" />;
  const open = q.data.items.filter((d) => d.status === "OPEN").length;
  return (
    <Panel title="Disputes" sub={`${open} open of ${q.data.items.length}`} pad={false}>
      <StaleNote error={q.error} />
      <DataTable<DisputeRow>
        rows={q.data.items}
        rowKey={(r) => r.id}
        onRow={setSelected}
        maxH="480px"
        empty="No disputes filed. Transporters file them from their portal."
        cols={[
          { key: "at", label: "Filed", mono: true, render: (r) => fmtDateTime(asUtc(r.created_at)) },
          { key: "plate", label: "Truck", mono: true, render: (r) => r.plate },
          { key: "event", label: "Event", mono: true, render: (r) => r.event_id || "-" },
          { key: "reason", label: "Reason", render: (r) => <span className="text-ink-2 text-[11.5px] line-clamp-1" title={r.reason}>{r.reason}</span> },
          { key: "status", label: "Status", render: (r) => <Badge tone={r.status === "OPEN" ? "wait" : "muted"}>{r.status}</Badge> },
          { key: "by", label: "Resolved by", render: (r) => r.resolved_by || "-" },
        ]}
      />
      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected ? `Dispute ${selected.id}` : ""}>
        {selected && <DisputeDetail key={selected.id} initial={selected} canResolve={can("dispute.resolve")} refresh={q.refresh} />}
      </Drawer>
    </Panel>
  );
}

function DisputeDetail({ initial, canResolve, refresh }: { initial: DisputeRow; canResolve: boolean; refresh: () => void }) {
  const [d, setD] = useState(initial);
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (status: "UPHELD" | "REJECTED") => {
    setBusy(status);
    setError(null);
    try {
      setD(await api<DisputeRow>(`/disputes/${d.id}/resolve`, { body: { status, resolution: resolution.trim() } }));
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <KV items={[["Truck", <PlateLink key="p" plate={d.plate} />], ["Status", <Badge key="s" tone={d.status === "OPEN" ? "wait" : "muted"}>{d.status}</Badge>], ["Filed", <span key="f" className="num">{fmtDateTime(asUtc(d.created_at))}</span>], ["Event", d.event_id ? <span key="e" className="num">{d.event_id}</span> : "None linked"]]} />
      <div><div className="text-[10.5px] text-ink-3">Reason</div><p className="text-[12px] text-ink mt-0.5 whitespace-pre-wrap">{d.reason}</p></div>
      {d.resolution && <div><div className="text-[10.5px] text-ink-3">Resolution by {d.resolved_by}</div><p className="text-[12px] text-ink mt-0.5 whitespace-pre-wrap">{d.resolution}</p></div>}
      {error && <ErrorBox text={error} />}
      {d.status === "OPEN" && (canResolve ? (
        <div className="flex flex-col gap-2">
          <Field label="Resolution" hint="At least 3 characters. Stored with the dispute; the action is written to the audit log.">
            <textarea rows={4} maxLength={2000} value={resolution} onChange={(e) => setResolution(e.target.value)} className={textareaCls} />
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" loading={busy === "UPHELD"} disabled={!!busy || resolution.trim().length < 3} onClick={() => resolve("UPHELD")}>Uphold</Button>
            <Button variant="danger" loading={busy === "REJECTED"} disabled={!!busy || resolution.trim().length < 3} onClick={() => resolve("REJECTED")}>Reject</Button>
          </div>
        </div>
      ) : <p className="text-[11.5px] text-ink-3">Your role does not include dispute.resolve.</p>)}
      {d.status !== "OPEN" && <Flag ok={d.status === "UPHELD"} yes="Upheld: the transporter's claim was accepted" no="Rejected: the original record stands" />}
    </div>
  );
}
