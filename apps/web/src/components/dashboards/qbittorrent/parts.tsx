import { ArrowDown, ArrowUp, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import type {
  DelugeDashboard,
  TransmissionDashboard,
  QbittorrentDashboard,
  Torrent,
  TorrentStatus,
} from "@dragon-control/core";

/** qBittorrent's or Deluge's live dashboard: the same torrents, read the same way. */
type Data = QbittorrentDashboard | DelugeDashboard | TransmissionDashboard;
import { ago, bytes } from "../../../lib/format";
import { cx } from "../../ui";

/** Pieces shared by qBittorrent's Overview and its Torrents tab. */

export const STOPPED = /^(paused|stopped)(DL|UP)$/;

export const speed = (bps: number) =>
  bps <= 0
    ? "0 B/s"
    : bps >= 1048576
      ? `${(bps / 1048576).toFixed(1)} MB/s`
      : `${Math.round(bps / 1024)} KB/s`;

export function eta(sec?: number) {
  if (sec === undefined) return undefined;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.round((sec % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
}

/** Colour per status: bar fill and badge. */
export const TONE: Record<TorrentStatus, { bar: string; badge: string }> = {
  downloading: { bar: "bg-gold", badge: "border-gold/50 text-gold" },
  metadata: { bar: "bg-gold/60", badge: "border-gold/40 text-gold/80" },
  stalled: { bar: "bg-amber", badge: "border-amber/60 text-amber" },
  queued: { bar: "bg-muted/50", badge: "border-line-strong text-muted" },
  paused: { bar: "bg-muted/40", badge: "border-line-strong text-muted" },
  checking: { bar: "bg-gold/50", badge: "border-gold/40 text-gold/80" },
  moving: { bar: "bg-gold/50", badge: "border-gold/40 text-gold/80" },
  seeding: { bar: "bg-live", badge: "border-live/50 text-live" },
  completed: { bar: "bg-live/70", badge: "border-live/40 text-live" },
  error: { bar: "bg-alert", badge: "border-alert/60 text-alert" },
};

export type Group =
  | "all"
  | "downloading"
  | "uploading"
  | "stalled"
  | "queued"
  | "paused"
  | "seeding"
  | "completed"
  | "error";

export const GROUPS: { id: Group; label: string; test: (t: Torrent) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  {
    id: "downloading",
    label: "Downloading",
    test: (t) => t.status === "downloading" || t.status === "metadata",
  },
  { id: "uploading", label: "Uploading", test: (t) => t.upSpeed > 0 },
  { id: "stalled", label: "Stalled", test: (t) => t.status === "stalled" },
  { id: "queued", label: "Queued", test: (t) => t.status === "queued" },
  { id: "paused", label: "Paused", test: (t) => t.status === "paused" },
  { id: "seeding", label: "Seeding", test: (t) => t.status === "seeding" },
  { id: "completed", label: "Completed", test: (t) => t.progressPct >= 100 },
  { id: "error", label: "Errors", test: (t) => t.status === "error" },
];

export type Sort = "attention" | "name" | "progress" | "down" | "up" | "eta" | "size" | "added";

export const SORTS: { id: Sort; label: string }[] = [
  { id: "attention", label: "Needs attention first" },
  { id: "name", label: "Name" },
  { id: "progress", label: "Progress" },
  { id: "down", label: "Download speed" },
  { id: "up", label: "Upload speed" },
  { id: "eta", label: "Time left" },
  { id: "size", label: "Size" },
  { id: "added", label: "Newest" },
];

const ATTENTION: Record<TorrentStatus, number> = {
  error: 0,
  stalled: 1,
  downloading: 2,
  metadata: 3,
  checking: 4,
  moving: 4,
  queued: 5,
  paused: 6,
  seeding: 7,
  completed: 8,
};

export function sortBy(sort: Sort) {
  return (a: Torrent, b: Torrent) => {
    switch (sort) {
      case "name":
        return a.name.localeCompare(b.name);
      case "progress":
        return b.progressPct - a.progressPct;
      case "down":
        return b.downSpeed - a.downSpeed;
      case "up":
        return b.upSpeed - a.upSpeed;
      case "eta":
        return (a.etaSec ?? Infinity) - (b.etaSec ?? Infinity);
      case "size":
        return b.sizeBytes - a.sizeBytes;
      case "added":
        return (b.addedAt ?? "").localeCompare(a.addedAt ?? "");
      default:
        return (
          ATTENTION[a.status] - ATTENTION[b.status] ||
          b.downSpeed - a.downSpeed ||
          a.name.localeCompare(b.name)
        );
    }
  };
}

/** Whether a torrent needs the owner: an error, stalled, or no seeders anywhere. */
export const needsYou = (t: Torrent) =>
  t.status === "error" ||
  t.status === "stalled" ||
  (t.progressPct < 100 && t.seedsInSwarm === 0 && t.status !== "metadata" && t.status !== "paused");

export function Header({ d, at, sample }: { d: Data; at: string; sample?: boolean }) {
  const conn = {
    connected: { text: "Connected", cls: "border-live/40 text-live", Icon: Wifi },
    firewalled: {
      text: "Firewalled (no incoming connections)",
      cls: "border-amber/50 text-amber",
      Icon: Wifi,
    },
    disconnected: { text: "Disconnected", cls: "border-alert/50 text-alert", Icon: WifiOff },
    unknown: { text: "Connection unknown", cls: "border-line-strong text-muted", Icon: Wifi },
  }[d.connection];
  return (
    <div className="flex flex-wrap items-center gap-2 text-[0.78rem]" data-testid="qb-header">
      <span
        className={cx(
          "fit-pill inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
          conn.cls,
        )}
      >
        <conn.Icon strokeWidth={1.5} className="h-3.5 w-3.5" /> {conn.text}
      </span>
      {d.vpn && (
        <span
          className={cx(
            "fit-pill inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
            d.vpn.health === "healthy"
              ? "border-live/40 text-live"
              : d.vpn.health === "attention"
                ? "border-amber/50 text-amber"
                : "border-alert/50 text-alert",
          )}
          title={d.vpn.detail}
          data-testid="qb-vpn"
        >
          <ShieldCheck strokeWidth={1.5} className="h-3.5 w-3.5" /> VPN ({d.vpn.name}):{" "}
          {d.vpn.health === "healthy"
            ? "healthy"
            : d.vpn.health === "attention"
              ? "needs attention"
              : "down"}
        </span>
      )}
      <span className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-ink tabular">
        <ArrowDown strokeWidth={1.5} className="h-3.5 w-3.5 text-gold" /> {speed(d.downSpeed)}
        <ArrowUp strokeWidth={1.5} className="ml-2 h-3.5 w-3.5 text-live" /> {speed(d.upSpeed)}
      </span>
      {d.freeSpaceBytes !== undefined && (
        <span className="rounded-full border border-line px-2.5 py-1 text-muted">
          {bytes(d.freeSpaceBytes)} free
        </span>
      )}
      <span className="ml-auto text-faint" data-testid="qb-freshness">
        {sample ? "Sample data · " : ""}Live · read {ago(at).toLowerCase()}
        {d.version ? ` · v${d.version.replace(/ \(sample data\)$/, "")}` : ""}
      </span>
    </div>
  );
}

export function Bar({ t }: { t: Torrent }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/[0.07]"
        role="progressbar"
        aria-label={`${t.name}: ${t.progressPct}%`}
        aria-valuenow={t.progressPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cx(
            "h-full rounded-full transition-[width] duration-700 ease-out",
            TONE[t.status].bar,
          )}
          style={{ width: `${Math.min(100, t.progressPct)}%` }}
        />
      </div>
      <span className="w-14 text-right text-[0.82rem] text-ink tabular">
        {t.progressPct.toFixed(t.progressPct % 1 ? 1 : 0)}%
      </span>
    </div>
  );
}

export function Meta({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-faint">{label} </span>
      <span className={cx("tabular", warn ? "text-amber" : "text-ink/90")}>{value}</span>
    </span>
  );
}

/** The status pill a torrent wears in lists. */
export function StatusPill({ t, label }: { t: Torrent; label: string }) {
  return (
    <span
      className={cx(
        "fit-pill shrink-0 rounded-full border px-2 py-0.5 text-[0.72rem]",
        TONE[t.status].badge,
      )}
    >
      {label}
    </span>
  );
}

/** qBittorrent's settings view (categories, tags, its default folder), shared with Settings. */
export interface QbView {
  settings: { key: string; label: string; shown: string }[];
  categories: { name: string; savePath?: string }[];
  tags: string[];
  defaultSavePath?: string;
  transfer: { alternativeLimits: boolean };
}

/** The folder a category saves into, worked out as qBittorrent does. */
export function categoryFolder(category: string, view: QbView | undefined): string | undefined {
  const root = view?.defaultSavePath?.replace(/[\\/]+$/, "");
  if (!category) return root;
  const own = view?.categories.find((c) => c.name === category)?.savePath;
  if (own) return /^([a-z]:)?[\\/]/i.test(own) ? own : root ? `${root}/${own}` : own;
  return root ? `${root}/${category}` : undefined;
}
