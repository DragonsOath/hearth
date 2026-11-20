import {
  ACTIONS,
  APP_ACTIONS,
  CONFIG_ACTIONS,
  FILE_ACTIONS,
  MEMORY_ACTIONS,
  RAID_ACTIONS,
  TRANSFER_ACTIONS,
  type ActionKind,
  type JobStepInput,
  type Requester,
  type StepChange,
  type StepParams,
} from "@dragon-control/core";
import type { AppOperations } from "../apps/operations";
import type { ConfigOperations } from "../admin/operations";
import type { ActionRunner } from "../actions/service";
import type { KeyImports } from "../credentials/import-step";
import type { FileOperations } from "../storage/file-ops";
import type { RaidService } from "../storage/raid/service";
import type { TinyauthUsers } from "../apps/tinyauth-users";
import type { HearthSelf } from "../agent/hearth-self";
import type { MemoryOperations } from "../monitor/memory-ops";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { eq } from "drizzle-orm";

/** A planned step, as the engine stores and runs it. */
export interface PlannedStep {
  label: string;
  serviceName: string;
  changes: boolean;
  policy: "allow" | "approve-first" | "refuse";
  policyReason: string;
  /** Parameters as resolved when planning (an indexer name becomes its id). */
  params?: StepParams;
  /** Configuration steps: the change read from the app when planning. */
  change?: StepChange;
}

export interface StepRun {
  kind: ActionKind;
  serviceId: string;
  requestedBy: Requester;
  incidentId?: string;
  params?: StepParams;
  change?: StepChange;
  /**
   * The plan and step this runs as, and when the owner approved the plan (absent for plans that
   * ran without approval). Elevated operations are only authorized for approved steps.
   */
  job?: { id: string; seq: number; approvedAt?: string };
}

export interface StepOutcome {
  ok: boolean;
  result: string;
  actionId?: string;
  /**
   * Nothing was done because the target is no longer what was approved (gone, changed, or no
   * longer allowed). Per-item plans report it as skipped, not failed.
   */
  stale?: boolean;
  /** A verified delete: the space it freed, read when the plan was made. */
  freedBytes?: number;
  /** Read back from the app afterwards, and it matched what was approved. */
  verified?: boolean;
}

/**
 * What a job can do: plan a step (the same checks and policy as any action)
 * and carry it out. `undo` reverses what can be reversed: a start is undone
 * by stopping, a stop by starting. Looking and restarting have nothing to
 * undo. Undo runs only as part of the plan you approved, through the same
 * checks as any step.
 */
export interface JobOperations {
  plan(step: JobStepInput, requestedBy: Requester): Promise<PlannedStep>;
  run(step: StepRun): Promise<StepOutcome>;
  undo?(step: StepRun): Promise<StepOutcome | undefined>;
}

