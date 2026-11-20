/**
 * Shared domain vocabulary for Hearth. Grows into the full domain
 * model (hosts, services, incidents, policies...) in M2; for now it holds
 * the contract the server and web app both depend on.
 */

export const APP_NAME = "Hearth";
export const APP_VERSION = "0.0.1";

export type ComponentStatus = "ok" | "degraded" | "down";

export interface HealthReport {
  status: ComponentStatus;
  app: string;
  version: string;
  mode: "development" | "production" | "test";
  uptimeSeconds: number;
  /** The web build the server serves (its main script's file name), so open pages notice an update. */
  webBuild?: string;
  database: {
    status: ComponentStatus;
    installId: string | null;
    firstStartedAt: string | null;
    error?: string;
  };
}

/** Overall status is the worst status of any component. */
export function worstStatus(statuses: ComponentStatus[]): ComponentStatus {
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

export * from "./domain";
export * from "./briefs";
export * from "./blueprint";
export * from "./seeding-rules";
export * from "./agent-setup";
export * from "./policy";
export * from "./notify";
export * from "./media";
export * from "./ember-lines";
export * from "./movie-nights";
export * from "./keys";
export * from "./memory";
export * from "./relevance";
export * from "./cave";
export * from "./jobs";
export * from "./apps";
export * from "./pcs";
export * from "./projects";
export * from "./credentials";
export * from "./todos";
export * from "./dashboards";
export * from "./wizarr-designs";
export * from "./immich-storage";
export * from "./workspaces";
export * from "./admin";
export * from "./watches";
export * from "./voice";
export * from "./voice-machine";
export * from "./build-plan";
export * from "./profile";
export * from "./work";
export * from "./getting-started";
export * from "./features";
export * from "./findings";
export * from "./blockers";
export * from "./raid";
export * from "./capabilities";
export * from "./show";
export * from "./browser";
export * from "./catalog";
export * from "./release-search";
export * from "./smart-quality";
export * from "./home-rows";
export * from "./manual-sort";
export * from "./audiobook-intake";
export * from "./download-health";
export * from "./premium";
export * from "./fuzzy";
export * from "./personas";
export * from "./layout-copy";
export * from "./recommend";
export * from "./coverage";
export * from "./panel-class";
export * from "./panel-spec";
export * from "./panel-contribution";
export * from "./chat-intent";
export * from "./speakers";
export * from "./storage-trend";
export * from "./embed";
export * from "./thread-looks";
export * from "./crucible";
