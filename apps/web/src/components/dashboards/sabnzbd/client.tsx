import { createContext, useContext } from "react";
import type { ActionKind, NzbgetDashboard, SabnzbdDashboard } from "@dragon-control/core";

/**
 * The Usenet downloader an Overview and Downloads tab are showing. SABnzbd and NZBGet share one
 * set of screens (the same queue, history, add dialog and controls, with the same plan operations);
 * this says what differs: its name, its plan step, how its speed limit is set (SABnzbd: a share of
 * the line speed; NZBGet: a rate), whether its warnings can be cleared, and its job ids.
 */

export type UsenetData = SabnzbdDashboard | NzbgetDashboard;

export interface UsenetClient {
  app: "sabnzbd" | "nzbget";
  name: string;
  kind: ActionKind;
  /** The speed limit choices, as the value the plan takes and the words shown. */
  limits: { value: string; label: string }[];
  /** The current limit as one of those values. */
  limitNow(d: UsenetData): string;
  /** Its warnings can be cleared from Hearth (SABnzbd's list; NZBGet's come from its log). */
  clearWarnings: boolean;
  /** A job id, as it appears in the panel's address. */
  job: RegExp;
}

export const SABNZBD: UsenetClient = {
  app: "sabnzbd",
  name: "SABnzbd",
  kind: "app-sabnzbd-control",
  limits: [100, 75, 50, 25, 10].map((p) => ({
    value: String(p),
    label: p === 100 ? "No speed limit" : `Limit to ${p}%`,
  })),
  limitNow: (d) => String((d.app === "sabnzbd" ? d.speedLimitPct : undefined) ?? 100),
  clearWarnings: true,
  job: /^SABnzbd_nzo_[\w-]+$/,
};

export const NZBGET: UsenetClient = {
  app: "nzbget",
  name: "NZBGet",
  kind: "app-nzbget-control",
  limits: [
    [0, "No speed limit"],
    [51200, "Limit to 50 MB/s"],
    [20480, "Limit to 20 MB/s"],
    [10240, "Limit to 10 MB/s"],
    [5120, "Limit to 5 MB/s"],
    [1024, "Limit to 1 MB/s"],
  ].map(([v, label]) => ({ value: String(v), label: String(label) })),
  limitNow: (d) => String((d.app === "nzbget" ? d.speedLimitKbps : undefined) ?? 0),
  clearWarnings: false,
  job: /^\d{1,10}$/,
};

const Ctx = createContext<UsenetClient>(SABNZBD);
export const UsenetProvider = Ctx.Provider;
export const useUsenet = () => useContext(Ctx);
