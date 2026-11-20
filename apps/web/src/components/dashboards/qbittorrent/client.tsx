import { createContext, useContext } from "react";
import type { ActionKind, StepParams } from "@dragon-control/core";

/**
 * The torrent client a Torrents tab and Overview are showing. qBittorrent and Deluge share one set
 * of screens (the same torrents, filters, detail and add dialog); this says what differs: its
 * name, what it calls a category (Deluge: a label, from its Label plugin), which controls it has,
 * and the plan step each change becomes.
 */

export type TorrentAct =
  | "pause"
  | "resume"
  | "force-start"
  | "recheck"
  | "reannounce"
  | "category"
  | "tags"
  | "remove"
  | "remove-with-data"
  | "file-priority"
  | "add"
  | "category-create"
  | "category-remove"
  | "queue-top"
  | "queue-up"
  | "queue-down"
  | "queue-bottom"
  | "labels-on";

export interface TorrentClient {
  app: "qbittorrent" | "deluge" | "transmission";
  name: string;
  /** Where its settings view is read (categories or labels, default folder). */
  settingsPath: string;
  /** What it calls a category, in the words its own screens use. */
  word: { one: string; many: string; none: string; every: string; Many: string };
  /** Controls it has. */
  tags: boolean;
  forceStart: boolean;
  /** Moving a torrent up and down its queue. */
  queue: boolean;
  /** Choosing a folder when adding. */
  folders: boolean;
  /**
   * Its categories are free text (Transmission's labels): typed when given to a torrent, never
   * made or removed on their own.
   */
  freeLabels?: boolean;
  /** "Paused" (Deluge) or "stopped" (qBittorrent 5) for a torrent not running. */
  paused: string;
  /** The plan step for a change. */
  step(act: TorrentAct, params: StepParams): { kind: ActionKind; params: StepParams };
}

const QBT_KIND: Partial<Record<TorrentAct, ActionKind>> = {
  pause: "app-qbt-pause",
  resume: "app-qbt-resume",
  "force-start": "app-qbt-force-start",
  recheck: "app-qbt-recheck",
  reannounce: "app-qbt-reannounce",
  category: "app-qbt-set-category",
  tags: "app-qbt-set-tags",
  remove: "app-qbt-remove",
  "remove-with-data": "app-qbt-remove-with-data",
  "file-priority": "app-qbt-file-priority",
  add: "app-qbt-add",
  "category-create": "app-qbt-category",
  "category-remove": "app-qbt-category",
};

export const QBITTORRENT: TorrentClient = {
  app: "qbittorrent",
  name: "qBittorrent",
  settingsPath: "qbittorrent/settings",
  word: {
    one: "category",
    many: "categories",
    Many: "Categories",
    none: "No category",
    every: "Every category",
  },
  tags: true,
  forceStart: true,
  queue: false,
  folders: true,
  paused: "stopped",
  step(act, params) {
    const kind = QBT_KIND[act];
    if (!kind) throw new Error(`qBittorrent has no ${act} here.`);
    return {
      kind,
      params:
        act === "category-create" || act === "category-remove"
          ? { categoryAction: act === "category-create" ? "create" : "remove", ...params }
          : params,
    };
  },
};

/** Deluge's own word for each change (its labels stand in for categories). */
const DELUGE_OP: Partial<Record<TorrentAct, string>> = {
  category: "label",
  "category-create": "label-create",
  "category-remove": "label-delete",
};

export const DELUGE: TorrentClient = {
  app: "deluge",
  name: "Deluge",
  settingsPath: "deluge/settings",
  word: { one: "label", many: "labels", Many: "Labels", none: "No label", every: "Every label" },
  tags: false,
  forceStart: false,
  queue: true,
  folders: false,
  paused: "paused",
  step(act, params) {
    if (act === "tags" || act === "force-start") throw new Error(`Deluge has no ${act}.`);
    // Deluge's add takes links, .torrent files, a label and paused; no tags or folder.
    const { tags: _tags, savepath: _savepath, ...rest } = params;
    void _tags;
    void _savepath;
    return { kind: "app-deluge-control", params: { op: DELUGE_OP[act] ?? act, ...rest } };
  },
};

export const TRANSMISSION: TorrentClient = {
  app: "transmission",
  name: "Transmission",
  settingsPath: "transmission/settings",
  word: { one: "label", many: "labels", Many: "Labels", none: "No label", every: "Every label" },
  tags: false,
  forceStart: false,
  queue: true,
  folders: false,
  freeLabels: true,
  paused: "paused",
  step(act, params) {
    if (act === "tags" || act === "force-start" || act === "labels-on")
      throw new Error(`Transmission has no ${act}.`);
    if (act === "category-create" || act === "category-remove")
      throw new Error("Transmission's labels are given to torrents; there is no list to edit.");
    // Transmission's add takes links, .torrent files, a label and paused; no tags or folder.
    const { tags: _tags, savepath: _savepath, ...rest } = params;
    void _tags;
    void _savepath;
    return {
      kind: "app-transmission-control",
      params: { op: act === "category" ? "label" : act, ...rest },
    };
  },
};

const Ctx = createContext<TorrentClient>(QBITTORRENT);
export const ClientProvider = Ctx.Provider;
export const useClient = () => useContext(Ctx);
