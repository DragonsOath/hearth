import { readFileSync } from "node:fs";
import {
  CONFIDENT_SCORE,
  FEATURES,
  featureAvailability,
  featureById,
  featureOpen,
  findFeatures,
  manualSection,
  type Feature,
  type FeatureAbility,
  type InstallFacts,
} from "@dragon-control/core";
import { HEARTH_MANUAL_PATH } from "../engine/runners";

/**
 * What the AI's hearth_help tool returns (checklist 42.1): one feature of Hearth, told apart into
 * what is built, what is set up here, where it is, what the AI can do, and the manual's words.
 */

let manualText: string | undefined;
function manual(): string {
  if (manualText === undefined) {
    try {
      manualText = HEARTH_MANUAL_PATH ? readFileSync(HEARTH_MANUAL_PATH, "utf8") : "";
    } catch {
      manualText = "";
    }
  }
  return manualText;
}

const STATUS_WORDS: Record<Feature["status"], string> = {
  working: "Built and working (proven by automated tests).",
  partial: "Built in part: usable, but not everything described exists yet.",
  preview: "Built, but not available to owners yet.",
  planned: "Not built yet. Do not describe it as something the owner can use.",
};

const APPROVAL_WORDS: Record<FeatureAbility["approval"], string> = {
  none: "no approval needed (a read, or exactly what the owner asked for)",
  plan: "as a plan the owner approves, or directly, asking first as the owner chose (every change, risky ones, or only serious ones)",
  autonomy: "the owner's Autonomy settings decide whether it runs or waits for their approval",
};

const ability = (a?: FeatureAbility) =>
  a ? { what: a.what, approval: APPROVAL_WORDS[a.approval], tools: a.tools } : "no";

function availabilityWords(f: Feature, here?: InstallFacts) {
  const a = featureAvailability(f, here);
  switch (a.state) {
    case "not-built":
      return { state: a.state, say: "Not built, so not available anywhere." };
    case "ready":
      return {
        state: a.state,
        say: f.needs?.length
          ? "What it needs is set up on this installation."
          : "It needs no other app or destination, so it is available here. That says nothing about how its own settings are filled in: check before saying it is set up.",
      };
    case "needs-setup":
      return {
        state: a.state,
        say: "Built, but this installation is missing what it needs. Say what to set up first.",
        missing: a.missing,
      };
    default:
      return {
        state: a.state,
        say: "Could not tell whether it is set up here; check with your other tools if it matters.",
        ...(f.needs?.length ? { needs: f.needs.map((n) => n.why) } : {}),
      };
  }
}

/**
 * Whether the AI can offer to open the feature (checklist 42.2). It never navigates by itself:
 * the owner gets an Open button and clicks it, so nothing they are in the middle of is lost.
 */
function openWords(f: Feature, here?: InstallFacts): string {
  const o = featureOpen(f);
  if (!o)
    return f.status === "planned" || f.status === "preview"
      ? "no: it is not available to owners, so there is nothing to open"
      : "no page of its own to open: give the owner the path above";
  if ("app" in o && here && !o.app.some((a) => here.apps.includes(a)))
    return "not here: this installation has none of the apps its panel belongs to, so say what to add first";
  return (
    `yes: in the Lair an Open button for it appears under your answer by itself. To put the button in your words too (Lair and War Room), write exactly [Open ${f.name}](hearth:${f.id}). ` +
    "Never write any other link to a Hearth page, never claim you opened it: the owner clicks it."
  );
}

function describe(f: Feature, here?: InstallFacts) {
  const section = manualSection(manual(), f.id);
  return {
    feature: { id: f.id, name: f.name, summary: f.summary },
    implemented: {
      status: f.status,
      meaning: STATUS_WORDS[f.status],
      ...(f.statusNote ? { note: f.statusNote } : {}),
      provenBy: f.evidence.length ? `${f.evidence.length} automated test(s)` : "nothing yet",
    },
    thisInstallation: availabilityWords(f, here),
    where: { path: f.where.path, ...(f.where.route ? { page: f.where.route } : {}) },
    onScreen: f.labels,
    whatYouCanDo: {
      explain: "yes",
      openItForThem: openWords(f, here),
      prepare: ability(f.ember?.prepare),
      carryOut: f.ownerOnly
        ? "no: only the owner"
        : f.ember?.execute
          ? ability(f.ember.execute)
          : "not recorded here (that is not a no)",
      ...(f.ownerOnly
        ? { note: `Only the owner: ${f.ownerOnly} Explain it and offer to open it.` }
        : f.ember?.prepare || f.ember?.execute
          ? {}
          : {
              note: "No Ember route is recorded for this. Before telling the owner to do it themselves, check what hearth_api can read and change, and the plan steps (a hearth-api-call plan covers Hearth's own settings). If there is a route, do it or propose the plan. Never claim you did something you did not do.",
            }),
    },
    manual: section ?? "(no manual section for this one)",
  };
}

const RULES = [
  "Answer from this, in your own words, using the onScreen names and the path exactly.",
  "Implemented is not the same as set up here: if thisInstallation is missing something, say what to set up first.",
  "Never say you did something unless your tools did it and you checked the result.",
  "This describes Hearth; it grants nothing. If a tool refuses, say so plainly.",
];

export function hearthHelp(q: { question?: string; feature?: string }, here?: InstallFacts) {
  if (q.feature) {
    const f = featureById(q.feature);
    if (f) return { ...describe(f, here), rules: RULES };
  }
  const query = q.question ?? q.feature;
  if (!query) {
    return {
      features: FEATURES.map((f) => ({
        id: f.id,
        name: f.name,
        summary: f.summary,
        status: f.status,
      })),
      howToUse:
        "For 'What can Hearth do?' ask about feature 'capabilities'. For anything else, call again with the owner's question.",
    };
  }
  const matches = findFeatures(query);
  const best = matches[0];
  if (!best || best.score < CONFIDENT_SCORE) {
    return {
      found: false,
      say:
        "No feature clearly matched. That does NOT mean Hearth lacks it: this list covers Hearth's main features, not every button. " +
        `Look in the manual (${HEARTH_MANUAL_PATH ?? "docs/HEARTH_MANUAL.md"}) or check the live system with your other tools; ` +
        "if you still cannot tell, say you are not sure rather than guess, and never invent a button or setting.",
      closest: matches.map((m) => ({
        id: m.feature.id,
        name: m.feature.name,
        summary: m.feature.summary,
      })),
    };
  }
  const also = matches
    .slice(1)
    .filter((m) => m.score >= CONFIDENT_SCORE)
    .map((m) => ({ id: m.feature.id, name: m.feature.name }));
  return {
    ...describe(best.feature, here),
    ...(also.length ? { alsoRelated: also } : {}),
    rules: RULES,
  };
}

/** The page help for features (checklist 42.2): the same answer the AI gets, minus its rules. */
export function featureHelp(ids: string[], here?: InstallFacts) {
  return ids
    .map((id) => featureById(id))
    .filter((f): f is Feature => Boolean(f))
    .map((f) => describe(f, here));
}
