"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { type Config, type OpenRequest, type SimCtx } from "@/components/sim/common";
import { ControlRoom } from "@/components/sim/ControlRoom";
import { L1Tab } from "@/components/sim/L1Tab";
import { L2Tab } from "@/components/sim/L2Tab";
import { L3Tab } from "@/components/sim/L3Tab";
import { L4Tab } from "@/components/sim/L4Tab";
import { LinkedTab } from "@/components/sim/LinkedTab";
import { PageTitle } from "@/components/shell";
import { Loading, Provenance, Tabs } from "@/components/ui";
import { useApi } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const TABS = [
  { id: "control", label: "Control Room" },
  { id: "l1", label: "L1 Sensor" },
  { id: "l2", label: "L2 Process" },
  { id: "l3", label: "L3 Traffic" },
  { id: "l4", label: "L4 System" },
  { id: "linked", label: "Linked run" },
];

const L1_DEFAULT: Config = { avg_loading_pct: 85, speed_kmh: 80, temperature_c: 30, sensor_error_pct: 2.5, noise_pct: 0.6, calibration: "good", road_roughness: "A", sensor_rows: 3, sampling_khz: 5 };

function SimulationInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const { can } = useAuth();
  const requested = sp.get("tab");
  const tab = TABS.some((t) => t.id === requested) ? (requested as string) : "control";

  const { data, error, refresh } = useApi<{ config: Config; provenance: Record<string, string> }>("/live/config");
  const [config, setConfig] = useState<Config | null>(null);
  const [l1, setL1] = useState<Config>(L1_DEFAULT);
  const [opened, setOpened] = useState<Record<string, OpenRequest>>({});
  const [seen, setSeen] = useState<Set<string>>(() => new Set([tab]));

  useEffect(() => {
    if (data?.config) setConfig((c) => c ?? data.config);
  }, [data]);

  // Tabs stay mounted once visited, so a running job and its result survive switching tabs.
  useEffect(() => {
    setSeen((s) => (s.has(tab) ? s : new Set(s).add(tab)));
  }, [tab]);

  const go = useCallback((id: string) => router.replace(`/simulation?tab=${id}`, { scroll: false }), [router]);
  const patch = useCallback((p: Config) => setConfig((c) => (c ? { ...c, ...p } : c)), []);

  const ctx: SimCtx = useMemo(
    () => ({
      config,
      live: data?.config ?? null,
      provenance: data?.provenance ?? {},
      patch,
      refresh,
      error,
      canRun: can("sim.run"),
      canControl: can("live.control"),
      canFault: can("faults.inject"),
      l1,
      setL1,
    }),
    [config, data, patch, refresh, error, can, l1],
  );

  const onOpen = useCallback(
    (target: string, id: string) => {
      setOpened((o) => ({ ...o, [target]: { id, n: (o[target]?.n ?? 0) + 1 } }));
      go(target);
    },
    [go],
  );

  const pane = (id: string, node: React.ReactNode) => (seen.has(id) ? <div key={id} hidden={tab !== id}>{node}</div> : null);

  return (
    <div className="p-3">
      <PageTitle
        title="Simulation environment"
        sub="Four linked levels: sensor, process, road traffic and system. One parameter set drives all of them and the live twin. Results are modelled from assumed inputs and are not measurements."
        actions={<Provenance kind="MODELLED" title="Every level is a model. Inputs must be replaced by field measurement." />}
      />
      <Tabs tabs={TABS} value={tab} onChange={go} />
      {pane("control", <ControlRoom ctx={ctx} onOpen={onOpen} />)}
      {pane("l1", <L1Tab ctx={ctx} />)}
      {pane("l2", <L2Tab ctx={ctx} open={opened.l2} />)}
      {pane("l3", <L3Tab ctx={ctx} open={opened.l3} />)}
      {pane("l4", <L4Tab ctx={ctx} open={opened.l4} />)}
      {pane("linked", <LinkedTab ctx={ctx} open={opened.linked} />)}
    </div>
  );
}

export default function SimulationPage() {
  return (
    <Suspense fallback={<Loading text="Loading the simulation environment" />}>
      <SimulationInner />
    </Suspense>
  );
}
