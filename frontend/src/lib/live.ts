"use client";
import { create } from "zustand";

export type TruckRow = [string, number, number, number, number, number, string, number]; // id, x, z, heading, state, hero, mode, axles

export interface Frame {
  now: string;
  trucks: TruckRow[];
  gantries: Record<string, string>;
  running: boolean;
  speed: number;
}

export interface StationKpi {
  id: string; name: string; kind: string; online: boolean; edge_up: boolean; processed: number; green: number; amber: number; red: number;
  lane_queue: number; static_queue: number; lane_visits: number; static_visits: number; bay_utilization: number; outbox: number; syncing: boolean; faults: number;
}

export interface Kpi {
  now: string; elapsed_h: number; running: boolean; paused: boolean; speed: number; entered: number; processed: number; trucks_processed: number; trucks_active: number; exited: number;
  auto_cleared: number; green: number; amber: number; red: number; lane: number; static: number; port_reweigh: number; tokens_issued: number; tokens_active: number; avg_clearance_min: number;
  avg_queue: number; truck_hours_saved: number; token_coverage_pct: number; uptime_pct: number; alerts_open: number; fail_safe: number; audits: number; token_mismatch: number;
  confirmed_overload: number; false_clears: number; streams: Record<string, number>; stations: StationKpi[];
  system: { messages: number; events_generated: number; events_delivered: number; queue_depth: number; api_latency_p50_ms: number; api_latency_p95_ms: number; failed_requests: number; registry_down: boolean; kra_down: boolean; step_ms: number; write_behind_written: number; write_behind_errors: number };
  conservation: { entered: number; exited: number; active: number; balanced: boolean };
  scenario: { id: string; title: string; truck: string | null; status: string; summary: string; log: { at: string; text: string; kind: string }[] } | null;
}

export interface LiveEvent {
  id: string; at: string; truck: string; plate: string; stream: string; site: string; site_name: string; stage: string; outcome: "GREEN" | "AMBER" | "RED"; action: string; risk: number; confidence: number; explanation: string; gross_kg: number | null; token: string | null; fail_safe: boolean; offline: boolean; hero: boolean;
}

export interface LiveAlert {
  at: string; severity: string; kind: string; site: string | null; title: string; detail: string;
}

interface LiveState {
  connected: boolean;
  kpi: Kpi | null;
  /** True once a connection has failed or stayed down. Before that, a closed socket only means it is still connecting. */
  lost: boolean;
  /** On function hosting, the tab reconnected to a different instance, whose simulation and records are separate. */
  instanceChanged: boolean;
  events: LiveEvent[];
  alerts: LiveAlert[];
  unread: number;
  frameRef: { current: Frame | null; prev: Frame | null; at: number };
  clearUnread: () => void;
}

// Frames arrive five times a second and never go through React state: the twin reads the ref in its render loop.
const frameRef: LiveState["frameRef"] = { current: null, prev: null, at: 0 };

export const useLive = create<LiveState>((set) => ({
  connected: false,
  lost: false,
  instanceChanged: false,
  kpi: null,
  events: [],
  alerts: [],
  unread: 0,
  frameRef,
  clearUnread: () => set({ unread: 0 }),
}));

let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let wanted = false;
let connecting = false;

// Function hosting runs several instances that share nothing, and a socket stays on one of them. Sending this tab's
// API calls over its socket keeps everything it sees on the same instance.
const TUNNEL = !!process.env.NEXT_PUBLIC_LIVE_TUNNEL;
const STAY_CONNECTED_WHEN_HIDDEN_MS = 60000;
let instance: string | null = null;
let nextRequest = 1;
type TunnelReply = { status: number; type?: string; body?: string; b64?: string; disposition?: string | null };
const pending = new Map<number, (reply: TunnelReply | null) => void>();
let lostTimer: ReturnType<typeof setTimeout> | null = null;

function failPending() {
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
}

async function socketOpen(waitMs: number): Promise<WebSocket | null> {
  void connectLive();
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (socket?.readyState === WebSocket.OPEN) return socket;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** Sends an API call over the socket. Null means the caller should fall back to plain HTTP. */
export async function tunnelFetch(method: string, path: string, body?: unknown): Promise<Response | null> {
  if (!TUNNEL || typeof window === "undefined") return null;
  const ws = await socketOpen(20000);
  if (!ws) return null;
  const id = nextRequest++;
  const reply = await new Promise<TunnelReply | null>((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ t: "req", id, method, path, body }));
    setTimeout(() => {
      if (pending.delete(id)) resolve(null);
    }, 120000);
  });
  if (!reply) return null;
  const headers: Record<string, string> = { "content-type": reply.type || "application/json" };
  if (reply.disposition) headers["content-disposition"] = reply.disposition;
  const data = reply.b64 ? Uint8Array.from(atob(reply.b64), (c) => c.charCodeAt(0)) : reply.body ?? "";
  return new Response(reply.status === 204 ? null : data, { status: reply.status, headers });
}

