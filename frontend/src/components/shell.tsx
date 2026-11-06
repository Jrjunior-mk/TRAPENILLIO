"use client";
import clsx from "clsx";
import { BarChart3, Bell, Box, Boxes, ChevronRight, Cpu, FlaskConical, Gauge, GitBranch, Landmark, LogOut, PanelLeft, Radio, Search, Shield, Truck, Waypoints, Wifi, WifiOff } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { AuthProvider, useAuth } from "@/lib/auth";
import { fmtDate, fmtTime, siteName } from "@/lib/format";
import { connectLive, disconnectLive, useLive } from "@/lib/live";
import { Badge } from "./ui";

const NAV = [
  { href: "/", label: "Command Centre", icon: Gauge },
  { href: "/twin", label: "Digital Twin", icon: Box },
  { href: "/clearance", label: "Truck Clearance", icon: Truck },
  { href: "/tokens", label: "Token Registry", icon: Shield },
  { href: "/decisions", label: "Decision Engine", icon: GitBranch },
  { href: "/lane", label: "Verification Lane", icon: Waypoints },
  { href: "/sensors", label: "Sensors and Edge", icon: Cpu },
  { href: "/simulation", label: "Simulation", icon: FlaskConical },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/portals", label: "Agency Portals", icon: Landmark },
  { href: "/alerts", label: "Alerts and Audit", icon: Bell },
];

