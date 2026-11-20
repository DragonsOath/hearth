import { DownloadHealthLine } from "../downloads/DownloadHealthPanel";
import { SourceBadge } from "./SourceBadge";
import { useMemo } from "react";
import { Plus } from "lucide-react";
import { TORRENT_STATUS_LABEL, type Torrent } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { Button, Skeleton } from "../ui";
import { ClientProvider, DELUGE, QBITTORRENT, TRANSMISSION, useClient } from "./qbittorrent/client";
import { DelugeTorrents, QbTorrents, TransmissionTorrents } from "./qbittorrent/QbTorrents";
import { Bar, GROUPS, Header, StatusPill, eta, needsYou, sortBy, speed } from "./qbittorrent/parts";

/**
 * qBittorrent's Overview: how it is doing at a glance (connection, VPN, speeds, free space), what
 * needs you, what is downloading now, and the way into the Torrents tab, where everything is
 * managed (adding, pausing, categories, files, removing). Refreshed every two seconds while on
 * screen; reading never changes a torrent.
 */
type Props = {
  serviceId: string;
  /** Opens another tab of the panel (Torrents, Settings), at a place inside it. */
  onGo?: (tab: string, sub?: string | null) => void;
};

export function QbittorrentDashboard(props: Props) {
  return (
    <ClientProvider value={QBITTORRENT}>
      <TorrentOverview {...props} />
    </ClientProvider>
  );
}

/** Deluge's Overview: the same at-a-glance view, read from Deluge. */
export function DelugeDashboard(props: Props) {
  return (
    <ClientProvider value={DELUGE}>
      <TorrentOverview {...props} />
    </ClientProvider>
  );
}

/** Transmission's Overview: the same at-a-glance view, read from Transmission. */
export function TransmissionDashboard(props: Props) {
  return (
    <ClientProvider value={TRANSMISSION}>
      <TorrentOverview {...props} />
    </ClientProvider>
  );
}

function TorrentOverview({ serviceId, onGo }: Props) {
  const client = useClient();
  const q = useDashboard(serviceId);
  const d =
    q.data?.data?.app === "qbittorrent" ||
    q.data?.data?.app === "deluge" ||
    q.data?.data?.app === "transmission"
      ? q.data.data.app === client.app
        ? q.data.data
        : undefined
      : undefined;
  const needing = useMemo(
    () => (d ? d.torrents.filter(needsYou).sort(sortBy("attention")).slice(0, 5) : []),
    [d],
  );
  const active = useMemo(
    () =>
      d
        ? d.torrents
            .filter((t) => t.status === "downloading" || t.status === "metadata")
            .sort(sortBy("down"))
            .slice(0, 3)
        : [],
    [d],
  );

  // Outside a panel (no other tabs to open), the whole torrent list shows here.
  if (!onGo)
    return client.app === "deluge" ? (
      <DelugeTorrents serviceId={serviceId} name="Deluge" />
    ) : client.app === "transmission" ? (
      <TransmissionTorrents serviceId={serviceId} name="Transmission" />
    ) : (
      <QbTorrents serviceId={serviceId} name="qBittorrent" />
    );
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {client.name}: {q.error.message}
      </p>
    );
  if (q.data?.error) {
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="qb-error">
        <p className="text-amber">{client.name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  }
  if (!d) return null;
  const go = (sub?: string) => onGo("torrents", sub ?? null);

  return (
    <section
      className="@container space-y-4"
      aria-label={`${client.name} at a glance`}
      data-testid="qb-dashboard"
    >
      <Header d={d} at={q.data!.at} sample={q.data!.sample} />
      <DownloadHealthLine serviceId={serviceId} />
      <div className="flex flex-wrap gap-2">
        <Button
          tone="primary"
          onClick={() => go("add")}
          data-hearth-target="overview:add"
          data-testid="qb-overview-add"
        >
          <Plus strokeWidth={1.75} className="h-4 w-4" /> Add torrent
        </Button>
        <Button tone="outline" onClick={() => go()} data-testid="qb-all">
          All torrents ({d.torrents.length})
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Torrents by status">
        {GROUPS.filter((g) => g.id !== "all").map((g) => {
          const n = d.torrents.filter(g.test).length;
          if (!n) return null;
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => go(`status/${g.id}`)}
              className="min-h-9 rounded-full border border-line px-3 text-[0.76rem] text-muted tabular hover:border-gold/50 hover:text-ink"
            >
              {g.label} {n}
            </button>
          );
        })}
      </div>

      {needing.length > 0 && (
        <div data-testid="qb-needs-you">
          <p className="eyebrow mb-1.5 text-amber">Needs you</p>
          <ul className="space-y-1.5">
            {needing.map((t) => (
              <Line key={t.hash} t={t} onOpen={() => go(t.hash)} problem />
            ))}
          </ul>
        </div>
      )}
      <div data-testid="qb-downloading">
        <p className="eyebrow mb-1.5">Downloading now</p>
        {active.length ? (
          <ul className="space-y-1.5">
            {active.map((t) => (
              <Line key={t.hash} t={t} onOpen={() => go(t.hash)} />
            ))}
          </ul>
        ) : (
          <p className="text-[0.84rem] text-muted">Nothing is downloading right now.</p>
        )}
      </div>

      <button
        type="button"
        onClick={() => onGo("config")}
        className="min-h-11 w-full rounded-xl border border-line px-4 text-left text-[0.86rem] text-ink hover:border-gold/50"
        data-testid="qb-settings"
        data-hearth-target="overview:settings"
      >
        Seeding, speed, and queue settings
      </button>
    </section>
  );
}

/** One torrent as a line that opens it in the Torrents tab. */
function Line({ t, onOpen, problem }: { t: Torrent; onOpen: () => void; problem?: boolean }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="block w-full rounded-xl border border-line p-3 text-left hover:border-gold/50"
        data-testid="qb-line"
      >
        <span className="mb-1.5 flex flex-wrap items-start gap-2">
          <StatusPill t={t} label={TORRENT_STATUS_LABEL[t.status]} />
          <SourceBadge source={t.source} />
          <span className="min-w-0 flex-1 text-[0.88rem] leading-snug break-words text-ink">
            {t.name}
          </span>
        </span>
        <Bar t={t} />
        <span className="mt-1.5 block text-[0.78rem] text-muted tabular">
          {problem && t.problem
            ? t.problem
            : `${speed(t.downSpeed)}${eta(t.etaSec) ? ` · ${eta(t.etaSec)} left` : ""}`}
        </span>
      </button>
    </li>
  );
}
