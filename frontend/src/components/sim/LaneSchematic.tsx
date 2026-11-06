"use client";
import { NEUTRAL, STATUS } from "@/components/charts";

type Pt = [number, number];

/** Samples a cubic Bezier so a truck can be placed by its fraction along the part. */
function bezier(a: Pt, b: Pt, c: Pt, d: Pt, steps = 28): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]]);
  }
  return out;
}

const MAIN_Y = 66;
const LANE_Y = 172;
const DIVERGE_X = 170;
const Z0 = 400;
const Z1 = 760;
const EXIT_END = 950;
const MERGE_X = 1060;
const STATIC_Y = 262;

const PARTS: Record<string, Pt[]> = {
  lane_approach: bezier([DIVERGE_X, MAIN_Y], [260, MAIN_Y], [290, LANE_Y], [Z0, LANE_Y]),
  lane_zone: [[Z0, LANE_Y], [Z1, LANE_Y]],
  lane_exit: [[Z1, LANE_Y], [EXIT_END, LANE_Y], ...bezier([EXIT_END, LANE_Y], [1000, LANE_Y], [1010, MAIN_Y], [MERGE_X, MAIN_Y]).slice(1)],
};
const STATIC_BRANCH = bezier([Z1, LANE_Y], [820, LANE_Y], [800, STATIC_Y], [880, STATIC_Y]);
const toPath = (pts: Pt[]) => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");

function pointAt(pts: Pt[], s: number): { x: number; y: number; angle: number } {
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    lens.push(l);
    total += l;
  }
  let d = Math.max(0, Math.min(1, s)) * total;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i] || i === lens.length - 1) {
      const f = lens[i] ? d / lens[i] : 0;
      const [a, b] = [pts[i], pts[i + 1]];
      return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, angle: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI };
    }
    d -= lens[i];
  }
  return { x: pts[0][0], y: pts[0][1], angle: 0 };
}

const STATE_COLOR: Record<string, string> = { NEUTRAL, GREEN: STATUS.go, AMBER: STATUS.wait, RED: STATUS.stop };

const Road = ({ d, width = 18 }: { d: string; width?: number }) => (
  <>
    <path d={d} fill="none" stroke="#2c3d53" strokeWidth={width + 2} strokeLinejoin="round" />
    <path d={d} fill="none" stroke="#152130" strokeWidth={width} strokeLinejoin="round" />
  </>
);

const Label = ({ x, y, children, anchor = "start", tone = "#a9b6c6", size = 11, weight }: { x: number; y: number; children: React.ReactNode; anchor?: "start" | "middle" | "end"; tone?: string; size?: number; weight?: number }) => (
  <text x={x} y={y} textAnchor={anchor} fontSize={size} fontWeight={weight} fill={tone} style={{ paintOrder: "stroke", stroke: "#101a27", strokeWidth: 3 }}>{children}</text>
);

const SpeedSign = ({ x, y, value }: { x: number; y: number; value: number }) => (
  <g>
    <line x1={x} y1={y + 12} x2={x} y2={y + 22} stroke="#7686a0" />
    <circle cx={x} cy={y} r={12} fill="#0b1420" stroke="#e8eef5" strokeWidth={2} />
    <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#e8eef5" className="num">{value}</text>
  </g>
);

const deviceTone = (bad: boolean) => (bad ? STATUS.stop : "#38bdf8");

export interface LaneTruck { id: string; plate: string; s: number; part: string; state: string }

