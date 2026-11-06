"use client";
import clsx from "clsx";
import { Building2, Container, Factory, FileSearch, Landmark, Scale, Settings, Truck, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { PageTitle } from "@/components/shell";
import { Badge, Note, Provenance } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { fmtInt } from "@/lib/format";
import { type Kpi, useLive } from "@/lib/live";

interface Card { id: string; name: string; icon: LucideIcon; blurb: string; needs?: (can: (p: string) => boolean, role?: string) => boolean; needText?: string; stat?: (k: Kpi) => string }

const CARDS: Card[] = [
  { id: "kenha", name: "KeNHA", icon: Scale, blurb: "Officer approvals, road screening, rolling verification, static referrals, calibration and disputes.", needs: (can) => can("case.decide"), needText: "Needs case.decide", stat: (k) => `${fmtInt(k.static)} static referrals today` },
  { id: "kpa", name: "KPA", icon: Container, blurb: "Port gate-out, the re-weigh queue, and container verification and release status.", stat: (k) => `${fmtInt(k.port_reweigh)} port re-weighs today` },
  { id: "kra", name: "KRA", icon: FileSearch, blurb: "Expected against measured weight, e-seal, customs release, misdeclaration and sealed overloads.", stat: (k) => `Mock customs API ${k.system.kra_down ? "unavailable" : "available"}` },
  { id: "ntsa", name: "NTSA", icon: Landmark, blurb: "Vehicle records with mock registration, insurance and roadworthiness flags, and demerits.", stat: (k) => `${fmtInt(k.trucks_active)} trucks on the corridor now` },
  { id: "transporter", name: "Transporter", icon: Truck, blurb: "One fleet: registered trucks, trucks on the road, tokens, history, axle loads and disputes.", needs: (can, role) => role === "transporter" || can("truck.view_all"), needText: "Needs fleet or agency access", stat: (k) => `${fmtInt(k.tokens_active)} active tokens corridor-wide` },
  { id: "loader", name: "Loading site", icon: Factory, blurb: "Site approval, calibration and suspension, origin tokens and weighing tickets.", stat: (k) => `${fmtInt(k.streams.origin ?? 0)} origin stream trucks today` },
  { id: "admin", name: "Administration", icon: Settings, blurb: "Users, system health and data retention.", needs: (can) => can("admin.users"), needText: "Needs admin.users", stat: (k) => `${fmtInt(k.alerts_open)} alerts raised today` },
];

export default function PortalsPage() {
  const { me, can } = useAuth();
  const kpi = useLive((s) => s.kpi);
  const home = me?.role;
  return (
    <div className="p-3">
      <PageTitle title="Agency portals" sub="One view per agency and role, over the same clearance records. Open any portal: the API decides what your role may see." actions={<Provenance kind="MOCK" title="Agency data comes from mock adapters and synthetic records" />} />
      <div className="mb-2">
        <Note>
          {me ? <>Signed in as <span className="text-ink">{me.display_name}</span>, {me.role_label}. {CARDS.some((c) => c.id === home) ? "Your home portal is highlighted." : "This role has no home portal, so none is highlighted."} </> : null}
          No real agency system is connected.
        </Note>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {CARDS.map((c) => {
          const I = c.icon;
          const isHome = c.id === home;
          const allowed = !me || !c.needs || c.needs(can, me.role);
          return (
            <Link key={c.id} href={`/portals/${c.id}`} className={clsx("block border rounded-md px-3 py-2.5 bg-panel/90 transition-colors min-w-0", isHome ? "border-accent" : "border-line hover:border-line-2")}>
              <div className="flex items-center gap-2">
                <I size={15} className={isHome ? "text-accent" : "text-ink-3"} />
                <span className="text-[13px] font-semibold text-ink">{c.name}</span>
                <span className="ml-auto flex items-center gap-1">
                  {isHome && <Badge tone="accent">Your home</Badge>}
                  {!allowed && <Badge title="The API will refuse this portal for your role">{c.needText}</Badge>}
                </span>
              </div>
              <p className="text-[11.5px] text-ink-2 mt-1.5 leading-snug">{c.blurb}</p>
              <div className="num text-[11px] text-ink-3 mt-2 flex items-center gap-1.5"><Building2 size={11} className="shrink-0" />{kpi && c.stat ? c.stat(kpi) : "Waiting for the live stream"}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
