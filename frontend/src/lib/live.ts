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
  wanted = true;
  connecting = true;
  let url: string | null = null;
  try {
    url = await liveUrl();
    if (!url) return; // no live stream configured: stay disconnected, which the UI reports
  } catch {
    scheduleReconnect();
    return;
  } finally {
    connecting = false;
  }
  if (!wanted || socket) return;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => useLive.setState({ connected: true });
  ws.onclose = () => {
    socket = null;
    useLive.setState({ connected: false });
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (msg) => {
    const m = JSON.parse(msg.data);
    if (m.t === "frame") {
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
