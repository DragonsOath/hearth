import { useState } from "react";
import {
  AI_NAME_PATTERN,
  DEFAULT_AI_NAME,
  DEFAULT_PERSONALITY,
  type CavePersonality,
} from "@dragon-control/core";
import { useUpdateSettings, useWorkspace } from "../../data/api";
import { usePersonality, useSetPersonality } from "../../data/cave";
import { FormError } from "../../pages/auth/AuthFrame";
import { Button, Segmented } from "../ui";

const field =
  "min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

/**
 * Your AI administrator's name, with its preview. A display name only. While it is empty the AI
 * is called Ember, whichever voice or look is in use, shown as the box's placeholder; a saved
 * name is never replaced by choosing a voice.
 */
export function AiNameField({
  placeholder,
  onValueChange,
}: {
  /** What it is called while the box is empty (Ember). */
  placeholder?: string;
  /** Told what is in the box as it changes, so the welcome's Next can save it. */
  onValueChange?: (value: string) => void;
}) {
  const ws = useWorkspace();
  const save = useUpdateSettings();
  const current = ws.data?.aiName ?? "";
  const fallback = placeholder ?? DEFAULT_AI_NAME;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current;
  const next = value.trim();
  const valid = next === "" || AI_NAME_PATTERN.test(next);
  const changed = next !== current;
  const shown = next || fallback;
  const commit = (name: string) =>
    save.mutate({ aiName: name }, { onSuccess: () => setDraft(null) });
  return (
    <div>
      <label htmlFor="ai-name" className="mb-1.5 block text-[0.85rem] text-ink">
        AI administrator name
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="ai-name"
          value={value}
          maxLength={40}
          placeholder={fallback}
          autoComplete="off"
          aria-invalid={!valid}
          aria-describedby="ai-name-help"
          onChange={(e) => {
            setDraft(e.target.value);
            onValueChange?.(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid && changed) commit(next);
            if (e.key === "Escape") setDraft(null);
          }}
          className={field + " max-w-xs flex-1"}
        />
        <Button
          tone="primary"
          disabled={!valid || !changed || save.isPending}
          onClick={() => commit(next)}
        >
          Save name
        </Button>
        {current && (
          <Button tone="quiet" disabled={save.isPending} onClick={() => commit("")}>
            Use {fallback}
          </Button>
        )}
      </div>
      <p id="ai-name-help" className="mt-2 text-[0.78rem] text-faint" data-testid="ai-name-preview">
        {valid
          ? `Shown as "${shown}": "Ask ${shown}…" in the chat, and how it introduces itself.`
          : "Use letters, numbers, spaces, apostrophes, dots, or hyphens (up to 40)."}
      </p>
      <FormError error={save.error} />
    </div>
  );
}

const PERSONALITY_CHOICES: {
  [K in keyof CavePersonality]: {
    label: string;
    options: { value: CavePersonality[K]; label: string; hint: string }[];
  };
} = {
  enthusiasm: {
    label: "Enthusiasm",
    options: [
      { value: "calm", label: "Calm", hint: "Even and understated." },
      {
        value: "warm",
        label: "Warm",
        hint: "Genuinely interested; says so when something is cool.",
      },
      { value: "lively", label: "Lively", hint: "Openly excited about good builds and wins." },
    ],
  },
  humor: {
    label: "Humor",
    options: [
      { value: "none", label: "None", hint: "Straight answers, no jokes." },
      { value: "light", label: "Light", hint: "A dry touch now and then, never mid-outage." },
      { value: "playful", label: "Playful", hint: "The odd dragon pun when nothing is broken." },
    ],
  },
  detail: {
    label: "Technical detail",
    options: [
      { value: "simple", label: "Simple", hint: "Plain words, no jargon." },
      {
        value: "balanced",
        label: "Balanced",
        hint: "Plain words with the technical name in passing.",
      },
      { value: "deep", label: "Deep", hint: "Components, protocols, settings, and why." },
    ],
  },
};

/**
 * How Ember talks: enthusiasm, humor, and detail. Style only, never permissions. Used in
 * Settings > Ember: personality and in the welcome.
 */
export function PersonalityControls() {
  const current = usePersonality();
  const save = useSetPersonality();
  const p = (!save.isError && save.variables) || current.data || DEFAULT_PERSONALITY;
  const set = <K extends keyof CavePersonality>(key: K, value: CavePersonality[K]) =>
    save.mutate({ ...p, [key]: value });
  return (
    <div data-testid="cave-personality" className="space-y-5">
      {(Object.keys(PERSONALITY_CHOICES) as (keyof CavePersonality)[]).map((key) => {
        const c = PERSONALITY_CHOICES[key];
        const chosen = c.options.find((o) => o.value === p[key]);
        return (
          <div key={key}>
            <p className="mb-2 text-[0.82rem] text-muted">{c.label}</p>
            <Segmented
              label={c.label}
              value={p[key]}
              options={c.options.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(v) => set(key, v as never)}
            />
            {chosen && <p className="mt-1.5 text-[0.76rem] text-faint">{chosen.hint}</p>}
          </div>
        );
      })}
      <FormError error={save.error} />
      <p className="text-[0.78rem] leading-relaxed text-faint">
        This changes how Ember talks, not what it may do. Whatever the setting, enthusiasm or a
        quick "yes" never approves anything: changes still need your approval of the exact plan, and
        your jurisdiction, credential, and protected-infrastructure rules stay the same. Tell it in
        conversation how you like it to talk, and it can suggest remembering that for your review in
        Memory.
      </p>
    </div>
  );
}
