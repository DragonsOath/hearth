import type { Fetch } from "./http";
import { SHOW_TVDB, fakeMedia, type FakeMedia } from "../watches/fake-media";
import { fakeWizarr } from "./fake-wizarr";
import { fakePortainer } from "./fake-portainer";
import { fakeUptimeKuma } from "./fake-uptimekuma";
import { fakeTraefik } from "./fake-traefik";
import { fakeNpm } from "./fake-npm";
import { fakeProxmox } from "./fake-proxmox";
import { fakeAdguard } from "./fake-adguard";
import { fakePihole } from "./fake-pihole";
import { fakeDeluge } from "./fake-deluge";
import { fakeTransmission } from "./fake-transmission";
import { fakeNzbget } from "./fake-nzbget";
import { fakeNextcloud } from "./fake-nextcloud";
import { fakePaperless } from "./fake-paperless";
import { fakeVaultwarden } from "./fake-vaultwarden";
import { fakeTailscale } from "./fake-tailscale";
import { fakeWgEasy } from "./fake-wgeasy";
import { fakeNavidrome } from "./fake-navidrome";
import { fakeKomga } from "./fake-komga";
import { fakeGitea } from "./fake-gitea";
import { fakeMealie } from "./fake-mealie";
import { fakeActual } from "./fake-actual";
import { fakeAuthentik } from "./fake-authentik";
import { fakeFrigate } from "./fake-frigate";
import { fakeAuthelia } from "./fake-authelia";
import { fakeQbittorrent } from "./fake-qbittorrent";
import { fakeTautulli } from "./fake-tautulli";
import { fakeSabnzbd } from "./fake-sabnzbd";
import { fakeProwlarr } from "./fake-prowlarr";
import { fakeBazarr } from "./fake-bazarr";
import { fakeHomeAssistant } from "./fake-homeassistant";
import { fakeSyncthing } from "./fake-syncthing";
import { fakeArrV1 } from "./fake-arr-v1";
import { fakeLidarr } from "./fake-lidarr";
import { fakeJellyfin } from "./fake-jellyfin";
import { fakeTasterr } from "./fake-tasterr";
import { fakeMusicAssistant } from "./fake-music-assistant";
import { fakePlex } from "./fake-plex";
import { fakeImmich } from "./fake-immich";
import { fakeAudiobookshelf } from "./fake-audiobookshelf";
import { fakeKavita } from "./fake-kavita";
import { fakeRomm } from "./fake-romm";
import { fakeErsatz } from "./fake-ersatztv";
import { fakeRadarr } from "./fake-radarr";
import { fakeSonarr } from "./fake-sonarr";
import { fakeZoneMinder } from "./fake-zoneminder";

/**
 * Browser tests only (DC_FAKE_APPS=1, never set in a real install): a stand-in Sonarr that keeps
 * state, so plans made from a workspace run through the real planning, approval, re-reading, and
 * verification code. Every other app answers 404. Tests steer it through a route that exists only
 * when this is switched on: change a file's size (the target changed) or make a delete fail.
 */

interface EpisodeFile {
  id: number;
  seriesId: number;
  path: string;
  relativePath: string;
  size: number;
  quality: { quality: { name: string } };
}

const GB = 1024 ** 3;

function initialFiles(): EpisodeFile[] {
  const file = (id: number, name: string, gb: number, q: string): EpisodeFile => ({
    id,
    seriesId: 1,
    path: `/tv/Ghosts (US)/Season 2/${name}`,
    relativePath: `Season 2/${name}`,
    size: Math.round(gb * GB),
    quality: { quality: { name: q } },
  });
  return [
    file(101, "Ghosts.S02E01.1080p.mkv", 1.5, "WEBDL-1080p"),
    file(102, "Ghosts.S02E02.1080p.mkv", 1.4, "WEBDL-1080p"),
    file(103, "Ghosts.S02E03.720p.mkv", 0.7, "HDTV-720p"),
    file(104, "Ghosts.S02E04.720p.mkv", 0.8, "HDTV-720p"),
  ];
}

