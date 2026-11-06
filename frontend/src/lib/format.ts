const EAT: Intl.DateTimeFormatOptions = { timeZone: "Africa/Nairobi", hour12: false };

export const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { ...EAT, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "-");
export const fmtClock = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { ...EAT, hour: "2-digit", minute: "2-digit" }) : "-");
export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { ...EAT, day: "2-digit", month: "short", year: "numeric" }) : "-");
export const fmtDateTime = (iso?: string | null) => (iso ? `${fmtDate(iso)} ${fmtClock(iso)}` : "-");
export const fmtInt = (n?: number | null) => (n === null || n === undefined ? "-" : Math.round(n).toLocaleString("en-US"));
export const fmtNum = (n?: number | null, d = 1) => (n === null || n === undefined ? "-" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtPct = (n?: number | null, d = 1) => (n === null || n === undefined ? "-" : `${fmtNum(n, d)}%`);
export const fmtKg = (n?: number | null) => (n === null || n === undefined ? "-" : `${fmtInt(n)} kg`);
export const fmtT = (n?: number | null) => (n === null || n === undefined ? "-" : `${fmtNum(n / 1000, 1)} t`);

export const SITE_SHORT: Record<string, string> = {
  port_node: "Port Node",
  dongo_kundu: "Dongo Kundu",
  mariakani: "Mariakani",
  mtwapa: "Mtwapa",
  origin_quarry: "Quarry Node",
  origin_cement: "Cement Node",
  origin_depot: "Depot Node",
};
export const STREAM_LABEL: Record<string, string> = { port: "Port", origin: "Industrial origin", untokened: "Untokened" };
export const siteName = (id?: string | null) => (id ? SITE_SHORT[id] || id : "System");
