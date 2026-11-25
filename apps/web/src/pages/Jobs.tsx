import { useState } from "react";
import { LongWork } from "../components/jobs/LongWork";
import { useNavigate, useSearchParams } from "react-router";
import {
  ACTION_KINDS,
  APP_ACTIONS,
  CONFIG_ACTIONS,
  MAX_JOB_STEPS,
  type ActionKind,
  type Job,
  type JobStatus,
  type Workspace,
} from "@dragon-control/core";
import { WithWorkspace } from "../components/WithWorkspace";
import {
  Button,
  EmptyState,
  PageHeader,
  Panel,
  RowLink,
  Rows,
  Section,
  StatusDot,
  Tag,
} from "../components/ui";
import { usePlanJob, useJobs } from "../data/jobs";
import { ago } from "../lib/format";
import { FormError } from "./auth/AuthFrame";

const field =
  "min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  "awaiting-approval": "Awaiting your approval",
  refused: "Not allowed",
  running: "Running",
  succeeded: "Done",
  partial: "Partly done",
  failed: "Did not finish",
  "rolled-back": "Undone",
  cancelled: "Cancelled",
  expired: "Expired",
  interrupted: "Interrupted",
};

export function jobTag(status: JobStatus) {
  const tone =
    status === "awaiting-approval" || status === "running"
      ? "gold"
      : status === "failed" ||
          status === "refused" ||
          status === "interrupted" ||
          status === "partial"
        ? "warn"
        : "neutral";
  return <Tag tone={tone}>{JOB_STATUS_LABEL[status]}</Tag>;
}

export const WHO: Record<Job["requestedBy"], string> = {
  you: "Planned by you",
  agent: "Proposed by the AI",
  "dragon-control": "Proposed by Hearth",
};

