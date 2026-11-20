import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** Small key/value table for install-level facts (install id, first start). */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(now),
});

/** User-facing settings (instance name, autonomy default, quiet hours, demo scenario). */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull().default(now),
});

export const hosts = sqliteTable("hosts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  os: text("os").notNull(),
  address: text("address").notNull(),
  cpuModel: text("cpu_model").notNull(),
  cpuCores: integer("cpu_cores").notNull(),
  cpuUsagePct: real("cpu_usage_pct").notNull(),
  memTotalGb: real("mem_total_gb").notNull(),
  memUsedGb: real("mem_used_gb").notNull(),
  uptimeHours: real("uptime_hours").notNull(),
  connection: text("connection", { enum: ["this-machine", "agent", "network"] }).notNull(),
  docker: integer("docker", { mode: "boolean" }).notNull(),
  health: text("health", { enum: ["healthy", "attention", "offline"] }).notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  sort: integer("sort").notNull().default(0),
});

/** Storage sources. Local volumes today; shares, NAS and remote storage later. */
export const volumes = sqliteTable("volumes", {
  id: text("id").primaryKey(),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  mount: text("mount").notNull(),
  kind: text("kind", { enum: ["ssd", "hdd", "nas", "disk"] }).notNull(),
  totalTb: real("total_tb").notNull(),
  usedTb: real("used_tb").notNull(),
  smart: text("smart", { enum: ["ok", "warning"] }).notNull(),
  sort: integer("sort").notNull().default(0),
});

export const autonomyRules = sqliteTable("autonomy_rules", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  description: text("description").notNull(),
  level: text("level", { enum: ["default", "monitor", "diagnose", "ask", "auto"] }).notNull(),
  sort: integer("sort").notNull().default(0),
});

export const services = sqliteTable("services", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["container", "process", "web"] }).notNull(),
  image: text("image"),
  version: text("version"),
  localUrl: text("local_url"),
  publicUrl: text("public_url"),
  proxyServiceId: text("proxy_service_id"),
  health: text("health", { enum: ["healthy", "attention", "offline"] }).notNull(),
  responseMs: integer("response_ms"),
  uptimePct: real("uptime_pct"),
  autonomyArea: text("autonomy_area").notNull(),
  /** What monitoring checks: "container:<name>", "process:<id>", or "demo:<id>". */
  checkTarget: text("check_target"),
  note: text("note"),
  /**
   * Watched normally, paused (off on purpose for now), retired (replaced
   * or removed, kept for history), or removed (you took it out of
   * Hearth: hidden everywhere, kept only so a scan never adds it back and
   * Settings can restore it). Only active services are checked.
   */
  lifecycle: text("lifecycle", { enum: ["active", "paused", "retired", "removed"] })
    .notNull()
    .default("active"),
  lifecycleNote: text("lifecycle_note"),
  lifecycleAt: text("lifecycle_at"),
  /**
   * Set while its container is stopped because someone asked (a stop action):
   * not checked and never "repaired" until it is started again.
   */
  stoppedAt: text("stopped_at"),
  stoppedBy: text("stopped_by"),
  /** Found by a scan, or added by you. A scan never removes one you added. */
  origin: text("origin", { enum: ["discovered", "manual"] })
    .notNull()
    .default("discovered"),
  sort: integer("sort").notNull().default(0),
});

/** Known relationships between services (the start of the service graph). */
export const serviceDependencies = sqliteTable(
  "service_dependencies",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.dependsOnId] })],
);

export const incidents = sqliteTable("incidents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
  status: text("status", { enum: ["open", "awaiting-approval", "approved", "resolved"] }).notNull(),
  openedAt: text("opened_at").notNull(),
  resolvedAt: text("resolved_at"),
  summary: text("summary").notNull(),
  resolution: text("resolution"),
  handledBy: text("handled_by", {
    enum: ["runbook", "agent", "you", "pending", "recovered"],
  }).notNull(),
  proposedAction: text("proposed_action"),
  /** When the current proposal can no longer be approved (see actions/approval.ts). */
  proposalExpiresAt: text("proposal_expires_at"),
  hostId: text("host_id").references(() => hosts.id, { onDelete: "set null" }),
  serviceId: text("service_id").references(() => services.id, { onDelete: "set null" }),
  /** Set when monitoring opened it (e.g. "service:prowlarr"), so one problem is one incident. */
  monitorKey: text("monitor_key"),
  /** Failure kind when opened by monitoring; with the service it is the incident's fingerprint. */
  problem: text("problem"),
});

export const incidentTimeline = sqliteTable("incident_timeline", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  incidentId: text("incident_id")
    .notNull()
    .references(() => incidents.id, { onDelete: "cascade" }),
  at: text("at").notNull(),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
});

/** Meaningful observations; the recent activity feed is built from these. */
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  tone: text("tone", { enum: ["good", "neutral", "attention"] }).notNull(),
  message: text("message").notNull(),
  incidentId: text("incident_id").references(() => incidents.id, { onDelete: "set null" }),
  hostId: text("host_id").references(() => hosts.id, { onDelete: "set null" }),
  serviceId: text("service_id").references(() => services.id, { onDelete: "set null" }),
});

/** Discrete operations requested by Hearth, an agent, or you (executed from M5). */
export const actions = sqliteTable("actions", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  targetType: text("target_type", { enum: ["host", "service"] }).notNull(),
  targetId: text("target_id").notNull(),
  requestedBy: text("requested_by", { enum: ["you", "dragon-control", "agent"] }).notNull(),
  incidentId: text("incident_id").references(() => incidents.id, { onDelete: "set null" }),
  status: text("status", {
    enum: ["requested", "refused", "running", "succeeded", "failed"],
  }).notNull(),
  requestedAt: text("requested_at").notNull(),
  completedAt: text("completed_at"),
  result: text("result"),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  status: text("status", { enum: ["connected", "available", "coming-later"] }).notNull(),
  detail: text("detail"),
  sort: integer("sort").notNull().default(0),
});

/** One piece of work by an AI agent: an incident it was asked to look at, or a conversation turn. */
export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  incidentId: text("incident_id"),
  conversationId: text("conversation_id"),
  provider: text("provider"),
  /** A concise diagnosis or answer; never hidden reasoning. */
  summary: text("summary").notNull(),
  outcome: text("outcome", { enum: ["resolved", "proposed", "escalated"] }).notNull(),
  durationMs: integer("duration_ms"),
});

/** Where notifications can go. Installation settings: never cleared with an environment. */
export const notificationChannels = sqliteTable("notification_channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status", { enum: ["configured", "available"] }).notNull(),
  detail: text("detail"),
  /** Non-secret settings (server, port, addresses, topic). */
  config: text("config", { mode: "json" }).$type<Record<string, string | number | boolean>>(),
  /** Vault entry holding the secret part (password, webhook address, token). */
  secretId: text("secret_id"),
  sort: integer("sort").notNull().default(0),
  /**
   * What kind of channel (discord, email...). Empty on the built-in channels, whose id is their
   * kind; set on destinations you add (a second Discord channel, say).
   */
  kind: text("kind"),
  /** Switched off for now: kept, but nothing is sent. */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * Who reads it. "private": you (any notification). "public": friends and family, such as a media
   * channel: only media announcements may go there, never system or admin messages.
   */
  audience: text("audience", { enum: ["private", "public"] })
    .notNull()
    .default("private"),
});

