"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";

export interface Me {
  id: number; username: string; display_name: string; role: string; role_label: string; org: string; fleet_id: number | null; site_id: string | null; permissions: string[]; sections: string[]; home: string;
}

const Ctx = createContext<{ me: Me | null; offline: boolean; can: (p: string) => boolean; has: (section: string) => boolean; refresh: () => void }>({ me: null, offline: false, can: () => false, has: () => false, refresh: () => {} });

/** The section a path belongs to. The API enforces access, and this keeps the screens consistent with it. */
export function sectionForPath(path: string): string {
  const [first, second] = path.split("/").filter(Boolean);
  if (!first) return "command";
  if (first === "portals") return second ? `portal:${second}` : "portals";
  return first;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [offline, setOffline] = useState(false);
  const load = () => {
    api<Me>("/auth/me")
      .then((u) => {
        setMe(u);
        setOffline(false);
      })
      .catch((e) => {
        setMe(null);
        // A 401 is already on its way to the sign-in page. Anything else means the API could not answer.
        setOffline(!(e instanceof ApiError && e.status === 401));
      });
  };
  useEffect(load, []);
  return <Ctx.Provider value={{ me, offline, can: (p) => !!me?.permissions.includes(p), has: (s) => !!me?.sections.includes(s), refresh: load }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