const STEP_KIND_LABEL: Record<ActionKind, string> = {
  "build-docker": "Install Docker (your homelab plan)",
  "build-tailscale": "Install Tailscale (your homelab plan)",
  "build-app": "Set up an app (your homelab plan)",
  "build-connect": "Connect your apps (your homelab plan)",
  "build-confirm": "You checked an app works (your homelab plan)",
  "run-check": "Run the health check",
  "test-endpoint": "Test the web address",
  "inspect-logs": "Read recent logs",
  "restart-container": "Restart the container",
  "start-container": "Start the container",
  "stop-container": "Stop the container",
  "app-test-indexer": "Test an indexer (Prowlarr)",
  "app-set-indexer-enabled": "Turn an indexer on or off (Prowlarr)",
  "app-qbt-resume": "Resume a torrent (qBittorrent)",
  "app-qbt-pause": "Pause a torrent (qBittorrent)",
  "app-qbt-reannounce": "Ask a torrent's trackers again (qBittorrent)",
  "app-qbt-recheck": "Recheck a torrent's files (qBittorrent)",
  "app-radarr-set-monitored": "Monitor or unmonitor a movie (Radarr)",
  "app-radarr-set-upgrades": "Allow or stop upgrades in a quality profile (Radarr)",
  "app-radarr-delete-file": "Delete a movie file (Radarr)",
  "app-plex-delete-media": "Delete a duplicate version (Plex)",
  "app-sonarr-set-monitored": "Monitor or unmonitor an episode (Sonarr)",
  "app-sonarr-set-upgrades": "Allow or stop upgrades in a quality profile (Sonarr)",
  "app-sonarr-delete-file": "Delete an episode file (Sonarr)",
  "app-arr-import": "Import a stuck download (Sonarr or Radarr)",
  "app-arr-search": "Search for a missing item (Sonarr or Radarr)",
  "app-arr-grab": "Download a release you picked (Sonarr or Radarr)",
  "app-sonarr-season-pack": "Try a whole-season pack for one request (Sonarr)",
  "app-arr-add-collection": "Add the movies missing from a collection (Radarr)",
  "app-arr-queue-remove": "Remove one item from the download queue (Sonarr or Radarr)",
  "app-arr-set-cutoff-score": "Set where a quality profile stops upgrading (Sonarr or Radarr)",
  "app-arr-set-naming": "Change one naming setting (Sonarr or Radarr)",
  "app-arr-edit": "Change settings of one object (Radarr or Sonarr)",
  "app-arr-create": "Add one object (Radarr or Sonarr)",
  "app-arr-delete": "Remove one object (Radarr or Sonarr)",
  "app-arr-command": "Run one of the app's own commands (Radarr or Sonarr)",
  "app-crucible-apply": "Save the Crucible's quality and size rows (Radarr)",
  "app-arr-unmonitor-owned": "Stop monitoring everything you already have (Sonarr or Radarr)",
  "app-qbt-remove": "Remove a torrent, keep its files (qBittorrent)",
  "app-qbt-remove-with-data": "Remove a torrent AND delete its files (qBittorrent)",
  "app-qbt-set-preferences": "Change seeding, speed, or queue settings (qBittorrent)",
  "app-qbt-set-share-limits": "Set torrents' seeding limits (qBittorrent)",
  "app-qbt-set-category": "Change torrents' category (qBittorrent)",
  "app-qbt-set-tags": "Change torrents' tags (qBittorrent)",
  "app-qbt-set-priority": "Move torrents in the queue (qBittorrent)",
  "app-qbt-force-start": "Force start torrents (qBittorrent)",
  "app-qbt-add": "Add torrents (qBittorrent)",
  "app-qbt-file-priority": "Change a torrent's file priorities (qBittorrent)",
  "app-qbt-category": "Create or remove a category (qBittorrent)",
  "app-qbt-manual-sort": "Sort manual downloads (qBittorrent)",
  "config-edit": "Edit a configuration file",
  "config-restore": "Restore a configuration file from its backup",
  "vpn-switch-server": "Switch a VPN to a different server",
  "app-recyclarr-sync": "Run Recyclarr's sync now",
  "credential-import": "Store an app's key in Secure Vault",
  "app-wizarr-invite": "Create a Wizarr invitation",
  "app-wizarr-invite-delete": "Delete a Wizarr invitation",
  "app-wizarr-user": "Change someone's access in Wizarr",
  "app-wizarr-setup": "Change Wizarr's invite steps or settings",
  "app-seerr-approve": "Approve a request (Overseerr)",
  "app-tautulli-stop-stream": "Stop a stream (Tautulli)",
  "app-tautulli-control": "People, libraries and history (Tautulli)",
  "app-sabnzbd-control": "Control downloads (SABnzbd)",
  "app-prowlarr-indexer": "Manage indexers (Prowlarr)",
  "app-bazarr-subtitles": "Find subtitles (Bazarr)",
  "app-homeassistant-control": "Control the home (Home Assistant)",
  "app-syncthing-control": "Control syncing (Syncthing)",
  "app-lidarr-control": "Albums and downloads (Lidarr)",
  "app-jellyfin-control": "Libraries and streams (Jellyfin)",
  "app-plex-control": "Scan libraries (Plex)",
  "app-immich-control": "Photo jobs (Immich)",
  "app-deluge-control": "Torrents (Deluge)",
  "app-transmission-control": "Torrents (Transmission)",
  "app-nzbget-control": "Downloads (NZBGet)",
  "app-audiobookshelf-control": "Libraries and backups (Audiobookshelf)",
  "app-kavita-control": "Libraries and backups (Kavita)",
  "app-portainer-control": "Stacks and containers (Portainer)",
  "app-uptimekuma-control": "Monitors (Uptime Kuma)",
  "app-nextcloud-control": "Accounts and apps (Nextcloud)",
  "app-paperless-control": "Documents (Paperless-ngx)",
  "app-vaultwarden-control": "Accounts (Vaultwarden)",
  "app-tailscale-control": "Devices (Tailscale)",
  "app-wgeasy-control": "WireGuard clients (wg-easy)",
  "app-navidrome-control": "Music library (Navidrome)",
  "app-komga-control": "Comics library (Komga)",
  "app-gitea-control": "Git server (Gitea)",
  "app-mealie-control": "Recipes (Mealie)",
  "app-authentik-control": "Sign-in (Authentik)",
  "app-frigate-control": "Cameras (Frigate)",
  "app-npm-control": "Sites (Nginx Proxy Manager)",
  "app-proxmox-control": "VMs and containers (Proxmox)",
  "app-adguard-control": "Ad blocking (AdGuard Home)",
  "app-pihole-control": "Ad blocking (Pi-hole)",
  "app-romm-control": "Scans and favourites (RomM)",
  "app-ersatztv-control": "Channels (ErsatzTV)",
  "app-chaptarr-control": "Books and downloads (Chaptarr)",
  "app-api-call": "A request to an app's own API",
  "hearth-api-call": "A change to Hearth itself",
  "browser-change": "Changes in an app's own web page, from Ember's browser",
  "free-memory": "Free memory: close an app or free the voice",
  "lab-transfer": "Hearth Transfer (removed from Hearth)",
  "app-radarr-set-root-folder": "Change a movie's root folder (Radarr)",
  "tinyauth-users": "Users and passwords (Tinyauth)",
  "app-seerr-decline": "Decline a request (Overseerr)",
  "app-seerr-remove": "Remove a request (Overseerr)",
  "app-seerr-request": "Request a movie or show (Seerr)",
  "app-seerr-retry": "Retry a failed request (Seerr)",
  "app-seerr-mark-available": "Tell Seerr a title is in the library",
  "app-seerr-search-on-add": "Whether Seerr searches as soon as a movie is requested",
  "app-seerr-issue": "Handle an issue (Seerr)",
  "compose-update-image": "Update a container's image",
  "compose-install": "Install a new app (Compose)",
  "compose-remove": "Remove a project's containers, keeping its files",
  "file-manage": "Create a folder, or rename, move, or copy files",
  "storage-raid": "Manage a RAID array: drives, checks, speed, growth, or a new array",
};
// Operations inside apps need details (which indexer, on or off): Ember plans those.
const STEP_KINDS = ACTION_KINDS.filter(
  (kind) => !APP_ACTIONS.includes(kind) && !CONFIG_ACTIONS.includes(kind),
).map((kind) => ({
  kind,
  label: STEP_KIND_LABEL[kind],
}));

