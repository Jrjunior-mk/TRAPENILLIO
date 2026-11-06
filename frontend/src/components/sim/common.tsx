"use client";
import { type ReactNode } from "react";
import { Badge, ErrorBox, Meter, Select } from "@/components/ui";
import { useApi } from "@/lib/api";

export type Config = Record<string, any>;

/** Everything the tabs share: the draft configuration and the permissions of the signed-in user. */
export interface SimCtx {
  /** The draft. Experiments run on it. It reaches the live twin only through "Apply to live twin". */
  config: Config | null;
  /** The configuration the live twin is running. */
  live: Config | null;
  provenance: Record<string, string>;
  patch: (p: Config) => void;
  refresh: () => void;
  error: string | null;
  canRun: boolean;
  canControl: boolean;
  canFault: boolean;
  l1: Config;
  setL1: (u: (p: Config) => Config) => void;
}

export interface OpenRequest { id: string; n: number }

export const STATION_OPTIONS = [
  { id: "dongo_kundu", label: "Dongo Kundu" },
  { id: "mariakani", label: "Mariakani" },
  { id: "mtwapa", label: "Mtwapa" },
];

export const NO_RUN = "Your role cannot run simulations.";
export const NO_CONTROL = "Your role cannot control the live twin.";
export const NO_FAULT = "Your role cannot inject faults.";

export const statusTone = (s?: string) => (s === "DONE" ? "go" : s === "FAILED" ? "stop" : "accent") as "go" | "stop" | "accent";

export const clockLabel = (i: number, stepMin: number) => {
  const m = Math.round(i * stepMin);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

export const ExportLinks = ({ id }: { id: string }) => (
  <span className="inline-flex gap-2 text-[11px]">
    <a className="text-accent hover:underline" href={`/api/sim/experiments/${id}/export.csv`}>CSV</a>
    <a className="text-accent hover:underline" href={`/api/sim/experiments/${id}/export.pdf`}>PDF</a>
  </span>
);

/** Progress, status and exports for a backend experiment. Renders nothing before the first run. */
export function JobStatus({ job, error }: { job: any; error?: string | null }) {
  if (!job && !error) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {job && (
        <div className="flex items-center gap-2 min-w-0">
          <Badge tone={statusTone(job.status)}>{job.status === "DONE" ? "Finished" : job.status === "FAILED" ? "Failed" : "Running"}</Badge>
          <div className="flex-1 min-w-[60px]"><Meter value={job.status === "DONE" ? 1 : job.progress || 0} tone="var(--color-accent)" /></div>
          <span className="num text-[11px] text-ink-2 w-9 text-right">{Math.round((job.status === "DONE" ? 1 : job.progress || 0) * 100)}%</span>
          {job.status === "DONE" && job.id && <ExportLinks id={job.id} />}
        </div>
      )}
      {job?.message && job.status === "RUNNING" && <div className="text-[11px] text-ink-3 truncate">{job.message}</div>}
      {error && <ErrorBox text={error} />}
    </div>
  );
}

export function useScenarios() {
  const { data, error } = useApi<{ scenarios: { id: string; label: string; note: string }[]; metrics: string[] }>("/sim/l2/scenarios");
  return { scenarios: data?.scenarios ?? [], error };
}

export function ScenarioSelect({ value, onChange, scenarios }: { value: string; onChange: (v: string) => void; scenarios: { id: string; label: string }[] }) {
  return (
    <Select aria-label="Scenario" value={value} onChange={(e) => onChange(e.target.value)}>
      {!scenarios.some((s) => s.id === value) && <option value={value}>{value}</option>}
      {scenarios.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
    </Select>
  );
}

export function ScenarioChecks({ value, onChange, scenarios }: { value: string[]; onChange: (v: string[]) => void; scenarios: { id: string; label: string; note?: string }[] }) {
  if (!scenarios.length) return <div className="text-[11px] text-ink-3">Loading scenarios</div>;
  return (
    <div className="grid grid-cols-1 gap-y-1">
      {scenarios.map((s) => (
        <label key={s.id} title={s.note} className="flex items-center gap-1.5 text-[11.5px] text-ink-2 cursor-pointer">
          <input type="checkbox" className="accent-[#38bdf8]" checked={value.includes(s.id)} onChange={(e) => onChange(e.target.checked ? [...value, s.id] : value.filter((x) => x !== s.id))} />
          <span className="truncate">{s.label}</span>
        </label>
      ))}
    </div>
  );
}

export const Toggle = ({ label, checked, onChange, title, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; title?: string; disabled?: boolean }) => (
  <label title={title} className="flex items-center gap-1.5 text-[11.5px] text-ink-2 cursor-pointer">
    <input type="checkbox" className="accent-[#38bdf8]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    {label}
  </label>
);

/** Plain numeric cell for dense comparison tables. */
export const n = (v: unknown, d = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "-");