const CRUMBS: Record<string, string> = { twin: "Digital Twin", clearance: "Truck Clearance", tokens: "Token Registry", decisions: "Decision Engine", lane: "Verification Lane", sensors: "Sensors and Edge", simulation: "Simulation", analytics: "Analytics", portals: "Agency Portals", alerts: "Alerts and Audit", trucks: "Trucks", kenha: "KeNHA", kpa: "KPA", kra: "KRA", ntsa: "NTSA", transporter: "Transporter", loader: "Loading site", admin: "Administration" };

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const path = usePathname();
  return (
    <aside className={clsx("shrink-0 border-r border-line bg-bg-2 flex flex-col transition-[width] duration-150", collapsed ? "w-12" : "w-[196px]")}>
      <div className="h-12 flex items-center gap-2 px-3 border-b border-line shrink-0">
        <Boxes size={18} className="text-accent shrink-0" />
        {!collapsed && (
          <div className="leading-none min-w-0">
            <div className="font-bold tracking-[0.12em] text-[12px] text-ink">RCS COMMAND</div>
            <div className="text-[9.5px] text-ink-3 mt-1 truncate">Measure once. Verify everywhere.</div>
          </div>
        )}
      </div>
      <nav className="flex-1 py-2 overflow-y-auto">
        {NAV.map((n) => {
          const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
          const I = n.icon;
          return (
            <Link key={n.href} href={n.href} title={collapsed ? n.label : undefined} className={clsx("flex items-center gap-2.5 h-8 mx-1.5 px-2 rounded-sm text-[12px] border-l-2", active ? "bg-panel-2 text-ink border-accent" : "text-ink-3 border-transparent hover:text-ink hover:bg-panel")}>
              <I size={15} className="shrink-0" />
              {!collapsed && <span className="truncate">{n.label}</span>}
            </Link>
          );
        })}
      </nav>
      <button onClick={onToggle} aria-label="Toggle sidebar" className="h-9 flex items-center gap-2 px-3 text-ink-3 hover:text-ink border-t border-line cursor-pointer">
        <PanelLeft size={15} />
        {!collapsed && <span className="text-[11px]">Collapse</span>}
      </button>
    </aside>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<{ type: string; label: string; href: string; id: string }[]>([]);
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (q.trim().length < 2) {
      setItems([]);
      return;
    }
    const id = setTimeout(() => api(`/search?q=${encodeURIComponent(q.trim())}`).then((r) => setItems(r.items)).catch(() => setItems([])), 200);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={box} className="relative w-[300px] max-md:hidden">
      <Search size={13} className="absolute left-2 top-2 text-ink-3" />
      <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder="Search plate, token, container, station" aria-label="Global search" className="w-full h-7 pl-7 pr-2 rounded-sm bg-panel border border-line text-[12px] text-ink placeholder:text-ink-3 outline-none focus:border-accent" />
      {open && q.trim().length >= 2 && (
        <div className="absolute top-8 left-0 right-0 bg-panel-2 border border-line-2 rounded-sm z-50 max-h-80 overflow-auto shadow-xl">
          {items.length === 0 && <div className="px-3 py-2 text-ink-3 text-[12px]">No matches</div>}
          {items.map((it) => (
            <button key={it.type + it.id} onClick={() => { setOpen(false); setQ(""); router.push(it.href); }} className="w-full text-left flex items-center gap-2 px-3 py-1.5 hover:bg-line text-[12px] cursor-pointer">
              <span className="text-[10px] text-ink-3 w-16 shrink-0 uppercase">{it.type}</span>
              <span className="truncate text-ink">{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const alerts = useLive((s) => s.alerts);
  const unread = useLive((s) => s.unread);
  const clear = useLive((s) => s.clearUnread);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={box} className="relative">
      <button aria-label="Notifications" onClick={() => { setOpen(!open); clear(); }} className="relative h-7 w-7 flex items-center justify-center rounded-sm hover:bg-panel-2 text-ink-2 cursor-pointer">
        <Bell size={15} />
        {unread > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-sm bg-stop text-white text-[9px] num leading-[14px] text-center">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-8 w-[340px] bg-panel-2 border border-line-2 rounded-sm z-50 shadow-xl">
          <div className="px-3 h-8 flex items-center border-b border-line text-[12px] font-medium">Notifications<Link href="/alerts" className="ml-auto text-accent text-[11px] font-normal">All alerts</Link></div>
          <div className="max-h-80 overflow-auto">
            {alerts.length === 0 && <div className="px-3 py-3 text-ink-3 text-[12px]">No alerts since you opened this page.</div>}
            {alerts.slice(0, 14).map((a, i) => (
              <div key={i} className="px-3 py-2 border-b border-line/60">
                <div className="flex items-center gap-2">
                  <Badge tone={a.severity === "critical" ? "stop" : a.severity === "warning" ? "wait" : "accent"}>{a.severity}</Badge>
                  <span className="text-ink-3 text-[10.5px] num">{fmtTime(a.at)}</span>
                  <span className="text-ink-3 text-[10.5px] ml-auto">{siteName(a.site)}</span>
                </div>
                <div className="text-[12px] mt-1">{a.title}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HealthIndicator() {
  const kpi = useLive((s) => s.kpi);
  const connected = useLive((s) => s.connected);
  const faults = kpi ? kpi.stations.filter((s) => !s.online || !s.edge_up || s.faults > 0).length + (kpi.system.registry_down ? 1 : 0) : 0;
  const state = !connected ? "stop" : faults > 2 ? "stop" : faults > 0 ? "wait" : "go";
  const text = !connected ? "Stream lost" : faults ? `${faults} degraded` : "Nominal";
  const I = connected ? Wifi : WifiOff;
  return (
    <Link href="/sensors" title="System health" className={clsx("flex items-center gap-1.5 h-7 px-2 rounded-sm border text-[11px]", state === "go" && "border-go/40 text-go", state === "wait" && "border-wait/40 text-wait", state === "stop" && "border-stop/40 text-stop")}>
      <I size={13} />
      {text}
    </Link>
  );
}

function Topbar() {
  const { me } = useAuth();
  const kpi = useLive((s) => s.kpi);
  const path = usePathname();
  const parts = path.split("/").filter(Boolean);
  const logout = async () => {
    await api("/auth/logout", { body: {} });
    disconnectLive();
    window.location.href = "/login";
  };
  return (
    <header className="h-12 shrink-0 border-b border-line flex items-center gap-3 px-3 bg-bg-2/80">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[12px] min-w-0 max-lg:hidden">
        <Link href="/" className="text-ink-3 hover:text-ink">Corridor</Link>
        {parts.length === 0 && (<><ChevronRight size={12} className="text-ink-3" /><span className="text-ink">Command Centre</span></>)}
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-1 min-w-0">
            <ChevronRight size={12} className="text-ink-3 shrink-0" />
            {i < parts.length - 1 ? <Link href={"/" + parts.slice(0, i + 1).join("/")} className="text-ink-3 hover:text-ink">{CRUMBS[p] || decodeURIComponent(p)}</Link> : <span className="text-ink truncate">{CRUMBS[p] || decodeURIComponent(p)}</span>}
          </span>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2.5">
        <GlobalSearch />
        <div className="flex items-center gap-1.5 h-7 px-2 rounded-sm border border-wait/40 text-wait text-[11px] font-medium" title="Simulated demonstration. No real infrastructure feed or agency system is connected.">
          <Radio size={12} className={kpi?.running ? "pulse-dot" : ""} />
          DEMO {kpi?.running ? "LIVE SIM" : "PAUSED"}
        </div>
        <HealthIndicator />
        <div className="text-right leading-tight max-sm:hidden" title="Simulated corridor clock, East Africa Time">
          <div className="num text-[12px] text-ink">{fmtTime(kpi?.now)}</div>
          <div className="text-[10px] text-ink-3">{fmtDate(kpi?.now)} EAT sim</div>
        </div>
        <Notifications />
        <div className="flex items-center gap-2 pl-2 border-l border-line">
          <div className="text-right leading-tight max-lg:hidden">
            <div className="text-[12px] text-ink">{me?.display_name}</div>
            <div className="text-[10px] text-ink-3">{me?.role_label}</div>
          </div>
          <button aria-label="Sign out" title="Sign out" onClick={logout} className="h-7 w-7 flex items-center justify-center rounded-sm hover:bg-panel-2 text-ink-3 hover:text-ink cursor-pointer"><LogOut size={14} /></button>
        </div>
      </div>
    </header>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("rcs.sidebar") === "1");
    } catch { /* storage unavailable */ }
    connectLive();
  }, []);
  const toggle = () => {
    setCollapsed((c) => {
      try { localStorage.setItem("rcs.sidebar", c ? "0" : "1"); } catch { /* storage unavailable */ }
      return !c;
    });
  };
  return (
    <AuthProvider>
      <div className="h-screen flex app-bg overflow-hidden">
        <Sidebar collapsed={collapsed} onToggle={toggle} />
        <div className="flex-1 flex flex-col min-w-0">
          <Topbar />
          <main className="flex-1 min-h-0 overflow-auto">{children}</main>
        </div>
      </div>
    </AuthProvider>
  );
}

export const PageTitle = ({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) => (
  <div className="flex items-end gap-3 mb-3 flex-wrap">
    <div className="min-w-0">
      <h1 className="text-[17px] font-semibold text-ink leading-tight">{title}</h1>
      {sub && <p className="text-[12px] text-ink-3 mt-0.5 max-w-[92ch]">{sub}</p>}
    </div>
    {actions && <div className="ml-auto flex items-center gap-2 flex-wrap">{actions}</div>}
  </div>
);

