"use client";
import { RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { asSim, asUtc, Fetching, StaleNote, useTabParam } from "@/components/portals/shared";
import { PageTitle } from "@/components/shell";
import { Badge, Button, DataTable, ErrorBox, Field, Input, Kpi, KV, Loading, Panel, Select, Tabs } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtDateTime, fmtInt, siteName } from "@/lib/format";

const KINDS = ["overload", "token_mismatch", "identity", "sensor", "sensor_drift", "calibration", "network", "suspicious_fleet", "token", "system"];
const SEVERITIES = ["critical", "warning", "info"];
const ACTION_PREFIXES = ["alert", "auth", "calibration", "case", "clearance", "dispute", "fault", "lane", "live", "policy", "retention", "scenario", "sim", "site", "truck", "user"];
const sevTone = (s: string) => (s === "critical" ? "stop" : s === "warning" ? "wait" : "accent") as "stop" | "wait" | "accent";

interface AlertRow { id: number; at: string; severity: string; kind: string; site: string | null; title: string; detail: string | null; ack_by: string | null; ack_at: string | null }
interface AuditRow { id: number; at: string; actor: string; role: string; action: string; target: string | null; detail: unknown; hash: string }
interface Chain { valid: boolean; checked: number; broken_at?: number; head?: string }

function AlertsTab() {
  const { can } = useAuth();
  const [severity, setSeverity] = useState("");
  const [kind, setKind] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  const params = new URLSearchParams({ limit: "150" });
  if (severity) params.set("severity", severity);
  if (kind) params.set("kind", kind);
  if (openOnly) params.set("open_only", "true");
  const q = useApi<{ items: AlertRow[]; open_counts: Record<string, number> }>(`/alerts?${params}`, 4000);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ack = async (id: number) => {
    setBusy(id);
    setError(null);
    try {
      await api(`/alerts/${id}/ack`, { body: {} });
      await q.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const counts = q.data?.open_counts ?? {};
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 grid-cols-3">
        <Kpi label="Open critical" value={fmtInt(counts.critical ?? 0)} tone={counts.critical ? "stop" : undefined} icon={ShieldAlert} sub="All kinds, unacknowledged" />
        <Kpi label="Open warning" value={fmtInt(counts.warning ?? 0)} tone={counts.warning ? "wait" : undefined} icon={ShieldAlert} sub="All kinds, unacknowledged" />
        <Kpi label="Open information" value={fmtInt(counts.info ?? 0)} tone={counts.info ? "accent" : undefined} icon={ShieldAlert} sub="All kinds, unacknowledged" />
      </div>
      <Panel
        title="Alerts"
        sub="refreshes every 4 s, up to 150 rows"
        pad={false}
        actions={
          <div className="flex items-center gap-2">
            <Select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)} className="!h-6 !w-28 !text-[11px]">
              <option value="">All severities</option>
              {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
            <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} className="!h-6 !w-36 !text-[11px]">
              <option value="">All kinds</option>
              {KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
            </Select>
            <label className="flex items-center gap-1.5 text-[11px] text-ink-2 cursor-pointer whitespace-nowrap"><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} className="accent-[#38bdf8]" />Open only</label>
          </div>
        }
      >
        {error && <div className="p-2"><ErrorBox text={error} /></div>}
        {!q.data ? <div className="p-3"><Fetching error={q.error} text="Loading alerts" /></div> : (
          <>
            <div className="px-3 pt-2 empty:hidden"><StaleNote error={q.error} /></div>
            <DataTable<AlertRow>
              rows={q.data.items}
              rowKey={(r) => r.id}
              maxH="600px"
              empty={openOnly ? "No open alerts match these filters." : "No alerts match these filters."}
              cols={[
                { key: "at", label: "Time", mono: true, render: (r) => fmtDateTime(asSim(r.at)) },
                { key: "severity", label: "Severity", render: (r) => <Badge tone={sevTone(r.severity)}>{r.severity}</Badge> },
                { key: "kind", label: "Kind", render: (r) => <span className="text-ink-2">{r.kind.replace(/_/g, " ")}</span> },
                { key: "site", label: "Site", render: (r) => siteName(r.site) },
                { key: "title", label: "Alert", render: (r) => <div className="min-w-0"><div className="text-ink">{r.title}</div>{r.detail && <div className="text-[11px] text-ink-3 line-clamp-1" title={r.detail}>{r.detail}</div>}</div> },
                {
                  key: "ack",
                  label: "Acknowledged",
                  render: (r) =>
                    r.ack_at ? <span className="text-[11px] text-ink-3" title={fmtDateTime(asUtc(r.ack_at))}>{r.ack_by}</span>
                    : can("alert.ack") ? <Button size="sm" loading={busy === r.id} disabled={busy !== null} onClick={() => ack(r.id)}>Acknowledge</Button>
                    : <span className="text-[11px] text-ink-3" title="Your role does not include alert.ack">Open</span>,
                },
              ]}
            />
          </>
        )}
      </Panel>
    </div>
  );
}

