import path from "node:path";
import { fileURLToPath } from "node:url";

/** apps/server/, whether running from src/ (dev) or dist/ (built). */
export const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Where add-ons (the Premium package) are installed (DC_ADDONS_DIR; default <dataDir>/addons). */
  addonsDir?: string;
  /** Where the key that seals background secrets lives on Linux (defaults to dataDir). Kept apart so a copy of the data folder alone cannot open them. */
  keyDir: string;
  /** Daily backups and the readable memory export. */
  backupDir: string;
  /** Optional second location for each backup (another drive, or a synced folder). */
  backupCopyDir?: string;
  /** How many daily backups to keep. */
  backupKeep: number;
  /** Name of the machine that fetches encrypted off-machine copies (turns the outbox on). */
  offsiteName?: string;
  webDir: string;
  migrationsDir: string;
  mode: "development" | "production" | "test";
  /** Seed and allow switching demo scenarios. On until real discovery exists (M3/M10). */
  demo: boolean;
  /** The machine running the speech services Home Assistant also uses (Whisper, Piper); Settings can change it. */
  voiceHost?: string;
  /** Where the engine's projects live (default: "Hearth Projects" in the home folder). */
  engineWorkspaces?: string;
  /** Claude Code and Codex, when they are not found on the PATH or in the usual places. */
  claudeBinary?: string;
  codexBinary?: string;
  /**
   * Where free-plan custom panels are submitted (Ember Panel Builder). Unset: no submission
   * service, so the free plan's "submit to unlock" step is off and installs stay open.
   */
  panelIntakeUrl?: string;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DC_PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

/**
 * Everything is overridable by environment so nothing depends on the
 * machine Hearth happens to be developed on. Defaults bind to
 * loopback only; exposing the UI on the network is an explicit choice.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode =
    env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development";
  const dataDir = path.resolve(env.DC_DATA_DIR || path.join(SERVER_ROOT, "../../data"));
  return {
    host: env.DC_HOST || "127.0.0.1",
    port: parsePort(env.DC_PORT, 7400),
    dataDir,
    addonsDir: env.DC_ADDONS_DIR ? path.resolve(env.DC_ADDONS_DIR) : undefined,
    keyDir: path.resolve(env.DC_KEY_DIR || dataDir),
    backupDir: path.resolve(env.DC_BACKUP_DIR || path.join(dataDir, "backups")),
    backupCopyDir: env.DC_BACKUP_COPY_DIR ? path.resolve(env.DC_BACKUP_COPY_DIR) : undefined,
    backupKeep: Math.max(1, Number(env.DC_BACKUP_KEEP) || 14),
    offsiteName: env.DC_OFFSITE_NAME?.trim() || undefined,
    webDir: path.resolve(env.DC_WEB_DIR || path.join(SERVER_ROOT, "../web/dist")),
    migrationsDir: path.join(SERVER_ROOT, "drizzle"),
    mode,
    demo: env.DC_DEMO !== "off",
    voiceHost: env.DC_VOICE_HOST?.trim() || undefined,
    engineWorkspaces: env.DC_ENGINE_WORKSPACES?.trim() || undefined,
    claudeBinary: env.DC_CLAUDE_BIN?.trim() || undefined,
    codexBinary: env.DC_CODEX_BIN?.trim() || undefined,
    panelIntakeUrl: env.DC_PANEL_INTAKE_URL?.trim() || undefined,
  };
}
