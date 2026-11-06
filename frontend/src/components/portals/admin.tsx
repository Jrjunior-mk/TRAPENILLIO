"use client";
import { useEffect, useState } from "react";
import { Badge, Button, DataTable, ErrorBox, Field, Input, KV, Note, Panel } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtInt, fmtNum } from "@/lib/format";
import { Fetching, Flag, PortalFrame, StaleNote } from "./shared";

interface UserRow { id: number; username: string; display_name: string; role: string; role_label: string; org: string; active: boolean }
interface Health {
  database: string; mqtt: string; write_behind: { written: number; errors: number; last_error: string | null; queue: number }; bus: { published: number; by_kind: Record<string, number>; bridge: boolean; bridge_failures: number };
  conservation: { entered: number; exited: number; active: number; balanced: boolean }; audit_chain: { valid: boolean; checked: number; broken_at?: number } | null;
  system: { api_latency_p50_ms: number; api_latency_p95_ms: number; failed_requests: number; step_ms: number; queue_depth: number };
}
interface Retention { clearance_days: number; anonymize_plates_after_days: number; alert_days: number; audit_days: number }

export function AdminPortal() {
  return (
    <PortalFrame title="Administration" sub="Users, system health and data retention. Each panel asks the API separately, so a role may see some and be refused others.">
      <div className="grid gap-2 2xl:grid-cols-2 items-start">
        <UsersPanel />
        <div className="flex flex-col gap-2 min-w-0">
          <HealthPanel />
          <RetentionPanel />
        </div>
      </div>
    </PortalFrame>
  );
}