function ChainStatus({ chain }: { chain: Chain }) {
  const I = chain.valid ? ShieldCheck : ShieldAlert;
  return (
    <div className={chain.valid ? "border border-go/40 bg-go/10 rounded-sm px-3 py-2" : "border border-stop/40 bg-stop/10 rounded-sm px-3 py-2"}>
      <div className={chain.valid ? "flex items-center gap-2 text-go font-semibold text-[13px]" : "flex items-center gap-2 text-stop font-semibold text-[13px]"}>
        <I size={15} />
        {chain.valid ? `Audit chain valid: ${fmtInt(chain.checked)} entries checked` : `Audit chain broken at row ${chain.broken_at}: ${fmtInt(chain.checked)} entries were valid before it`}
      </div>
      <p className="text-[11.5px] text-ink-2 mt-1">Each entry stores a SHA-256 hash over its own fields and the previous entry&apos;s hash, so changing or removing a stored row breaks the chain from that row onward. The check runs across the whole log, not only the rows shown.</p>
    </div>
  );
}

function AuditTab() {
  const [text, setText] = useState("");
  const [prefix, setPrefix] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setPrefix(text.trim()), 300);
    return () => clearTimeout(id);
  }, [text]);
  const q = useApi<{ items: AuditRow[]; chain: Chain }>(`/audit?limit=200${prefix ? `&action=${encodeURIComponent(prefix)}` : ""}`, 15000);
  if (!q.data) return <Fetching error={q.error} text="Loading the audit log" />;
  return (
    <div className="flex flex-col gap-2">
      <ChainStatus chain={q.data.chain} />
      <Panel
        title="Audit log"
        sub="newest first, up to 200 rows"
        pad={false}
        actions={
          <div className="flex items-center gap-2">
            <Input aria-label="Filter by action prefix" list="audit-prefixes" value={text} onChange={(e) => setText(e.target.value)} placeholder="Action prefix, for example case" className="!h-6 !w-56 !text-[11px]" />
            <datalist id="audit-prefixes">{ACTION_PREFIXES.map((p) => <option key={p} value={p} />)}</datalist>
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => q.refresh()}>Refresh</Button>
          </div>
        }
      >
        <div className="px-3 pt-2 empty:hidden"><StaleNote error={q.error} /></div>
        <DataTable<AuditRow>
          rows={q.data.items}
          rowKey={(r) => r.id}
          maxH="560px"
          empty={prefix ? `No audit entry has an action starting with "${prefix}".` : "No audit entries yet."}
          cols={[
            { key: "at", label: "Time", mono: true, render: (r) => fmtDateTime(asUtc(r.at)) },
            { key: "actor", label: "Actor", render: (r) => r.actor },
            { key: "role", label: "Role", render: (r) => <span className="text-ink-2">{r.role}</span> },
            { key: "action", label: "Action", mono: true, render: (r) => r.action },
            { key: "target", label: "Target", mono: true, render: (r) => r.target || "-" },
            { key: "detail", label: "Detail", render: (r) => { const s = r.detail ? JSON.stringify(r.detail) : "-"; return <span className="num text-[11px] text-ink-3 line-clamp-1 break-all" title={s}>{s}</span>; } },
            { key: "hash", label: "Hash prefix", mono: true, render: (r) => <span className="text-ink-3">{r.hash}</span> },
          ]}
        />
      </Panel>
    </div>
  );
}

function SecurityPanel() {
  const { me } = useAuth();
  return (
    <Panel title="Security" sub="this session">
      {!me ? <Loading text="Loading your session" /> : (
        <div className="flex flex-col gap-3">
          <KV items={[["Signed in as", me.display_name], ["Role", me.role_label]]} />
          <div>
            <div className="eyebrow mb-1">Permissions</div>
            {me.permissions.length ? <div className="flex flex-wrap gap-1">{me.permissions.map((p) => <Badge key={p}><span className="num">{p}</span></Badge>)}</div> : <p className="text-[11.5px] text-ink-3">This role holds no named permissions.</p>}
          </div>
          <div>
            <div className="eyebrow mb-1">How the system protects data</div>
            <dl className="text-[11.5px] flex flex-col gap-1.5">
              {[
                ["Session", "HttpOnly, SameSite=Lax cookie tied to a server-side session row. The database holds only a SHA-256 of the session token."],
                ["Passwords", "Stored as salted scrypt hashes."],
                ["Field encryption", "Personal fields such as driver names use Fernet."],
                ["Signed records", "Tokens and clearance records carry Ed25519 signatures from the issuing site's key."],
              ].map(([k, v]) => <div key={k}><dt className="text-ink">{k}</dt><dd className="text-ink-3">{v}</dd></div>)}
            </dl>
          </div>
          <p className="text-[11.5px] text-wait border-t border-line pt-2">Design goal: Kenya Data Protection Act, 2019. Not a compliance certification.</p>
        </div>
      )}
    </Panel>
  );
}

function AlertsAudit() {
  const { can } = useAuth();
  const [tab, setTab] = useTabParam("alerts");
  return (
    <div className="p-3">
      <PageTitle title="Alerts, audit and security" sub="Operational alerts from the simulated corridor, the tamper-evident audit log and the controls behind your session." />
      <div className="grid gap-2 xl:grid-cols-[1fr_300px] items-start">
        <div className="min-w-0">
          {can("audit.view") && <Tabs tabs={[{ id: "alerts", label: "Alerts" }, { id: "audit", label: "Audit log" }]} value={tab} onChange={setTab} />}
          <div className="mt-2">{tab === "audit" && can("audit.view") ? <AuditTab /> : <AlertsTab />}</div>
        </div>
        <SecurityPanel />
      </div>
    </div>
  );
}

export default function AlertsPage() {
  return (
    <Suspense fallback={<div className="p-3"><Loading /></div>}>
      <AlertsAudit />
    </Suspense>
  );
}
