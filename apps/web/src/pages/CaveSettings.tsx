import { useClaudeStatus } from "../data/agent";
import { AddonSlot, PremiumCard } from "../components/AddonSlot";
import { FullAccessSetting } from "../components/settings/FullAccessSetting";
import { OllamaSetting } from "../components/settings/OllamaSetting";
import { useState } from "react";
import { CLAUDE_MODELS, DEFAULT_AI_NAME } from "@dragon-control/core";
import { Button, Section, Segmented } from "../components/ui";
import { useAiUsage, useSetBudget } from "../data/cave";
import { FormError } from "./auth/AuthFrame";
import { readWritingMode, writeWritingMode } from "../components/cave/useWritingAssist";
import type { WritingMode } from "../lib/writing";
import { HostAdministration, ToolsCapabilities } from "./AdminSettings";
import { VoiceSettings } from "./VoiceSettings";
import { AiNameField, PersonalityControls } from "../components/settings/AiStyle";
import { AiPictureField } from "../components/settings/AiPictureField";

/**
 * Settings > Ember: who it is, how it talks, what it asks before acting, and its AI use.
 */

const field =
  "min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

const MODELS = CLAUDE_MODELS;

const AI_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  ollama: "Ollama",
};
const LEVEL_WORD = { light: "Light", normal: "Normal", heavy: "Heavy" } as const;

/**
 * AI use, with no money shown (Flint, 2026-11-13): Hearth never charges for AI, and dollar signs
 * made people think it did. Counts and a plain level; Ollama says it is free; the limit is runs.
 */