export const VERIFY_TEXT: Record<ActionKind, string> = {
  "run-check": "Passes when Hearth's health check finds it working.",
  "test-endpoint": "Passes when its web address answers.",
  "inspect-logs": "Passes when its recent logs can be read.",
  "restart-container":
    "Hearth's own health check must find it working again after the restart (up to 90 seconds).",
  "start-container":
    "Hearth's own health check must find it working after it starts (up to 90 seconds).",
  "stop-container": "Docker must report the container stopped.",
  "app-test-indexer": "Passes when Prowlarr ran the test; its answer is reported either way.",
  "app-set-indexer-enabled":
    "Prowlarr must report the indexer in the new state when read back after the change.",
  "app-qbt-resume":
    "qBittorrent must report the torrent no longer stopped when read back. Whether it then actually downloads is reported separately; resuming alone is not called a fix.",
  "app-qbt-pause": "qBittorrent must report the torrent stopped when read back.",
  "app-qbt-reannounce":
    "A tracker must be seen answering again (its status or next-announce time changes) when read back; the trackers' answers and the swarm are reported as they are.",
  "app-qbt-recheck":
    "qBittorrent must be seen checking the torrent's files; the result is reported when the check finishes, or as still running.",
  "app-radarr-set-monitored":
    "Radarr must report the movie in the new monitored state when read back.",
  "app-radarr-set-upgrades":
    "Radarr must report the quality profile with upgrades in the new state when read back.",
  "app-radarr-delete-file":
    "Radarr must no longer list that file for the movie when read back; whether a copy remains is reported.",
  "app-plex-delete-media":
    "Plex must no longer list that version of the title when read back, and the other versions must still be there.",
  "app-sonarr-set-monitored":
    "Sonarr must report the episode in the new monitored state when read back.",
  "app-sonarr-set-upgrades":
    "Sonarr must report the quality profile with upgrades in the new state when read back.",
  "app-sonarr-delete-file": "Sonarr must no longer have that episode file when read back.",
  "app-arr-import":
    "Each episode or movie must have its file when read back; the app accepting the import is not enough.",
  "app-arr-search":
    "The search must finish; the result says whether a release was actually grabbed or nothing suitable was found.",
  "app-arr-grab":
    "The app must accept the release and send it to the download client; the result says whether it shows in the queue.",
  "app-arr-queue-remove":
    "The queue item must be gone from the app's queue when read back. Library files are never touched. Nothing is blocklisted, except the one release a Download Health recovery removes.",
  "app-arr-add-collection":
    "Each movie must be in Radarr when read back; the result says which were added and searched for.",
  "app-arr-set-cutoff-score":
    "The quality profile must report the new upgrade-until score when read back.",
  "app-arr-set-naming":
    "The naming setting must read back with the new value. It applies to files imported from now on; files already in the library keep their names.",
  "app-arr-unmonitor-owned":
    "Every title or episode in the approved list that still has its file must read back as not monitored.",
  "app-arr-edit":
    "The object must read back with exactly the approved values; if it changed since the plan was made, nothing is changed.",
  "app-arr-create":
    "The new object must read back under its name; if one with that name already exists (an earlier try), nothing is added.",
  "app-arr-delete": "The object must be gone when read back.",
  "app-arr-command":
    "The app must report the command completed (checked for up to a minute; a longer one is reported as still running).",
  "app-crucible-apply":
    "Every row's profile must read back with its qualities, its size caps and its upgrade setting, and every moved movie must read back on its row's profile; if Hearth's own profiles or formats changed since the plan was made, nothing is changed.",
  "app-qbt-remove":
    "qBittorrent must no longer list the torrent when read back. Its downloaded data is left on disk.",
  "app-qbt-remove-with-data":
    "qBittorrent must no longer list the torrent when read back. qBittorrent deletes the data; Hearth cannot check the disk itself, so no space is claimed.",
  "app-qbt-set-preferences":
    "qBittorrent's settings must read back with exactly the approved new values.",
  "app-qbt-set-share-limits": "Each torrent must read back with the approved seeding limits.",
  "app-qbt-set-category": "Each torrent must read back in the approved category.",
  "app-qbt-set-tags": "Each torrent must read back with the tags added and removed as approved.",
  "app-qbt-set-priority": "Each torrent must read back at its new queue position.",
  "app-qbt-force-start": "Each torrent must read back with force start in the approved state.",
  "app-qbt-add":
    "qBittorrent must list the new torrents when read back (by their hash for magnet links and uploaded files).",
  "app-qbt-file-priority": "Each file must read back with the approved priority.",
  "app-qbt-category":
    "qBittorrent's category list must read back with the category created or gone.",
  "app-qbt-manual-sort":
    "Setting up: the new categories must read back from qBittorrent and the sorter is on. Filing or undoing: the torrent must read back in its new category.",
  "storage-raid":
    "The elevated executor reads the kernel's state back (the drive shows in the array with the expected state, the check is running, the member count or size grew), then Hearth reads the array again and reports where it stands.",
  "file-manage":
    "The item must read back at its new place with the same size (and be gone from the old place for a rename or move); a new folder must exist.",
  "config-edit":
    "The file must read back exactly as approved (same fingerprint), and the app's own check of the new file must pass.",
  "config-restore": "The file must read back identical to the backup.",
  "vpn-switch-server":
    "Every container of the VPN's Compose project must be running again, and the VPN must reach the internet from the new server (its new internet address is reported). Otherwise it is put back on the old server.",
  "app-recyclarr-sync":
    "Recyclarr must finish without errors; what it set in Radarr and Sonarr is reported from its own log.",
  "compose-update-image":
    "Every container of the project must be running (and not unhealthy) on the new image, and Hearth's own check of the app must pass.",
  "compose-install":
    "Every container of the new project must be running (and not unhealthy) after it starts.",
  "compose-remove":
    "None of the project's containers may remain; its files and data are untouched.",
  "credential-import":
    "The key must be in Secure Vault afterwards, linked to the app; Hearth then checks the app with it.",
  "app-wizarr-invite":
    "Wizarr must list the new invitation when read back; its link is reported so it can be sent.",
  "app-wizarr-invite-delete": "Wizarr must no longer list the invitation when read back.",
  "app-wizarr-user":
    "A new end date must be what Wizarr lists when read back, and someone removed must no longer be listed. Disabling and enabling report Wizarr's answer: Wizarr does not show that state, so it cannot be read back.",
  "app-wizarr-setup":
    "Wizarr's invite steps or General settings must read back as approved; cleaning expired users must leave none whose access has ended.",
  "app-seerr-approve": "Seerr must report the request approved when read back.",
  "app-tautulli-stop-stream": "The stream must be gone from Tautulli's activity within 15 seconds.",
  "app-tautulli-control":
    "Edits to a person or a library are read back; deleted play records must be gone from the history; a backup or refresh reports Tautulli's answer.",
  "app-ersatztv-control":
    "A stopped stream must be gone from ErsatzTV's sessions; a rebuilt schedule reports its answer.",
  "app-adguard-control":
    "Each change is read back from AdGuard Home: protection on or paused, the rule, list, rewrite or blocked services as planned, the switch on or off; a filter update reports how many lists changed.",
  "app-pihole-control":
    "Each change is read back from Pi-hole: blocking on or paused, the domain on or off the list, the list on, off, added or removed; a blocklist update must show a newer update time.",
  "app-proxmox-control":
    "Each change waits for Proxmox's own task to finish, then reads back: the VM or container running or stopped as planned, the new backup file listed, the snapshot listed.",
  "app-npm-control":
    "Each change is read back from Nginx Proxy Manager, including whether nginx loaded the site: on or off, the new forward address, the site added or removed, the certificate's new expiry.",
  "app-portainer-control":
    "Each change is read back from Docker through Portainer: the stack or container running or stopped as planned, every container of an updated stack running again.",
  "app-uptimekuma-control":
    "Each change is read back from Uptime Kuma: the monitor paused or checking, the new monitor listed with its address, the removed one gone, the maintenance window paused or on.",
  "app-nextcloud-control":
    "Each change is read back from Nextcloud: the account on or off, its quota, in or out of the group, the app on or off, the background jobs mode or the sharing setting as planned.",
  "app-paperless-control":
    "Each document change is read back from Paperless-ngx (it applies bulk edits a moment later): out of the inbox, tagged or not, its correspondent or type, in the trash or back; a new tag listed; a failed import gone from the list. Maintenance reports that Paperless started it.",
  "app-vaultwarden-control":
    "Each change is read back from Vaultwarden's admin view: the account off or on, its two-step sign-in off, the invitation listed, the account gone. Signing out everywhere and sending an invitation again report Vaultwarden's answer.",
  "app-tailscale-control":
    "Each change is read back from Tailscale's API: the device approved or not, its key expiry, the exit node or subnet routes approved or withdrawn, its new name, or gone.",
  "app-wgeasy-control":
    "Each change is read back from wg-easy: the client on or off, added, renamed, its end date, or gone; a restart is read back by wg-easy answering again.",
  "app-navidrome-control":
    "A scan is followed until Navidrome reports it finished (or still running); forgetting missing files, administrator changes and removing a user are read back from Navidrome.",
  "app-gitea-control":
    "A mirror sync is followed until Gitea records it; a re-run must show a new attempt; a runner off, on or removed is read back from Gitea's runner list. A scheduled task reports that Gitea started it.",
  "app-frigate-control":
    "Detection is read back from Frigate's live stats, an event from its event list, a restart by Frigate answering again. Recording reports Frigate's answer (Frigate does not list it live).",
  "app-authentik-control":
    "An account turned off or on is read back from Authentik; a retried task reports that Authentik took it.",
  "app-mealie-control":
    "A backup must show in Mealie's backup list; unlocking reports how many accounts Mealie freed; clean-ups report Mealie's answer.",
  "app-komga-control":
    "A scan is followed until Komga's book count for the library changes (or it is still scanning); the other library tasks and reading a broken book again report that Komga started them.",
  "app-kavita-control": "Scans and backups report Kavita's answer; new files appear as it scans.",
  "app-romm-control":
    "A scan reports RomM's own result (finished, with what it found, or still running); a favourite is read back from RomM.",
  "app-audiobookshelf-control":
    "A backup must show in Audiobookshelf's backup list; a scan reports its answer. A list change is read back: the book must be in (or out of) the list, in the planned order.",
  "app-nzbget-control":
    "Each change is read back from NZBGet's queue and history: paused or running, removed, retried, the new speed limit, priority, place or category, the added NZBs.",
  "app-transmission-control":
    "Each change is read back from Transmission: a paused, resumed, labelled, added or removed torrent, file priorities, and settings; a recheck or reannounce reports Transmission's answer.",
  "app-deluge-control":
    "Each change is read back from Deluge: a paused, resumed, labelled, added or removed torrent, file priorities, and settings; a recheck or reannounce reports Deluge's answer.",
  "app-immich-control":
    "Pausing, resuming, and clearing failures are read back from Immich's queues; runs and backups report Immich's answer. Album changes are read back from the album; edits are read back from the photo; a new storage template is read back from Immich's settings, and the panel checks a few photos are where it says once Immich's job has run.",
  "app-plex-control":
    "Watched state, edits and settings are read back from Plex; scans, refreshes and maintenance report Plex's answer.",
  "app-jellyfin-control":
    "A stopped stream must be gone from Jellyfin's sessions; a stopped task must no longer be running; a task turned off or on is read back from its schedule; scans report Jellyfin's answer.",
  "app-lidarr-control":
    "A search must finish in Lidarr; a replaced download must be gone from its queue; wanting an album is read back from Lidarr.",
  "app-chaptarr-control":
    "A search must finish in Chaptarr; a replaced download must be gone from its queue; wanting a book is read back from Chaptarr.",
  "app-api-call":
    "The app must accept the request; an *arr command must finish; Ember reads the result back from the app afterwards.",
  "hearth-api-call":
    "Hearth must accept the change; the step reads the same place back afterwards and shows what it says now.",
  "browser-change":
    "The step opens the approved window for changes; Ember makes them in the app's page, then reads the result back and says what it shows.",
  "free-memory":
    "The app must be gone (checked by its process), or Hearth's voice must read as stopped.",
  "lab-transfer": "Hearth Transfer was removed: nothing runs.",
  "app-syncthing-control":
    "Pausing and resuming are read back from Syncthing's configuration; a rescan reports Syncthing's answer.",
  "app-homeassistant-control":
    "Switching is read back from Home Assistant's state; a reloaded integration must load; runs report Home Assistant's answer.",
  "app-bazarr-subtitles":
    "A search is read back from Bazarr's wanted list; a provider reset must leave none throttled.",
  "app-prowlarr-indexer":
    "A test reports Prowlarr's own result; switching on or off is read back from Prowlarr; a sync must finish in Prowlarr.",
  "app-sabnzbd-control":
    "SABnzbd's queue and history must show the change when read back (added, paused, running, retried, or gone; cleared warnings gone).",
  "tinyauth-users":
    "Tinyauth must come back after its restart, and a new password must sign in; otherwise the old users file is put back.",
  "app-radarr-set-root-folder":
    "Radarr must report the movie in the new root folder when read back; moving files is reported, not assumed.",
  "app-seerr-decline": "Seerr must report the request declined when read back.",
  "app-seerr-remove": "Seerr must no longer have the request when read back.",
  "app-seerr-request": "Seerr must list the new request for that title when read back.",
  "app-seerr-retry": "Seerr must no longer report the request as failed when read back.",
  "app-seerr-mark-available": "Seerr must report the title as available when read back.",
  "app-seerr-search-on-add":
    "Seerr's Radarr server must read back with automatic search as approved; if it changed since the plan was made, nothing is changed.",
  "app-seerr-issue":
    "A comment must be on the issue, a resolved or reopened issue must read so, and a deleted one must be gone, when read back.",
};