/** Sonarr's naming settings as a fresh install has them: renaming off. */
function initialNaming(): Record<string, unknown> {
  return {
    id: 1,
    renameEpisodes: false,
    replaceIllegalCharacters: true,
    standardEpisodeFormat:
      "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}",
    dailyEpisodeFormat: "{Series Title} - {Air-Date} - {Episode Title} {Quality Full}",
    animeEpisodeFormat:
      "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}",
    seriesFolderFormat: "{Series Title}",
    seasonFolderFormat: "Season {season}",
  };
}

export interface FakeApps {
  fetch: Fetch;
  /** The stand-in Home Assistant's live connection. */
  socket: import("./homeassistant").SocketFactory;
  state(): {
    naming: Record<string, unknown>;
    files: { id: number; path: string; size: number }[];
    deleted: number[];
    movies: ReturnType<FakeMedia["movies"]>;
  };
  control(c: {
    reset?: boolean;
    resize?: { id: number; gb: number };
    failDelete?: number;
    /** The stand-in ZoneMinder (Panel Builder): its events read fails. */
    zoneminder?: { eventsFail?: boolean };
    /** The stand-in Seerr and Radarr (watches/fake-media.ts). */
    media?: Parameters<FakeMedia["control"]>[0];
    /** Two finished torrents added by hand to the stand-in qBittorrent (manual sorting). */
    manualTorrents?: boolean;
    /** The stand-in Plex gets a second movie library, New Releases (Home rows setup). */
    plexNewReleases?: boolean;
    /** And a second show library, Kids TV (the local preview). */
    plexKidsTv?: boolean;
    /** And made-up animated family films with drawn posters (the website's clips). */
    plexFamily?: boolean;
    /** A new movie arrives in the stand-in Jellyfin (media announcements). */
    /** A new movie arrives in the stand-in Jellyfin (true: Quiet Harbor; a string: that title). */
    jellyfinArrival?: boolean | string;
    /** A new audiobook arrives in the stand-in Audiobookshelf (New in your library). */
    absArrival?: string;
    /** The stand-in Immich gets this many albums (Album 1 is the oldest). */
    immichAlbums?: number;
    /** The stand-in Home Assistant: its weather, the sun, or not answering. */
    home?: {
      condition?: string;
      sunUp?: boolean;
      down?: boolean;
      ring?: boolean;
      musicAssistant?: boolean;
      livingRoom?: boolean;
      googleSignInAgain?: boolean;
      googleSignInLost?: boolean;
    };
  }): void;
}