/** Lane schematic, not to scale. Device faults come from the backend list of failed sensors, and always carry a text label. */
export function LaneSchematic({ view, followed }: { view: any; followed?: string | null }) {
  const trucks: LaneTruck[] = view.lane_trucks ?? [];
  const failed: string[] = view.sensors_failed ?? [];
  const bad = (name: string) => failed.includes(name);
  const scaleBad = bad("Lane per-wheel scales");
  const lidarBad = bad("Lane side and overhead LiDAR");
  const anprBad = bad("Lane ANPR cameras");
  const rfidBad = bad("Lane RFID reader");
  const speed = view.design?.target_speed_kmh ?? 10;
  const rows = 8;
  const lidarX = Z0 + 0.65 * (Z1 - Z0);
  const gantry = view.gantry as string;

  // Plate labels take the row above or below the truck, whichever is free. A truck with no free row keeps its hover title.
  const placed = trucks
    .map((t) => ({ t, p: pointAt(PARTS[t.part] ?? PARTS.lane_zone, t.s) }))
    .sort((a, b) => a.p.x - b.p.x);
  const lastX = { up: -999, down: -999 };
  const labelled = placed.map(({ t, p }) => {
    const isFollowed = t.id === followed;
    let row: "up" | "down" | null = null;
    if (p.x - lastX.up >= 62 || isFollowed) row = "up";
    else if (p.x - lastX.down >= 62) row = "down";
    if (row) lastX[row] = p.x;
    return { t, p, row, isFollowed };
  });

  return (
    <div className="overflow-x-auto">
      <svg viewBox="0 0 1200 300" className="w-full min-w-[900px] block" role="img" aria-label={`Rolling Verification Lane at ${view.name}, with ${trucks.length} trucks in the lane`}>
        {/* Roads */}
        <Road d={`M16 ${MAIN_Y} L1184 ${MAIN_Y}`} width={22} />
        <path d={`M16 ${MAIN_Y} L1184 ${MAIN_Y}`} stroke="#7686a0" strokeDasharray="10 12" strokeWidth={1} />
        <Road d={toPath(PARTS.lane_approach)} />
        <Road d={toPath(STATIC_BRANCH) + ` L1000 ${STATIC_Y}`} />
        <Road d={toPath(PARTS.lane_exit)} />
        <Road d={toPath(PARTS.lane_zone)} />
        <rect x={Z0} y={LANE_Y - 15} width={Z1 - Z0} height={30} fill="#38bdf8" fillOpacity={0.09} stroke="#38bdf8" strokeOpacity={0.5} strokeDasharray="4 3" />

        {/* Mainline annotations */}
        <Label x={18} y={46} tone="#e8eef5" weight={600}>Mainline</Label>
        <path d={`M92 42 h26 m-6 -4 l6 4 l-6 4`} fill="none" stroke="#7686a0" strokeWidth={1.4} />
        <line x1={DIVERGE_X} y1={MAIN_Y - 26} x2={DIVERGE_X} y2={MAIN_Y + 14} stroke="#a9b6c6" strokeWidth={1.5} />
        <circle cx={DIVERGE_X} cy={MAIN_Y - 28} r={5} fill={STATE_COLOR[gantry] ?? NEUTRAL} />
        <Label x={DIVERGE_X + 10} y={MAIN_Y - 32} tone="#e8eef5" weight={600}>Diverge gantry</Label>
        <Label x={DIVERGE_X + 10} y={MAIN_Y - 18}>{`Signal: ${gantry ? gantry.toLowerCase() : "unknown"}`}</Label>
        <Label x={MERGE_X} y={MAIN_Y - 18} anchor="middle" tone="#e8eef5" weight={600}>Merge</Label>

        {/* Approach */}
        <SpeedSign x={235} y={124} value={speed} />

        <Label x={210} y={166} anchor="middle">Speed control</Label>
        <Label x={210} y={180} anchor="middle">{`${speed} km/h target`}</Label>
        <Label x={40} y={112} tone="#e8eef5" weight={600}>Lane approach</Label>
        <Label x={40} y={127}>{`Queue: ${view.lane_queue ?? 0} trucks`}</Label>
        <Label x={40} y={142}>{view.lane_open ? "Lane open" : "Lane closed"}</Label>

        {/* ANPR camera and RFID reader, on the far side of the zone entry */}
        <g>
          <line x1={388} y1={122} x2={388} y2={LANE_Y - 15} stroke="#7686a0" />
          <rect x={380} y={114} width={16} height={10} rx={1} fill="#0b1420" stroke={deviceTone(anprBad)} strokeWidth={1.5} />
          <path d="M396 117 l6 -3 v10 l-6 -3 z" fill={deviceTone(anprBad)} />
          <Label x={402} y={106} anchor="end" tone={anprBad ? STATUS.stop : "#a9b6c6"}>{anprBad ? "ANPR camera: fault" : "ANPR camera"}</Label>
        </g>
        <g>
          <line x1={440} y1={126} x2={440} y2={LANE_Y - 15} stroke="#7686a0" />
          <rect x={433} y={112} width={14} height={14} rx={1} fill="#0b1420" stroke={deviceTone(rfidBad)} strokeWidth={1.5} />
          <path d="M437 119 a3 3 0 0 1 6 0 M435 119 a5 5 0 0 1 10 0" fill="none" stroke={deviceTone(rfidBad)} />
          <Label x={426} y={106} tone={rfidBad ? STATUS.stop : "#a9b6c6"}>{rfidBad ? "RFID reader: fault" : "RFID reader"}</Label>
        </g>

        {/* Per-wheel scales: a left and a right pad on each row */}
        {Array.from({ length: rows }).map((_, i) => {
          const x = Z0 + 34 + i * 25;
          return (
            <g key={i}>
              <rect x={x} y={LANE_Y - 11} width={10} height={7} fill={scaleBad ? STATUS.stop : "#38bdf8"} fillOpacity={0.75} />
              <rect x={x} y={LANE_Y + 4} width={10} height={7} fill={scaleBad ? STATUS.stop : "#38bdf8"} fillOpacity={0.75} />
            </g>
          );
        })}
        <path d={`M${Z0} ${LANE_Y + 20} v6 H${Z1} v-6`} fill="none" stroke="#7686a0" />
        <Label x={(Z0 + Z1) / 2} y={LANE_Y + 40} anchor="middle" tone="#e8eef5" weight={600}>Measuring zone</Label>
        <Label x={(Z0 + Z1) / 2} y={LANE_Y + 55} anchor="middle" tone={scaleBad ? STATUS.stop : "#a9b6c6"}>{scaleBad ? "Per-wheel scales: fault, trucks fail safe to the static scale" : `Per-wheel scales, left and right, ${rows} rows`}</Label>

        {/* LiDAR dimension portal */}
        <g>
          <path d={`M${lidarX - 8} ${LANE_Y + 18} V${LANE_Y - 26} H${lidarX + 8} V${LANE_Y + 18}`} fill="none" stroke={deviceTone(lidarBad)} strokeWidth={2} />
          <rect x={lidarX - 4} y={LANE_Y - 30} width={8} height={6} fill={deviceTone(lidarBad)} />
          <Label x={lidarX} y={LANE_Y - 38} anchor="middle" tone={lidarBad ? STATUS.stop : "#a9b6c6"}>{lidarBad ? "LiDAR portal: fault" : "LiDAR dimension portal"}</Label>
        </g>

        {/* Exit and static branch */}
        <Label x={930} y={LANE_Y + 34} anchor="middle" tone="#e8eef5" weight={600}>Exit lane</Label>
        <Label x={930} y={LANE_Y + 49} anchor="middle">Green: token issued, back to mainline</Label>
        <rect x={1006} y={STATIC_Y - 22} width={170} height={44} fill="#0b1420" stroke="#2c3d53" />
        <Label x={1091} y={STATIC_Y - 5} anchor="middle" tone={bad("Static weighbridge decks") ? STATUS.stop : "#e8eef5"} weight={600}>{bad("Static weighbridge decks") ? "Static scale: fault" : "Static scale, red only"}</Label>
        <Label x={1091} y={STATIC_Y + 11} anchor="middle">{`${view.bays_busy ?? 0} of ${view.bays_total ?? 0} bays, ${view.static_queue ?? 0} queued`}</Label>

        {/* Trucks */}
        {labelled.map(({ t, p, row, isFollowed }) => (
          <g key={t.id} style={{ transform: `translate(${p.x}px, ${p.y}px)`, transition: "transform 1s linear" }}>
            <title>{`${t.plate}, ${t.state.toLowerCase()}, ${t.part.replace("_", " ")}`}</title>
            {isFollowed && <circle r={15} fill="none" stroke="#e8eef5" strokeWidth={2} />}
            <rect x={-11} y={-4.5} width={22} height={9} rx={1.5} transform={`rotate(${p.angle})`} fill={STATE_COLOR[t.state] ?? NEUTRAL} stroke="#0b1420" strokeWidth={1} />
            {row && (
              <text y={row === "up" ? -11 - (isFollowed ? 6 : 0) : 19} textAnchor="middle" fontSize={10} fontWeight={isFollowed ? 700 : 500} fill="#e8eef5" className="num" style={{ paintOrder: "stroke", stroke: "#101a27", strokeWidth: 3 }}>{t.plate}</text>
            )}
          </g>
        ))}
      </svg>
      <div className="flex items-center gap-3 flex-wrap text-[11px] text-ink-2 mt-1">
        {[["NEUTRAL", "No lane decision yet"], ["GREEN", "Green"], ["AMBER", "Amber"], ["RED", "Red"]].map(([k, l]) => (
          <span key={k} className="flex items-center gap-1.5"><span className="inline-block w-4 h-2" style={{ background: STATE_COLOR[k] }} />{l}</span>
        ))}
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full border-2 border-ink" />Followed truck</span>
        <span className="ml-auto text-ink-3">Schematic, not to scale. Trucks sit at their real fraction along each part of the lane.</span>
      </div>
    </div>
  );
}
