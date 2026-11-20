import { AppSessions } from "../credentials/app-session";
import { AudiobookIntake } from "./audiobook-intake";
import { eq } from "drizzle-orm";
import {
  ACTIONS,
  APP_INTEGRATIONS,
  isCoreNetworking,
  TORRENT_ACTIONS,
  MEDIA_ACTIONS,
  WIZARR_ACTIONS,
  SEERR_ACTIONS,
  ARR_ACTIONS,
  ARR_RESOURCE_ACTIONS,
  type ActionKind,
  type Requester,
  type StepChange,
  type StepParams,
} from "@dragon-control/core";
import type { ActionRunner } from "../actions/service";
import type { Vault } from "../auth/vault";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { recordAudit } from "../store/audit";
import type { Memory } from "../memory/service";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { AppKeyError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";
import { CredentialBroker, fitsNeed, needOf } from "../credentials/broker";
import { appOf } from "./service";
import { TorrentOperations } from "./torrent-operations";
import { CONTROL_ACTIONS } from "./qbittorrent-control";
import { MediaOperations } from "./media-operations";
import { ArrResourceOperations, ResourcePlanError } from "./arr-resource-operations";
import { ArrOperations } from "./arr-operations";
import { MediaLibrary } from "./media-library";
import { WizarrOperations } from "./wizarr";
import { SeerrOperations } from "./seerr-ops";
import { SeerrLibrary } from "./seerr-library";
import { MovieReleases } from "../watches/movie-release";
import { RadarrFolderOperations } from "./radarr-folder";
import { TautulliOperations } from "./tautulli";
import { TautulliControl } from "./tautulli-control";
import { SabnzbdOperations } from "./sabnzbd-live";
import { ProwlarrOperations } from "./prowlarr-live";
import { BazarrOperations } from "./bazarr-live";
import { HomeAssistantOperations } from "./homeassistant-live";
import { SyncthingOperations } from "./syncthing-live";
import { LibraryOperations } from "./arr-v1-live";
import { JellyfinOperations } from "./jellyfin";
import { PlexOperations } from "./plex-control";
import { DelugeOperations } from "./deluge-control";
import { TransmissionOperations } from "./transmission-control";
import { NzbgetOperations } from "./nzbget-control";
import { ImmichOperations } from "./immich";
import { AudiobookshelfOperations } from "./audiobookshelf";
import { KavitaOperations } from "./kavita";
import { PortainerOperations } from "./portainer-control";
import { KumaOperations } from "./uptimekuma-control";
import { NextcloudOperations } from "./nextcloud-control";
import { PaperlessOperations } from "./paperless-control";
import { VaultwardenOperations } from "./vaultwarden-control";
import { TailscaleOperations } from "./tailscale-control";
import { WgEasyOperations } from "./wgeasy-control";
import { NavidromeOperations } from "./navidrome-control";
import { KomgaOperations } from "./komga-control";
import { MealieOperations } from "./mealie-control";
import { AuthentikOperations } from "./authentik-control";
import { FrigateOperations } from "./frigate-control";
import { GiteaOperations } from "./gitea-control";
import { NpmOperations } from "./npm-control";
import { localTlsFetch } from "./local-tls";
import { ProxmoxOperations } from "./proxmox-control";
import { AdguardOperations } from "./adguard-control";
import { PiholeOperations } from "./pihole-control";
import { RommOperations } from "./romm";
import { ErsatzOperations } from "./ersatztv";
import {
  API_METHODS,
  appApi,
  authProblem,
  bodyProblem,
  followCommand,
  pathProblem,
  type ApiApp,
  type ApiMethod,
  type ApiRequest,
} from "./app-api";

/**
 * Operations inside applications, through each app's own API: the repair
 * framework's first rung above container actions. Each operation is fixed
 * code with typed parameters (never a shell, a file edit, or Docker), runs
 * only as a step of a plan, and follows one pattern:
 *
 * 1. plan: read the current state from the app and describe the exact change
 *    (before and after). Approval covers those values (job fingerprint).
 * 2. run: check the policy again; read again and stop if the app no longer
 *    matches "before" (it changed since you approved); apply; read back to
 *    verify; audit with before and after.
 * 3. undo: put back the "before" value if a later step fails.
 *
 * Credentials come from the Secure Vault and are used server side only. A
 * resource read back from an app (which can include its own secrets, like an
 * indexer's key) is sent back unchanged and never stored, logged, or shown.
 *
 * Supported: Prowlarr indexers (test; turn on or off) and one torrent at a
 * time in qBittorrent (resume, pause, reannounce, recheck; torrent-operations.ts).
 * The same pattern extends to Radarr and Sonarr.
 */

interface IndexerResource {
  id: number;
  name: string;
  enable: boolean;
  [field: string]: unknown;
}

class PlanError extends Error {}

const yesNo = (b: boolean) => (b ? "On" : "Off");

/** Which Servarr app a service is, for the shared resource steps. */
const servarrOf = (service: Parameters<typeof appOf>[0]) =>
  appOf(service) === "radarr"
    ? "radarr"
    : appOf(service) === "prowlarr"
      ? "prowlarr"
      : appOf(service) === "lidarr"
        ? "lidarr"
        : "sonarr";

export class AppOperations {
  private readonly broker: CredentialBroker;
  private readonly torrents: TorrentOperations;
  private readonly media: MediaOperations;
  private readonly resources: ArrResourceOperations;
  private readonly arr: ArrOperations;
  private readonly wizarr: WizarrOperations;
  private readonly seerr: SeerrOperations;
  private readonly folders: RadarrFolderOperations;
  private readonly tautulli: TautulliOperations;
  private readonly tautulliControl: TautulliControl;
  private readonly sab: SabnzbdOperations;
  private readonly prowlarr: ProwlarrOperations;
  private readonly bazarr: BazarrOperations;
  private readonly ha: HomeAssistantOperations;
  private readonly syncthing: SyncthingOperations;
  private readonly library: LibraryOperations;
  private readonly jellyfin: JellyfinOperations;
  private readonly plex: PlexOperations;
  private readonly immich: ImmichOperations;
  private readonly deluge: DelugeOperations;
  private readonly transmission: TransmissionOperations;
  private readonly nzbget: NzbgetOperations;
  private readonly abs: AudiobookshelfOperations;
  private readonly adguard: AdguardOperations;
  private readonly kavita: KavitaOperations;
  private readonly portainer: PortainerOperations;
  private readonly kuma: KumaOperations;
  private readonly nextcloud: NextcloudOperations;
  private readonly paperless: PaperlessOperations;
  private readonly vaultwarden: VaultwardenOperations;
  private readonly tailscale: TailscaleOperations;
  private readonly wgeasy: WgEasyOperations;
  private readonly navidrome: NavidromeOperations;
  private readonly komga: KomgaOperations;
  private readonly mealie: MealieOperations;
  private readonly authentik: AuthentikOperations;
  private readonly frigate: FrigateOperations;
  private readonly gitea: GiteaOperations;
  private readonly npm: NpmOperations;
  private readonly proxmox: ProxmoxOperations;
  private readonly pihole: PiholeOperations;
  private readonly romm: RommOperations;
  private readonly ersatz: ErsatzOperations;
  private readonly sessions: AppSessions;

  constructor(
    private readonly handle: DbHandle,
    vault: Vault,
    private readonly runner: ActionRunner,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
    /** Verified changes become journal entries (facts only), like verified repairs. */
    private readonly memory?: Memory,
    /** Waiting between read-backs after a torrent repair (tests pass a no-op). */
    wait?: (ms: number) => Promise<void>,
    /** Home Assistant's live connection (browser tests pass the stand-in's). */
    haSocket?: import("./homeassistant").SocketFactory,
  ) {
    this.broker = new CredentialBroker(handle, vault);
    // Apps with no API key that Hearth reads with a saved sign-in (auth "session", such as Tasterr
    // signed in with Plex): an approved change is sent with that sign-in too (11-19).
    this.sessions = new AppSessions(handle, vault, this.broker, () => fetchImpl);
    this.torrents = new TorrentOperations(handle, this.broker, fetchImpl, memory, wait);
    this.media = new MediaOperations(handle, this.broker, fetchImpl, memory);
    this.resources = new ArrResourceOperations(handle, this.broker, fetchImpl, memory);
    this.arr = new ArrOperations(handle, new MediaLibrary(this.broker, fetchImpl), memory, wait);
    this.wizarr = new WizarrOperations(handle, this.broker, fetchImpl);
    this.seerr = new SeerrOperations(
      handle,
      this.broker,
      fetchImpl,
      new SeerrLibrary(new MovieReleases(handle, this.broker, fetchImpl)),
    );
    this.folders = new RadarrFolderOperations(handle, this.broker, fetchImpl);
    this.tautulli = new TautulliOperations(handle, this.broker, fetchImpl, wait);
    this.tautulliControl = new TautulliControl(handle, this.broker, fetchImpl);
    this.sab = new SabnzbdOperations(handle, this.broker, fetchImpl);
    this.prowlarr = new ProwlarrOperations(handle, this.broker, fetchImpl, wait);
    this.bazarr = new BazarrOperations(handle, this.broker, fetchImpl);
    this.ha = new HomeAssistantOperations(handle, this.broker, fetchImpl, wait, haSocket);
    this.syncthing = new SyncthingOperations(handle, this.broker, fetchImpl);
    this.library = new LibraryOperations(handle, this.broker, fetchImpl, wait);
    this.jellyfin = new JellyfinOperations(handle, this.broker, fetchImpl, wait);
    this.plex = new PlexOperations(handle, this.broker, fetchImpl);
    this.immich = new ImmichOperations(handle, this.broker, fetchImpl);
    this.deluge = new DelugeOperations(handle, this.broker, fetchImpl);
    this.transmission = new TransmissionOperations(handle, this.broker, fetchImpl);
    this.nzbget = new NzbgetOperations(handle, this.broker, fetchImpl);
    this.abs = new AudiobookshelfOperations(
      handle,
      this.broker,
      fetchImpl,
      new AudiobookIntake(handle, this.broker, fetchImpl, {
        mounts: (c) => runner.containerTools.mounts(c),
        qbSession: (s) => this.torrents.sessionFor(s),
      }),
    );
    this.kavita = new KavitaOperations(handle, this.broker, fetchImpl);
    this.portainer = new PortainerOperations(handle, this.broker, fetchImpl);
    this.kuma = new KumaOperations(handle, this.broker, fetchImpl);
    this.nextcloud = new NextcloudOperations(handle, this.broker, fetchImpl);
    this.paperless = new PaperlessOperations(handle, this.broker, fetchImpl);
    this.vaultwarden = new VaultwardenOperations(handle, this.broker, fetchImpl);
    this.tailscale = new TailscaleOperations(handle, this.broker, fetchImpl);
    this.wgeasy = new WgEasyOperations(handle, this.broker, fetchImpl);
    this.navidrome = new NavidromeOperations(handle, this.broker, fetchImpl);
    this.komga = new KomgaOperations(handle, this.broker, fetchImpl);
    this.mealie = new MealieOperations(handle, this.broker, fetchImpl);
    this.authentik = new AuthentikOperations(handle, this.broker, fetchImpl);
    // Frigate's signed-in port uses its own self-signed certificate, as Proxmox does.
    this.frigate = new FrigateOperations(
      handle,
      this.broker,
      fetchImpl === (fetch as unknown as Fetch) ? localTlsFetch : fetchImpl,
    );
    this.gitea = new GiteaOperations(handle, this.broker, fetchImpl);
    this.npm = new NpmOperations(handle, this.broker, fetchImpl);
    // Proxmox answers with its own self-signed certificate: reached through a pinned connection,
    // unless a stand-in is in use (tests).
    this.proxmox = new ProxmoxOperations(
      handle,
      this.broker,
      fetchImpl === (fetch as unknown as Fetch) ? localTlsFetch : fetchImpl,
      wait,
    );
    this.adguard = new AdguardOperations(handle, this.broker, fetchImpl);
    this.pihole = new PiholeOperations(handle, this.broker, fetchImpl);
    this.romm = new RommOperations(handle, this.broker, fetchImpl);
    this.ersatz = new ErsatzOperations(handle, fetchImpl);
  }

  /** The service and its credential, or why this operation cannot be done there at all. */
  private async target(kind: ActionKind, serviceId: string) {
    const service = await this.handle.db
      .select()
      .from(t.services)
      .where(eq(t.services.id, serviceId))
      .get();
    if (!service) throw new PlanError("No such service.");
    if (kind === "app-api-call") return this.apiTarget(service);
    const torrent = TORRENT_ACTIONS.includes(kind);
    const media = MEDIA_ACTIONS.includes(kind) || ARR_ACTIONS.includes(kind);
    // Import and search work in either Sonarr or Radarr: the service decides which.
    // The shared resource steps (edit, add, remove, command) also cover Prowlarr (Phase 3).
    // The Crucible's Save goes to the Radarr (or, later, Sonarr) it was made for.
    const arrApp =
      kind.startsWith("app-arr-") || kind === "app-crucible-apply"
        ? appOf(service) === "radarr"
          ? "radarr"
          : (appOf(service) === "prowlarr" || appOf(service) === "lidarr") &&
              ARR_RESOURCE_ACTIONS.includes(kind)
            ? appOf(service)
            : "sonarr"
        : undefined;
    const app =
      kind === "app-ersatztv-control"
        ? "ersatztv"
        : kind === "app-kavita-control"
          ? "kavita"
          : kind === "app-portainer-control"
            ? "portainer"
            : kind === "app-uptimekuma-control"
              ? "uptimekuma"
              : kind === "app-nextcloud-control"
                ? "nextcloud"
                : kind === "app-paperless-control"
                  ? "paperless"
                  : kind === "app-vaultwarden-control"
                    ? "vaultwarden"
                    : kind === "app-tailscale-control"
                      ? "tailscale"
                      : kind === "app-wgeasy-control"
                        ? "wgeasy"
                        : kind === "app-navidrome-control"
                          ? "navidrome"
                          : kind === "app-komga-control"
                            ? "komga"
                            : kind === "app-mealie-control"
                              ? "mealie"
                              : kind === "app-authentik-control"
                                ? "authentik"
                                : kind === "app-frigate-control"
                                  ? "frigate"
                                  : kind === "app-gitea-control"
                                    ? "gitea"
                                    : kind === "app-npm-control"
                                      ? "npm"
                                      : kind === "app-proxmox-control"
                                        ? "proxmox"
                                        : kind === "app-pihole-control"
                                          ? "pihole"
                                          : kind === "app-adguard-control"
                                            ? "adguard"
                                            : kind === "app-romm-control"
                                              ? "romm"
                                              : kind === "app-audiobookshelf-control"
                                                ? "audiobookshelf"
                                                : kind === "app-immich-control"
                                                  ? "immich"
                                                  : kind === "app-deluge-control"
                                                    ? "deluge"
                                                    : kind === "app-transmission-control"
                                                      ? "transmission"
                                                      : kind === "app-nzbget-control"
                                                        ? "nzbget"
                                                        : kind === "app-jellyfin-control"
                                                          ? "jellyfin"
                                                          : kind === "app-lidarr-control"
                                                            ? "lidarr"
                                                            : kind === "app-chaptarr-control"
                                                              ? "chaptarr"
                                                              : kind === "app-syncthing-control"
                                                                ? "syncthing"
                                                                : kind ===
                                                                    "app-homeassistant-control"
                                                                  ? "homeassistant"
                                                                  : kind === "app-bazarr-subtitles"
                                                                    ? "bazarr"
                                                                    : kind ===
                                                                        "app-prowlarr-indexer"
                                                                      ? "prowlarr"
                                                                      : kind ===
                                                                          "app-sabnzbd-control"
                                                                        ? "sabnzbd"
                                                                        : kind ===
                                                                              "app-tautulli-stop-stream" ||
                                                                            kind ===
                                                                              "app-tautulli-control"
                                                                          ? "tautulli"
                                                                          : kind ===
                                                                              "app-radarr-set-root-folder"
                                                                            ? "radarr"
                                                                            : SEERR_ACTIONS.includes(
                                                                                  kind,
                                                                                )
                                                                              ? "seerr"
                                                                              : WIZARR_ACTIONS.includes(
                                                                                    kind,
                                                                                  )
                                                                                ? "wizarr"
                                                                                : torrent
                                                                                  ? "qbittorrent"
                                                                                  : kind ===
                                                                                        "app-plex-delete-media" ||
                                                                                      kind ===
                                                                                        "app-plex-control"
                                                                                    ? "plex"
                                                                                    : arrApp
                                                                                      ? arrApp
                                                                                      : kind.startsWith(
                                                                                            "app-sonarr-",
                                                                                          )
                                                                                        ? "sonarr"
                                                                                        : media
                                                                                          ? "radarr"
                                                                                          : "prowlarr";
    const APP_NAME = {
      qbittorrent: "qBittorrent",
      deluge: "Deluge",
      transmission: "Transmission",
      nzbget: "NZBGet",
      plex: "Plex",
      radarr: "Radarr",
      sonarr: "Sonarr",
      prowlarr: "Prowlarr",
      wizarr: "Wizarr",
      seerr: "Overseerr or Jellyseerr",
      tautulli: "Tautulli",
      sabnzbd: "SABnzbd",
      bazarr: "Bazarr",
      homeassistant: "Home Assistant",
      syncthing: "Syncthing",
      lidarr: "Lidarr",
      adguard: "AdGuard Home",
      chaptarr: "Chaptarr",
      jellyfin: "Jellyfin",
      immich: "Immich",
      audiobookshelf: "Audiobookshelf",
      kavita: "Kavita",
      portainer: "Portainer",
      uptimekuma: "Uptime Kuma",
      nextcloud: "Nextcloud",
      paperless: "Paperless-ngx",
      vaultwarden: "Vaultwarden",
      tailscale: "Tailscale",
      wgeasy: "wg-easy",
      navidrome: "Navidrome",
      komga: "Komga",
      mealie: "Mealie",
      actual: "Actual Budget",
      authentik: "Authentik",
      frigate: "Frigate",
      authelia: "Authelia",
      gitea: "Gitea",
      traefik: "Traefik",
      npm: "Nginx Proxy Manager",
      proxmox: "Proxmox VE",
      pihole: "Pi-hole",
      romm: "RomM",
      ersatztv: "ErsatzTV",
      emby: "Emby",
    };
    // Emby takes Jellyfin's steps: it speaks the same API.
    if (appOf(service) !== app && !(app === "jellyfin" && appOf(service) === "emby")) {
      throw new PlanError(
        `${ACTIONS[kind].describe(service.name)} is only supported for ${APP_NAME[app]}.`,
      );
    }
    // Protected infrastructure never takes configuration changes through this path, except
    // Pi-hole's, AdGuard Home's, Nginx Proxy Manager's, Tailscale's and wg-easy's own typed
    // controls: every one of their plans is marked protected, so approving it asks the owner to
    // confirm it is them.
    if (
      isCoreNetworking(service.name, service.image) &&
      kind !== "app-pihole-control" &&
      kind !== "app-adguard-control" &&
      kind !== "app-npm-control" &&
      kind !== "app-tailscale-control" &&
      kind !== "app-wgeasy-control"
    ) {
      throw new PlanError(
        `${service.name} is protected infrastructure; changing it needs a separate, explicit authorization.`,
      );
    }
    if (service.lifecycle !== "active") {
      throw new PlanError(
        service.lifecycle === "removed"
          ? `${service.name} was removed from Hearth, so Hearth leaves it alone.`
          : `${service.name} is ${service.lifecycle}, so Hearth leaves it alone.`,
      );
    }
    if (service.checkTarget?.startsWith("demo:")) {
      throw new PlanError(`Sample data: there is no real ${service.name} to change.`);
    }
    // Tailscale is changed through its own cloud API, not at the service's address.
    if (!service.localUrl && kind !== "app-tailscale-control")
      throw new PlanError(`Hearth does not know ${service.name}'s address.`);
    if (torrent || media) {
      // The Web UI login, through the broker; every torrent repair is a change, so its scope must allow approved changes.
      const why = await this.broker.canChange(service.id);
      if (why) throw new PlanError(why);
      return { service, credentialOf: service.id };
    }
    // An app that takes no key (ErsatzTV): the plan you confirm is the only gate.
    if (APP_INTEGRATIONS[app].credential === "none") return { service, credentialOf: service.id };
    const secret = (
      await this.handle.db
        .select()
        .from(t.vaultSecrets)
        .where(eq(t.vaultSecrets.serviceId, service.id))
    ).find((s) => s.tier === "automation" && fitsNeed(needOf(service), s));
    if (!secret) {
      throw new PlanError(
        `Add ${service.name}'s ${APP_INTEGRATIONS[app].credential === "login" ? "login" : "API key"} to the vault first (${APP_INTEGRATIONS[app].where}).`,
      );
    }
    // A configuration change also needs the credential's scope to allow approved changes.
    if (ACTIONS[kind].changes) {
      const why = await this.broker.canChange(service.id);
      if (why) throw new PlanError(why);
    }
    return { service, credentialOf: service.id };
  }

  /** app-api-call works in any app Hearth can sign in to; changes need the approved-changes scope. */
  private async apiTarget(service: typeof t.services.$inferSelect) {
    const app = appOf(service);
    // An app Hearth has no reader for is reached at its own web address (generic).
    if (!app && !/^https?:\/\//.test(service.localUrl ?? ""))
      throw new PlanError(`Hearth does not know a web address for ${service.name}.`);
    if (isCoreNetworking(service.name, service.image))
      throw new PlanError(
        `${service.name} is protected infrastructure; changing it needs a separate, explicit authorization.`,
      );
    if (service.lifecycle !== "active")
      throw new PlanError(`${service.name} is ${service.lifecycle}, so Hearth leaves it alone.`);
    if (service.checkTarget?.startsWith("demo:"))
      throw new PlanError(`Sample data: there is no real ${service.name} to change.`);
    if (!service.localUrl) throw new PlanError(`Hearth does not know ${service.name}'s address.`);
    // A generic app needs its credential to allow changes only when it has one.
    if (app ? APP_INTEGRATIONS[app].credential !== "none" : await this.broker.has(service.id)) {
      const why = await this.broker.canChange(service.id);
      if (why) throw new PlanError(why);
    }
    return { service, credentialOf: service.id };
  }

  private apiRequest(params: StepParams | undefined, app: ApiApp): ApiRequest & { why: string } {
    const method = String(params?.method ?? "").toUpperCase() as ApiMethod;
    if (!API_METHODS.includes(method) || method === "GET")
      throw new PlanError("Say the method: POST, PUT, PATCH, or DELETE (reads need no plan).");
    const path = typeof params?.path === "string" ? params.path : "";
    const body = typeof params?.body === "string" && params.body ? params.body : undefined;
    const auth = app === "generic" && typeof params?.auth === "string" ? params.auth : undefined;
    const problem = pathProblem(path) ?? bodyProblem(app, body) ?? authProblem(auth);
    if (problem) throw new PlanError(problem);
    const why = typeof params?.why === "string" ? params.why.trim() : "";
    return { method, path, ...(body ? { body } : {}), ...(auth ? { auth } : {}), why };
  }

  /** Sends an approved request and reports the app's answer (and an *arr command's outcome). */
  private async apiSend(service: typeof t.services.$inferSelect, app: ApiApp, req: ApiRequest) {
    const base = service.localUrl!;
    const name = app === "generic" ? service.name : APP_INTEGRATIONS[app].name;
    const keyless =
      app === "generic"
        ? req.auth === "none" || !(await this.broker.has(service.id))
        : APP_INTEGRATIONS[app].credential === "none";
    const once = (r: ApiRequest, access: "read" | "change") =>
      r.auth === "session"
        ? this.sessions.withSession(
            service.id,
            `${r.method} ${r.path.split("?")[0]} (approved plan)`,
            (cred, headers) => appApi(this.fetchImpl, app, name, base, cred, r, headers),
          )
        : keyless
          ? appApi(this.fetchImpl, app, name, base, undefined, r)
          : this.broker.use(
              {
                serviceId: service.id,
                purpose: `${r.method} ${r.path.split("?")[0]} (approved plan)`,
                access,
                destination: joinUrl(base, r.path),
              },
              (cred) => appApi(this.fetchImpl, app, name, base, cred, r),
            );
    const first = await once(req, "change");
    return followCommand(req, first, (path) =>
      once({ method: "GET", path, ...(req.auth ? { auth: req.auth } : {}) }, "read"),
    );
  }

  private async call<T>(
    base: string,
    credentialOf: string,
    method: "GET" | "PUT" | "POST",
    path: string,
    purpose: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: T }> {
    // Through the broker: only to this service's own address; PUT changes settings, so it
    // needs a credential scoped for approved changes (the plan approval is checked by the engine).
    return this.broker.use(
      {
        serviceId: credentialOf,
        purpose,
        access: method === "PUT" ? "change" : "read",
        destination: joinUrl(base, path),
      },
      async ({ value }) => {
        const res = await this.fetchImpl(joinUrl(base, path), {
          method,
          headers: {
            "X-Api-Key": value,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS * 3),
        });
        if (res.status === 401 || res.status === 403) {
          throw new AppKeyError("Prowlarr refused the API key. Check the key in the vault.");
        }
        const data = (await res.json().catch(() => undefined)) as T;
        return { ok: res.ok, status: res.status, data };
      },
    );
  }

  /** Finds the indexer by id or by name (as the AI or you wrote it). */
  private async indexer(
    base: string,
    credentialOf: string,
    params: StepParams | undefined,
  ): Promise<IndexerResource> {
    const list = await this.call<IndexerResource[]>(
      base,
      credentialOf,
      "GET",
      "/api/v1/indexer",
      "find an indexer",
    );
    if (!list.ok || !Array.isArray(list.data))
      throw new PlanError(`Prowlarr answered ${list.status}.`);
    const byId = typeof params?.indexerId === "number" ? params.indexerId : undefined;
    const byName =
      typeof params?.indexer === "string" ? params.indexer.trim().toLowerCase() : undefined;
    const found = list.data.find(
      (i) =>
        (byId !== undefined && i.id === byId) ||
        (byName !== undefined && i.name.toLowerCase() === byName),
    );
    if (!found) {
      throw new PlanError(
        `Prowlarr has no indexer ${byName ? `named "${params!.indexer}"` : `#${byId ?? "?"}`}. It has: ${list.data
          .map((i) => i.name)
          .join(", ")}.`,
      );
    }
    return found;
  }

  async plan(
    step: { kind: ActionKind; serviceId: string; params?: StepParams },
    requestedBy: Requester,
  ): Promise<PlannedStep> {
    const base: PlannedStep = {
      label: ACTIONS[step.kind].describe(step.serviceId),
      serviceName: step.serviceId,
      changes: ACTIONS[step.kind].changes,
      policy: "refuse",
      policyReason: "",
    };
    try {
      const { service, credentialOf } = await this.target(step.kind, step.serviceId);
      const { decision } = await this.runner.policyFor(step.kind, service.id, requestedBy);
      if (step.kind === "app-api-call") {
        const req = this.apiRequest(step.params, appOf(service) ?? "generic");
        const where = req.path.split("?")[0];
        const change: StepChange = {
          summary: `${req.why || `${req.method} ${where}`} in ${service.name}`,
          settings: [
            {
              name: `${req.method} ${req.path}`.slice(0, 300),
              before: `As it is now in ${service.name}`,
              after: req.body
                ? `Sent to ${service.name}'s own API with: ${req.body.slice(0, 1500)}${req.body.length > 1500 ? "..." : ""}`
                : `Sent to ${service.name}'s own API`,
            },
          ],
        };
        return {
          ...base,
          label: change.summary,
          serviceName: service.name,
          params: {
            method: req.method,
            path: req.path,
            ...(req.body ? { body: req.body } : {}),
            // How it signs in (a saved sign-in for a custom panel's app): dropped here before
            // 11-19, so Tasterr's Request went without its sign-in and was refused (401).
            ...(req.auth ? { auth: req.auth } : {}),
            why: req.why,
          },
          change,
          policy: decision.outcome,
          policyReason: decision.reason,
        };
      }
      if (step.kind === "app-ersatztv-control") {
        const planned = await this.ersatz.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-romm-control") {
        const planned = await this.romm.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-pihole-control") {
        const planned = await this.pihole.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-adguard-control") {
        const planned = await this.adguard.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-proxmox-control") {
        const planned = await this.proxmox.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-npm-control") {
        const planned = await this.npm.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-gitea-control") {
        const planned = await this.gitea.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-frigate-control") {
        const planned = await this.frigate.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-authentik-control") {
        const planned = await this.authentik.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-mealie-control") {
        const planned = await this.mealie.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-komga-control") {
        const planned = await this.komga.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-navidrome-control") {
        const planned = await this.navidrome.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-wgeasy-control") {
        const planned = await this.wgeasy.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-tailscale-control") {
        const planned = await this.tailscale.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl ?? "" },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-vaultwarden-control") {
        const planned = await this.vaultwarden.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-paperless-control") {
        const planned = await this.paperless.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-nextcloud-control") {
        const planned = await this.nextcloud.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-uptimekuma-control") {
        const planned = await this.kuma.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-portainer-control") {
        const planned = await this.portainer.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-kavita-control") {
        const planned = await this.kavita.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-audiobookshelf-control") {
        const planned = await this.abs.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-nzbget-control") {
        const planned = await this.nzbget.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-transmission-control") {
        const planned = await this.transmission.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-deluge-control") {
        const planned = await this.deluge.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-immich-control") {
        const planned = await this.immich.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-plex-control") {
        const planned = await this.plex.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-jellyfin-control") {
        const planned = await this.jellyfin.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-lidarr-control" || step.kind === "app-chaptarr-control") {
        const planned = await this.library.plan(
          step.kind === "app-lidarr-control" ? "lidarr" : "chaptarr",
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-syncthing-control") {
        const planned = await this.syncthing.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-homeassistant-control") {
        const planned = await this.ha.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-bazarr-subtitles") {
        const planned = await this.bazarr.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-prowlarr-indexer") {
        const planned = await this.prowlarr.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-sabnzbd-control") {
        const planned = await this.sab.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-tautulli-control") {
        const planned = await this.tautulliControl.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-tautulli-stop-stream") {
        const planned = await this.tautulli.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (step.kind === "app-radarr-set-root-folder") {
        const planned = await this.folders.plan(
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (SEERR_ACTIONS.includes(step.kind)) {
        const planned = await this.seerr.plan(
          step.kind as Parameters<SeerrOperations["plan"]>[0],
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (WIZARR_ACTIONS.includes(step.kind)) {
        const planned = await this.wizarr.plan(
          step.kind as Parameters<WizarrOperations["plan"]>[0],
          {
            id: service.id,
            name: service.name,
            localUrl: service.localUrl!,
            publicUrl: service.publicUrl,
          },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (TORRENT_ACTIONS.includes(step.kind)) {
        const planned = await this.torrents.plan(
          step.kind,
          { id: service.id, name: service.name, localUrl: service.localUrl! },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (ARR_RESOURCE_ACTIONS.includes(step.kind)) {
        const app = servarrOf(service);
        try {
          const planned = await this.resources.plan(
            step.kind,
            app,
            {
              id: service.id,
              name: service.name,
              localUrl: service.localUrl!,
              hostId: service.hostId,
            },
            step.params,
            { ...base, serviceName: service.name },
          );
          return { ...planned, policy: decision.outcome, policyReason: decision.reason };
        } catch (error) {
          if (error instanceof ResourcePlanError) throw new PlanError(error.message);
          throw error;
        }
      }
      if (ARR_ACTIONS.includes(step.kind) && !MEDIA_ACTIONS.includes(step.kind)) {
        const app = appOf(service) === "radarr" ? "radarr" : "sonarr";
        const planned = await this.arr.plan(
          step.kind,
          app,
          {
            id: service.id,
            name: service.name,
            localUrl: service.localUrl!,
            hostId: service.hostId,
          },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      if (MEDIA_ACTIONS.includes(step.kind)) {
        const planned = await this.media.plan(
          step.kind,
          {
            id: service.id,
            name: service.name,
            localUrl: service.localUrl!,
            hostId: service.hostId,
          },
          step.params,
          { ...base, serviceName: service.name },
        );
        return { ...planned, policy: decision.outcome, policyReason: decision.reason };
      }
      const found = await this.indexer(service.localUrl!, credentialOf, step.params);
      const params: StepParams = { indexerId: found.id, indexer: found.name };
      if (step.kind === "app-test-indexer") {
        return {
          ...base,
          label: `Test the ${found.name} indexer in ${service.name}`,
          serviceName: service.name,
          params,
          policy: decision.outcome,
          policyReason: decision.reason,
        };
      }
      const enabled = step.params?.enabled;
      if (typeof enabled !== "boolean")
        throw new PlanError("Say whether to turn the indexer on or off (enabled: true or false).");
      if (found.enable === enabled) {
        throw new PlanError(
          `${found.name} is already ${enabled ? "on" : "off"} in ${service.name}; nothing to change.`,
        );
      }
      const change: StepChange = {
        summary: `${enabled ? "Turn on" : "Turn off"} the ${found.name} indexer in ${service.name}`,
        settings: [
          { name: `${found.name}: enabled`, before: yesNo(found.enable), after: yesNo(enabled) },
        ],
      };
      return {
        ...base,
        label: change.summary,
        serviceName: service.name,
        params: { ...params, enabled },
        change,
        policy: decision.outcome,
        policyReason: decision.reason,
      };
    } catch (error) {
      return { ...base, policyReason: error instanceof Error ? error.message : String(error) };
    }
  }

  async run(step: StepRun): Promise<StepOutcome> {
    try {
      const { service, credentialOf } = await this.target(step.kind, step.serviceId);
      // The policy again, at the moment it runs (an approved plan still obeys Monitor/Diagnose).
      const { decision } = await this.runner.policyFor(
        step.kind,
        service.id,
        step.requestedBy,
        true,
      );
      if (decision.outcome !== "allow")
        return { ok: false, result: `Not allowed now: ${decision.reason}` };
      if (step.kind === "app-api-call") {
        const app = appOf(service) ?? "generic";
        const req = this.apiRequest(step.params, app);
        const answer = await this.apiSend(service, app, req);
        const st = (answer.body as { status?: unknown } | null)?.status;
        const command = typeof st === "string" && req.path.includes("/command");
        const ok = answer.ok && (!command || st === "completed");
        const said = (
          typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? null)
        ).slice(0, 600);
        const what = req.why || `${req.method} ${req.path.split("?")[0]}`;
        const result = ok
          ? `${service.name} accepted ${req.method} ${req.path.split("?")[0]} (${answer.status})${command ? ", and the command completed" : ""}. Its answer: ${said}`
          : `${service.name} did not complete ${req.method} ${req.path.split("?")[0]} (${answer.status}${command ? `, command ${String(st)}` : ""}). Its answer: ${said}`;
        await recordAudit(this.handle.db, {
          actor: step.requestedBy,
          action: `${what} in ${service.name} (approved plan)`,
          target: `service:${service.id}`,
          detail: { method: req.method, path: req.path.slice(0, 300), status: answer.status, ok },
        });
        if (ok && this.memory) {
          await this.memory
            .recordSystem(this.handle.db, {
              title: `${what} in ${service.name}`,
              body: `${result.slice(0, 400)} Approved as a step of a plan.`,
              happenedAt: new Date().toISOString(),
              links: [{ label: service.name, ref: `service:${service.id}` }],
            })
            .catch(() => undefined);
        }
        return { ok, result };
      }
      if (step.kind === "app-ersatztv-control") {
        return await this.ersatz.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-romm-control") {
        return await this.romm.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-pihole-control") {
        return await this.pihole.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-adguard-control") {
        return await this.adguard.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-proxmox-control") {
        return await this.proxmox.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-npm-control") {
        return await this.npm.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-portainer-control") {
        return await this.portainer.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-uptimekuma-control") {
        return await this.kuma.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-nextcloud-control") {
        return await this.nextcloud.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-paperless-control") {
        return await this.paperless.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-vaultwarden-control") {
        return await this.vaultwarden.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-tailscale-control") {
        return await this.tailscale.run(step, { ...service, localUrl: service.localUrl ?? "" });
      }
      if (step.kind === "app-wgeasy-control") {
        return await this.wgeasy.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-gitea-control") {
        return await this.gitea.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-frigate-control") {
        return await this.frigate.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-authentik-control") {
        return await this.authentik.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-mealie-control") {
        return await this.mealie.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-komga-control") {
        return await this.komga.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-navidrome-control") {
        return await this.navidrome.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-kavita-control") {
        return await this.kavita.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-audiobookshelf-control") {
        return await this.abs.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-deluge-control") {
        return await this.deluge.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-transmission-control") {
        return await this.transmission.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-nzbget-control") {
        return await this.nzbget.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-immich-control") {
        return await this.immich.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-plex-control") {
        return await this.plex.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-jellyfin-control") {
        return await this.jellyfin.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-lidarr-control" || step.kind === "app-chaptarr-control") {
        return await this.library.run(
          step.kind === "app-lidarr-control" ? "lidarr" : "chaptarr",
          step,
          { ...service, localUrl: service.localUrl! },
        );
      }
      if (step.kind === "app-syncthing-control") {
        return await this.syncthing.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-homeassistant-control") {
        return await this.ha.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-bazarr-subtitles") {
        return await this.bazarr.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-prowlarr-indexer") {
        return await this.prowlarr.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-sabnzbd-control") {
        return await this.sab.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-tautulli-control") {
        return await this.tautulliControl.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-tautulli-stop-stream") {
        return await this.tautulli.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (step.kind === "app-radarr-set-root-folder") {
        return await this.folders.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (SEERR_ACTIONS.includes(step.kind)) {
        return await this.seerr.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (WIZARR_ACTIONS.includes(step.kind)) {
        return await this.wizarr.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (TORRENT_ACTIONS.includes(step.kind)) {
        return await this.torrents.run(step, { ...service, localUrl: service.localUrl! });
      }
      if (ARR_RESOURCE_ACTIONS.includes(step.kind)) {
        const app = servarrOf(service);
        return await this.resources.run(step, app, {
          ...service,
          localUrl: service.localUrl!,
        });
      }
      if (ARR_ACTIONS.includes(step.kind) && !MEDIA_ACTIONS.includes(step.kind)) {
        const app = appOf(service) === "radarr" ? "radarr" : "sonarr";
        return await this.arr.run(step, app, { ...service, localUrl: service.localUrl! });
      }
      if (MEDIA_ACTIONS.includes(step.kind)) {
        return await this.media.run(step, { ...service, localUrl: service.localUrl! });
      }
      const base = service.localUrl!;
      // A test right after Prowlarr restarted (a VPN switch recreates it): wait for it to answer.
      let current: Awaited<ReturnType<typeof this.indexer>> | undefined;
      for (let i = 0; !current; i++) {
        try {
          current = await this.indexer(base, credentialOf, step.params);
        } catch (error) {
          const retry =
            step.kind === "app-test-indexer" && i < 11 && !(error instanceof AppKeyError);
          if (!retry || error instanceof PlanError) throw error;
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }

      if (step.kind === "app-test-indexer") {
        const res = await this.call<{ errorMessage?: string }[] | undefined>(
          base,
          credentialOf,
          "POST",
          "/api/v1/indexer/test",
          `test the ${current.name} indexer`,
          current,
        );
        const why = Array.isArray(res.data)
          ? res.data
              .map((e) => e.errorMessage)
              .filter(Boolean)
              .join(" ")
          : "";
        await recordAudit(this.handle.db, {
          actor: step.requestedBy,
          action: `Tested the ${current.name} indexer in ${service.name}`,
          target: `service:${service.id}`,
          detail: { passed: res.ok, ...(why ? { answer: why.slice(0, 300) } : {}) },
        });
        // An investigation step succeeds when the test ran, whatever the indexer answered.
        return {
          ok: true,
          result: res.ok
            ? `${service.name} tested ${current.name}: it works.`
            : `${service.name} tested ${current.name}: it failed${why ? `: ${why.slice(0, 300)}` : ` (${res.status})`}.`,
        };
      }

      // A configuration change: exactly the approved one, or nothing.
      const setting = step.change?.settings[0];
      const want = step.params?.enabled;
      if (!setting || typeof want !== "boolean")
        return { ok: false, result: "This step has no approved change." };
      if (yesNo(current.enable) !== setting.before) {
        return {
          ok: false,
          result: `${current.name} is now ${yesNo(current.enable).toLowerCase()} in ${service.name}, not ${setting.before.toLowerCase()} as when this plan was approved. Nothing was changed; plan it again.`,
        };
      }
      const put = await this.call<IndexerResource>(
        base,
        credentialOf,
        "PUT",
        `/api/v1/indexer/${current.id}`,
        `change the ${current.name} indexer`,
        { ...current, enable: want },
      );
      if (!put.ok)
        return {
          ok: false,
          result: `${service.name} refused the change (${put.status}). Nothing else was changed.`,
        };
      const after = await this.indexer(base, credentialOf, { indexerId: current.id });
      const verified = after.enable === want;
      await recordAudit(this.handle.db, {
        actor: step.requestedBy,
        action: `${want ? "Turned on" : "Turned off"} the ${current.name} indexer in ${service.name}`,
        target: `service:${service.id}`,
        detail: {
          setting: setting.name,
          before: setting.before,
          after: yesNo(after.enable),
          verified,
        },
      });
      if (verified && this.memory) {
        // A verified change is a fact Hearth saw: it goes in the journal like a verified repair.
        const host = await this.handle.db
          .select()
          .from(t.hosts)
          .where(eq(t.hosts.id, service.hostId))
          .get();
        await this.memory
          .recordSystem(this.handle.db, {
            title: `${want ? "Turned on" : "Turned off"} the ${current.name} indexer in ${service.name}`,
            body: `${setting.name}: ${setting.before} to ${yesNo(after.enable)}. Approved as a step of a plan, then verified by reading ${service.name} back.`,
            happenedAt: new Date().toISOString(),
            machine: host?.name,
            links: [{ label: service.name, ref: `service:${service.id}` }],
          })
          .catch(() => undefined);
      }
      return verified
        ? {
            ok: true,
            result: `Changed and verified: ${setting.name} is now ${yesNo(after.enable)} (was ${setting.before}).`,
          }
        : {
            ok: false,
            result: `${service.name} accepted the change but still reports ${setting.name} ${yesNo(after.enable)}.`,
          };
    } catch (error) {
      return { ok: false, result: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Puts a changed setting back to its approved "before" value. */
  async undo(step: StepRun): Promise<StepOutcome | undefined> {
    if (step.kind === "app-portainer-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.portainer.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-uptimekuma-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.kuma.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-komga-control") return this.komga.undo();
    if (step.kind === "app-mealie-control") return this.mealie.undo();
    if (step.kind === "app-frigate-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.frigate.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-authentik-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.authentik.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-gitea-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.gitea.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-navidrome-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.navidrome.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-wgeasy-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.wgeasy.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-tailscale-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.tailscale.undo(step, { ...service, localUrl: service.localUrl ?? "" });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-vaultwarden-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.vaultwarden.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-paperless-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.paperless.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-nextcloud-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.nextcloud.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-npm-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.npm.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-proxmox-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.proxmox.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-adguard-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.adguard.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-pihole-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.pihole.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-deluge-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.deluge.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-nzbget-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.nzbget.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-transmission-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.transmission.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-immich-control") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.immich.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-seerr-search-on-add") {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.seerr.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (ARR_RESOURCE_ACTIONS.includes(step.kind)) {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        const app = servarrOf(service);
        return await this.resources.undo(step, app, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (ARR_ACTIONS.includes(step.kind) && !MEDIA_ACTIONS.includes(step.kind)) return undefined;
    if (MEDIA_ACTIONS.includes(step.kind)) {
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.media.undo(step, { ...service, localUrl: service.localUrl! });
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (CONTROL_ACTIONS.includes(step.kind) && step.kind !== "app-qbt-add") {
      // The wider qBittorrent controls put the approved "before" values back.
      try {
        const { service } = await this.target(step.kind, step.serviceId);
        return await this.torrents.run(
          step,
          { ...service, localUrl: service.localUrl! },
          { undo: true },
        );
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind === "app-qbt-resume" || step.kind === "app-qbt-pause") {
      // Put back: the opposite, on the same torrent (still checked to be the approved one).
      const kind = step.kind === "app-qbt-resume" ? "app-qbt-pause" : "app-qbt-resume";
      try {
        const { service } = await this.target(kind, step.serviceId);
        return await this.torrents.run(
          { ...step, kind },
          { ...service, localUrl: service.localUrl! },
          {
            undo: true,
          },
        );
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
    if (step.kind !== "app-set-indexer-enabled" || !step.change?.settings[0]) return undefined;
    const before = step.change.settings[0].before === "On";
    return this.run({
      ...step,
      params: { ...step.params, enabled: before },
      change: {
        summary: `Put back: ${step.change.summary}`,
        settings: [
          {
            ...step.change.settings[0],
            before: step.change.settings[0].after,
            after: step.change.settings[0].before,
          },
        ],
      },
    });
  }
}