/** Every notification sent, held for quiet hours, or failed. */
export const notificationLog = sqliteTable("notification_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  /** Route id: needs-you, auto-repaired, repair-failed, critical, resolved, weekly, test. */
  event: text("event").notNull(),
  incidentId: text("incident_id"),
  channelId: text("channel_id").notNull(),
  title: text("title").notNull(),
  status: text("status", { enum: ["sent", "held", "failed"] }).notNull(),
  error: text("error"),
  attempts: integer("attempts").notNull().default(1),
  sentAt: text("sent_at"),
});

export const notificationRoutes = sqliteTable("notification_routes", {
  id: text("id").primaryKey(),
  event: text("event").notNull(),
  description: text("description").notNull(),
  channels: text("channels", { mode: "json" }).$type<string[]>().notNull(),
  sort: integer("sort").notNull().default(0),
});

export const integrations = sqliteTable("integrations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull(),
  status: text("status", { enum: ["connected", "discovered", "available"] }).notNull(),
  instances: integer("instances"),
  sort: integer("sort").notNull().default(0),
});

/** Every change made by you, Hearth, or an agent. Append only. */
export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull().default(now),
  actor: text("actor", { enum: ["you", "dragon-control", "agent"] }).notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
});

/** Folders you chose to watch. Browsing is limited to these. */
export const storageLocations = sqliteTable("storage_locations", {
  id: text("id").primaryKey(),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  path: text("path").notNull(),
  source: text("source", { enum: ["fs", "demo"] }).notNull(),
  addedAt: text("added_at").notNull(),
  sort: integer("sort").notNull().default(0),
});

/** Physical drives and their health (CrystalDiskInfo-style), refreshed on demand. */
export const disks = sqliteTable("disks", {
  id: text("id").primaryKey(),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  type: text("type", { enum: ["ssd", "hdd", "unknown"] }).notNull(),
  bus: text("bus").notNull(),
  sizeTb: real("size_tb").notNull(),
  health: text("health", { enum: ["healthy", "warning", "failing", "unknown"] }).notNull(),
  temperatureC: real("temperature_c"),
  powerOnHours: integer("power_on_hours"),
  wearPct: real("wear_pct"),
  readErrors: integer("read_errors"),
  writeErrors: integer("write_errors"),
  volumes: text("volumes", { mode: "json" }).$type<string[]>().notNull(),
  checkedAt: text("checked_at").notNull(),
  limitation: text("limitation"),
});

/** Latest result per service check, used to debounce failures. */
export const checkState = sqliteTable("check_state", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["ok", "slow", "failing"] }).notNull(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  /** When the current run of failures began. */
  failingSince: text("failing_since"),
  /** Docker's restart count at the last check, to spot crash loops. */
  restartCount: integer("restart_count"),
  detail: text("detail"),
  /** What kind of failure, when failing; decides which repair (if any) fits. */
  problem: text("problem"),
  checkedAt: text("checked_at").notNull(),
  lastOkAt: text("last_ok_at"),
});

/** Hourly check totals, for 30-day availability without storing every check. */
export const availabilityHourly = sqliteTable(
  "availability_hourly",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    hour: text("hour").notNull(),
    ok: integer("ok").notNull().default(0),
    total: integer("total").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.hour] })],
);

/* ---------- Owner, sessions, and the vault. Never part of an environment. ---------- */

/** The one owner of this installation (single row, id 1). */
export const owner = sqliteTable("owner", {
  id: integer("id").primaryKey(),
  /** scrypt hash of the password, "scrypt$N$salt$hash". */
  passwordHash: text("password_hash").notNull(),
  recoveryHash: text("recovery_hash").notNull(),
  createdAt: text("created_at").notNull(),
  passwordChangedAt: text("password_changed_at").notNull(),
  /** Optional sign-in name; when set, the password sign-in asks for it too. */
  username: text("username"),
});

export const passkeys = sqliteTable("passkeys", {
  /** WebAuthn credential id, base64url. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull(),
  transports: text("transports", { mode: "json" }).$type<string[]>().notNull(),
  rpId: text("rp_id").notNull(),
  /** The protected-secrets key, wrapped by this passkey's PRF output; null when it cannot unlock. */
  wrappedPrivateKey: text("wrapped_private_key"),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
});

export const sessions = sqliteTable("sessions", {
  /** sha256 of the session token; the token itself is only ever in the cookie. */
  id: text("id").primaryKey(),
  method: text("method", {
    // "home": a paired home tablet; the server lets it reach the home dashboard only.
    enum: ["password", "passkey", "recovery", "setup", "paired", "home"],
  }).notNull(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  /** Last time you proved it was you (password or passkey) in this session. */
  verifiedAt: text("verified_at").notNull(),
  userAgent: text("user_agent"),
  /** "Remember this device": a long sliding lifetime; otherwise it ends after a few hours. */
  persistent: integer("persistent", { mode: "boolean" }).notNull().default(true),
  /** Signed in through the public address (internet) rather than the home network or Tailscale. */
  viaPublic: integer("via_public", { mode: "boolean" }).notNull().default(false),
});

/** Key material for the vault (single row, id 1). Every key here is wrapped. */
export const vaultKeys = sqliteTable("vault_keys", {
  id: integer("id").primaryKey(),
  /** Key for automation secrets, sealed by the operating system (or a key file). */
  automationKeySealed: text("automation_key_sealed").notNull(),
  keyGuard: text("key_guard").notNull(),
  /** X25519 public key that protected secrets are encrypted to. */
  protectedPublicKey: text("protected_public_key").notNull(),
  /** The matching private key, wrapped by your password and by the recovery key. */
  privateByPassword: text("private_by_password").notNull(),
  passwordKdfSalt: text("password_kdf_salt").notNull(),
  privateByRecovery: text("private_by_recovery").notNull(),
  recoveryKdfSalt: text("recovery_kdf_salt").notNull(),
  /** Salt for the passkey PRF extension, the same for every passkey. */
  prfSalt: text("prf_salt").notNull(),
});

export const vaultSecrets = sqliteTable("vault_secrets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", {
    enum: [
      "api-key",
      "password",
      "token",
      "login",
      "ssh-key",
      "database",
      "recovery",
      "certificate",
      // An app's sign-in (OAuth): its client ID (shown) and client secret (the value).
      "oauth-app",
      // A saved sign-in Hearth keeps for an app with no API key (its session, and how to sign in).
      "session",
      "other",
    ],
  }).notNull(),
  tier: text("tier", { enum: ["automation", "protected"] }).notNull(),
  /**
   * The owner allowed Hearth to sign Ember's Browser in to this credential's app with it
   * (server side; the browser only gets the session). Off unless the owner switches it on.
   */
  browserSignIn: integer("browser_sign_in", { mode: "boolean" }).notNull().default(false),
  /** How you organise it ("Router", "Proxies", "AI providers"); free text. Not secret. */
  category: text("category"),
  /** The account name that goes with the secret, when there is one. Not secret, shown only unlocked. */
  username: text("username"),
  /** Where it is used: an address or host. Not secret. */
  endpoint: text("endpoint"),
  /** Your notes about it (never the secret itself). */
  notes: text("notes"),
  tags: text("tags", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  /** When it last worked: you confirmed it, or an integration used it successfully. */
  verifiedAt: text("verified_at"),
  /** Soft link to the service it belongs to; survives re-scans and sample data switches. */
  serviceId: text("service_id"),
  /** Encrypted value; the plain value is never stored or logged. */
  ciphertext: text("ciphertext").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastUsedAt: text("last_used_at"),
  /**
   * What Hearth may do with it: "read" (diagnostics only) or
   * "approved-changes" (also changes you approve in a plan). Having a
   * credential never skips an approval.
   */
  scope: text("scope", { enum: ["read", "approved-changes"] })
    .notNull()
    .default("read"),
  /** Last time a use worked, and the last failure (never containing the value). */
  lastOkAt: text("last_ok_at"),
  lastFailureAt: text("last_failure_at"),
  lastFailure: text("last_failure"),
  /** rejected, unreachable, blocked, incompatible, or internal: only "rejected" means the credential is wrong. */
  lastFailureKind: text("last_failure_kind"),
  /** How it got here: "you", "generated: ...", or "imported from ...". */
  source: text("source"),
});

