"use client";
import { Boxes } from "lucide-react";
import { useState } from "react";
import { Button, ErrorBox, Field, Input, Note } from "@/components/ui";
import { api } from "@/lib/api";

const DEMO = [
  ["admin", "RCS administrator"],
  ["kenha", "KeNHA officer"],
  ["kpa", "KPA gate operator"],
  ["kra", "KRA customs officer"],
  ["ntsa", "NTSA records officer"],
  ["transporter", "Transporter"],
  ["loader", "Loading-site operator"],
  ["viewer", "Observer"],
];
const PW = "rcs-demo-2026";

export default function LoginPage() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (u: string, p: string) => {
    setBusy(true);
    setError(null);
    try {
      await api("/auth/login", { body: { username: u, password: p } });
      window.location.href = "/";
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="min-h-screen app-bg flex items-center justify-center p-4">
      <div className="w-full max-w-[860px] grid md:grid-cols-[1.1fr_1fr] border border-line rounded-md overflow-hidden bg-panel">
        <div className="p-7 border-b md:border-b-0 md:border-r border-line bg-bg-2">
          <div className="flex items-center gap-2.5">
            <Boxes size={22} className="text-accent" />
            <div className="font-bold tracking-[0.14em] text-[15px]">RCS COMMAND</div>
          </div>
          <div className="text-[13px] text-ink-2 mt-1">Intelligent Freight Clearance and Digital Twin</div>
          <p className="text-[21px] leading-[1.25] font-medium mt-8 text-ink">Measure once.<br />Verify everywhere.<br />Keep freight moving.</p>
          <div className="mt-8">
            <Note>
              Demonstration system. Traffic, sensors and results are simulated from assumptions in the two RCS documents. Agency connections are labelled mocks. Nothing here is an approved operating system or a regulatory decision.
            </Note>
          </div>
        </div>
        <div className="p-7">
          <form onSubmit={(e) => { e.preventDefault(); submit(username, password); }} className="space-y-3">
            <h1 className="text-[15px] font-semibold">Sign in</h1>
            <Field label="Username"><Input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
            <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            {error && <ErrorBox text={error} />}
            <Button variant="primary" className="w-full" loading={busy} type="submit">Sign in</Button>
          </form>
          <div className="mt-5">
            <div className="eyebrow mb-1.5">Demo roles (password {PW})</div>
            <div className="grid grid-cols-2 gap-1">
              {DEMO.map(([u, label]) => (
                <button key={u} disabled={busy} onClick={() => submit(u, PW)} className="text-left px-2 py-1.5 border border-line rounded-sm hover:border-line-2 hover:bg-panel-2 cursor-pointer disabled:opacity-50">
                  <div className="text-[11.5px] text-ink">{label}</div>
                  <div className="text-[10px] text-ink-3 num">{u}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