export const ROLLBACK_TEXT: Record<ActionKind, string> = {
  "lab-transfer": "Nothing to undo: Hearth Transfer was removed.",
  "free-memory":
    "Nothing to put back: open the app again yourself; the voice starts again when used.",
  "run-check": "Nothing to undo: it only looks.",
  "test-endpoint": "Nothing to undo: it only looks.",
  "inspect-logs": "Nothing to undo: it only looks.",
  "restart-container":
    "Nothing to undo: a restart changes no settings or data. If the service does not come back, the job stops there and tells you.",
  "start-container": "If a later step fails, it is stopped again.",
  "stop-container": "If a later step fails, it is started again.",
  "app-test-indexer": "Nothing to undo: a test changes no settings.",
  "app-set-indexer-enabled":
    "If a later step fails, the indexer is set back to how it was (the value read when planning).",
  "app-qbt-resume": "If a later step fails, the torrent is paused again.",
  "app-qbt-pause": "If a later step fails, the torrent is resumed again.",
  "app-qbt-reannounce": "Nothing to undo: asking the trackers again changes no settings or files.",
  "app-qbt-recheck":
    "Nothing to undo: a recheck only re-verifies the files already on disk (no settings or paths change).",
  "app-radarr-set-monitored": "If a later step fails, the movie is set back to how it was.",
  "app-radarr-set-upgrades": "If a later step fails, the profile is set back to how it was.",
  "app-radarr-delete-file":
    "Cannot be undone by Hearth. The plan says whether Radarr's recycle bin keeps a copy you can restore.",
  "app-plex-delete-media":
    "Cannot be undone by Hearth: Plex deletes the file from disk. Only a duplicate is ever deleted, never the last copy.",
  "app-sonarr-set-monitored": "If a later step fails, the episode is set back to how it was.",
  "app-sonarr-set-upgrades": "If a later step fails, the profile is set back to how it was.",
  "app-sonarr-delete-file":
    "Cannot be undone by Hearth. The plan says whether Sonarr's recycle bin keeps a copy you can restore.",
  "app-arr-import":
    "Nothing to undo automatically: the download is left as is; an imported file can be removed in the app if wrong.",
  "app-arr-search":
    "Nothing to undo: a search changes no settings; a grabbed release appears in the queue.",
  "app-arr-grab":
    "Not undone automatically: remove it from the Queue tab if you change your mind (that also stops the download).",
  "app-arr-queue-remove":
    "Not undone automatically. Kept in the client: the app picks the download up again on its own or with a search. Removed from the client: its downloaded data is gone; search again to re-download.",
  "app-arr-add-collection":
    "Not undone automatically: delete a movie you did not want in Radarr (its downloaded file, if any, can be kept or deleted there).",
  "app-arr-set-cutoff-score":
    "If a later step fails, the profile's score is set back to how it was.",
  "app-arr-set-naming": "If a later step fails, the setting is put back to its value before.",
  "app-arr-unmonitor-owned":
    "If a later step fails, exactly the ones it unmonitored are monitored again.",
  "app-arr-edit":
    "If a later step fails, the changed settings are put back to their values before.",
  "app-arr-create":
    "Not undone automatically: remove the added object in the panel if a later step fails.",
  "app-arr-delete":
    "Cannot be undone by Hearth. A removed movie can be added again; deleted files only come back from the app's recycle bin, if one is set.",
  "app-arr-command": "Nothing to undo: it ran one of the app's own commands.",
  "app-crucible-apply":
    "Undo puts every moved movie back on its profile, puts Hearth's profiles and formats back as they were, and removes the ones Save created.",
  "app-qbt-remove":
    "Cannot be undone by Hearth: the torrent can be added again; its data stays on disk.",
  "app-qbt-remove-with-data":
    "Cannot be undone: the downloaded data is deleted by qBittorrent and is not in any recycle bin.",
  "app-qbt-set-preferences":
    "If a later step fails, the settings are set back to the values read when planning.",
  "app-qbt-set-share-limits":
    "If a later step fails, each torrent's limits are set back to how they were.",
  "app-qbt-set-category": "If a later step fails, each torrent goes back to its old category.",
  "app-qbt-set-tags":
    "If a later step fails, the tags added are removed and the tags removed are added back.",
  "app-qbt-set-priority":
    "Not put back automatically: queue order changes all the time on its own.",
  "app-qbt-force-start": "If a later step fails, force start is set back to how it was.",
  "app-qbt-add": "Not removed automatically: remove an added torrent with its own plan if wanted.",
  "app-qbt-file-priority": "If a later step fails, each file goes back to its earlier priority.",
  "app-qbt-category":
    "If a later step fails, a created category is removed again (while still empty), a removed one is created again with its folder.",
  "app-qbt-manual-sort":
    "Switching it off stops sorting; each sort has its own Undo, which puts the torrent back with no category. An app's import is not undone.",
  "storage-raid":
    "Not undone automatically. Adding a spare can be undone by removing it, and a check by cancelling it; erasing a drive, creating an array, and growing one cannot be undone.",
  "file-manage":
    "A rename or move is put back if a later step fails. A copy or a new folder is left in place: Hearth does not delete.",
  "config-edit":
    "A backup of the file is made first; if a later step fails, the file is put back from it. You can also restore it later.",
  "config-restore": "The file as it was before the restore is backed up too.",
  "vpn-switch-server":
    "A backup of the Compose file is made first. If the VPN does not come back working, it goes back to the old server on its own; if a later step fails, it is switched back.",
  "app-recyclarr-sync":
    "Not undone automatically: it applies the configuration file as it is. Restoring the file and syncing again puts things back.",
  "compose-update-image":
    "If the app does not come back working, the Compose file and the previous image are put back and recreated. Changes the new version made to the app's own data (a database upgrade, for example) are not undone by that.",
  "compose-install":
    "If it does not start cleanly, its containers are removed and its new Compose file and empty folder are taken away. Folders and volumes its containers created are left in place and listed.",
  "compose-remove":
    "If a later step fails, the project is started again from its unchanged Compose file.",
  "credential-import":
    "Not removed automatically: the key stays in Secure Vault, where you can delete it. The app itself is not changed.",
  "app-wizarr-invite":
    "Not deleted automatically: delete it from the Wizarr panel if it is not wanted (only while unused).",
  "app-wizarr-invite-delete":
    "Cannot be undone by Hearth: make a new invitation if it is needed again.",
  "app-wizarr-user":
    "Not undone automatically: enable or disable again, or set the end date back, from the People tab. Removing someone cannot be undone: their account on the media server is gone; invite them again if needed.",
  "app-wizarr-setup":
    "Not undone automatically: the plan shows what was there before, so it can be put back from the Wizard or Settings tab. A deleted step is gone (its text is in the plan); people removed by cleaning expired users cannot be brought back.",
  "app-seerr-approve":
    "Not undone automatically: once approved, Seerr sends it to Radarr or Sonarr; remove it there if unwanted.",
  "app-seerr-decline": "Not undone automatically: the person can request it again.",
  "app-seerr-remove": "Not undone automatically: request it again in Overseerr if needed.",
  "app-seerr-request":
    "Not undone automatically: remove the request from the Requests tab (an approved one may already be in Radarr or Sonarr).",
  "app-seerr-retry": "Nothing to undo: Seerr sends the request again.",
  "app-seerr-mark-available":
    "Not undone automatically: Seerr's next library scan corrects it if the title is not there.",
  "app-seerr-search-on-add": "Undo puts Seerr's automatic search back as it was.",
  "app-seerr-issue":
    "Resolving and reopening undo each other; a comment or a deleted issue cannot be undone by Hearth.",
  "app-tautulli-stop-stream": "Cannot be undone: the person can start playing again.",
  "app-tautulli-control":
    "A person or library edit is set back from the panel. Deleted play records cannot be brought back (Plex's watched state is untouched).",
  "app-adguard-control":
    "A pause is undone by turning protection back on, and the other way round; a rule, rewrite or list is taken off again or put back; blocked services and switches go back to their approved before. A filter update is not undone: run it again later.",
  "app-ersatztv-control":
    "A rebuilt schedule is not put back (the channel starts over); a stopped stream starts again when someone tunes in.",
  "app-pihole-control":
    "A pause is undone by turning blocking back on, and the other way round; an allowed or blocked domain is taken off again, a removed one put back; a list is switched back, a new one removed, a removed one added again. A blocklist update is not undone: run it again later.",
  "app-proxmox-control":
    "A start is undone by shutting the guest down, a shutdown or force-stop by starting it again. A restart, backup or snapshot is not undone automatically: delete a backup or snapshot in Proxmox if you do not want it.",
  "app-npm-control":
    "Switching on or off is undone the opposite way, a new forward address goes back to the old one, an added site is removed, a removed site is added again (custom nginx settings are not kept). A renewal is not undone.",
  "app-portainer-control":
    "Starting is undone by stopping, and stopping by starting again. An update is not undone: its new images stay (deploy an older tag in Portainer to go back).",
  "app-uptimekuma-control":
    "A pause is undone by resuming, and a resume by pausing again; an added monitor is removed. A removed monitor is not undone: its history is gone (add it again to watch it).",
  "app-nextcloud-control":
    "Every change is undone by putting the old value back: the account on or off again, its old quota, back in or out of the group, the app off or on again, the old background jobs mode or sharing setting.",
  "app-paperless-control":
    "Document changes are undone by putting the old values back (back in the inbox, the old tags, correspondent or type, out of the trash); a new tag with no documents is removed. Processing again, maintenance and dismissing a failed import are not undone.",
  "app-vaultwarden-control":
    "Turning an account off is undone by turning it on (and back), and an invitation by withdrawing it. Signing out, turning off two-step sign-in and deleting are not undone: deleting removes the whole vault.",
  "app-tailscale-control":
    "Every change is undone by putting the old value back (approval, key expiry, exit node, routes, name). Removing a device is not undone: it signs in and is approved again.",
  "app-wgeasy-control":
    "Turning a client on or off, renaming it and its end date are undone by putting the old value back, and an added client is removed. Removing a client is not undone: its configuration stops working for good.",
  "app-navidrome-control":
    "Making a user an administrator, or an ordinary user, is undone the opposite way. A scan changes no settings. Forgetting missing files and removing a user are not undone (their plays and stars are gone).",
  "app-gitea-control":
    "Turning a runner off or on is undone the opposite way. Syncs, re-runs and scheduled tasks change no settings. A removed runner is not undone: it must register again with a new token, made in Gitea.",
  "app-frigate-control":
    "Detection and recording switches, and keeping an event, are undone the opposite way. Deleting an event and restarting are not undone.",
  "app-authentik-control":
    "Turning an account off or on is undone the opposite way. A retried task is not undone.",
  "app-mealie-control":
    "A backup can be deleted in Mealie. Cleaning temporary files, unused images and empty folders, and unlocking accounts, are not undone.",
  "app-komga-control":
    "Scans, analysis and metadata refreshes change no settings. Emptying a library's trash is not undone: Komga forgets those books and their reading progress.",
  "app-kavita-control":
    "A scan changes no settings; a backup can be removed from Kavita's backups folder.",
  "app-romm-control":
    "A scan never deletes a game or a file; what it added stays (RomM's own cleanup removes missing games). A favourite is undone the opposite way.",
  "app-audiobookshelf-control":
    "A scan changes no settings; a new backup can be deleted in Audiobookshelf. A list change is not undone automatically: add, move, or take the book out again from the panel. A playlist whose last book is taken out is deleted by Audiobookshelf; make it again with that book.",
  "app-nzbget-control":
    "Pausing and resuming are undone the opposite way; a priority or category is put back. A removed download stays in NZBGet's history and can be downloaded again from there; a speed limit is set back by hand.",
  "app-transmission-control":
    "Pause and resume are undone the opposite way; labels or a setting are put back to their approved before. A removed torrent can be added again; deleted files are gone. A recheck or reannounce changes nothing to undo.",
  "app-deluge-control":
    "Pause and resume are undone the opposite way; a label or setting is put back to its approved before. A removed torrent can be added again; deleted files are gone. A recheck or reannounce changes nothing to undo.",
  "app-immich-control":
    "Pause and resume are undone the opposite way; cleared failures are not put back (the photos are untouched). Photos added to an album are taken out again with Undo in the panel; an edit is removed with Restore original. Neither changes the original files. A storage template is put back if a later step fails; files Immich already moved go back only by setting the old pattern and running its job again.",
  "app-plex-control":
    "Watched state and settings are set back from the panel; an edit is undone with another edit; a scan, refresh or maintenance task changes no settings. Emptying trash cannot be undone, but removes only entries for files already gone.",
  "app-jellyfin-control":
    "A task turned off is turned back on from the panel with the schedule it had; a stopped stream or task can start again; scans change no settings.",
  "app-lidarr-control":
    "A replaced download is not put back (its release stays blocked; unblock it in Lidarr); a search changes nothing; wanting an album is undone by no longer wanting it.",
  "app-chaptarr-control":
    "A replaced download is not put back (its release stays blocked; unblock it in Chaptarr); a search changes nothing; wanting a book is undone by no longer wanting it.",
  "app-api-call":
    "Not undone automatically: the plan shows the exact request, and the opposite change is another request.",
  "hearth-api-call":
    "Not undone automatically: the plan shows the exact change and what it was before, and changing it back is another plan.",
  "browser-change":
    "Not undone automatically: the window closes by itself when its time is up; changing it back is another plan.",
  "app-syncthing-control": "Pause and resume are undone the opposite way; nothing is deleted.",
  "app-homeassistant-control":
    "Switching is undone the opposite way; what a script, scene, or automation did is not undone.",
  "app-bazarr-subtitles":
    "Downloaded subtitles can be removed in Bazarr; searches and resets change no settings.",
  "app-prowlarr-indexer":
    "Switching on or off is undone the opposite way; tests and syncs change no settings.",
  "app-sabnzbd-control":
    "Pause and resume are undone the opposite way; an added job can be removed again; a removed job is not put back (its files stay unless deleting them was approved); cleared warnings do not come back.",
  "tinyauth-users":
    "The users file from before is kept in Hearth's backups (service-backups/tinyauth); a change is undone the same way (the old password typed again, the user added back).",
  "app-radarr-set-root-folder":
    "Not put back automatically: change it back the same way (Radarr moves the files again if asked).",
};

