import type { Service } from "./domain";

/**
 * What an app panel shows for services Hearth does not read inside yet (the
 * application-aware panels audit, 10-12): what the service is for, and why its panel is the
 * container view for now. Infrastructure is not an integration gap: for a database or a helper,
 * health, logs, and resources are the useful view. Kept honest: nothing here is invented data.
 */

export interface Coverage {
  /** What it is, in a few words. */
  role: string;
  kind: "infrastructure" | "planned" | "no-api" | "protected";
  /** Why there is no app view (yet), and what would add one. */
  note: string;
}

const RULES: [RegExp, Coverage][] = [
  [
    /postgres|mariadb|mysql/i,
    {
      role: "A database",
      kind: "infrastructure",
      note: "A database for the app it belongs to. Its health, restarts, logs, and memory below are what matter; its data is read through that app.",
    },
  ],
  [
    /redis|valkey/i,
    {
      role: "A cache",
      kind: "infrastructure",
      note: "A cache for the app it belongs to. Health, restarts, and memory below are what matter.",
    },
  ],
  [
    /gluetun/i,
    {
      role: "The VPN",
      kind: "protected",
      note: "Protected infrastructure. Hearth watches that the tunnel is up and never changes it. Changes need your separate approval.",
    },
  ],
  [
    /caddy|traefik/i,
    {
      role: "The reverse proxy",
      kind: "protected",
      note: "Protected infrastructure: routes and certificates are only read, never changed, without your separate approval. A read of its routes and certificate status is planned.",
    },
  ],
  [
    /flaresolverr/i,
    {
      role: "Prowlarr's Cloudflare helper",
      kind: "no-api",
      note: "It has no status worth reading beyond being up; Prowlarr's panel shows whether indexers that need it work.",
    },
  ],
  [
    /machine.?learning/i,
    {
      role: "Immich's photo recognition",
      kind: "infrastructure",
      note: "Immich's face and object recognition worker. Its health, memory, and logs below are what matter; Immich shows its jobs.",
    },
  ],
  [
    /nanohive/i,
    {
      role: "Audiobookshelf's themed front end",
      kind: "no-api",
      note: "A themed front end for Audiobookshelf (audiobooks.example.com); Audiobookshelf's panel shows the library.",
    },
  ],
  [
    /arr-dashboard/i,
    {
      role: "A dashboard for the *arr apps",
      kind: "no-api",
      note: "Its own page, from the same apps whose panels are here; nothing more to read.",
    },
  ],
  [
    /audiobook-organizer/i,
    {
      role: "Audiobook organizer (your own)",
      kind: "planned",
      note: "Your own tool; it has no API Hearth knows. Tell Ember what it should show here.",
    },
  ],
  [
    /jellyfin/i,
    {
      role: "Media server",
      kind: "planned",
      note: "Planned: sessions, transcoding, libraries, and scans. Needs a Jellyfin API key you create in Jellyfin (Dashboard > API Keys); it is not stored in a settings file Hearth can import.",
    },
  ],
  [
    /immich/i,
    {
      role: "Photo library",
      kind: "planned",
      note: "Planned: photo and video counts, storage, and background jobs. Needs an Immich API key you create in Immich (Account Settings > API Keys); Immich stores keys scrambled, so they cannot be imported.",
    },
  ],
  [
    /kavita/i,
    {
      role: "Book and comic library",
      kind: "planned",
      note: "Planned: libraries, recently added, and scans. Needs your Kavita API key (User settings > 3rd Party Clients).",
    },
  ],
  [
    /audiobookshelf/i,
    {
      role: "Audiobook library",
      kind: "planned",
      note: "Planned: libraries, listening sessions, and scans. Needs an Audiobookshelf API token (Settings > Users > your user).",
    },
  ],
  [
    /ersatztv/i,
    {
      role: "Live TV channels",
      kind: "planned",
      note: "Planned: channels and what is playing. ErsatzTV's API is still being checked.",
    },
  ],
  [
    /wizarr/i,
    {
      role: "Plex invitations",
      kind: "planned",
      note: "Planned: open invitations and new users. Needs a Wizarr API key.",
    },
  ],
  [
    /(^|\/)qui(:|$)|\bqui\b/i,
    {
      role: "qBittorrent web interface",
      kind: "no-api",
      note: "Another interface on the same qBittorrent; qBittorrent's own panel shows the torrents.",
    },
  ],
  [
    /recyclarr/i,
    {
      role: "Quality settings sync",
      kind: "no-api",
      note: "It runs on a schedule and has no live status. Its runs and the configuration plans are in Ember (config-edit, app-recyclarr-sync).",
    },
  ],
  [
    /kometa/i,
    {
      role: "Plex collections and posters",
      kind: "no-api",
      note: "Paused by you. It runs on a schedule with no live status; its logs are below.",
    },
  ],
  [
    /rustdesk|hbb[rs]/i,
    {
      role: "Remote desktop relay",
      kind: "infrastructure",
      note: "A relay server; being up and reachable is what matters, shown below.",
    },
  ],
  [
    /opnform/i,
    {
      role: "Forms",
      kind: "infrastructure",
      note: "Part of the OpnForm forms app; the containers' health and logs below are what matter.",
    },
  ],
  [
    /ha-?ui/i,
    {
      role: "The home panel",
      kind: "infrastructure",
      note: "The home.example.com panel for Belle and Saoirse; Home Assistant's own panel shows the home.",
    },
  ],
  [
    /nginx/i,
    {
      role: "A small web server",
      kind: "infrastructure",
      note: "Serves files; being up is what matters.",
    },
  ],
];

export function coverageOf(service: Pick<Service, "name" | "image">): Coverage {
  const text = `${service.image ?? ""} ${service.name}`;
  return (
    RULES.find(([re]) => re.test(text))?.[1] ?? {
      role: "A service",
      kind: "planned",
      note: "Hearth does not read inside this app yet; its container health, logs, and resources are below. Tell Ember what you would want to see here.",
    }
  );
}