/** Access keys for other software (Home Assistant, scripts) and short-lived keys for agent sessions. */
export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** First characters, to recognise a key without storing it. */
  prefix: text("prefix").notNull(),
  /** sha256 of the key; the key itself is shown once. */
  tokenHash: text("token_hash").notNull(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  kind: text("kind", { enum: ["key", "agent"] }).notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
});

/** Conversations with the operator agent, typed in the app or spoken through Home Assistant. */
export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  source: text("source", { enum: ["app", "voice", "api"] }).notNull(),
  title: text("title").notNull(),
  /** A project's own conversation; null for general and main conversations. */
  projectId: text("project_id"),
  /** Its Thread Look (THREAD_LOOKS): a small Ember picture on the thread; null for none. */
  look: text("look"),
  status: text("status", { enum: ["idle", "working"] }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const conversationMessages = sqliteTable("conversation_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["you", "agent", "note"] }).notNull(),
  text: text("text").notNull(),
  at: text("at").notNull(),
  /** Where the answer's claims come from (Ember answers). */
  evidence: text("evidence", { mode: "json" }).$type<
    {
      id: string;
      label: string;
      ref?: string;
      kind: "live" | "record" | "memory" | "unreviewed";
      at?: string;
    }[]
  >(),
  /** How the answer was produced: by the AI, from records alone, or declined. */
  meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
});

/**
 * What actually happened while Ember answered one message, in order:
 * gathering facts, asking the AI, each tool the AI used, plans it proposed.
 * Written as it happens, never ahead of time; the app shows it live.
 */
export const conversationActivity = sqliteTable("conversation_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  /** The owner's message this work answers. */
  messageId: integer("message_id").notNull(),
  kind: text("kind", { enum: ["gather", "ai", "tool", "job", "records", "show"] }).notNull(),
  label: text("label").notNull(),
  status: text("status", { enum: ["running", "done", "failed", "waiting", "stopped"] }).notNull(),
  detail: text("detail"),
  /** What it refers to, e.g. "job:<id>" or "service:<id>". */
  ref: text("ref"),
  at: text("at").notNull(),
  finishedAt: text("finished_at"),
  /** A Show & Tell step: the place and target shown, and whether the screen confirmed it. */
  show: text("show", { mode: "json" }).$type<
    NonNullable<import("@dragon-control/core").CaveActivity["show"]>
  >(),
  /** Where what a step read came from (an evidence card), from the tool's own result. */
  evidence: text("evidence", { mode: "json" }).$type<
    NonNullable<import("@dragon-control/core").CaveActivity["evidence"]>
  >(),
});

/**
 * What Ember looks after, and what it must not take on. Installation
 * settings, owned by you: the AI can read it, never change it.
 */
export const jurisdiction = sqliteTable("jurisdiction", {
  id: text("id").primaryKey(),
  kind: text("kind", {
    enum: ["machine", "service", "repository", "path", "domain", "topic"],
  }).notNull(),
  name: text("name").notNull(),
  value: text("value"),
  access: text("access", { enum: ["in", "out"] }).notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
});

/** Every AI run with what it used, for usage reports and daily budgets. */
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull(),
    /** Local calendar day (YYYY-MM-DD), the unit budgets are counted in. */
    day: text("day").notNull(),
    kind: text("kind", { enum: ["question", "incident"] }).notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costUsd: real("cost_usd"),
    turns: integer("turns"),
    durationMs: integer("duration_ms").notNull().default(0),
    outcome: text("outcome", { enum: ["answered", "failed", "stopped-at-limit"] }).notNull(),
    conversationId: text("conversation_id"),
    incidentId: text("incident_id"),
  },
  (table) => [index("ai_usage_day").on(table.day)],
);

/* ---------- Homelab memory (D10) ---------- */

/** A homelab project the memory is organised around (the migration, Plezy, Belle...). */
export const memoryProjects = sqliteTable("memory_projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  summary: text("summary").notNull().default(""),
  status: text("status", { enum: ["active", "paused", "done"] })
    .notNull()
    .default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** Command center: the phase you set (facts like a waiting job override what is shown). */
  phase: text("phase"),
  icon: text("icon"),
  /** Its color on Home (PROJECT_COLORS); none keeps the plain card. */
  color: text("color"),
  /** Systems it concerns: [{ kind: "service" | "host", id }]. */
  related: text("related", { mode: "json" })
    .$type<{ kind: "service" | "host"; id: string }[]>()
    .notNull()
    .default(sql`'[]'`),
});

/** A project's own checklist: what is done and what is left. */
export const projectTasks = sqliteTable(
  "project_tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => memoryProjects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status", { enum: ["todo", "doing", "done", "blocked"] }).notNull(),
    seq: integer("seq").notNull(),
    createdAt: text("created_at").notNull(),
    doneAt: text("done_at"),
  },
  (table) => [index("project_tasks_project").on(table.projectId, table.seq)],
);

/** One remembered thing. Deleting only marks it (deleted_at), so it can be restored. */
export const memoryEntries = sqliteTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    kind: text("kind", {
      enum: ["journal", "thread", "win", "preference", "hardware", "note"],
    }).notNull(),
    projectId: text("project_id").references(() => memoryProjects.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status", { enum: ["open", "done"] }),
    happenedAt: text("happened_at").notNull(),
    basis: text("basis", { enum: ["observed", "documented", "stated", "unknown"] })
      .notNull()
      .default("unknown"),
    machine: text("machine"),
    verification: text("verification", { mode: "json" }).$type<{
      at: string;
      check: string;
      result: string;
    }>(),
    /** No longer how things are: kept as history, never shown as current. */
    superseded: text("superseded", { mode: "json" }).$type<{ at: string; reason: string }>(),
    source: text("source", { enum: ["you", "ai", "dragon-control", "import"] }).notNull(),
    author: text("author"),
    links: text("links", { mode: "json" })
      .$type<{ label: string; ref: string }[]>()
      .notNull()
      .default([]),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
    /** The writer's own id for this save, so a save resent after being offline is not duplicated. */
    clientRef: text("client_ref"),
  },
  (table) => [
    index("memory_entries_kind").on(table.kind, table.happenedAt),
    index("memory_entries_project").on(table.projectId),
    uniqueIndex("memory_entries_client_ref").on(table.clientRef),
  ],
);

/** Every change to an entry, with the entry as it was before. Nothing is silently lost. */
export const memoryRevisions = sqliteTable(
  "memory_revisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entryId: text("entry_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    at: text("at").notNull(),
    action: text("action", { enum: ["created", "edited", "deleted", "restored"] }).notNull(),
    by: text("by", { enum: ["you", "ai", "dragon-control", "import"] }).notNull(),
    author: text("author"),
    snapshot: text("snapshot", { mode: "json" }).notNull(),
  },
  (table) => [index("memory_revisions_entry").on(table.entryId)],
);

