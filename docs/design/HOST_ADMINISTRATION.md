# Home server administration: audit, privilege boundaries, plan

Status: Phase 1 APPROVED by the owner 2026-10-10 and BUILT (see 12); everything else PROPOSED. Self-service capability acquisition added as a core requirement (11). This replaces the per-file registration design (checklist 21.1 to 21.7). Nothing in it is deployed. Phase 1 adds no new operating-system privilege. The root helper (Phase 4) and any automatic policy (Phase 5) each get their own approval when they come up.

## 1. Audit: what exists today

### How Hearth runs on a typical home server (an example install, read only)

| Fact | Consequence |
|---|---|
| The systemd unit runs as `homelab` (the owner's login user). | DC can already read and write everything the owner's account can. |
| That user is in the `docker` group. | The DC process is already root-equivalent through the Docker socket. Today the only limit is DC's own code. |
| That user is in the `adm` group. | DC can read `/var/log` and the system journal without root. |
| Even if that user can use sudo, the unit sets `NoNewPrivileges=yes`. | The DC process cannot use sudo. This proposal keeps it that way. |
| `ProtectSystem=full` is set. | `/usr`, `/boot` and `/etc` are read-only to DC, which stops DC from editing its own unit, sudoers or `/etc`. |
| Most folders in `/srv/homelab/docker/config` are owned by `homelab`, as are `/srv/homelab/backups` and the media drives. | Config edits, Recyclarr, media inventory and quarantine moves all work **as the existing user**. None of them needs root. |
| the home server's docs live in `/srv/homelab/docs/{architecture,infrastructure,procedures,services}`. The backup ledger convention is `backups/<service>/<date>-<reason>/`. No quarantine convention exists yet. | Backups follow the ledger. The quarantine location is a new convention and needs the owner's decision (see 6). |

### Capabilities DC already has (all reused, nothing duplicated)

- **Containers:** status, health, logs, inspect and mounts; lifecycle actions through approval plans.
- **Apps:** Radarr, Sonarr, qBittorrent and other APIs through Secure Vault. Credentials stay on the backend.
- **Plans engine:** immutable fingerprints, per-item revalidation, the stale and partial outcomes, undo, audit, and memory records.
- **Interactive Workspaces:** snapshot to plan to per-item results (Stage 2).
- **Built in this session (uncommitted):**
  - safe file primitives: masked read, exact edits, ledger backups, atomic writes, restore (`admin/files.ts`);
  - fixed-command container exec (`admin/docker-exec.ts`);
  - Recyclarr preview, sync and last run (`admin/recyclarr.ts`);
  - config-edit, config-restore and recyclarr-sync plan steps (`admin/operations.ts`);
  - qBittorrent remove and remove-with-data steps.

  All of these carry over unchanged. Only the access check changes: from "this file was registered" to "this path is inside the host scope and not protected" (`admin/grants.ts` is reworked, see 3).

### What is missing

- General host reading: any file or folder, disk usage, processes, timers and cron, systemd units, network state.
- General file operations: create, move, rename, ownership and mode changes, quarantine.
- Compose operations.
- Classifying failures so the Cave can report them correctly.
- Resuming a workflow after authorization.
- Recording capability gaps.
- Media inventory.

## 2. Threat model, stated plainly

The controls protect against **the AI doing something you did not approve**: a mistake, a misunderstanding, or instructions planted in a file, log or web page it reads. They do this by limiting the operations the AI can request.

They do **not** turn a compromised Hearth process into a safe one. Docker group membership already makes that process root-equivalent, and that was true before this proposal. Hardening it (a dedicated service user plus a Docker socket proxy) is listed under future work, not hidden.

## 3. Scope model

- **Host scope grant (one per host).** Settings > Ember > Administration has a per-host switch for the home server: "Administer this host".
  - It replaces per-file registration. It is durable, revocable at once, audited, and limited to that host.
  - It never extends to Desktop-PC or Gaming-PC. Each machine needs its own switch, and only hosts DC runs on are eligible for file work.
- **Inside the scope, every path, unit and container falls into a class:**
  - **Ordinary:** most of the storage pool, the media drives, app configs, logs.
  - **Protected:** Caddy, Gluetun, the VPN, firewall (ufw/nftables), Tailscale, sshd, sudoers, PAM, users and groups, fstab, Docker daemon config and networks, Hearth's own code, unit, database, keys and Secure Vault, and `/srv/homelab/secrets`.
  - **Secret content:** private keys, `/etc/shadow`, gpg keyrings, `.env` values, token files, DC's key directory. Never returned to the AI.
- **The class lists live in code plus a root-owned file** (`/etc/dragon-control/protected.json`).
  - DC can read that file but cannot change it (`ProtectSystem=full`).
  - No AI tool edits it, and no setting the AI can reach edits it.
  - the owner can add entries by hand. Code can only make the lists stricter.

## 4. Operation tiers

| Tier | What | Who decides | Examples |
|---|---|---|---|
| T0 Investigate | Read-only; runs automatically inside the scope | Host scope switch | List, stat, read (masked), search names, disk usage, container inspect and logs, Compose files, systemd status and journal, timers and cron, processes, listening ports, Docker networks, DNS lookups, app API reads, Recyclarr preview |
| T1 Routine | Reversible, low risk; **only** under an automatic policy the owner turns on | Policy (none enabled at first) | Restarting a non-protected container, an Arr rescan or refresh |
| T2 Consequential | Approval plan: exact targets, fingerprints, backup, verify, undo | the owner approves the plan | Config edit (any ordinary text file), create, move, rename, mkdir, quarantine and restore, chown and chmod, container start, stop, restart and recreate, Compose up and pull, Recyclarr sync, torrent removal |
| T3 Protected | A plan step flagged Protected: approved on its own, with a fresh passkey check, never bundled with other steps | the owner, separately | Anything touching a protected path, unit or container |
| Never | Not offered to the AI at all | Nobody (code) | Raw shell or arbitrary commands, returning secret content, editing the protected lists or audit log, editing DC itself, permanent deletion without the separate item-specific purge approval, deleting backups, creating or rotating credentials |

### T0 safeguards

- **Size limits:**
  - reads: 256 KB per call, paged, binary files detected;
  - listings: 500 entries;
  - searches and disk usage: depth and time caps (default 20 s).
- **Masking:**
  - key-based masking (already built) plus pattern redaction of results;
  - container environment shows names only.
- **Auditing:** every read records path, bytes and tool, never the content.
- **Untrusted content:** results are labelled as data from the host, so text inside files is never treated as instructions.

### T2 and T3 safeguards

Unchanged from the existing engine:

- immutable snapshot and fingerprint, including before-hashes;
- each target revalidated before every step (stale means skip);
- a ledger backup before any write;
- atomic replace that keeps owner and mode;
- read-back plus an app-specific check (Recyclarr preview, a container health check);
- undo from the backup;
- the audit and memory record.

## 5. How operations run (privilege boundary)

1. **Phases 1 to 3 run in the existing DC process as `homelab`.**
   - The unit does not change: `NoNewPrivileges` stays, sudo stays unusable from DC, and `ProtectSystem` stays.
   - Commands are fixed argument lists run without a shell (`execFile`), or Docker API calls. The AI supplies only typed parameters such as paths, names and edits. It never supplies a command string.
2. **Phase 4: a small root helper, `dc-hostd`, only for what needs root.**
   - Examples: restarting system services, reading root-only files with masking, ownership repairs to other users.
   - It listens on a Unix socket readable only by `homelab`.
   - It offers a fixed operation list with its own copy of the protected and never rules.
   - Writes are refused unless they carry an approved plan step ID and fingerprint, which the helper checks against DC.
   - It logs every request to journald, outside DC's database.
   - the owner approves its exact operation list before install.
3. **Rejected:**
   - Dropping `NoNewPrivileges` so DC can use sudo: that gives the DC process every command.
   - Using the Docker socket to reach root (mounting `/` into a container): a hidden escalation that is hard to audit.

## 6. Quarantine and backups

- **Config and host file backups:** `/srv/homelab/backups/<service or host>/<YYYYMMDD-HHMMSS>-dragon-control-<reason>/`, each with a `manifest.json`. This follows the ledger.
  - Bundling: whether the nightly encrypted bundle includes these folders is not yet confirmed. It excludes old `.bak` copies; I will check its include list before the first write.
  - Nothing is pruned automatically.
- **Media quarantine (proposed, needs the owner's decision):** a per-drive folder, `/mnt/<drive>/.dragon-control-quarantine/<date>-<plan>/<original relative path>`, plus a manifest.
  - A same-drive rename is instant and copies nothing, which matters for multi-GB files on NTFS.
  - It never uses `$RECYCLE.BIN`.
  - "Space recovered" is reported as zero until a purge, because quarantined files still occupy the drive. The workspace shows the space that **will** be recovered on purge.
  - A purge is a separate P6-style destructive approval per item. It is never automatic.
  - Exclusion: Radarr and Sonarr do not scan `.dragon-control-quarantine` because it sits outside their root folders. Plex and Jellyfin library paths get checked before first use.

## 7. Continuity

- **Failure classes:** each tool result carries one of `missing-capability`, `missing-permission`, `missing-credential`, `unsupported`, `protected` or `temporary`, so the Cave names the real cause.
- **Authorization inside the workflow:** a missing permission or a protected step appears as a card in the conversation with "Allow and continue". After approval, the same conversation resumes the interrupted step from a saved checkpoint (tool, parameters, plan).
- **Capability gaps** are recorded with the conversation, plan and attempted operation, and appear in a Capabilities list. When the capability ships, the Cave reopens the linked task.
- **Instruction:** the Cave must try the general host operation before reporting that a service-specific integration is missing.

## 8. Phases

| Phase | Delivers | New OS privilege |
|---|---|---|
| 1 | Host scope switch and protected lists; T0 investigation tools; failure classes; the config tools moved onto scope; capability gaps; Settings UI. **Unblocks the Recyclarr acceptance test** (recyclarr.yml is owned by homelab; edits go through approved plans). | None |
| 2 | File operations (T2): create, move, rename, mkdir, chown and chmod within user-owned trees, quarantine and restore; Compose operations; T3 protected flagging with a passkey check; resume after authorization. | None |
| 3 | Media inventory (Radarr and Sonarr file data, plus filesystem and ffprobe from an existing media container for files they do not manage); duplicates workspace; quarantine plan; actual recovered space. **Duplicate-media acceptance test.** | None |
| 4 | `dc-hostd` root helper for system services and root-owned files. | Yes: separate approval |
| 5 | Optional T1 automatic policy. | None; the owner defines it |
| 6 | Ember rename and administrator display name (Identity). Internal IDs (`cave`) stay. | None |

## 9. Rollback of the framework itself

- **Before deploy:** a standard pre-deploy backup.
- **Database:** migrations are additive.
- **Kill switch:** the host scope switch turns off all T0 to T3 host operations immediately. "Stop all administrative actions" also cancels queued steps.
- **Feature flag:** `DC_HOST_ADMIN=0` disables the whole module at startup.
- **dc-hostd (Phase 4):** removed with `systemctl disable --now dc-hostd`, then deleting the unit and the socket.

## 10. Future hardening (not proposed now)

Run DC as a dedicated `dragon-control` user behind a Docker socket proxy, so a compromised process is no longer root-equivalent. Doing this means reworking file ownership on the storage pool, so it gets its own plan.

## 11. Self-service capability acquisition (the owner, 2026-10-10: core requirement)

The workflow: **investigate, identify the missing capability, research a suitable solution,
explain the requirements, request approval, install or configure, verify, resume the original task.**
One framework for every kind (Linux packages and utilities, diagnostic and maintenance tools, tools
inside containers, AI skills and workflow instructions, plugins and integrations, app API
connections, reusable scripts), not one installer per tool.

**Building blocks (Phase 1 lays the first three; the rest are later phases):**

1. **Capability registry** (`capabilities` table, built): one record per capability with kind,
   status (available, missing, requested, installed, disabled, removed), source, version,
   location, purpose, host, and, for something missing, the gap kind, the task it blocked, the
   conversation and plan. Utilities are detected from the PATH (nothing is run).
2. **Failure classes** (built): every host tool result names missing capability, missing
   permission, missing credential, unsupported, protected, secret, or temporary.
3. **Host conventions lookup** (built): `host_conventions` lists the host's own documents and
   backup ledger; the Ember must read the relevant ones before proposing installations, folders,
   backups, deployments, or storage changes, and ask before inventing a convention.
4. **Acquisition proposal** (planned, plan kind `capability-install`): a structured proposal the
   owner approves, stating name, why it is needed, trusted source and exact version (distribution
   repository or verified upstream release with checksum or signature), method and location
   (host package, existing container, new container per the host's Compose conventions),
   permissions it gets, dependencies and conflicts, impact on running services, backup and
   rollback, and whether it adds a service, network exposure, or recurring maintenance.
5. **Installers per method, not per tool** (planned): `apt` packages (needs the root helper,
   Phase 4, so its exact operation is part of that approval), container tools (prefer a tool an
   existing container already has, e.g. ffprobe in the Plex or Jellyfin image, run with a fixed
   command), new Compose services (Compose files per the home server's layout, protected keys still
   protected), skills and workflow instructions (stored as reviewed text in Hearth, never
   executed, never able to change permissions).
6. **Verification and resume** (planned): after install, a fixed check (version command, a probe)
   marks it installed; the linked task is reopened in its conversation.
7. **Lifecycle** (planned): disable, remove (with the same approval and rollback), update
   availability, execution history; shown in Settings > Ember > Tools and capabilities.

**Self-created scripts.** Category A (a narrowly scoped script inside an approved framework, run
through a reviewed approval plan with its full text shown, no new privileges) can follow once the
installer exists. Category B (new executable code with privileges, new privileged operations,
changes to Hearth's security architecture or code) always needs the owner's explicit approval and
may need DC to implement or review it. The Ember can never modify its own security controls, its
scope rules, or its permissions.

**Untrusted content.** Downloaded skills, plugins, documentation, and code are data. Nothing
downloaded is executed with administrative privileges without review, and no third-party
instruction text can widen what the Ember may do.

## 12. Phase 1 as built (2026-10-10)

- Host scope switch per host (`host_scopes`, Settings > Ember > Administration: Off,
  Investigate, Investigate and propose changes). Session routes only; access keys cannot reach them.
- Classes in `apps/server/src/admin/scope.ts` plus optional root-owned
  `/etc/dragon-control/protected.json` (additive only). Protected systems are readable; secret
  files return metadata only. Hearth's data, key, and backup folders are secret; its code
  is protected.
- Investigation tools for the Ember: `host_scope`, `host_list`, `host_stat`, `host_read` (256 KB
  pages, masked), `host_search`, `host_disk_usage`, `host_diagnose` (24 fixed diagnostics, no
  shell, redacted, 64 KB), `host_conventions`, `service_files`, `recyclarr_status`, `config_check`,
  `record_missing_capability`, `list_capabilities`. Every look is audited by what, never content.
- Config edits on any ordinary text file through plans (`config-edit`, `config-restore`,
  `app-recyclarr-sync`); Compose edits under networking or privilege keys are refused as protected.
- Tools and capabilities registry with gap recording and PATH detection.
- Still runs as `homelab` with `NoNewPrivileges`; no unit change, no root helper.
- Phase 1 counts as functionally complete only after the Ember demonstrates the Recyclarr repair.
