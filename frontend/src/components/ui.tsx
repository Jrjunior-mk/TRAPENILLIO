"use client";
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, CircleSlash, Loader2, OctagonX, X, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useEffect } from "react";

export function Panel({ title, sub, actions, children, className, pad = true, tag }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean; tag?: ReactNode }) {
  return (
    <section className={clsx("border border-line bg-panel/90 rounded-md flex flex-col min-w-0", className)}>
      {(title || actions) && (
        <header className="flex items-center gap-2 px-3 h-9 border-b border-line shrink-0">
          <div className="min-w-0 flex items-baseline gap-2">
            <h2 className="text-[12px] font-semibold text-ink truncate">{title}</h2>
            {sub && <span className="text-[11px] text-ink-3 truncate">{sub}</span>}
          </div>
          {tag}
          <div className="ml-auto flex items-center gap-1.5 shrink-0">{actions}</div>
        </header>
      )}
      <div className={clsx("min-h-0 flex-1", pad && "p-3")}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, unit, sub, tone, icon: Icon, href }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: "go" | "wait" | "stop" | "accent"; icon?: LucideIcon; href?: string }) {
  const body = (
    <div className={clsx("border border-line bg-panel/90 rounded-md px-3 py-2.5 min-w-0 h-full", href && "hover:border-line-2 transition-colors")}>
      <div className="flex items-center gap-1.5 text-ink-3">
        {Icon && <Icon size={12} className={tone === "go" ? "text-go" : tone === "wait" ? "text-wait" : tone === "stop" ? "text-stop" : tone === "accent" ? "text-accent" : ""} />}
        <span className="text-[11px] truncate">{label}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="num text-[21px] leading-6 font-medium text-ink">{value}</span>
        {unit && <span className="text-[11px] text-ink-3">{unit}</span>}
      </div>
      {sub && <div className="text-[11px] text-ink-3 mt-0.5 truncate">{sub}</div>}
    </div>
  );
  return href ? <a href={href} className="block min-w-0">{body}</a> : body;
}

const OUTCOME_STYLE: Record<string, { cls: string; icon: LucideIcon }> = {
  GREEN: { cls: "text-go border-go/40 bg-go/10", icon: CheckCircle2 },
  AMBER: { cls: "text-wait border-wait/40 bg-wait/10", icon: AlertTriangle },
  RED: { cls: "text-stop border-stop/40 bg-stop/10", icon: OctagonX },
};

/** Status always ships with an icon and a label, never colour alone. */
export function Outcome({ value, size = "sm" }: { value?: string | null; size?: "sm" | "lg" }) {
  const s = OUTCOME_STYLE[value || ""] || { cls: "text-ink-3 border-line-2 bg-panel-2", icon: CircleSlash };
  const I = s.icon;
  return (
    <span className={clsx("inline-flex items-center gap-1 border rounded-sm font-semibold", s.cls, size === "lg" ? "px-2 py-1 text-[13px]" : "px-1.5 py-0.5 text-[10.5px]")}>
      <I size={size === "lg" ? 15 : 11} />
      {value || "NONE"}
    </span>
  );
}

const TOKEN_TONE: Record<string, string> = { ACTIVE: "go", ISSUED: "accent", PENDING: "muted", EXPIRED: "muted", SUSPENDED: "wait", FLAGGED: "wait", REVOKED: "stop" };

export function Badge({ children, tone = "muted", title }: { children: ReactNode; tone?: "go" | "wait" | "stop" | "accent" | "muted"; title?: string }) {
  return (
    <span title={title} className={clsx("inline-flex items-center gap-1 border rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium whitespace-nowrap", tone === "go" && "text-go border-go/40 bg-go/10", tone === "wait" && "text-wait border-wait/40 bg-wait/10", tone === "stop" && "text-stop border-stop/40 bg-stop/10", tone === "accent" && "text-accent border-accent/40 bg-accent/10", tone === "muted" && "text-ink-2 border-line-2 bg-panel-2")}>
      {children}
    </span>
  );
}

export const TokenStatus = ({ value }: { value: string }) => <Badge tone={(TOKEN_TONE[value] || "muted") as "go"}>{value}</Badge>;

/** Separates modelled results, assumed inputs and measured data, as the brief requires. */
export function Provenance({ kind, title }: { kind: "MODELLED" | "ASSUMED" | "MEASURED" | "SIMULATED" | "MOCK" | "DEMO DATA"; title?: string }) {
  const tone = kind === "MEASURED" ? "go" : kind === "MODELLED" || kind === "SIMULATED" ? "accent" : "wait";
  return <Badge tone={tone} title={title}>{kind}</Badge>;
}

export function Button({ children, variant = "default", size = "md", loading, className, icon: Icon, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" | "ghost"; size?: "sm" | "md"; loading?: boolean; icon?: LucideIcon }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-sm border font-medium transition-colors whitespace-nowrap disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer",
        size === "sm" ? "h-6 px-2 text-[11px]" : "h-[30px] px-3 text-[12px]",
        variant === "default" && "border-line-2 bg-panel-2 text-ink hover:bg-line",
        variant === "primary" && "border-accent-2 bg-accent-2 text-white hover:bg-[#3487e0]",
        variant === "danger" && "border-stop/50 bg-stop/15 text-stop hover:bg-stop/25",
        variant === "ghost" && "border-transparent text-ink-2 hover:bg-panel-2 hover:text-ink",
        className,
      )}
    >
      {loading ? <Loader2 size={13} className="animate-spin" /> : Icon ? <Icon size={13} /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("block min-w-0", className)}>
      <span className="block text-[11px] text-ink-2 mb-1">{label}</span>
      {children}
      {hint && !error && <span className="block text-[10.5px] text-ink-3 mt-0.5">{hint}</span>}
      {error && <span className="block text-[10.5px] text-stop mt-0.5">{error}</span>}
    </label>
  );
}