/** A whole session kept word for word (Claude Code, the app, voice), so reasoning survives. */
export const memoryTranscripts = sqliteTable(
  "memory_transcripts",
  {
    id: text("id").primaryKey(),
    client: text("client").notNull(),
    title: text("title").notNull(),
    machine: text("machine"),
    sessionRef: text("session_ref"),
    projectId: text("project_id").references(() => memoryProjects.id, { onDelete: "set null" }),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("memory_transcripts_session").on(table.client, table.sessionRef)],
);

export const memoryTranscriptMessages = sqliteTable(
  "memory_transcript_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    transcriptId: text("transcript_id")
      .notNull()
      .references(() => memoryTranscripts.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["you", "ai", "tool", "note"] }).notNull(),
    text: text("text").notNull(),
    at: text("at").notNull(),
  },
  (table) => [uniqueIndex("memory_transcript_messages_seq").on(table.transcriptId, table.seq)],
);

/** Each backup attempt and how it went. */
export const backupLog = sqliteTable("backup_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  reason: text("reason", { enum: ["scheduled", "manual", "startup"] }).notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  file: text("file"),
  bytes: integer("bytes"),
  durationMs: integer("duration_ms").notNull(),
  detail: text("detail").notNull(),
  copied: integer("copied", { mode: "boolean" }),
});

/**
 * Proposed memories from an import (notes, ledgers, past sessions), waiting
 * for the owner's review. Nothing becomes memory until accepted.
 */
export const memoryImportDrafts = sqliteTable(
  "memory_import_drafts",
  {
    id: text("id").primaryKey(),
    /** Stable id of the source piece (file + section), so a re-run updates instead of duplicating. */
    sourceRef: text("source_ref").notNull(),
    batch: text("batch").notNull(),
    origin: text("origin").notNull(),
    anchor: text("anchor").notNull(),
    kind: text("kind", { enum: ["entry", "project", "session"] }).notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    /** How it was read from the source ("decision heading", "open items list"...). */
    note: text("note").notNull().default(""),
    status: text("status", { enum: ["pending", "accepted", "rejected"] })
      .notNull()
      .default("pending"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    decidedAt: text("decided_at"),
    resultId: text("result_id"),
  },
  (table) => [
    uniqueIndex("memory_import_drafts_source").on(table.sourceRef),
    index("memory_import_drafts_status").on(table.status, table.batch),
  ],
);

/**
 * Jobs: a plan of known operations, approved once as a whole (bound by
 * fingerprint, expiring, single use), then carried out step by step.
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    reason: text("reason"),
    /** What changes for the owner if approved, in the AI's words. */
    impact: text("impact"),
    requestedBy: text("requested_by", { enum: ["you", "dragon-control", "agent"] }).notNull(),
    incidentId: text("incident_id").references(() => incidents.id, { onDelete: "set null" }),
    /** The project this job serves, if any (a project can hold many jobs). */
    projectId: text("project_id"),
    /** The conversation it was proposed in: its result is posted there when it ends. */
    conversationId: text("conversation_id"),
    status: text("status", {
      enum: [
        "awaiting-approval",
        "refused",
        "running",
        "succeeded",
        "partial",
        "failed",
        "rolled-back",
        "cancelled",
        "expired",
        "interrupted",
      ],
    }).notNull(),
    createdAt: text("created_at").notNull(),
    /** Until when the plan can be approved; cleared once decided. */
    expiresAt: text("expires_at"),
    approvedAt: text("approved_at"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    summary: text("summary"),
    /** Made from a workspace submission: the workspace and its frozen snapshot. */
    workspaceId: text("workspace_id"),
    snapshotId: text("snapshot_id"),
    /** per-item: each step stands alone (skipped or failed items never stop or undo the rest). */
    mode: text("mode", { enum: ["sequence", "per-item"] }),
  },
  (table) => [index("jobs_status").on(table.status, table.createdAt)],
);

export const jobSteps = sqliteTable(
  "job_steps",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    /** The service at planning time (kept even if the service is later removed). */
    serviceId: text("service_id").notNull(),
    serviceName: text("service_name").notNull(),
    label: text("label").notNull(),
    policy: text("policy", { enum: ["allow", "approve-first", "refuse"] }).notNull(),
    policyReason: text("policy_reason").notNull(),
    status: text("status", {
      enum: ["pending", "running", "succeeded", "failed", "skipped", "rolled-back", "interrupted"],
    }).notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    result: text("result"),
    actionId: text("action_id"),
    /** Values the operation needs (which indexer, on or off). Never secrets. */
    params: text("params", { mode: "json" }).$type<Record<string, string | number | boolean>>(),
    /** For configuration steps: the exact change, before and after, as approved. */
    change: text("change", { mode: "json" }).$type<{
      summary: string;
      settings: { name: string; before: string; after: string }[];
    }>(),
    /** Per-item plans: the workspace item this step acts on. */
    itemId: text("item_id"),
    /** Space a verified delete freed. */
    freedBytes: integer("freed_bytes"),
    /** Hearth read the result back and it matched what was approved. */
    verified: integer("verified", { mode: "boolean" }),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.seq] })],
);

/** The latest read of an application's own health (M9), one row per watched app. */
export const appHealth = sqliteTable("app_health", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  app: text("app").notNull(),
  status: text("status", {
    enum: ["ok", "attention", "failing", "unreachable", "needs-key"],
  }).notNull(),
  version: text("version"),
  issues: text("issues", { mode: "json" }).notNull(),
  facts: text("facts", { mode: "json" }).notNull(),
  detail: text("detail"),
  checkedAt: text("checked_at").notNull(),
  /** Consecutive reads with an error-level issue, so one blip does not open an incident. */
  failingChecks: integer("failing_checks").notNull().default(0),
  /** Queue, recent activity, and connections from the same read (Diagnostics panel). */
  details: text("details", { mode: "json" }),
});

