"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

export interface Me {
  id: number; username: string; display_name: string; role: string; role_label: string; org: string; fleet_id: number | null; site_id: string | null; permissions: string[];
}

const Ctx = createContext<{ me: Me | null; can: (p: string) => boolean; refresh: () => void }>({ me: null, can: () => false, refresh: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const load = () => {
    api<Me>("/auth/me").then(setMe).catch(() => setMe(null));
  };
  useEffect(load, []);
  return <Ctx.Provider value={{ me, can: (p) => !!me?.permissions.includes(p), refresh: load }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