const inputCls = "w-full h-[30px] px-2 rounded-sm bg-bg-2 border border-line-2 text-ink text-[12px] placeholder:text-ink-3 focus:border-accent outline-none disabled:opacity-50";

export const Input = ({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) => <input {...rest} className={clsx(inputCls, className)} />;

export const Select = ({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...rest} className={clsx(inputCls, "appearance-auto", className)}>
    {children}
  </select>
);

export function Slider({ label, value, min, max, step = 1, unit, onChange, hint }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; hint?: string }) {
  return (
    <label className="block" title={hint}>
      <div className="flex justify-between text-[11px] mb-0.5">
        <span className="text-ink-2 truncate">{label}</span>
        <span className="num text-ink">{value}{unit}</span>
      </div>
      <input type="range" className="w-full accent-[#38bdf8] h-4" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: ReactNode }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="flex items-center gap-0.5 border-b border-line overflow-x-auto">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)} className={clsx("px-3 h-8 text-[12px] whitespace-nowrap border-b-2 -mb-px cursor-pointer", t.id === value ? "border-accent text-ink font-medium" : "border-transparent text-ink-3 hover:text-ink-2")}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export interface Col<T> {
  key: string;
  label: ReactNode;
  render?: (row: T) => ReactNode;
  align?: "right" | "left";
  mono?: boolean;
  width?: string;
}

export function DataTable<T>({ cols, rows, rowKey, onRow, empty = "Nothing to show yet.", dense = true, maxH }: { cols: Col<T>[]; rows: T[]; rowKey: (r: T) => string | number; onRow?: (r: T) => void; empty?: string; dense?: boolean; maxH?: string }) {
  if (!rows.length) return <Empty text={empty} />;
  return (
    <div className="overflow-auto" style={{ maxHeight: maxH }}>
      <table className="w-full text-[12px] border-collapse">
        <thead className="sticky top-0 bg-panel z-10">
          <tr>
            {cols.map((c) => (
              <th key={c.key} style={{ width: c.width }} className={clsx("font-medium text-[11px] text-ink-3 border-b border-line px-2 h-7 whitespace-nowrap", c.align === "right" ? "text-right" : "text-left")}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRow ? () => onRow(r) : undefined} className={clsx("border-b border-line/60", onRow && "cursor-pointer hover:bg-panel-2")}>
              {cols.map((c) => (
                <td key={c.key} className={clsx("px-2", dense ? "py-1.5" : "py-2.5", c.align === "right" && "text-right", c.mono && "num text-[11.5px]")}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? "-")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const Empty = ({ text = "Nothing to show yet." }: { text?: string }) => <div className="text-ink-3 text-[12px] py-6 text-center">{text}</div>;
export const Loading = ({ text = "Loading" }: { text?: string }) => (
  <div className="flex items-center justify-center gap-2 text-ink-3 text-[12px] py-6">
    <Loader2 size={14} className="animate-spin" />
    {text}
  </div>
);
export const ErrorBox = ({ text }: { text: string }) => <div role="alert" className="border border-stop/40 bg-stop/10 text-stop text-[12px] rounded-sm px-3 py-2">{text}</div>;
export const Note = ({ children }: { children: ReactNode }) => <div className="border border-line bg-bg-2 text-ink-2 text-[11.5px] leading-relaxed rounded-sm px-3 py-2">{children}</div>;

export function Drawer({ open, onClose, title, children, width = 520 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} onClick={onClose} className="fixed inset-0 bg-black/40 z-40" />
          <motion.aside role="dialog" aria-modal initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ duration: 0.16 }} style={{ width }} className="fixed top-0 right-0 bottom-0 max-w-full bg-panel border-l border-line-2 z-50 flex flex-col">
            <header className="flex items-center h-11 px-4 border-b border-line shrink-0">
              <div className="font-semibold text-[13px] truncate">{title}</div>
              <button aria-label="Close" onClick={onClose} className="ml-auto text-ink-3 hover:text-ink cursor-pointer"><X size={16} /></button>
            </header>
            <div className="flex-1 overflow-auto p-4">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

export function KV({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: number }) {
  return (
    <dl className="grid gap-x-4 gap-y-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[10.5px] text-ink-3">{k}</dt>
          <dd className="text-[12px] text-ink break-words">{v ?? "-"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CheckList({ checks }: { checks: { code: string; label: string; status: string; detail?: string }[] }) {
  return (
    <ul className="divide-y divide-line/60">
      {checks.map((c, i) => (
        <li key={i} className="flex items-start gap-2 py-1.5 text-[12px]">
          {c.status === "pass" ? <CheckCircle2 size={13} className="text-go mt-0.5 shrink-0" /> : c.status === "fail" ? <OctagonX size={13} className="text-stop mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="text-wait mt-0.5 shrink-0" />}
          <div className="min-w-0">
            <div className="text-ink">{c.label}</div>
            {c.detail && <div className="text-[11px] text-ink-3 break-words">{c.detail}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Meter({ value, tone }: { value: number; tone?: string }) {
  const v = Math.max(0, Math.min(1, value));
  const color = tone || (v > 0.85 ? "var(--color-stop)" : v > 0.65 ? "var(--color-wait)" : "var(--color-accent)");
  return (
    <div className="h-1.5 bg-line rounded-sm overflow-hidden w-full" role="meter" aria-valuenow={Math.round(v * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full" style={{ width: `${v * 100}%`, background: color }} />
    </div>
  );
}