function done(job: Job) {
  return job.steps.filter((s) => s.status === "succeeded" || s.status === "rolled-back").length;
}

/** Build a plan from what Hearth already knows how to do. */
function PlanForm({ ws, projectId }: { ws: Workspace; projectId?: string }) {
  const plan = usePlanJob();
  const navigate = useNavigate();
  const services = [...ws.services].sort((a, b) => a.name.localeCompare(b.name));
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [steps, setSteps] = useState<{ kind: ActionKind; serviceId: string }[]>([
    { kind: "run-check", serviceId: services[0]?.id ?? "" },
  ]);
  const update = (i: number, change: Partial<{ kind: ActionKind; serviceId: string }>) =>
    setSteps((all) => all.map((s, j) => (j === i ? { ...s, ...change } : s)));

  if (!services.length) {
    return (
      <EmptyState title="Nothing to plan for yet">
        Add your systems first; jobs act on the services Hearth watches.
      </EmptyState>
    );
  }
  return (
    <Panel className="p-6 sm:p-8">
      <form
        aria-label="Plan a job"
        className="grid gap-4"
        onSubmit={(ev) => {
          ev.preventDefault();
          plan.mutate(
            { title, reason: reason || undefined, steps, projectId },
            { onSuccess: (job) => void navigate(`/jobs/${job.id}`) },
          );
        }}
      >
        <div>
          <label htmlFor="job-title" className="mb-1 block text-[0.82rem] text-muted">
            Title
          </label>
          <input
            id="job-title"
            required
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Job title"
            className={field}
          />
        </div>
        <div>
          <label htmlFor="job-reason" className="mb-1 block text-[0.82rem] text-muted">
            Why (optional)
          </label>
          <input
            id="job-reason"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={field}
          />
        </div>
        <ol className="grid gap-3" aria-label="Steps">
          {steps.map((step, i) => (
            <li key={i} className="grid gap-2 sm:grid-cols-[2rem_1fr_1fr_auto] sm:items-center">
              <span className="font-display text-[1.2rem] text-gold">{i + 1}</span>
              <select
                aria-label={`Step ${i + 1}: what`}
                value={step.kind}
                onChange={(e) => update(i, { kind: e.target.value as ActionKind })}
                className={field}
              >
                {STEP_KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
              <select
                aria-label={`Step ${i + 1}: service`}
                value={step.serviceId}
                onChange={(e) => update(i, { serviceId: e.target.value })}
                className={field}
              >
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <Button
                tone="quiet"
                disabled={steps.length === 1}
                aria-label={`Remove step ${i + 1}`}
                onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-3">
          <Button
            disabled={steps.length >= MAX_JOB_STEPS}
            onClick={() =>
              setSteps((all) => [...all, { kind: "run-check", serviceId: all.at(-1)!.serviceId }])
            }
          >
            Add a step
          </Button>
          <Button type="submit" tone="primary" disabled={plan.isPending || !title.trim()}>
            Review the plan
          </Button>
        </div>
        <p className="text-[0.8rem] leading-relaxed text-faint">
          Nothing runs yet. You review the plan with what each step does, how it is checked, and how
          it would be undone, then approve it once.
        </p>
        <FormError error={plan.error} />
      </form>
    </Panel>
  );
}

function JobsContent({ ws }: { ws: Workspace }) {
  const jobs = useJobs();
  const [params] = useSearchParams();
  const projectId = params.get("project") ?? undefined;
  const [planning, setPlanning] = useState(Boolean(projectId));
  const list = jobs.data ?? [];
  const waiting = list.filter((j) => j.status === "awaiting-approval").length;

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Jobs"
        subtitle={
          waiting
            ? `${waiting} waiting for your approval. Each job runs its steps in order, checks each one, and stops at the first problem.`
            : "Plans of steps Hearth already knows, approved once, carried out in order, each step checked."
        }
        actions={
          !planning && (
            <Button tone="primary" onClick={() => setPlanning(true)}>
              Plan a job
            </Button>
          )
        }
      />
      {planning && (
        <Section title="New plan">
          <PlanForm ws={ws} projectId={projectId} />
        </Section>
      )}
      <LongWork />
      {list.length === 0 && !jobs.isLoading ? (
        <EmptyState title="No jobs yet">
          Plans you make, and plans the AI proposes, appear here with their progress and results.
        </EmptyState>
      ) : (
        <Rows>
          {list.map((job) => (
            <RowLink key={job.id} to={`/jobs/${job.id}`} label={job.title}>
              <StatusDot
                health={
                  job.status === "awaiting-approval"
                    ? "attention"
                    : job.status === "failed" || job.status === "interrupted"
                      ? "offline"
                      : "healthy"
                }
              />
              <div className="min-w-0 flex-1">
                <p className="text-[0.95rem] text-ink">{job.title}</p>
                <p className="mt-0.5 truncate text-[0.8rem] text-faint">
                  {WHO[job.requestedBy]} · {done(job)} of {job.steps.length}{" "}
                  {job.steps.length === 1 ? "step" : "steps"} · {ago(job.createdAt)}
                </p>
              </div>
              <div className="hidden sm:block">{jobTag(job.status)}</div>
            </RowLink>
          ))}
        </Rows>
      )}
    </>
  );
}

export function JobsPage() {
  return <WithWorkspace>{(ws) => <JobsContent ws={ws} />}</WithWorkspace>;
}
