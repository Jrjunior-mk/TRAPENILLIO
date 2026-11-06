"use client";
import { ArrowLeft, Box } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { actionLabel, type ClearanceEvent, EventDrawer, tokenHref } from "@/components/clearance-bits";
import { PageTitle } from "@/components/shell";
import { Badge, DataTable, Empty, ErrorBox, KV, Loading, Note, Outcome, Panel, Provenance, TokenStatus } from "@/components/ui";
import { useApi } from "@/lib/api";
import { fmtDateTime, fmtInt, fmtKg, fmtNum, fmtPct, fmtTime, siteName } from "@/lib/format";

interface Group { kind: string; axles: number; limit_kg: number }
interface TokenRow { token_id: string; status: string; status_reason: string | null; source: string; trust_tier: number; origin_station: string; gross_kg: number; issued_at: string; valid_until: string; container_number: string | null }
interface Profile {
  vehicle: {
    plate: string; trailer: string | null; rfid: string | null; config: string; tractor_tare: number; trailer_tare: number; height: number; width: number; length: number; fleet: string | null; permit: string | null; demerits: number; enrolled: boolean; driver_ref: string | null; driver_name?: string | null;
    mock_ntsa: { registration_valid: boolean; insurance_valid: boolean; roadworthy: boolean };
  };
  gross_limit_kg: number;
  groups: Group[];
  events: ClearanceEvent[];
  tokens: TokenRow[];
  live_truck: string | null;
}

const GROUP_LABEL: Record<string, string> = { steer: "Steering axle", single: "Single axle", tandem: "Tandem group", tridem: "Tridem group" };

const Flag = ({ ok, yes, no }: { ok: boolean; yes: string; no: string }) => <Badge tone={ok ? "go" : "stop"}>{ok ? yes : no}</Badge>;

