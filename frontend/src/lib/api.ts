"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { tunnelFetch } from "./live";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function detail(body: unknown, fallback: string): string {
  const d = (body as { detail?: unknown })?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    return d.map((x: { loc?: unknown[]; msg?: string }) => `${(x.loc || []).slice(1).join(".")}: ${x.msg}`).join("; ");
  }
  return fallback;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "include",
  };
  // Sign-in and sign-out set the cookie, so they always use HTTP. Everything else may go over the tab's socket.
  const tunnelled = path.startsWith("/auth/") ? null : await tunnelFetch(init.method!, path, opts.body);
  let res = tunnelled ?? (await fetch(`/api${path}`, init));
  // A read can safely retry once if the proxy lost its connection to the API.
  if ((res.status === 500 || res.status === 502) && init.method === "GET") res = await fetch(`/api${path}`, init);
  if (res.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login") && !path.startsWith("/auth/login")) {
    window.location.href = "/login";
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error */
    }
    // Every API error is JSON, so anything else came from the proxy or host in front of it.
    const fallback = body === null ? `The API server is not responding (${res.status}). Check that the backend is running and API_ORIGIN points to it.` : `Request failed (${res.status})`;
    throw new ApiError(res.status, detail(body, fallback));
  }
  return res.json() as Promise<T>;
}

/** Fetches on mount and on `poll` ms. Keeps stale data on screen during refreshes. */
export function useApi<T = any>(path: string | null, poll?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    setLoading(true);
    refresh();
    if (poll) {
      const id = setInterval(refresh, poll);
      return () => {
        alive.current = false;
        clearInterval(id);
      };
    }
    return () => {
      alive.current = false;
    };
  }, [refresh, poll]);
  return { data, error, loading, refresh, setData };
}

/** Starts a backend experiment and polls until it finishes. */
export function useJob<T = any>() {
  const [job, setJob] = useState<{ id: string; progress: number; message?: string; status: string; result?: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  const watch = useCallback((id: string) => {
    stop();
    setError(null);
    setJob({ id, progress: 0, status: "RUNNING" });
    timer.current = setInterval(async () => {
      try {
        const e = await api(`/sim/experiments/${id}`);
        setJob(e);
        if (e.status !== "RUNNING") {
          stop();
          if (e.status === "FAILED") setError(e.message || "Experiment failed");
        }
      } catch (err) {
        stop();
        setError((err as Error).message);
      }
    }, 600);
  }, []);
  const start = useCallback(
    async (path: string, body: unknown) => {
      setError(null);
      setJob({ id: "", progress: 0, status: "RUNNING", message: "Starting" });
      try {
        const r = await api(path, { body });
        watch(r.job_id);
      } catch (err) {
        setJob(null);
        setError((err as Error).message);
      }
    },
    [watch],
  );
  return { job, error, start, watch, running: job?.status === "RUNNING" };
}