/** Saved desktop workspace layouts: which panels are open and how the desk is arranged. */
export const deskLayouts = sqliteTable("desk_layouts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** The panels, in the address format (`[!]kind:id[@tab]`, comma-separated). */
  panels: text("panels").notNull(),
  /** Conversation dock: width in pixels and whether it was docked, minimized, or wide. */
  dock: text("dock", { mode: "json" }).$type<{ width?: number; mode?: string }>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Workspace groups: everything open on the command center at once (panels, their order and
 * sizes, the conversation beside them, and what was typed, filtered, or scrolled inside them),
 * kept as one restorable group. Leaving the command center minimizes the group to a pill;
 * restoring it brings every panel back. Closing a group is a separate, deliberate action.
 */
export const deskGroups = sqliteTable("desk_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** The command center's address for this group (panels, focus, view), without the group id. */
  search: text("search").notNull(),
  conversationId: text("conversation_id"),
  /** View state inside the panels (search, filters, sort, scroll, sizes, dock), size-limited. */
  view: text("view", { mode: "json" }).$type<Record<string, unknown>>(),
  /** Unfinished decisions the group held when last saved (warns before closing). */
  unsent: integer("unsent").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Issues & ideas: the owner's to-do list with Ember. "suggested" rows
 * are things Ember noticed that are not on the list (saved_at null)
 * until the owner asks; they also stop the same thing being suggested twice.
 */
export const todoItems = sqliteTable(
  "todo_items",
  {
    id: text("id").primaryKey(),
    number: integer("number").notNull(),
    category: text("category", { enum: ["issue", "task", "idea"] }).notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    priority: text("priority", { enum: ["high", "medium", "low"] }).notNull(),
    status: text("status", {
      enum: [
        "suggested",
        "open",
        "investigating",
        "waiting-approval",
        "deferred",
        "resolved",
        "dismissed",
      ],
    }).notNull(),
    services: text("services", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    projectId: text("project_id").references(() => memoryProjects.id, { onDelete: "set null" }),
    evidence: text("evidence", { mode: "json" })
      .$type<{ label: string; ref?: string; kind: string; at?: string }[]>()
      .notNull()
      .default(sql`'[]'`),
    nextAction: text("next_action"),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    jobIds: text("job_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    source: text("source", { enum: ["you", "agent"] }).notNull(),
    /** Normalised title words, to recognise the same thing noticed again. */
    fingerprint: text("fingerprint").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    savedAt: text("saved_at"),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    uniqueIndex("todo_items_number").on(table.number),
    index("todo_items_status").on(table.status),
  ],
);

/** Everything that happened to a to-do item, never rewritten. */
export const todoEvents = sqliteTable(
  "todo_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: text("item_id")
      .notNull()
      .references(() => todoItems.id, { onDelete: "cascade" }),
    at: text("at").notNull(),
    actor: text("actor", { enum: ["you", "agent", "dragon-control"] }).notNull(),
    kind: text("kind", {
      enum: ["created", "saved", "status", "edited", "linked", "note"],
    }).notNull(),
    text: text("text").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    conversationId: text("conversation_id"),
  },
  (table) => [index("todo_events_item").on(table.itemId, table.id)],
);

/**
 * Resource history, off until the owner switches it on: one row per container
 * (or the host) per hour, built from samples every few minutes as running
 * totals, so an hour costs one row however often it is sampled. Pruned daily
 * to the retention the owner set (default 14 days).
 */
export const resourceHourly = sqliteTable(
  "resource_hourly",
  {
    /** "host", or the container's name (its service is found through checkTarget). */
    subject: text("subject").notNull(),
    hour: text("hour").notNull(),
    samples: integer("samples").notNull().default(0),
    /** Percent of one CPU core (200 = two cores busy), as Docker reports it; host: percent of all. */
    cpuSum: real("cpu_sum").notNull().default(0),
    cpuMax: real("cpu_max").notNull().default(0),
    memSumMb: real("mem_sum_mb").notNull().default(0),
    memMaxMb: real("mem_max_mb").notNull().default(0),
    memLimitMb: real("mem_limit_mb"),
    /** Bytes read and written during the hour (between samples), where the system reports it. */
    readBytes: integer("read_bytes"),
    writeBytes: integer("write_bytes"),
    /** Host only: the highest 1-minute load average seen. */
    loadMax: real("load_max"),
  },
  // No index on hour alone: the daily prune scans at most a few tens of thousands of rows.
  (table) => [primaryKey({ columns: [table.subject, table.hour] })],
);

/**
 * Restart history: each start and stop of a watched container that
 * Hearth saw (read from Docker's own inspect data on monitoring passes), with
 * how the previous run ended and who caused it. Small rows, kept for the
 * retention the owner sets (default 90 days) and at most RESTART_KEEP_PER_SERVICE
 * per service.
 */
export const containerEvents = sqliteTable(
  "container_events",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    /** Docker's own time for the start or the end of the run. */
    at: text("at").notNull(),
    kind: text("kind", { enum: ["start", "stop"] }).notNull(),
    exitCode: integer("exit_code"),
    oomKilled: integer("oom_killed", { mode: "boolean" }),
    restartCount: integer("restart_count"),
    /** Starts: first-seen, dragon-control (an action it ran), docker (restart policy), outside. */
    cause: text("cause").notNull(),
    actionId: text("action_id"),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.serviceId, table.at, table.kind] })],
);

/**
 * Interactive workspaces (feature request 20): temporary side panels Ember fills with a
 * task's data. Kept until you dismiss them (or save them); untouched temporary ones are removed
 * after WORKSPACE_KEEP_DAYS. Dismissing never touches files, services, or approved operations.
 */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id"),
  kind: text("kind", { enum: ["temporary", "saved"] }).notNull(),
  /** closed: a saved working file nobody has open (it stays in Saved work). */
  state: text("state", { enum: ["open", "minimized", "closed"] }).notNull(),
  spec: text("spec", { mode: "json" }).notNull(),
  selections: text("selections", { mode: "json" }).notNull(),
  submission: text("submission", { mode: "json" }),
  /** Saved working files: your own folder name, for organizing them. */
  folder: text("folder"),
  savedAt: text("saved_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * What you submitted from a workspace, frozen (feature request 20.6). Never updated: a plan made
 * from a submission points here, so editing the workspace later cannot change what was approved.
 * Kept when the workspace is discarded, as the record behind its plans.
 */
export const workspaceSnapshots = sqliteTable(
  "workspace_snapshots",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    conversationId: text("conversation_id"),
    at: text("at").notNull(),
    title: text("title").notNull(),
    choices: text("choices", { mode: "json" }).notNull(),
    decisions: text("decisions", { mode: "json" }).notNull(),
    /** The decided items as they were shown when you submitted. */
    items: text("items", { mode: "json" }).notNull(),
  },
  (table) => [index("workspace_snapshots_workspace").on(table.workspaceId, table.at)],
);

/**
 * Images you attached to a message (feature request 19). Kept on your Hearth with their
 * conversation (deleted with it); captures never sent are cleared after a day, and the total is
 * capped (ATTACHMENT_LIMITS). The AI sees one only through view_attachment, only in the
 * conversation it was sent in, and only after it was sent.
 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    /** Set when sent: the message it belongs to. */
    messageId: integer("message_id"),
    mime: text("mime").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    context: text("context", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("attachments_message").on(table.conversationId, table.messageId)],
);

/**
 * What Hearth may touch, granted by you (feature request 21): one file or one fixed
 * operation of one service on one machine, with the operations allowed. Revoked grants are kept
 * (revoked_at) as the record. Nothing outside these grants is read or changed.
 */
export const hostScopes = sqliteTable("host_scopes", {
  id: text("id").primaryKey(),
  hostId: text("host_id").notNull(),
  /** investigate (read only, automatic) and propose (plans for consequential changes). */
  operations: text("operations", { mode: "json" }).notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
});

