import {
  isOpen,
  needsYou,
  type Health,
  type Host,
  type Incident,
  type Service,
  type IsoTime,
  type Workspace,
} from "@dragon-control/core";

export function minutesSince(at: IsoTime, now = Date.now()): number {
  return Math.max(0, (now - Date.parse(at)) / 60_000);
}

export function minutesBetween(from: IsoTime, to: IsoTime): number {
  return Math.max(0, (Date.parse(to) - Date.parse(from)) / 60_000);
}

export function ago(at: IsoTime): string {
  const minutes = minutesSince(at);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

/** How long something has lasted, as people say it: "for 12 minutes", "for 3 hours", "for 4 days". */
export function lasting(at: IsoTime, now = Date.now()): string {
  const m = Math.max(1, Math.round(minutesSince(at, now)));
  if (m < 90) return `for ${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 36) return `for ${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `for ${d} day${d === 1 ? "" : "s"}`;
}

/** "Just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago": spelled out. */
export function agoWords(at: IsoTime, now = Date.now()): string {
  const m = Math.round(minutesSince(at, now));
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function shortAgo(at: IsoTime): string {
  const minutes = minutesSince(at);
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function clockTime(at: IsoTime): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Short date and time; the year appears whenever it is not this year. */
export function dateTime(at: IsoTime): string {
  const d = new Date(at);
  return d.toLocaleString([], {
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Full date and time, as a Properties dialog shows it. */
export function fullDateTime(at: IsoTime): string {
  return new Date(at).toLocaleString([], {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function duration(hours: number): string {
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function tb(value: number): string {
  return value < 1 ? `${Math.round(value * 1000)} GB` : `${value.toFixed(1)} TB`;
}

/**
 * File sizes the way Windows Properties shows them (1 GB = 1024^3 bytes),
 * so "7.2 GB" here matches what you would see on the machine itself.
 */
export function bytes(n: number | undefined): string {
  if (n === undefined) return "…";
  const units = ["bytes", "KB", "MB", "GB", "TB", "PB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${n} ${n === 1 ? "byte" : "bytes"}`;
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`;
}

export const exactBytes = (n: number) => `${n.toLocaleString()} bytes`;

export function hoursAsDuration(hours: number): string {
  const days = Math.floor(hours / 24);
  if (days < 1) return `${hours} h`;
  const years = days / 365;
  return years >= 1 ? `${years.toFixed(1)} years` : `${days} days`;
}

export function pct(used: number, total: number): number {
  return total === 0 ? 0 : Math.round((used / total) * 100);
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export const healthLabel: Record<Health, string> = {
  healthy: "Healthy",
  attention: "Needs attention",
  offline: "Offline",
};

/** Incidents still in progress, including approved repairs waiting to run. */
export function openIncidents(ws: Workspace): Incident[] {
  return ws.incidents.filter(isOpen);
}

/** Incidents waiting on you specifically. Drives the home headline and badges. */
export function attentionIncidents(ws: Workspace): Incident[] {
  return ws.incidents.filter(needsYou);
}

export function storageTotals(hosts: Host[]) {
  const volumes = hosts.flatMap((h) => h.volumes);
  const total = volumes.reduce((s, v) => s + v.totalTb, 0);
  const used = volumes.reduce((s, v) => s + v.usedTb, 0);
  return { total, used, percent: pct(used, total) };
}

export function volumeHealth(usedTb: number, totalTb: number): Health {
  return pct(usedTb, totalTb) >= 90 ? "attention" : "healthy";
}

/**
 * Where "Open" should take you: the public address through the reverse
 * proxy when there is one, otherwise the local web interface. Wildcards
 * (a proxy's own "*.example.com") are not addresses you can open.
 */
export function publicHref(publicUrl: string | undefined): string | undefined {
  if (!publicUrl || publicUrl.includes("*")) return undefined;
  return /^https?:\/\//.test(publicUrl) ? publicUrl : `https://${publicUrl}`;
}

export function openTarget(
  service: Pick<Service, "name" | "publicUrl" | "localUrl">,
  /** Settings: through the reverse proxy when there is an address there (default), or the host. */
  via: "proxy" | "host" = "proxy",
): { href: string; label: string } | undefined {
  if (via === "host" && service.localUrl)
    return { href: service.localUrl, label: `Open ${service.name} on your network` };
  const pub = publicHref(service.publicUrl);
  if (pub) return { href: pub, label: `Open ${service.name} at ${service.publicUrl}` };
  if (service.localUrl)
    return { href: service.localUrl, label: `Open ${service.name} on your network` };
  return undefined;
}