function installTunnelBrowserHooks() {
  // Plain links to the API (CSV, PDF and key downloads) would reach some other instance.
  document.addEventListener("click", async (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href^='/api/']") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const res = await tunnelFetch("GET", a.getAttribute("href")!.slice(4));
    if (!res || !res.ok) {
      window.open(a.href, "_blank");
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const name = res.headers.get("content-disposition")?.match(/filename="?([^";]+)/)?.[1];
    if (name) {
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
    } else {
      window.open(url, "_blank");
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  // A connection left open in a background tab keeps a function instance running and uses up the plan's quota.
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  document.addEventListener("visibilitychange", () => {
    if (hiddenTimer) clearTimeout(hiddenTimer);
    if (document.hidden) {
      hiddenTimer = setTimeout(disconnectLive, STAY_CONNECTED_WHEN_HIDDEN_MS);
    } else if (!socket) {
      void connectLive();
    }
  });
}
let hooksInstalled = false;

function scheduleReconnect() {
  if (retry) clearTimeout(retry);
  if (wanted) retry = setTimeout(connectLive, 1500);
}

/** A separately hosted API is on another site, so the socket authenticates with a one-time ticket instead of the cookie. */
async function liveUrl(): Promise<string | null> {
  const remote = process.env.NEXT_PUBLIC_WS_URL;
  if (remote) {
    const res = await fetch("/api/ws/ticket", { method: "POST", credentials: "include" });
    if (!res.ok) throw new Error(`Live stream ticket failed (${res.status})`);
    const { ticket } = await res.json();
    return `${remote}?ticket=${encodeURIComponent(ticket)}`;
  }
  // Local and Docker runs. A page served over HTTPS cannot open ws://, and there is no API on port 8000 of a hosted domain.
  return window.location.protocol === "http:" ? `ws://${window.location.hostname}:8000/api/ws/live` : null;
}

export async function connectLive() {
  if (typeof window === "undefined" || socket || connecting) return;
  if (TUNNEL && !hooksInstalled) {
    hooksInstalled = true;
    installTunnelBrowserHooks();
  }
  wanted = true;
  connecting = true;
  let url: string | null = null;
  try {
    url = await liveUrl();
    if (!url) {
      useLive.setState({ lost: true }); // no live stream is configured for this site
      return;
    }
  } catch {
    useLive.setState({ lost: true });
    scheduleReconnect();
    return;
  } finally {
    connecting = false;
  }
  if (!wanted || socket) return;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    if (lostTimer) clearTimeout(lostTimer);
    useLive.setState({ connected: true, lost: false });
  };
  ws.onclose = () => {
    socket = null;
    failPending();
    useLive.setState({ connected: false });
    // Function hosting closes sockets on a schedule and the tab reconnects at once, so only a lasting outage is reported.
    if (lostTimer) clearTimeout(lostTimer);
    lostTimer = setTimeout(() => {
      if (wanted) useLive.setState({ lost: true });
    }, TUNNEL ? 8000 : 0);
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (msg) => {
    const m = JSON.parse(msg.data);
    if (m.t === "res") {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    } else if (m.t === "hello") {
      if (instance && instance !== m.instance) useLive.setState({ instanceChanged: true });
      instance = m.instance;
    } else if (m.t === "frame") {
      frameRef.prev = frameRef.current;
      frameRef.current = m;
      frameRef.at = performance.now();
    } else if (m.t === "kpi") {
      useLive.setState({ kpi: m });
    } else if (m.t === "events") {
      useLive.setState((s) => ({ events: [...m.events.reverse(), ...s.events].slice(0, 80) }));
    } else if (m.t === "alerts") {
      useLive.setState((s) => ({ alerts: [...m.alerts.reverse(), ...s.alerts].slice(0, 40), unread: s.unread + m.alerts.length }));
    }
  };
}

export function disconnectLive() {
  wanted = false;
  if (retry) clearTimeout(retry);
  socket?.close();
  socket = null;
}