/** Tools and capabilities (feature request 22): what exists, what is missing, what was asked for. */
export const capabilities = sqliteTable("capabilities", {
  id: text("id").primaryKey(),
  hostId: text("host_id"),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  version: text("version"),
  source: text("source"),
  location: text("location"),
  purpose: text("purpose"),
  gap: text("gap"),
  task: text("task"),
  conversationId: text("conversation_id"),
  jobId: text("job_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Conversation mode's workstation: the floating panels open beside one conversation
 * with Warden (which, where, how big, which on top, minimized), so leaving and coming back, a
 * refresh, or another browser restores them. Keyed by conversation ("draft:..." before its first
 * message). Only an explicit close removes a panel.
 */
export const talkLayouts = sqliteTable("talk_layouts", {
  key: text("key").primaryKey(),
  layout: text("layout", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Long work reported from anywhere (voice training on the GPU machine, a big copy, a migration
 * script): progress and a heartbeat, so a job that stops reporting is noticed as stalled. See
 * packages/core/src/work.ts and docs/design/AGENT_NEEDS_PLAN.md (Phase 0).
 */
export const trackedWork = sqliteTable(
  "tracked_work",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    machine: text("machine").notNull(),
    status: text("status", {
      enum: ["running", "done", "failed", "stalled", "stopped"],
    }).notNull(),
    progress: real("progress"),
    detail: text("detail"),
    startedAt: text("started_at").notNull(),
    heartbeatAt: text("heartbeat_at").notNull(),
    stopBy: text("stop_by"),
    stallMinutes: integer("stall_minutes").notNull().default(10),
    finishedAt: text("finished_at"),
    reportedBy: text("reported_by").notNull(),
    /** Alerts already sent, so each is sent once: "stalled", "overdue", "failed". */
    alerted: text("alerted", { mode: "json" }).$type<string[]>().notNull().default([]),
  },
  (table) => [index("tracked_work_status").on(table.status, table.heartbeatAt)],
);

/**
 * Watches: things followed over days or weeks, each checked when it is due
 * (docs/design/RELEASE_WATCH.md). One row per thing, found again by its stable key.
 */
export const watches = sqliteTable(
  "watches",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["movie-release"] }).notNull(),
    /** Stable per kind (a Seerr request), so the same thing is never watched twice. */
    key: text("key").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull(),
    /** What was read at the last check (never a secret). */
    facts: text("facts", { mode: "json" }).$type<unknown>(),
    /** What the rules made of it. */
    assessment: text("assessment", { mode: "json" }).$type<unknown>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastCheckedAt: text("last_checked_at"),
    /** Null when the watch is finished or dismissed. */
    nextCheckAt: text("next_check_at"),
    checkError: text("check_error"),
    snoozedUntil: text("snoozed_until"),
    dismissedAt: text("dismissed_at"),
    /** News already recorded, by key, so each piece is told once. */
    told: text("told", { mode: "json" }).$type<string[]>().notNull().default([]),
  },
  (table) => [
    uniqueIndex("watches_kind_key").on(table.kind, table.key),
    index("watches_due").on(table.nextCheckAt),
  ],
);

export const watchEvents = sqliteTable(
  "watch_events",
  {
    id: text("id").primaryKey(),
    watchId: text("watch_id")
      .notNull()
      .references(() => watches.id, { onDelete: "cascade" }),
    at: text("at").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    text: text("text").notNull(),
    /** The kind of news (release-watch notify kinds); absent for history that is not news. */
    notify: text("notify"),
    /** Sent to a channel, held (quiet hours or snoozed, sent later), switched off, or not news. */
    sent: text("sent", { enum: ["sent", "held", "off", "none"] }).notNull(),
  },
  (table) => [index("watch_events_watch").on(table.watchId, table.at)],
);

/**
 * Findings (checklist section 32): conditions worth the owner's attention, from Hearth's
 * analyzers and from Ember. One row per occurrence of a condition: updated while it lasts,
 * resolved when a recheck shows it is gone, and kept as history after that.
 */
export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    number: integer("number").notNull(),
    key: text("key").notNull(),
    source: text("source").notNull(),
    analyzer: text("analyzer").notNull(),
    kind: text("kind", {
      enum: ["problem", "suspected", "observation", "recommendation"],
    }).notNull(),
    severity: text("severity", { enum: ["critical", "high", "medium", "low", "info"] }).notNull(),
    /** failure, degraded, risk, maintenance, visibility, or state (see FINDING_NATURES). */
    nature: text("nature", {
      enum: ["failure", "degraded", "risk", "maintenance", "visibility", "state"],
    })
      .notNull()
      .default("failure"),
    /** What makes it the same condition (set by its analyzer): an acceptance holds while it matches. */
    signature: text("signature").notNull().default(""),
    status: text("status", {
      enum: [
        "candidate",
        "open",
        "acknowledged",
        "investigating",
        "planned",
        "resolved",
        "dismissed",
        "accepted",
      ],
    }).notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    why: text("why").notNull(),
    nextSteps: text("next_steps", { mode: "json" }).$type<string[]>().notNull(),
    evidence: text("evidence", { mode: "json" })
      .$type<{ label: string; value: string; at?: string }[]>()
      .notNull(),
    resources: text("resources", { mode: "json" })
      .$type<{ kind: string; name: string; id?: string }[]>()
      .notNull(),
    serviceId: text("service_id").references(() => services.id, { onDelete: "set null" }),
    hostId: text("host_id").references(() => hosts.id, { onDelete: "set null" }),
    incidentId: text("incident_id").references(() => incidents.id, { onDelete: "set null" }),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    todoId: text("todo_id").references(() => todoItems.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by", { enum: ["hearth", "ember"] }).notNull(),
    /** Times seen in a row (a candidate shows once its analyzer has seen it often enough). */
    sightings: integer("sightings").notNull().default(1),
    occurrences: integer("occurrences").notNull().default(1),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    checkedAt: text("checked_at").notNull(),
    resolvedAt: text("resolved_at"),
    resolution: text("resolution"),
    /** It was resolved by a repair (a plan, or Hearth's own fix), not on its own. */
    repaired: integer("repaired", { mode: "boolean" }).notNull().default(false),
    /** It came back after such a repair: the fix did not hold. */
    returnedAfterRepair: integer("returned_after_repair", { mode: "boolean" })
      .notNull()
      .default(false),
    snoozedUntil: text("snoozed_until"),
  },
  (table) => [
    uniqueIndex("findings_number").on(table.number),
    index("findings_key").on(table.key, table.status),
    index("findings_status").on(table.status),
  ],
);

/** Everything that happened to a finding, never rewritten. */
export const findingEvents = sqliteTable(
  "finding_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    findingId: text("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    at: text("at").notNull(),
    kind: text("kind").notNull(),
    actor: text("actor", { enum: ["hearth", "ember", "you"] }).notNull(),
    text: text("text").notNull(),
  },
  (table) => [index("finding_events_finding").on(table.findingId, table.id)],
);

/** The last run of each analyzer: what it could see, so gaps are shown instead of hidden. */
export const analyzerRuns = sqliteTable("analyzer_runs", {
  analyzer: text("analyzer").primaryKey(),
  status: text("status", { enum: ["ok", "partial", "unavailable", "off"] }).notNull(),
  note: text("note"),
  checkedAt: text("checked_at").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  /** Small state an analyzer keeps between runs (last seen versions, containers). */
  memo: text("memo", { mode: "json" }),
});