export function fakeApps(): FakeApps {
  let files = initialFiles();
  let deleted: number[] = [];
  let failing = new Set<number>();
  /** Whether the stand-in Sonarr monitors Ghosts (Seerr's Stop tracking turns it off). */
  let seriesMonitored = true;
  // Releases sent to the download client from an interactive search (the Seerr panel's What's
  // Missing): they show in the queue, with the episode they are for.
  let ghostsGrabbed: { title: string; episodeId: number }[] = [];
  // A stand-in Seerr and Radarr too, for release watch (watches/fake-media.ts).
  const media = fakeMedia();
  // And a stand-in Wizarr (port 5690) for its panel and invitations.
  const wizarr = fakeWizarr();
  // A stand-in Tasterr (8220): no API key, a Plex PIN or a login and a session cookie.
  const tasterr = fakeTasterr();
  // A stand-in Music Assistant API (8099): Up Next and likes on the music card.
  const musicAssistant = fakeMusicAssistant();
  // And a stand-in Tautulli (port 8181).
  const tautulli = fakeTautulli();
  // And a stand-in SABnzbd (port 8080).
  const sab = fakeSabnzbd();
  // And a stand-in qBittorrent 5.2 (port 8090) for its Settings tab.
  // And a stand-in AdGuard Home (port 3000).
  const adguard = fakeAdguard();
  const qbt = fakeQbittorrent();
  // And a stand-in Portainer (port 9000).
  const portainer = fakePortainer();
  // And a stand-in Uptime Kuma (port 3001).
  const kuma = fakeUptimeKuma();
  // And a stand-in Traefik (port 8082).
  const traefik = fakeTraefik();
  // And a stand-in Nginx Proxy Manager (port 81).
  const npm = fakeNpm();
  // And a stand-in Proxmox VE (port 8006).
  const proxmox = fakeProxmox();
  // And a stand-in Pi-hole 6 (port 8053).
  const pihole = fakePihole();
  // And a stand-in Deluge 2.2 Web UI (port 8112).
  const deluge = fakeDeluge();
  // And a stand-in Transmission 4.1 (port 9091).
  const transmission = fakeTransmission();
  // And a stand-in NZBGet 26 (port 6789).
  const nzbget = fakeNzbget();
  // And a stand-in Nextcloud 35 (port 11000).
  const nextcloud = fakeNextcloud();
  // And a stand-in Paperless-ngx 3.4 (port 8000).
  const paperless = fakePaperless();
  // And a stand-in Vaultwarden 1.37 (port 8222).
  const vaultwarden = fakeVaultwarden();
  // And a stand-in for Tailscale's cloud API (api.tailscale.com).
  const tailscale = fakeTailscale();
  // And a stand-in wg-easy 15 (port 51821).
  const wgeasy = fakeWgEasy();
  // And a stand-in Navidrome 0.64 (port 4533).
  const navidrome = fakeNavidrome();
  // And a stand-in Komga 1.30 (port 25600).
  const komga = fakeKomga();
  // And a stand-in Gitea 1.27 (port 3030).
  const gitea = fakeGitea();
  // And a stand-in Forgejo 13 (port 3031), which Gitea's panel reads too.
  const forgejo = fakeGitea({ forgejo: true });
  // And a stand-in Mealie 3.30 (port 9925).
  const mealie = fakeMealie();
  // And a stand-in Actual Budget server 26.11 (port 5006).
  const actual = fakeActual();
  // And a stand-in Authentik 2026.8 (port 9010).
  const authentik = fakeAuthentik();
  // And a stand-in Frigate 0.18 (port 8971).
  const frigate = fakeFrigate();
  // And a stand-in Authelia 4.39 (port 9092, its metrics on 9959).
  const authelia = fakeAuthelia();
  // And a stand-in Prowlarr (port 9696).
  const prowlarr = fakeProwlarr();
  // And a stand-in Bazarr (port 6767).
  const bazarr = fakeBazarr();
  // And a stand-in Home Assistant (port 8123).
  const ha = fakeHomeAssistant();
  // And a stand-in Syncthing (port 8384).
  const syncthing = fakeSyncthing();
  // And a stand-in Lidarr (8686) and Chaptarr (8789).
  const lidarr = fakeLidarr();
  const chaptarr = fakeArrV1("chaptarr");
  // And a stand-in Jellyfin (8096).
  const jellyfin = fakeJellyfin();
  // A stand-in Emby on the same port: the Emby tests' addresses end in .95.
  const emby = fakeJellyfin({ emby: true });
  // And a stand-in Plex (32400) for the Plex panel's own tabs.
  const plex = fakePlex();
  // And a stand-in Immich (2283).
  const immich = fakeImmich();
  // And a stand-in Audiobookshelf (13378).
  const abs = fakeAudiobookshelf();
  // And a stand-in Kavita (5000).
  const kavita = fakeKavita();
  // And a stand-in RomM (8095).
  const romm = fakeRomm();
  // And a stand-in ErsatzTV (8409).
  const ersatz = fakeErsatz();
  // And a full stand-in Radarr 6 (7879) for the native Radarr panel (fake-radarr.ts).
  const radarr = fakeRadarr();
  // And a full stand-in Sonarr 4 (8990) for the native Sonarr panel (fake-sonarr.ts); the small
  // one on 8989 stays for the older Sonarr tests.
  const sonarr = fakeSonarr();
  // And a stand-in ZoneMinder (8484): no Hearth panel, Panel Builder's proof app.
  const zoneminder = fakeZoneMinder();
  let naming = initialNaming();
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const p = u.pathname;
    // The home dashboard's news widget: a stand-in news feed.
    if (u.hostname === "news.test")
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () =>
          `<rss version="2.0"><channel><title>Town News</title><item><title>Harbor bridge reopens</title><link>https://news.test/bridge</link><pubDate>${new Date(Date.now() - 3_600_000).toUTCString()}</pubDate></item><item><title>Library opens late on Fridays</title><link>https://news.test/library</link></item></channel></rss>`,
      };
    // The weather: a place search, the National Weather Service (Testville) and Open-Meteo.
    if (u.hostname === "geocoding-api.open-meteo.com") {
      const q = u.searchParams.get("name") ?? "";
      const all = [
        {
          name: "Testville",
          latitude: 35.1,
          longitude: -110.2,
          admin1: "Arizona",
          country_code: "US",
          country: "United States",
        },
        {
          name: "Faraway",
          latitude: 51.5,
          longitude: -0.12,
          admin1: "England",
          country_code: "GB",
          country: "United Kingdom",
        },
      ];
      return reply(200, {
        results: all.filter((x) => x.name.toLowerCase().startsWith(q.toLowerCase())),
      });
    }
    if (u.hostname === "api.weather.gov") {
      const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
      if (p.startsWith("/points/"))
        return p.startsWith("/points/35.1")
          ? reply(200, {
              properties: {
                forecast: "https://api.weather.gov/gridpoints/TST/1,1/forecast",
                forecastHourly: "https://api.weather.gov/gridpoints/TST/1,1/forecast/hourly",
                observationStations: "https://api.weather.gov/gridpoints/TST/1,1/stations",
                relativeLocation: { properties: { city: "Testville", state: "AZ" } },
              },
            })
          : reply(404, { title: "Data Unavailable For Requested Point" });
      if (p.endsWith("/forecast/hourly"))
        return reply(200, {
          properties: {
            periods: [0, 1, 2, 3, 4, 5, 6, 7].map((h) => ({
              startTime: at(h),
              isDaytime: true,
              temperature: 70 + h,
              temperatureUnit: "F",
              shortForecast: h < 3 ? "Sunny" : "Chance Showers",
              probabilityOfPrecipitation: { value: h * 10 },
              relativeHumidity: { value: 20 },
              windSpeed: "10 mph",
              windDirection: "W",
            })),
          },
        });
      if (p.endsWith("/forecast"))
        return reply(200, {
          properties: {
            periods: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({
              startTime: at(i * 12),
              isDaytime: i % 2 === 0,
              temperature: i % 2 === 0 ? 80 : 55,
              temperatureUnit: "F",
              shortForecast: "Mostly Sunny",
              probabilityOfPrecipitation: { value: 5 },
            })),
          },
        });
      if (p.endsWith("/stations"))
        return reply(200, { features: [{ properties: { stationIdentifier: "KTST" } }] });
      if (p.endsWith("/observations/latest"))
        return reply(200, {
          properties: {
            timestamp: new Date().toISOString(),
            textDescription: "Clear",
            temperature: { value: 22.2 },
            relativeHumidity: { value: 18 },
            windSpeed: { value: 16 },
            windDirection: { value: 270 },
          },
        });
    }
    if (u.hostname === "api.open-meteo.com") {
      const hours = [0, 1, 2, 3, 4, 5, 6, 7].map(
        (h) => new Date(Date.now() + h * 3_600_000).toISOString().slice(0, 13) + ":00",
      );
      const days = [0, 1, 2, 3, 4, 5, 6].map((d) =>
        new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10),
      );
      return reply(200, {
        current: {
          temperature_2m: 9,
          relative_humidity_2m: 80,
          apparent_temperature: 7,
          weather_code: 61,
          wind_speed_10m: 8,
          wind_direction_10m: 200,
          is_day: 1,
        },
        hourly: {
          time: hours,
          temperature_2m: hours.map(() => 9),
          precipitation_probability: hours.map(() => 60),
          weather_code: hours.map(() => 61),
          is_day: hours.map(() => 1),
        },
        daily: {
          time: days,
          weather_code: days.map(() => 61),
          temperature_2m_max: days.map(() => 11),
          temperature_2m_min: days.map(() => 6),
          precipitation_probability_max: days.map(() => 70),
        },
      });
    }
    // The now-playing card's video: YouTube Music's video search, with one official video.
    if (u.hostname === "music.youtube.com") {
      const q = String((JSON.parse(init.body ?? "{}") as { query?: string }).query ?? "");
      const row = (id: string, type: string, title: string, line: string) => ({
        musicResponsiveListItemRenderer: {
          flexColumns: [title, line].map((t) => ({
            musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: t }] } },
          })),
          overlay: { videoId: id, musicVideoType: type },
        },
      });
      return reply(200, {
        contents: q.includes("Harbor Song")
          ? [
              row("aaaaaaaaaa1", "MUSIC_VIDEO_TYPE_UGC", "Harbor Song (lyrics)", "fan • 2K views"),
              row(
                "dQw4w9WgXcQ",
                "MUSIC_VIDEO_TYPE_OMV",
                "Harbor Song (Official Video)",
                "The Lighthouse Band • 3M views • 3:30",
              ),
            ]
          : [row("bbbbbbbbbb2", "MUSIC_VIDEO_TYPE_UGC", q, "someone • 10 views")],
      });
    }
    if (u.port === "5055" || u.port === "7878") return media.fetch(url, init);
    if (u.port === "8484") return zoneminder.fetch(url, init);
    // The movie database's public poster server: a 1x1 picture for any poster file.
    if (u.hostname === "image.tmdb.org" && /^\/t\/p\/w\d+\/[\w-]+\.jpg$/.test(u.pathname))
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
        json: async () => null,
        arrayBuffer: async () => {
          const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==",
            "base64",
          );
          return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
        },
      } as unknown as Awaited<ReturnType<Fetch>>;
    if (u.port === "5690") return wizarr.fetch(url, init);
    if (u.port === "3000") return adguard.fetch(url, init);
    if (u.port === "8181") return tautulli.fetch(url, init);
    if (u.port === "8080") return sab.fetch(url, init);
    if (u.port === "8090") return qbt.fetch(url, init);
    if (u.port === "9000") return portainer.fetch(url, init);
    if (u.port === "3001") return kuma.fetch(url, init);
    if (u.port === "8082") return traefik.fetch(url, init);
    if (u.port === "81") return npm.fetch(url, init);
    if (u.port === "8006") return proxmox.fetch(url, init);
    if (u.port === "8053") return pihole.fetch(url, init);
    if (u.port === "8112") return deluge.fetch(url, init);
    if (u.port === "9091") return transmission.fetch(url, init);
    if (u.port === "6789") return nzbget.fetch(url, init);
    if (u.port === "11000") return nextcloud.fetch(url, init);
    if (u.port === "8000") return paperless.fetch(url, init);
    if (u.port === "8222") return vaultwarden.fetch(url, init);
    if (u.port === "8220") return tasterr.fetch(url, init);
    if (u.port === "8099")
      return musicAssistant.fetch(url, init as Parameters<typeof musicAssistant.fetch>[1]) as never;
    if (u.hostname === "api.tailscale.com") return tailscale.fetch(url, init);
    if (u.port === "51821") return wgeasy.fetch(url, init);
    if (u.port === "4533") return navidrome.fetch(url, init);
    if (u.port === "25600") return komga.fetch(url, init);
    if (u.port === "3030") return gitea.fetch(url, init);
    if (u.port === "3031") return forgejo.fetch(url, init);
    if (u.port === "9925") return mealie.fetch(url, init);
    if (u.port === "5006") return actual.fetch(url, init);
    if (u.port === "9010") return authentik.fetch(url, init);
    if (u.port === "8971") return frigate.fetch(url, init);
    if (u.port === "9092" || u.port === "9959") return authelia.fetch(url, init);
    if (u.port === "9696") return prowlarr.fetch(url, init);
    if (u.port === "6767") return bazarr.fetch(url, init);
    if (u.port === "8123") return ha.fetch(url, init);
    if (u.port === "8384") return syncthing.fetch(url, init);
    if (u.port === "8686") return lidarr.fetch(url, init);
    if (u.port === "8789") return chaptarr.fetch(url, init);
    if (u.port === "8096") return (u.hostname.endsWith(".95") ? emby : jellyfin).fetch(url, init);
    if (u.port === "32400" || u.hostname === "plex.tv") return plex.fetch(url, init);
    if (u.port === "2283") return immich.fetch(url, init);
    if (u.port === "13378") return abs.fetch(url, init);
    if (u.port === "5000") return kavita.fetch(url, init);
    if (u.port === "8095") return romm.fetch(url, init);
    if (u.port === "8409") return ersatz.fetch(url, init);
    if (u.port === "7879") return radarr.fetch(url, init);
    if (u.port === "8990") return sonarr.fetch(url, init);
    if (u.port !== "8989") return reply(404, {});
    const ghosts = () => ({
      id: 1,
      title: "Ghosts (US)",
      year: 2021,
      tvdbId: SHOW_TVDB,
      monitored: seriesMonitored,
      qualityProfileId: 1,
      path: "/tv/Ghosts (US)",
      statistics: { episodeFileCount: 30, episodeCount: 40 },
      // Season 1 complete, season 2 half there; a new episode next week (the Seerr panel's
      // show card and its What you're missing).
      status: "continuing",
      nextAiring: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      seasons: [
        { seasonNumber: 0, monitored: false, statistics: { episodeFileCount: 0, episodeCount: 0 } },
        {
          seasonNumber: 1,
          monitored: true,
          statistics: { episodeFileCount: 20, episodeCount: 20 },
        },
        {
          seasonNumber: 2,
          monitored: true,
          statistics: { episodeFileCount: 10, episodeCount: 20 },
        },
      ],
    });
    // Season 2's missing half, aired and monitored, as Sonarr lists them for the series view.
    const ghostsMissing = Array.from({ length: 10 }, (_, i) => ({
      id: 9000 + i,
      seriesId: 1,
      seasonNumber: 2,
      episodeNumber: 11 + i,
      title: `Missing episode ${11 + i}`,
      airDateUtc: new Date(Date.now() - (30 - i) * 86_400_000).toISOString(),
      monitored: true,
      hasFile: false,
      episodeFileId: 0,
    }));
    // Season 3: the next episode next week, and one with no air date yet.
    const ghostsComing = [
      {
        id: 9100,
        seriesId: 1,
        seasonNumber: 3,
        episodeNumber: 1,
        title: "Premiere",
        airDateUtc: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        monitored: true,
        hasFile: false,
        episodeFileId: 0,
      },
      {
        id: 9101,
        seriesId: 1,
        seasonNumber: 3,
        episodeNumber: 2,
        title: "TBA",
        monitored: true,
        hasFile: false,
        episodeFileId: 0,
      },
    ];
    // What the indexers offer for one missing episode: one the rules accept, one over the size
    // limit, and one on the blocklist.
    const ghostsReleases = (episodeId: number) => {
      const e = ghostsMissing.find((x) => x.id === episodeId);
      if (!e) return [];
      const code = `S02E${String(e.episodeNumber).padStart(2, "0")}`;
      const r = (
        n: number,
        title: string,
        gb: number,
        q: { name: string; source: string; resolution: number },
        approved: boolean,
        rejections: string[],
      ) => ({
        guid: `ghosts-${episodeId}-${n}`,
        indexerId: 1,
        indexer: "Example Indexer",
        title,
        size: Math.round(gb * GB),
        protocol: "torrent",
        seeders: 40 - n * 10,
        leechers: 2,
        ageHours: 20 + n,
        quality: { quality: q },
        approved,
        rejections,
      });
      return [
        r(
          1,
          `Ghosts.US.${code}.1080p.WEB-DL.DDP5.1.H.264-GRP`,
          1.6,
          { name: "WEBDL-1080p", source: "web", resolution: 1080 },
          true,
          [],
        ),
        r(
          2,
          `Ghosts.US.${code}.2160p.WEB-DL.DDP5.1.DV.HEVC-GRP`,
          9.4,
          { name: "WEBDL-2160p", source: "web", resolution: 2160 },
          false,
          ["Release is larger than maximum allowed 4.0 GiB"],
        ),
        r(
          3,
          `Ghosts.US.${code}.720p.HDTV.x264-BAD`,
          0.8,
          { name: "HDTV-720p", source: "television", resolution: 720 },
          false,
          ["Release in the blocklist"],
        ),
      ];
    };
    if (p === "/api/v3/release" && method === "GET")
      return reply(200, ghostsReleases(Number(u.searchParams.get("episodeId"))));
    if (p === "/api/v3/release" && method === "POST") {
      const body = JSON.parse(init.body!) as { guid?: string };
      const ep = Number(String(body.guid).split("-")[1]);
      const rel = ghostsReleases(ep).find((x) => x.guid === body.guid);
      if (!rel) return reply(404, {});
      ghostsGrabbed.push({ title: rel.title, episodeId: ep });
      return reply(200, { title: rel.title });
    }
    if (p === "/api/v3/queue" && method === "GET")
      return reply(200, {
        records: ghostsGrabbed.map((g, i) => ({
          id: 500 + i,
          seriesId: 1,
          episodeId: g.episodeId,
          title: g.title,
          size: 1000,
          sizeleft: 600,
          status: "downloading",
          trackedDownloadState: "downloading",
        })),
      });
    if (p === "/api/v3/system/status") return reply(200, { version: "4.0.15.2941" });
    if (p === "/api/v3/qualityprofile" || p === "/api/v3/tag") return reply(200, []);
    if (p === "/api/v3/episodefile" && method === "GET") return reply(200, []);
    if (p === "/api/v3/series" && method === "GET") return reply(200, [ghosts()]);
    if (p === "/api/v3/series/1" && method === "PUT") {
      seriesMonitored = (JSON.parse(init.body!) as { monitored: boolean }).monitored;
      return reply(202, ghosts());
    }
    if (p === "/api/v3/series/1") return reply(200, ghosts());
    if (p === "/api/v3/episode" && method === "GET")
      return reply(
        200,
        files
          .map((f) => {
            // Its episode, from the file name ("Ghosts.S02E03..."), for the series view.
            const n = Number(/S\d\dE(\d\d)/.exec(f.relativePath)?.[1] ?? 0);
            return {
              id: f.id * 10,
              seriesId: 1,
              episodeFileId: f.id,
              hasFile: true,
              monitored: false,
              ...(n
                ? {
                    seasonNumber: 2,
                    episodeNumber: n,
                    title: `Episode ${n}`,
                    airDateUtc: new Date(Date.now() - (200 - n) * 86_400_000).toISOString(),
                  }
                : {}),
            };
          })
          .concat(
            u.searchParams.get("seriesId") === "1" ? [...ghostsMissing, ...ghostsComing] : [],
          ),
      );
    if (p === "/api/v3/config/naming") return reply(200, structuredClone(naming));
    if (p === "/api/v3/config/naming/1" && method === "PUT") {
      const body = JSON.parse(init.body!) as Record<string, unknown>;
      // Sonarr checks a format has an episode number before it saves it.
      if (
        typeof body.standardEpisodeFormat === "string" &&
        !/\{episode/i.test(body.standardEpisodeFormat)
      )
        return reply(400, [
          { propertyName: "StandardEpisodeFormat", errorMessage: "Must contain Episode numbers" },
        ]);
      Object.assign(naming, body);
      return reply(202, structuredClone(naming));
    }
    if (p === "/api/v3/config/mediamanagement")
      return reply(200, { recycleBin: "/tv/.recycle", recycleBinCleanupDays: 7 });
    const one = /^\/api\/v3\/episodefile\/(\d+)$/.exec(p);
    if (one) {
      const id = Number(one[1]);
      const f = files.find((x) => x.id === id);
      if (!f) return reply(404, {});
      if (method === "DELETE") {
        if (failing.has(id)) return reply(500, { message: "Disk is read-only" });
        files = files.filter((x) => x.id !== id);
        deleted.push(id);
        return reply(200, {});
      }
      return reply(200, structuredClone(f));
    }
    return reply(404, {});
  };
  return {
    fetch: fetchImpl,
    socket: ha.socket,
    state: () => ({
      naming: structuredClone(naming),
      files: files.map((f) => ({ id: f.id, path: f.path, size: f.size })),
      deleted: [...deleted],
      movies: media.movies(),
    }),
    control(c) {
      if (c.reset) {
        files = initialFiles();
        naming = initialNaming();
        deleted = [];
        failing = new Set();
        seriesMonitored = true;
        ghostsGrabbed = [];
        wizarr.reset();
        tasterr.reset();
        musicAssistant.reset();
        zoneminder.reset();
        radarr.reset();
        adguard.reset();
        sonarr.reset();
        tautulli.reset();
        sab.reset();
        qbt.reset();
        portainer.reset();
        kuma.reset();
        npm.reset();
        proxmox.reset();
        pihole.reset();
        deluge.reset();
        transmission.reset();
        nzbget.reset();
        nextcloud.reset();
        paperless.reset();
        vaultwarden.reset();
        tailscale.reset();
        wgeasy.reset();
        navidrome.reset();
        komga.reset();
        gitea.reset();
        forgejo.reset();
        mealie.reset();
        actual.reset();
        authentik.reset();
        frigate.reset();
        authelia.reset();
        prowlarr.reset();
        bazarr.reset();
        ha.reset();
        syncthing.reset();
        lidarr.reset();
        chaptarr.reset();
        jellyfin.reset();
        emby.reset();
        plex.reset();
        immich.reset();
        abs.reset();
        kavita.reset();
        romm.reset();
        ersatz.reset();
      }
      if (c.resize) {
        const f = files.find((x) => x.id === c.resize!.id);
        if (f) f.size = Math.round(c.resize.gb * GB);
      }
      if (c.plexNewReleases !== undefined || c.plexKidsTv !== undefined || c.plexFamily)
        plex.reset({
          newReleases: c.plexNewReleases,
          kidsTv: c.plexKidsTv,
          family: c.plexFamily,
        });
      if (c.failDelete !== undefined) failing.add(c.failDelete);
      if (c.media) media.control(c.media);
      if (c.zoneminder) zoneminder.control(c.zoneminder);
      if (c.immichAlbums) immich.seedAlbums(c.immichAlbums);
      if (c.manualTorrents) qbt.addManual();
      if (c.absArrival) abs.arrive(c.absArrival);
      if (c.home) ha.home(c.home);
      if (c.jellyfinArrival)
        jellyfin.arrive(typeof c.jellyfinArrival === "string" ? c.jellyfinArrival : undefined);
    },
  };
}
