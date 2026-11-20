import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactQuery from "@tanstack/react-query";
import * as ReactRouter from "react-router";
import { useSyncExternalStore, type ComponentType } from "react";
import { api } from "../data/api";
import * as ReactDOM from "react-dom";
import * as ui from "../components/ui";
import { EmberMark } from "../components/ember/EmberMark";
import * as apiModule from "../data/api";
import * as format from "./format";
import * as caveContext from "../components/shell/cave-context";
import * as approveHere from "../components/jobs/ApproveHere";
import * as serviceLogo from "../components/command/ServiceLogo";
import * as signInCard from "../components/panels/SignInCard";
import * as lifecycle from "../components/panels/lifecycle";
import * as appGlance from "../components/dashboards/AppGlance";
import * as dialogs from "../components/workspace/dialogs";
import * as emberMark from "../components/ember/EmberMark";
import * as addonSlot from "../components/AddonSlot";
import * as premiumData from "../data/premium";
import * as pcsData from "../data/pcs";
import * as devicesData from "../data/devices";
import * as confirmIdentity from "../pages/auth/ConfirmIdentity";
import * as openNetwork from "../components/devices/OpenNetwork";
import * as pcsSection from "../components/devices/Pcs";
import * as jobsData from "../data/jobs";
import * as progress from "../components/cave/Progress";
import * as showData from "../data/show";
import * as voiceData from "../data/voice";
import * as deskLayout from "../components/desk/layout";
import * as deskLinks from "../components/desk/links";
import * as showBus from "../components/show/bus";
import * as panelTargets from "../components/panels/targets";

/**
 * Add-ons in the web app (11-14, the Premium split). The server lists the add-ons it loaded
 * (GET /api/addons); one with a web part is served at /addons/<name>/ and its index.js is imported
 * here. It fills named slots (registerSlot) that the core renders with <AddonSlot>, which shows
 * the core's own fallback (a Premium card) while no add-on fills it.
 *
 * Add-on bundles are built with these libraries left out and read them from window.hearthCore, so
 * there is one React (two would break hooks) and the add-on looks like the rest of Hearth.
 */
export const ADDON_WEB_API = 1;

export interface HearthCore {
  api: number;
  React: typeof React;
  jsxRuntime: typeof JsxRuntime;
  ReactQuery: typeof ReactQuery;
  ReactRouter: typeof ReactRouter;
  /** Hearth's own fetch helper (signed in, its error messages). */
  request: typeof api;
  /** Hearth's UI kit (buttons, sections, tags...). */
  ui: typeof ui;
  /** A few of Hearth's own pieces add-on screens show (Ember's mark...). */
  components: { EmberMark: typeof EmberMark };
  ReactDOM: typeof ReactDOM;
  /**
   * Hearth's own screen modules an add-on uses, by their path under apps/web/src. Shared, never
   * copied: they hold live state (Ember's chat, dialogs, queries). The Premium build maps its
   * imports of these paths here; a test checks every path it names exists.
   */
  modules: Record<string, unknown>;
  registerSlot(name: string, component: ComponentType<Record<string, unknown>>): void;
}

const slots = new Map<string, ComponentType<Record<string, unknown>>>();
const listeners = new Set<() => void>();
let version = 0;

export function registerSlot(name: string, component: ComponentType<Record<string, unknown>>) {
  slots.set(name, component);
  version += 1;
  for (const l of listeners) l();
}

/** The component an add-on put in a slot, if any (re-renders when one arrives). */
export function useSlot(name: string): ComponentType<Record<string, unknown>> | undefined {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return slots.get(name);
}

declare global {
  interface Window {
    hearthCore?: HearthCore;
  }
}

/** The modules add-on screens may import from Hearth (see HearthCore.modules). */
export const ADDON_MODULES: Record<string, unknown> = {
  "components/ui": ui,
  "data/api": apiModule,
  "lib/format": format,
  "components/shell/cave-context": caveContext,
  "components/jobs/ApproveHere": approveHere,
  "components/command/ServiceLogo": serviceLogo,
  "components/panels/SignInCard": signInCard,
  "components/panels/lifecycle": lifecycle,
  "components/dashboards/AppGlance": appGlance,
  "components/workspace/dialogs": dialogs,
  "components/ember/EmberMark": emberMark,
  "components/AddonSlot": addonSlot,
  "data/premium": premiumData,
  "data/pcs": pcsData,
  "data/devices": devicesData,
  "pages/auth/ConfirmIdentity": confirmIdentity,
  "components/devices/OpenNetwork": openNetwork,
  "components/devices/Pcs": pcsSection,
  "data/jobs": jobsData,
  "components/cave/Progress": progress,
  "data/show": showData,
  "data/voice": voiceData,
  "components/desk/layout": deskLayout,
  "components/desk/links": deskLinks,
  "components/show/bus": showBus,
  "components/panels/targets": panelTargets,
};

let loading: Promise<void> | undefined;

/** Loads every add-on's web part once (after sign-in). Failures are logged, never shown. */
export function loadAddons(): Promise<void> {
  if (loading) return loading;
  window.hearthCore = {
    api: ADDON_WEB_API,
    React,
    jsxRuntime: JsxRuntime,
    ReactQuery,
    ReactRouter,
    request: api,
    ui,
    components: { EmberMark },
    ReactDOM,
    modules: ADDON_MODULES,
    registerSlot,
  };
  loading = (async () => {
    let list: { loaded: { name: string; web?: string; css?: boolean }[] };
    try {
      list = await api("GET", "/api/addons");
    } catch {
      return;
    }
    for (const a of list.loaded) {
      if (!a.web) continue;
      // Its screens' own styles: the classes Hearth's style sheet doesn't have.
      if (a.css) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = `${a.web}index.css`;
        document.head.appendChild(link);
      }
      try {
        await import(/* @vite-ignore */ `${a.web}index.js`);
      } catch (error) {
        console.warn(`Hearth add-on ${a.name}: its screens did not load`, error);
      }
    }
  })();
  return loading;
}