function UsersPanel() {
  const { me } = useAuth();
  const q = useApi<{ items: UserRow[]; roles: Record<string, string> }>("/admin/users");
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (u: UserRow) => {
    setBusy(u.id);
    setError(null);
    try {
      await api(`/admin/users/${u.id}/active`, { body: { active: !u.active } });
      await q.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel title="Users" sub={q.data ? `${q.data.items.filter((u) => u.active).length} active of ${q.data.items.length}` : undefined} pad={false}>
      {!q.data ? <div className="p-3"><Fetching error={q.error} text="Loading users" /></div> : (
        <>
          {error && <div className="p-2"><ErrorBox text={error} /></div>}
          <DataTable<UserRow>
            rows={q.data.items}
            rowKey={(r) => r.id}
            empty="No users."
            cols={[
              { key: "username", label: "Username", mono: true, render: (r) => r.username },
              { key: "name", label: "Name", render: (r) => r.display_name },
              { key: "role", label: "Role", render: (r) => <span className="text-ink-2">{r.role_label}</span> },
              { key: "org", label: "Organisation", render: (r) => <span className="text-ink-2">{r.org}</span> },
              { key: "active", label: "State", render: (r) => (r.active ? <Badge>Active</Badge> : <Badge tone="wait">Deactivated</Badge>) },
              { key: "do", label: "", align: "right", render: (r) => (r.id === me?.id ? <span className="text-[11px] text-ink-3">Signed in</span> : <Button size="sm" variant={r.active ? "danger" : "default"} loading={busy === r.id} disabled={busy !== null} onClick={() => toggle(r)}>{r.active ? "Deactivate" : "Activate"}</Button>) },
            ]}
          />
          <div className="p-3 border-t border-line">
            <div className="eyebrow mb-1.5">Roles</div>
            <div className="flex flex-wrap gap-1">{Object.values(q.data.roles).map((label) => <Badge key={label}>{label}</Badge>)}</div>
            <p className="text-[11px] text-ink-3 mt-2">The API lists role labels only. A deactivated user is refused on their next request, because every request checks the account state.</p>
          </div>
        </>
      )}
    </Panel>
  );
}

function HealthPanel() {
  const q = useApi<Health>("/admin/health", 5000);
  const h = q.data;
  return (
    <Panel title="System health" sub="this server, refreshes every 5 s">
      {!h ? <Fetching error={q.error} text="Loading health" /> : (
        <>
          <StaleNote error={q.error} />
          <KV
            cols={3}
            items={[
              ["Database", <span key="d" className="num">{h.database}</span>],
              ["MQTT", h.mqtt],
              ["Bridge failures", <span key="b" className="num">{fmtInt(h.bus.bridge_failures)}</span>],
              ["Event bus messages", <span key="p" className="num">{fmtInt(h.bus.published)}</span>],
              ["Write-behind written", <span key="w" className="num">{fmtInt(h.write_behind.written)}</span>],
              ["Write-behind queue", <span key="q" className="num">{fmtInt(h.write_behind.queue)}</span>],
              ["Write-behind errors", <span key="e" className={h.write_behind.errors ? "num text-stop" : "num"}>{fmtInt(h.write_behind.errors)}</span>],
              ["Simulation step", <span key="s" className="num">{fmtNum(h.system.step_ms, 1)} ms</span>],
              ["Failed lookups", <span key="f" className="num">{fmtInt(h.system.failed_requests)}</span>],
              ["Truck conservation", <span key="c"><Flag ok={h.conservation.balanced} yes="Balanced" no="Check failed" /><span className="num text-[11px] text-ink-3 ml-1.5">{fmtInt(h.conservation.entered)} in, {fmtInt(h.conservation.exited)} out, {fmtInt(h.conservation.active)} active</span></span>],
              ["Audit chain", h.audit_chain ? <span key="a"><Flag ok={h.audit_chain.valid} yes="Valid" no={`Broken at row ${h.audit_chain.broken_at}`} /><span className="num text-[11px] text-ink-3 ml-1.5">{fmtInt(h.audit_chain.checked)} checked</span></span> : <span key="a" className="text-ink-3">Needs audit.view</span>],
            ]}
          />
          {h.write_behind.last_error && <div className="mt-2"><ErrorBox text={`Last write-behind error: ${h.write_behind.last_error}`} /></div>}
          {Object.keys(h.bus.by_kind).length > 0 && (
            <div className="mt-3">
              <div className="eyebrow mb-1">Event bus by kind</div>
              <div className="flex flex-wrap gap-1">{Object.entries(h.bus.by_kind).map(([k, v]) => <Badge key={k}>{k}: <span className="num">{fmtInt(v)}</span></Badge>)}</div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

const RETENTION_FIELDS: { key: keyof Retention; label: string; hint: string; min: number }[] = [
  { key: "anonymize_plates_after_days", label: "Pseudonymize plates after (days)", hint: "Clearance event plates become a hash.", min: 1 },
  { key: "clearance_days", label: "Delete clearance events after (days)", hint: "Deleted by the run below.", min: 1 },
  { key: "alert_days", label: "Delete alerts after (days)", hint: "Deleted by the run below.", min: 1 },
  { key: "audit_days", label: "Keep audit log (days)", hint: "Stored only. The run does not delete audit rows, so the hash chain stays whole.", min: 30 },
];

function RetentionPanel() {
  const q = useApi<{ settings: Retention | null; note: string }>("/admin/retention");
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ran, setRan] = useState<{ anonymized: number; deleted_events: number; deleted_alerts: number } | null>(null);
  useEffect(() => {
    const s = q.data?.settings;
    if (s) setForm(Object.fromEntries(RETENTION_FIELDS.map((f) => [f.key, String(s[f.key] ?? "")])));
    else if (q.data) setForm(Object.fromEntries(RETENTION_FIELDS.map((f) => [f.key, ""])));
  }, [q.data]);
  const bad = (f: (typeof RETENTION_FIELDS)[number]) => {
    const v = Number(form?.[f.key]);
    return !Number.isInteger(v) || v < f.min || v > 3650;
  };
  const invalid = RETENTION_FIELDS.some(bad);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api("/admin/retention", { method: "PUT", body: Object.fromEntries(RETENTION_FIELDS.map((f) => [f.key, Number(form[f.key])])) });
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const run = async () => {
    setRunning(true);
    setConfirming(false);
    setError(null);
    try {
      setRan(await api("/admin/retention/run", { body: {} }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };
  return (
    <Panel title="Data retention" sub="measured against the simulated clock">
      {!q.data || !form ? <Fetching error={q.error} text="Loading retention settings" /> : (
        <div className="flex flex-col gap-3">
          <Note>{q.data.note}</Note>
          <form onSubmit={save} className="grid gap-2 md:grid-cols-2">
            {RETENTION_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint} error={bad(f) ? `Whole number from ${f.min} to 3650` : null}>
                <Input type="number" min={f.min} max={3650} value={form[f.key]} onChange={(e) => { setForm({ ...form, [f.key]: e.target.value }); setSaved(false); }} />
              </Field>
            ))}
            <div className="md:col-span-2 flex items-center gap-2 flex-wrap">
              <Button type="submit" variant="primary" loading={saving} disabled={invalid}>Save settings</Button>
              {saved && <span className="text-[11.5px] text-ink-2">Settings saved. They apply on the next run.</span>}
              <span className="ml-auto flex items-center gap-2">
                {confirming ? (
                  <>
                    <span className="text-[11.5px] text-wait">This pseudonymizes and deletes records and cannot be undone.</span>
                    <Button type="button" variant="danger" onClick={run}>Confirm run</Button>
                    <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
                  </>
                ) : <Button type="button" loading={running} onClick={() => setConfirming(true)}>Run retention now</Button>}
              </span>
            </div>
          </form>
          {error && <ErrorBox text={error} />}
          {ran && <div className="text-[11.5px] text-ink-2 num">Run finished: {fmtInt(ran.anonymized)} plates pseudonymized, {fmtInt(ran.deleted_events)} clearance events deleted, {fmtInt(ran.deleted_alerts)} alerts deleted.</div>}
        </div>
      )}
    </Panel>
  );
}