/** Space used on each volume, one row per day (the day's highest reading), for forecasts. */
export const volumeUsageDaily = sqliteTable(
  "volume_usage_daily",
  {
    volumeId: text("volume_id")
      .notNull()
      .references(() => volumes.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    usedTb: real("used_tb").notNull(),
    totalTb: real("total_tb").notNull(),
  },
  (table) => [primaryKey({ columns: [table.volumeId, table.day] })],
);

/**
 * Conditions the owner accepted as they are (a container kept stopped on purpose, a setting
 * they chose). Kept apart from any one finding so the acceptance outlives it: the same condition
 * coming back stays accepted; a changed one (a different signature, or more serious) is raised.
 */
export const findingAcceptances = sqliteTable("finding_acceptances", {
  key: text("key").primaryKey(),
  /** What made it the same condition when accepted (set by its analyzer). */
  signature: text("signature").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  note: text("note"),
  acceptedAt: text("accepted_at").notNull(),
});

/**
 * Every file on this machine's drives that Storage & Files has seen (spec section 7), for
 * Recently Added: when it first appeared, its size and time, and when it left (moved or
 * deleted), so history survives. basis "timestamp" means it was already there when Hearth first
 * looked, so its own modified time stands in; "observed" means Hearth saw it arrive.
 */
export const fileIndex = sqliteTable(
  "file_index",
  {
    path: text("path").primaryKey(),
    rootId: text("root_id").notNull(),
    hostId: text("host_id").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    modifiedAt: text("modified_at").notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    basis: text("basis", { enum: ["timestamp", "observed"] }).notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    goneAt: text("gone_at"),
    /** Observed arrivals: the previous check, so it arrived between this and first_seen_at. */
    seenAfter: text("seen_after"),
    /** Where it was before, when it moved or finished downloading under another name. */
    movedFrom: text("moved_from"),
    /** Device and inode: two paths with the same pair are one file (a hardlink). */
    fileKey: text("file_key"),
    links: integer("links"),
  },
  (table) => [
    index("file_index_first_seen").on(table.firstSeenAt),
    index("file_index_file_key").on(table.fileKey),
  ],
);

/**
 * Your names for drives ("Film" for /mnt/f). Keyed by the filesystem's own id when the system
 * shares one ("uuid:..."), so a remount or a changed letter keeps the name, else by mount point.
 * Display only: the drive, its mount, and its files are never changed.
 */
export const volumeNames = sqliteTable("volume_names", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  /** The mount it was last seen at, to show and to match when the id is not known. */
  mount: text("mount").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/* ---------- The engine: Claude Code and Codex working in project folders (from EMBER) ---------- */

/**
 * Projects the engine works in: each is a folder on this machine with its own git history and
 * its own ongoing conversation. See apps/server/src/engine.
 */
export const engineProjects = sqliteTable("engine_projects", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  path: text("path").notNull(),
  createdAt: text("created_at").notNull(),
  archived: integer("archived").notNull().default(0),
  /** Its color on Home (PROJECT_COLORS); none keeps the plain card. */
  color: text("color"),
});

/**
 * Work for Claude Code or Codex, run one after another. Every state change goes through the
 * engine's transition rules and is recorded in engine_task_events; nothing is deleted.
 */
export const engineTasks = sqliteTable(
  "engine_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    project: text("project").notNull(),
    engine: text("engine").notNull(),
    model: text("model"),
    state: text("state").notNull(),
    position: real("position").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    needsApproval: integer("needs_approval").notNull().default(0),
    approvalReason: text("approval_reason"),
    approvedBy: text("approved_by"),
    approvedAt: text("approved_at"),
    sessionId: text("session_id"),
    resume: integer("resume").notNull().default(0),
    result: text("result"),
    error: text("error"),
    exitCode: integer("exit_code"),
    costUsd: real("cost_usd"),
    source: text("source"),
    pid: integer("pid"),
    conversation: integer("conversation").notNull().default(0),
    attachments: text("attachments"),
    archived: integer("archived").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    heartbeatAt: text("heartbeat_at"),
  },
  (t) => [index("engine_tasks_state").on(t.state, t.position)],
);

export const engineTaskEvents = sqliteTable(
  "engine_task_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull(),
    at: text("at").notNull(),
    fromState: text("from_state"),
    toState: text("to_state"),
    actor: text("actor"),
    detail: text("detail"),
  },
  (t) => [index("engine_task_events_task").on(t.taskId, t.id)],
);

/** What a task did, line by line (tools, output, its words), for the live view. */
export const engineTaskLog = sqliteTable(
  "engine_task_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull(),
    at: text("at").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("engine_task_log_task").on(t.taskId, t.id)],
);

/** Each project's conversation with the owner. */
export const engineMessages = sqliteTable(
  "engine_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    project: text("project").notNull(),
    at: text("at").notNull(),
    role: text("role").notNull(),
    text: text("text").notNull(),
    meta: text("meta"),
    taskId: integer("task_id"),
  },
  (t) => [index("engine_messages_project").on(t.project, t.id)],
);

/** The engine's own settings (paused, saved conversations, limits used today). */
export const engineSettings = sqliteTable("engine_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const engineUsage = sqliteTable(
  "engine_usage",
  {
    day: text("day").notNull(),
    kind: text("kind").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.kind] })],
);

/* ---------- One account, many PCs and devices (docs/design/ONE_ACCOUNT.md) ---------- */

/** One-time codes: a device's sign-in (QR) or a PC's join link. Only their hash is kept. */
export const pairCodes = sqliteTable("pair_codes", {
  id: text("id").primaryKey(),
  // "home": a home tablet that opens only the home dashboard (11-04).
  purpose: text("purpose", { enum: ["device", "pc", "home"] }).notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});

/** On your Hearth: the PCs that joined it. */
export const pcs = sqliteTable("pcs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** sha256 of the PC's link token; the token itself is only on the PC. */
  tokenHash: text("token_hash").notNull(),
  os: text("os").notNull().default(""),
  version: text("version").notNull().default(""),
  /** How it was installed, and so whether it can uninstall itself (from its install.json). */
  install: text("install"),
  /** Its icon, so its projects and systems are easy to tell apart: "preset:<name>" or
   * "image:<file>" (a picture you chose, kept in the data folder). */
  icon: text("icon"),
  /** The color its name is shown in (the icon's own, or one you chose for a picture). */
  color: text("color"),
  joinedAt: text("joined_at").notNull(),
  lastSeenAt: text("last_seen_at"),
});

/** On a PC that joined another Hearth: where that Hearth is (single row, id 1). */
export const hubLink = sqliteTable("hub_link", {
  id: integer("id").primaryKey(),
  hubUrl: text("hub_url").notNull(),
  hubName: text("hub_name").notNull(),
  pcId: text("pc_id").notNull(),
  joinedAt: text("joined_at").notNull(),
});

/**
 * Media announcements (media/arrivals.ts): every movie, series, season and episode Hearth has
 * seen in a Plex or Jellyfin library, once, by its own identity. "baseline": already there when
 * Hearth started watching (never announced). "new": arrived later. "covered": part of something
 * announced as a whole (the episodes of a new series).
 */
export const mediaTitles = sqliteTable("media_titles", {
  key: text("key").primaryKey(),
  kind: text("kind", {
    enum: [
      "movie",
      "series",
      "season",
      "episode",
      "album",
      "audiobook",
      "book",
      "comic",
      "game",
      "podcast",
    ],
  }).notNull(),
  title: text("title").notNull(),
  status: text("status", { enum: ["baseline", "new", "covered"] }).notNull(),
  firstSeenAt: text("first_seen_at").notNull(),
  /** What an announcement needs (metadata, where it is), refreshed as servers report it. */
  data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});

/** Every id a title is known by (tmdb:123, imdb:tt..., a server's own id), pointing at its key. */
export const mediaAliases = sqliteTable("media_aliases", {
  alias: text("alias").primaryKey(),
  key: text("key").notNull(),
});

/**
 * One row per announcement per destination: what makes a title go out once, even across restarts,
 * retries and both media servers reporting it.
 */