function Budget() {
  const usage = useAiUsage();
  const save = useSetBudget();
  // Claude Code signed in with an Anthropic Console account is billed per use (Flint, 11-13).
  const claude = useClaudeStatus();
  const perUse = claude.data?.loggedIn === true && claude.data.method === "console";
  const b = usage.data?.budget;
  const [daily, setDaily] = useState<string | null>(null);
  // The estimate checkbox answers at once, saved in the background.
  const [estimate, setEstimate] = useState<boolean | null>(null);
  if (!usage.data || !b) return null;
  const showEstimate = estimate ?? b.showEstimate === true;
  const { today, week, providers, level } = usage.data;
  const dailyValue = daily ?? (b.dailyRuns !== undefined ? String(b.dailyRuns) : "");
  const older =
    b.dailyRuns === undefined && (b.dailyUsd !== undefined || b.dailyTokens !== undefined);
  const week7 = usage.data.days.slice(0, 7).reduce((s, d) => s + d.costUsd, 0);
  const money = (n: number) => (n < 0.01 && n > 0 ? "under $0.01" : `about $${n.toFixed(2)}`);

  return (
    <div data-testid="ai-budget">
      <p
        className="mb-4 rounded-lg border border-line bg-panel/60 px-4 py-3 text-[0.88rem] text-ink"
        data-testid="ai-never-charges"
      >
        Hearth never charges for AI. This shows how much of your own AI Ember uses.
      </p>
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-line px-4 py-3">
          <p className="font-display text-[1.6rem] leading-none text-ink" data-testid="ai-level">
            {LEVEL_WORD[level ?? "light"]}
          </p>
          <p className="mt-1 text-[0.8rem] text-muted">
            use today
            {b.dailyRuns ? `, ${today.runs} of ${b.dailyRuns} runs` : ", no daily limit"}
          </p>
        </div>
        <div className="rounded-lg border border-line px-4 py-3">
          <p className="font-display text-[1.6rem] leading-none text-ink">{today.questions}</p>
          <p className="mt-1 text-[0.8rem] text-muted">
            questions today ({today.incidents} problems looked into)
          </p>
        </div>
        <div className="rounded-lg border border-line px-4 py-3">
          <p className="font-display text-[1.6rem] leading-none text-ink">{week?.runs ?? 0}</p>
          <p className="mt-1 text-[0.8rem] text-muted">AI runs in the last 7 days</p>
        </div>
      </div>
      {(providers ?? []).length > 0 && (
        <ul className="mb-6 space-y-2 text-[0.85rem]" data-testid="ai-by-provider">
          {(providers ?? []).map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2"
            >
              <span className="text-ink">{AI_NAMES[p.id] ?? p.id}</span>
              <span className="text-muted">
                {p.today} today, {p.week} this week
                {p.id === "ollama"
                  ? " · Free, runs on your computer"
                  : p.id === "claude-code" && perUse
                    ? ""
                    : " · on your own plan"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {perUse && (
        <div
          className="mb-6 rounded-lg border border-warn/40 px-4 py-3 text-[0.85rem]"
          data-testid="ai-per-use"
        >
          <p className="text-ink">
            Claude Code is signed in with an Anthropic Console account. This provider may charge you
            per use.
          </p>
          <label className="mt-2 flex items-center gap-2 text-muted">
            <input
              type="checkbox"
              checked={showEstimate}
              onChange={(e) => {
                setEstimate(e.target.checked);
                save.mutate({ showEstimate: e.target.checked });
              }}
            />
            Show an estimated cost
          </label>
          {showEstimate && (
            <p className="mt-2 text-muted" data-testid="ai-estimate">
              Estimate: {money(today.costUsd)} today, {money(week7)} in the last 7 days. Billed by
              Anthropic, not Hearth.
            </p>
          )}
        </div>
      )}
      {usage.data.state !== "ok" && (
        <p role="status" className="mb-4 text-[0.85rem] text-warn">
          {usage.data.state === "reached"
            ? "Today's limit is reached: questions are answered from records until midnight."
            : `${Math.round((usage.data.usedShare ?? 0) * 100)}% of today's limit is used.`}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = Math.round(Number(dailyValue));
            save.mutate(
              { dailyRuns: dailyValue.trim() === "" ? null : n },
              { onSuccess: () => setDaily(null) },
            );
          }}
        >
          <label htmlFor="ai-daily" className="mb-1 block text-[0.82rem] text-muted">
            Most AI runs a day (empty for no limit)
          </label>
          <div className="flex gap-2">
            <input
              id="ai-daily"
              inputMode="numeric"
              value={dailyValue}
              onChange={(e) => setDaily(e.target.value)}
              placeholder="Runs"
              className={field}
            />
            <Button type="submit" disabled={save.isPending}>
              Save
            </Button>
          </div>
          <p className="mt-1 text-[0.75rem] text-faint">
            A run is one answer or one problem looked into. Past the limit, questions are answered
            from Hearth&apos;s records until midnight. You are warned at{" "}
            {Math.round(b.warnAt * 100)}%.
          </p>
          {older && (
            <p className="mt-2 text-[0.8rem] text-warn" role="status" data-testid="ai-older-limit">
              Your old limit from an earlier version is still on. Set a new limit here.{" "}
              <button
                type="button"
                className="text-gold underline"
                onClick={() => save.mutate({ dailyRuns: null })}
              >
                Remove it
              </button>
            </p>
          )}
        </form>
        <div>
          <label htmlFor="ai-model" className="mb-1 block text-[0.82rem] text-muted">
            Model for questions
          </label>
          <select
            id="ai-model"
            value={b.questionModel}
            onChange={(e) => save.mutate({ questionModel: e.target.value })}
            className={field}
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[0.75rem] text-faint">
            Incident investigations use{" "}
            {b.incidentModel === "default" ? "the agent's default" : b.incidentModel}.
          </p>
        </div>
      </div>
      <FormError error={save.error} />
      {usage.data.days.length > 0 && (
        <table className="mt-6 w-full text-left text-[0.82rem]">
          <caption className="sr-only">AI use by day</caption>
          <thead className="text-faint">
            <tr>
              <th className="py-1 font-normal">Day</th>
              <th className="py-1 font-normal">Runs</th>
              <th className="py-1 text-right font-normal">Tokens</th>
            </tr>
          </thead>
          <tbody className="text-muted">
            {usage.data.days.slice(0, 7).map((d) => (
              <tr key={d.day} className="border-t border-line">
                <td className="py-1.5">{d.day}</td>
                <td className="py-1.5">{d.runs}</td>
                <td className="py-1.5 text-right">{(d.tokens / 1000).toFixed(1)}k</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Per device: phones and tablets usually correct as you type already. */
function WritingAssistance() {
  const [mode, setMode] = useState<WritingMode>(readWritingMode);
  return (
    <div data-testid="writing-assistance" className="space-y-3">
      <Segmented
        label="Writing assistance"
        value={mode}
        options={[
          { value: "off", label: "Off" },
          { value: "basic", label: "Basic" },
          { value: "enhanced", label: "Enhanced" },
        ]}
        onChange={(v) => {
          setMode(v);
          writeWritingMode(v);
        }}
      />
      <p className="text-[0.78rem] leading-relaxed text-faint">
        {mode === "off"
          ? "Off: your messages are sent exactly as typed. Your phone's own keyboard still corrects as it normally does."
          : 'Basic fixes capitals at the start of sentences, a lone "i", common typos, and stray spaces before punctuation, when you finish a sentence or pause. Each fix can be undone (Undo under the box, or Ctrl+Z).'}{" "}
        {mode === "enhanced" &&
          "Enhanced also checks grammar with Harper, an open-source checker that runs inside this browser, and offers changes under the box for you to accept or keep as written; it never changes anything by itself. It downloads once from Hearth (about 8 MB) the first time it is used on a device. "}
        {mode !== "off" &&
          "Nothing you type is sent anywhere for this, and code, commands, paths, addresses, and the names of your systems are never touched. "}
        This setting is for this device only.
      </p>
    </div>
  );
}

/** Your AI administrator's name (a display name only) and picture, changeable any time. */
function Identity() {
  return (
    <div className="mb-10 max-w-2xl" data-testid="ai-identity">
      <p className="mb-4 text-[0.88rem] leading-relaxed text-muted">
        Give your AI administrator its own name, and change it whenever you like. Only the name you
        see changes: it is the same assistant, with the same conversations, memory, permissions,
        tools, credentials, approvals, and history. Records already written keep the name they had.
        Until you name it, it is called {DEFAULT_AI_NAME}.
      </p>
      <AiNameField />
      <AiPictureField />
    </div>
  );
}

export function CaveSettings() {
  return (
    <div id="cave" className="scroll-mt-24">
      <Section title="Ember: identity">
        <Identity />
      </Section>
      <Section title="Ember: voice">
        <VoiceSettings />
      </Section>
      <Section title="Ember: Show & Tell" id="show-and-tell">
        <AddonSlot
          name="settings.showAndTell"
          fallback={<PremiumCard feature="ember_show_and_tell" />}
        />
      </Section>
      <Section title="Ember: personality">
        <PersonalityControls />
      </Section>
      <Section title="Ember: writing assistance">
        <WritingAssistance />
      </Section>
      <Section title="Ember: What it asks before acting" id="full-access">
        <FullAccessSetting />
      </Section>
      <Section title="Ember: Ollama (free AI on your own hardware)" id="ollama">
        <OllamaSetting />
      </Section>
      <Section title="Ember: administration">
        <HostAdministration />
      </Section>
      <Section title="Ember: tools and capabilities">
        <ToolsCapabilities />
      </Section>
      <Section title="Ember: AI use">
        <Budget />
      </Section>
    </div>
  );
}