function AxleReport({ event, groups, config, grossLimit }: { event: ClearanceEvent; groups: Group[]; config: string; grossLimit: number }) {
  const axles = event.axle_loads_kg ?? [];
  const parts = config.split("-").map(Number);
  const complete = axles.length === parts.reduce((a, b) => a + b, 0);
  let cursor = 0;
  const rows = complete
    ? groups.map((g, i) => {
        const slice = axles.slice(cursor, cursor + parts[i]);
        cursor += parts[i];
        return { label: GROUP_LABEL[g.kind] || g.kind, axles: slice, load: slice.reduce((a, b) => a + b, 0), limit: g.limit_kg };
      })
    : [];
  const gross = axles.reduce((a, b) => a + b, 0);
  const all = [...rows, { label: "Gross", axles: [] as number[], load: event.gross_kg ?? gross, limit: grossLimit }];
  return (
    <div>
      <div className="text-[11px] text-ink-3 mb-2">
        From {event.stage} at {siteName(event.site)}, <span className="num">{fmtDateTime(event.at)}</span>. The tick on each bar marks the limit.
      </div>
      {!complete && <div className="mb-2"><Note>This reading has {axles.length} axle loads for a {config} vehicle, so only gross is compared. Axle values: <span className="num">{axles.map((a) => fmtInt(a)).join(", ")}</span> kg.</Note></div>}
      <ul className="space-y-2.5">
        {all.map((r) => {
          const ratio = r.limit ? r.load / r.limit : 0;
          const scale = Math.max(1.15, ratio * 1.03);
          const state = ratio > 1 ? { text: "Over limit", cls: "text-stop", bg: "var(--color-stop)" } : ratio > 0.95 ? { text: "Near limit", cls: "text-wait", bg: "var(--color-wait)" } : { text: "Within limit", cls: "text-go", bg: "var(--color-go)" };
          return (
            <li key={r.label}>
              <div className="flex items-baseline gap-2 text-[11.5px] mb-1">
                <span className="text-ink">{r.label}</span>
                {r.axles.length > 1 && <span className="num text-[10.5px] text-ink-3">{r.axles.map((a) => fmtInt(a)).join(" + ")}</span>}
                <span className="ml-auto num text-ink-2">{fmtInt(r.load)} of {fmtInt(r.limit)} kg ({fmtPct(ratio * 100, 0)})</span>
                <span className={`text-[10.5px] font-medium w-[68px] text-right ${state.cls}`}>{state.text}</span>
              </div>
              <div className="relative h-2 bg-line rounded-sm" role="img" aria-label={`${r.label}: ${fmtInt(r.load)} kg against a limit of ${fmtInt(r.limit)} kg, ${state.text}`}>
                <div className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${(ratio / scale) * 100}%`, background: state.bg }} />
                <div className="absolute -top-0.5 -bottom-0.5 w-px bg-ink" style={{ left: `${(1 / scale) * 100}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      <div className="text-[10.5px] text-ink-3 mt-2">An operator entry without axle loads is spread across groups in proportion to their limits, so it adds no axle evidence beyond the gross. Limits are demo policy values and must be re-verified.</div>
    </div>
  );
}

function TruckInner() {
  const params = useParams<{ plate: string }>();
  const router = useRouter();
  const plate = useMemo(() => {
    const raw = params?.plate ?? "";
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }, [params]);
  const { data, error, loading } = useApi<Profile>(plate ? `/trucks/${encodeURIComponent(plate)}` : null, 10000);
  const [event, setEvent] = useState<ClearanceEvent | null>(null);

  const back = <Link href="/clearance?tab=fleet" className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"><ArrowLeft size={12} />Registered fleet</Link>;
  if (!data && loading) return <Loading text={`Loading ${plate}`} />;
  if (!data) return (
    <div className="p-3 space-y-2">
      <PageTitle title={plate} actions={back} />
      <ErrorBox text={error || "This vehicle could not be loaded."} />
    </div>
  );

  const v = data.vehicle;
  const latest = data.events.find((e) => e.axle_loads_kg && e.axle_loads_kg.length > 0) ?? null;
  return (
    <div className="p-3">
      <PageTitle
        title={v.plate}
        sub={`${v.trailer ? `Trailer ${v.trailer}, ` : "No trailer, "}axle configuration ${v.config}, ${v.fleet || "no fleet"}.`}
        actions={
          <>
            <Provenance kind="DEMO DATA" title="Synthetic vehicle record" />
            {data.live_truck && <Link href={`/twin?truck=${encodeURIComponent(data.live_truck)}`} className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"><Box size={12} />Watch on the twin</Link>}
            <Link href={`/clearance?tab=road&plate=${encodeURIComponent(v.plate)}`} className="text-[12px] text-accent hover:underline">Process this truck</Link>
            {back}
          </>
        }
      />
      {error && <div className="mb-2"><ErrorBox text={`Refresh failed, showing the last result: ${error}`} /></div>}
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4 mb-2">
        <Panel title="Identity">
          <KV
            items={[
              ["Tractor plate", <span key="p" className="num">{v.plate}</span>],
              ["Trailer plate", <span key="t" className="num">{v.trailer || "None"}</span>],
              ["RFID tag", <span key="r" className="num break-all">{v.rfid || "None"}</span>],
              ["Enrolled", v.enrolled ? "Yes" : "No"],
              ["Fleet", v.fleet || "No fleet"],
              ["Demerit points", <span key="d" className="num">{v.demerits}</span>],
              ["Driver reference", <span key="f" className="num">{v.driver_ref || "-"}</span>],
              ["Driver name", "driver_name" in v ? v.driver_name || "Not recorded" : "Hidden for your role"],
            ]}
          />
        </Panel>
        <Panel title="Tare and dimensions">
          <KV
            items={[
              ["Tractor tare", <span key="a" className="num">{fmtKg(v.tractor_tare)}</span>],
              ["Trailer tare", <span key="b" className="num">{fmtKg(v.trailer_tare)}</span>],
              ["Combined tare", <span key="c" className="num">{fmtKg(v.tractor_tare + v.trailer_tare)}</span>],
              ["Height", <span key="h" className="num">{fmtNum(v.height, 2)} m</span>],
              ["Width", <span key="w" className="num">{fmtNum(v.width, 2)} m</span>],
              ["Length", <span key="l" className="num">{fmtNum(v.length, 1)} m</span>],
              ["Permit", <span key="m" className="num">{v.permit || "None on record"}</span>],
            ]}
          />
        </Panel>
        <Panel title="Vehicle records" tag={<Provenance kind="MOCK" title="Mock NTSA adapter. No agency system is connected." />}>
          <dl className="space-y-2">
            <div className="flex items-center justify-between gap-2"><dt className="text-[12px] text-ink-2">Registration</dt><dd><Flag ok={v.mock_ntsa.registration_valid} yes="Valid" no="Invalid" /></dd></div>
            <div className="flex items-center justify-between gap-2"><dt className="text-[12px] text-ink-2">Insurance</dt><dd><Flag ok={v.mock_ntsa.insurance_valid} yes="Valid" no="Invalid" /></dd></div>
            <div className="flex items-center justify-between gap-2"><dt className="text-[12px] text-ink-2">Roadworthiness</dt><dd><Flag ok={v.mock_ntsa.roadworthy} yes="Valid" no="Invalid" /></dd></div>
          </dl>
          <div className="text-[10.5px] text-ink-3 mt-2">Synthetic mock flags for the demo. They do not affect clearance decisions here.</div>
        </Panel>
        <Panel title="Axle group limits" sub={`Configuration ${v.config}`} tag={<Provenance kind="ASSUMED" title="Demo policy values that must be re-verified" />}>
          <ul className="divide-y divide-line/60">
            {data.groups.map((g, i) => (
              <li key={i} className="flex items-center justify-between py-1 text-[12px]">
                <span className="text-ink-2">{GROUP_LABEL[g.kind] || g.kind}{g.axles > 1 ? ` (${g.axles} axles)` : ""}</span>
                <span className="num text-ink">{fmtKg(g.limit_kg)}</span>
              </li>
            ))}
            <li className="flex items-center justify-between py-1 text-[12px] font-medium">
              <span className="text-ink">Gross limit</span>
              <span className="num text-ink">{fmtKg(data.gross_limit_kg)}</span>
            </li>
          </ul>
        </Panel>
      </div>

      <div className="grid gap-2 xl:grid-cols-2 mb-2">
        <Panel title="Axle-load report" sub="latest reading with axle loads">
          {latest ? <AxleReport event={latest} groups={data.groups} config={v.config} grossLimit={data.gross_limit_kg} /> : <Empty text="No clearance event with axle loads has been recorded for this truck yet." />}
        </Panel>
        <Panel title="Load Compliance Tokens" sub="latest 20" pad={false}>
          <DataTable<TokenRow>
            rows={data.tokens}
            rowKey={(r) => r.token_id}
            maxH="280px"
            empty="No tokens have been issued to this truck."
            onRow={(r) => router.push(tokenHref(r.token_id))}
            cols={[
              { key: "token_id", label: "Token", mono: true, render: (r) => <span className="text-ink">{r.token_id}</span> },
              { key: "status", label: "Status", render: (r) => <TokenStatus value={r.status} /> },
              { key: "source", label: "Source", render: (r) => <span className="text-ink-2">{r.source}</span> },
              { key: "station", label: "Station", render: (r) => <span className="text-ink-2">{siteName(r.origin_station)}</span> },
              { key: "gross", label: "Gross", align: "right", mono: true, render: (r) => fmtKg(r.gross_kg) },
              { key: "until", label: "Valid until", mono: true, render: (r) => fmtDateTime(r.valid_until) },
            ]}
          />
        </Panel>
      </div>

      <Panel title="Clearance history" sub="latest 40, select a row for the checks" pad={false}>
        <DataTable<ClearanceEvent>
          rows={data.events}
          rowKey={(r) => r.id}
          maxH="360px"
          empty="No clearance events have been recorded for this truck."
          onRow={setEvent}
          cols={[
            { key: "at", label: "Time", mono: true, render: (r) => <span title={fmtDateTime(r.at)}>{fmtTime(r.at)}</span> },
            { key: "site", label: "Site", render: (r) => siteName(r.site) },
            { key: "stage", label: "Stage", render: (r) => <span className="text-ink-2">{r.stage}</span> },
            { key: "gross", label: "Gross", align: "right", mono: true, render: (r) => fmtKg(r.gross_kg) },
            { key: "outcome", label: "Outcome", render: (r) => <Outcome value={r.outcome} /> },
            { key: "action", label: "Action", render: (r) => <span className="text-ink-2">{actionLabel(r.action)}</span> },
            { key: "risk", label: "Risk", align: "right", mono: true, render: (r) => fmtNum(r.risk, 1) },
            { key: "why", label: "Reason", render: (r) => <span className="text-ink-3 text-[11px] line-clamp-1" title={r.explanation}>{r.explanation}</span> },
          ]}
        />
      </Panel>
      <EventDrawer event={event} onClose={() => setEvent(null)} />
    </div>
  );
}

export default function TruckProfilePage() {
  return (
    <Suspense fallback={<Loading text="Loading truck" />}>
      <TruckInner />
    </Suspense>
  );
}