export const mediaDeliveries = sqliteTable(
  "media_deliveries",
  {
    key: text("key").notNull(),
    channelId: text("channel_id").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed", "skipped"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Not before this time (a retry, or a digest's hour). */
    dueAt: text("due_at").notNull(),
    error: text("error"),
    sentAt: text("sent_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.channelId] })],
);

/**
 * Movie nights (media/nights.ts): a library title at a time, posted to friends-and-family
 * destinations. Each post keeps Discord's message id, so changes edit the invitation in place.
 */
export const movieNights = sqliteTable("movie_nights", {
  /** The host's own "Where to watch" text; empty uses the links Hearth finds. */
  watch: text("watch").notNull().default(""),
  /** A watch-party room code for this night (Plezy Watch Together and the like); empty for none. */
  code: text("code").notNull().default(""),
  /** How the invitation looks on Discord: cinematic, streaming or compact (as announcements). */
  look: text("look", { enum: ["cinematic", "streaming", "compact", "banner"] })
    .notNull()
    .default("cinematic"),
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  title: text("title").notNull(),
  startsAt: text("starts_at").notNull(),
  timeZone: text("time_zone").notNull(),
  spots: integer("spots"),
  note: text("note").notNull().default(""),
  status: text("status", { enum: ["scheduled", "cancelled", "done"] }).notNull(),
  reminders: text("reminders", { mode: "json" }).$type<string[]>().notNull(),
  channels: text("channels", { mode: "json" }).$type<string[]>().notNull(),
  guests: text("guests", { mode: "json" }).$type<string[]>().notNull(),
  posts: text("posts", { mode: "json" })
    .$type<{ channelId: string; messageId?: string; postedAt: string; error?: string }[]>()
    .notNull(),
  remindersSent: text("reminders_sent", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * Home Rows (design "Home Rows: design for DC", 2026-11-06): the owner's home-screen rows, one
 * saved definition each, shared by the editor and Ember. `published` is what Plex holds for the
 * row, tracked by Plex's own ids; `undo` is the state before the last apply, so it can be put back.
 */
export const homeRows = sqliteTable("home_rows", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull(),
  libraryId: text("library_id").notNull(),
  libraryName: text("library_name"),
  name: text("name").notNull(),
  definition: text("definition", { mode: "json" })
    .$type<{
      rules: import("@dragon-control/core").HomeRowRules;
      sort: import("@dragon-control/core").HomeRowSort;
      limit: number;
      placement: import("@dragon-control/core").HomeRowPlacement;
      after: string;
    }>()
    .notNull(),
  published: text("published", { mode: "json" }).$type<
    import("@dragon-control/core").HomeRowPublished
  >(),
  undo: text("undo", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Saved home screens (11-06: "build one out and save it, give it a name ... toggle one or
 * another"): every library's rows as Plex showed them (where each shows and the order), with
 * Hearth's own rows by their row id. Switching to one is a plan the owner approves.
 */
export const homeLayouts = sqliteTable("home_layouts", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull(),
  name: text("name").notNull(),
  snapshot: text("snapshot", { mode: "json" })
    .$type<Record<string, { id: string; code: string; row?: string; title?: string }[]>>()
    .notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
/* ---------- Hearth Premium (docs/design/PREMIUM.md) ---------- */

/**
 * On the issuing Hearth only (the owner's, holding the signing key): every grant it made, by a
 * direct grant or a redeemed code. A grant becomes a signed licence for one installation.
 */
export const premiumGrants = sqliteTable(
  "premium_grants",
  {
    id: text("id").primaryKey(),
    /** Who it is for, in the owner's words ("Alex", "Creator: Sam's homelab"). */
    recipient: text("recipient").notNull(),
    /** family, friend, creator, tester, partner, self, other. */
    audience: text("audience").notNull().default("other"),
    /** The owner's private note: never shown to the recipient. */
    note: text("note"),
    /** Feature ids, or premium_all. */
    scope: text("scope", { mode: "json" }).$type<string[]>().notNull(),
    kind: text("kind").notNull().default("complimentary"),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at"),
    /** The installation it is bound to (empty until the recipient's install id is known). */
    installId: text("install_id"),
    /** The licence issued for it (its id; the key itself is shown once, then only its id). */
    licenseId: text("license_id"),
    codeId: text("code_id"),
    status: text("status").notNull().default("active"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (tbl) => [index("premium_grants_install").on(tbl.installId)],
);

/** Redeemable codes: only a hash is kept; the code itself is shown once, when it is made. */
export const premiumCodes = sqliteTable("premium_codes", {
  id: text("id").primaryKey(),
  hash: text("hash").notNull().unique(),
  /** The first letters, to tell codes apart in a list ("HRTH-7KQ2…"). */
  hint: text("hint").notNull(),
  campaign: text("campaign"),
  audience: text("audience").notNull().default("other"),
  note: text("note"),
  scope: text("scope", { mode: "json" }).$type<string[]>().notNull(),
  /** How long a redeemed grant lasts, in days; empty: for good. */
  durationDays: integer("duration_days"),
  /** When the code can no longer be redeemed (empty: never). */
  expiresAt: text("expires_at"),
  maxUses: integer("max_uses").notNull().default(1),
  uses: integer("uses").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(now),
});

/** One installation redeems a code once. */
export const premiumRedemptions = sqliteTable(
  "premium_redemptions",
  {
    id: text("id").primaryKey(),
    codeId: text("code_id").notNull(),
    installId: text("install_id").notNull(),
    grantId: text("grant_id").notNull(),
    at: text("at").notNull().default(now),
  },
  (tbl) => [uniqueIndex("premium_redemptions_once").on(tbl.codeId, tbl.installId)],
);

/**
 * Custom panels (Ember Panel Builder, 11-10): a checked spec for a basic panel, drawn by Hearth's
 * own blocks. Data, not code, so it lives here: untouched by updates, and in the daily backup. One draft and one installed panel per service at a time; earlier installs
 * stay as "previous" so Back restores them.
 */
export const customPanels = sqliteTable(
  "custom_panels",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id").notNull(),
    /**
     * pending: Free plan, a new version waiting for its contribution to be accepted; the installed
     * panel keeps working meanwhile, and a pending one is never read or exported.
     */
    status: text("status", { enum: ["draft", "installed", "previous", "pending"] }).notNull(),
    version: integer("version").notNull(),
    specVersion: integer("spec_version").notNull(),
    /** Where the draft came from: Ember, or a file (verified shared, or not). */
    origin: text("origin", { enum: ["ember", "file", "shared"] })
      .notNull()
      .default("ember"),
    spec: text("spec", { mode: "json" }).notNull(),
    dropped: text("dropped", { mode: "json" }).notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    installedAt: text("installed_at"),
  },
  (x) => [index("custom_panels_service").on(x.serviceId, x.status)],
);

/**
 * Custom panels submitted to the Hearth project (the free plan's contribution, or a Premium
 * donation through the submission service), each with the service's signed receipt.
 */
export const panelSubmissions = sqliteTable(
  "panel_submissions",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id").notNull(),
    specId: text("spec_id").notNull(),
    version: integer("version").notNull(),
    /** The submission service's receipt, and the pull request it opened when it says. */
    receipt: text("receipt").notNull(),
    url: text("url"),
    termsVersion: integer("terms_version").notNull(),
    sentAt: text("sent_at").notNull(),
    /** sha-256 of the published spec the receipt is bound to. */
    specHash: text("spec_hash"),
    /** The service's id for it (to ask whether its pull request is filed). */
    remoteId: text("remote_id"),
    urlCheckedAt: text("url_checked_at"),
  },
  (x) => [index("panel_submissions_spec").on(x.serviceId, x.specId)],
);

/**
 * Panels an install may use for free on the Free plan, besides its installed and earlier ones:
 * shared panel files whose receipt proves they were accepted, and its own accepted contributions.
 * A new version that is the same as, or a minor change of, one of these needs no submission.
 */
export const panelBaselines = sqliteTable(
  "panel_baselines",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id").notNull(),
    origin: text("origin", { enum: ["shared", "submitted"] }).notNull(),
    spec: text("spec", { mode: "json" }).notNull(),
    specHash: text("spec_hash").notNull(),
    /** The receipt that proves it was accepted. */
    receipt: text("receipt").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (x) => [index("panel_baselines_service").on(x.serviceId)],
);

/**
 * The Free plan's contribution agreement, accepted per app before Ember builds a panel for it
 * (Improve this panel). Ember's panel drafts on Free are refused without it.
 */
export const panelAgreements = sqliteTable("panel_agreements", {
  serviceId: text("service_id").primaryKey(),
  termsVersion: integer("terms_version").notNull(),
  acceptedAt: text("accepted_at").notNull(),
});