const OPPOSITE: Partial<Record<ActionKind, ActionKind>> = {
  "start-container": "stop-container",
  "stop-container": "start-container",
};

/** Jobs carried out through the ActionRunner: one execution path for everything. */
export function runnerOperations(
  handle: DbHandle,
  runner: ActionRunner,
  apps?: AppOperations,
  config?: ConfigOperations,
  keys?: KeyImports,
  files?: FileOperations,
  raid?: RaidService,
  tinyauth?: TinyauthUsers,
  hearth?: HearthSelf,
  memory?: MemoryOperations,
  browser?: ReturnType<typeof import("../browser/staged").browserChangeOperations>,
): JobOperations {
  return {
    async plan(step, requestedBy) {
      if (TRANSFER_ACTIONS.includes(step.kind)) {
        return refusedPlan(step, "Hearth Transfer was removed from Hearth.");
      }
      if (MEMORY_ACTIONS.includes(step.kind)) {
        if (!memory) return refusedPlan(step, "Freeing memory is not available here.");
        return memory.plan(step);
      }
      if (step.kind === "hearth-api-call") {
        if (!hearth) return refusedPlan(step, "Changing Hearth itself is not available here.");
        return hearth.plan(step);
      }
      if (step.kind === "browser-change") {
        if (!browser) return refusedPlan(step, "Ember's browser is not available here.");
        return browser.plan(step);
      }
      if (step.kind === "tinyauth-users") {
        if (!tinyauth) return refusedPlan(step, "Changing Tinyauth's users is not available here.");
        const service = await serviceRow(handle, step.serviceId);
        return tinyauth.plan(service, step.params, {
          label: "",
          serviceName: service.name,
          changes: true,
          policy: "approve-first",
          policyReason:
            "Who can sign in is changed only with your approval, after you confirm it's you.",
        });
      }
      if (step.kind === "credential-import") {
        if (!keys) return refusedPlan(step, "Storing keys is not available here.");
        return keys.plan(step.serviceId);
      }
      if (RAID_ACTIONS.includes(step.kind)) {
        if (!raid) return refusedPlan(step, "RAID management is not available here.");
        return raid.plan(step);
      }
      if (FILE_ACTIONS.includes(step.kind)) {
        if (!files) return refusedPlan(step, "File operations are not available here.");
        return files.plan(step);
      }
      if (CONFIG_ACTIONS.includes(step.kind)) {
        if (!config) return refusedPlan(step, "Configuration changes are not available here.");
        return config.plan(step, requestedBy);
      }
      if (APP_ACTIONS.includes(step.kind)) {
        if (!apps) return refusedPlan(step, "Operations inside apps are not available here.");
        return apps.plan(step, requestedBy);
      }
      const { serviceName, label, decision } = await runner.preview(
        step.kind,
        step.serviceId,
        requestedBy,
      );
      return {
        label,
        serviceName,
        changes: ACTIONS[step.kind].changes,
        policy: decision.outcome,
        policyReason: decision.reason,
      };
    },

    async undo(step) {
      if (step.kind === "credential-import") return undefined;
      if (FILE_ACTIONS.includes(step.kind)) return files?.undo(step);
      if (CONFIG_ACTIONS.includes(step.kind)) return config?.undo(step);
      if (APP_ACTIONS.includes(step.kind)) return apps?.undo(step);
      const opposite = OPPOSITE[step.kind];
      if (!opposite) return undefined;
      return this.run({ ...step, kind: opposite });
    },

    async run(step) {
      if (TRANSFER_ACTIONS.includes(step.kind)) {
        return { ok: false, result: "Hearth Transfer was removed from Hearth." };
      }
      if (MEMORY_ACTIONS.includes(step.kind)) {
        if (!memory) return { ok: false, result: "Freeing memory is not available here." };
        return memory.run(step);
      }
      if (step.kind === "hearth-api-call") {
        if (!hearth) return { ok: false, result: "Changing Hearth itself is not available here." };
        return hearth.run(step);
      }
      if (step.kind === "browser-change") {
        if (!browser) return { ok: false, result: "Ember's browser is not available here." };
        return browser.run(step);
      }
      if (step.kind === "tinyauth-users") {
        if (!tinyauth)
          return { ok: false, result: "Changing Tinyauth's users is not available here." };
        return tinyauth.run(step, await serviceRow(handle, step.serviceId));
      }
      if (step.kind === "credential-import") {
        if (!keys) return { ok: false, result: "Storing keys is not available here." };
        return keys.run(step);
      }
      if (RAID_ACTIONS.includes(step.kind)) {
        if (!raid) return { ok: false, result: "RAID management is not available here." };
        return raid.run(step);
      }
      if (FILE_ACTIONS.includes(step.kind)) {
        if (!files) return { ok: false, result: "File operations are not available here." };
        return files.run(step);
      }
      if (CONFIG_ACTIONS.includes(step.kind)) {
        if (!config) return { ok: false, result: "Configuration changes are not available here." };
        return config.run(step);
      }
      if (APP_ACTIONS.includes(step.kind)) {
        if (!apps) return { ok: false, result: "Operations inside apps are not available here." };
        return apps.run(step);
      }
      try {
        const { action } = await runner.request({ ...step, approved: true });
        if (action.status === "running") await runner.settled(step.serviceId);
        const done = await handle.db
          .select()
          .from(t.actions)
          .where(eq(t.actions.id, action.id))
          .get();
        return {
          ok: done?.status === "succeeded",
          result: done?.result ?? action.result ?? "Done.",
          actionId: action.id,
        };
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** The service a step names (for steps that carry out their own work). */
async function serviceRow(handle: DbHandle, id: string) {
  const s = await handle.db.select().from(t.services).where(eq(t.services.id, id)).get();
  if (!s) throw new Error("No such service.");
  return s;
}

function refusedPlan(step: JobStepInput, reason: string): PlannedStep {
  return {
    label: ACTIONS[step.kind].describe(step.serviceId),
    serviceName: step.serviceId,
    changes: ACTIONS[step.kind].changes,
    policy: "refuse",
    policyReason: reason,
  };
}
