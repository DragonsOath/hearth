import { useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AI_AVATAR_PATH, EMBER_LOOK, EMBER_LOOKS } from "@dragon-control/core";
import { api, useWorkspace } from "../../data/api";
import { squareJpeg } from "../shell/OwnerAvatar";
import { Button, cx } from "../ui";

/**
 * Your AI's look: the ten official Ember pictures (Classic first, the default), and your own
 * picture once you have chosen one from your library (46.16). Every look goes with every voice.
 * Used in Settings, the welcome, and when switching voice.
 */

/** A picture's address for an <img>: your own picture carries when it was set, so a new one shows. */
export function avatarSrc(path: string, aiAvatarAt?: string): string {
  return path === AI_AVATAR_PATH && aiAvatarAt
    ? `${path}?v=${encodeURIComponent(aiAvatarAt)}`
    : path;
}

/** How a picture is framed: the owner's own round, an Ember picture whole (no background). */
export const lookFit = (path: string | undefined) =>
  path === AI_AVATAR_PATH ? "rounded-full object-cover" : "object-contain";

/** One picture you can pick: a real radio button, so arrow keys and screen readers work. */
function Option({
  name,
  path,
  label,
  checked,
  disabled,
  src,
  own,
  onPick,
}: {
  name: string;
  path: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  src: string;
  /** The owner's own picture: shown round, as uploaded. Ember pictures have no background. */
  own?: boolean;
  onPick: (path: string) => void;
}) {
  return (
    <label
      className={cx(
        "relative flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-2 p-2 transition-colors",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-gold",
        checked ? "border-gold bg-gold/10" : "border-line hover:border-line-strong",
        disabled && "cursor-default opacity-60",
      )}
      data-testid="look-option"
    >
      <input
        type="radio"
        name={name}
        value={path}
        checked={checked}
        disabled={disabled}
        onChange={() => onPick(path)}
        aria-label={label}
        // Invisible but covering the card, so tapping the picture is choosing the radio.
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0"
      />
      <img
        src={src}
        alt=""
        width={96}
        height={96}
        loading="lazy"
        draggable={false}
        className={cx(
          "aspect-square w-full max-w-24 select-none",
          own ? "rounded-full object-cover" : "object-contain",
        )}
      />
      <span
        aria-hidden
        className={cx(
          "text-center text-[0.76rem] leading-tight",
          checked ? "font-semibold text-gold" : "text-muted",
        )}
      >
        {label}
      </span>
    </label>
  );
}

export function LookPicker({
  value,
  onPick,
  label = "Its look",
  disabled,
}: {
  /** The picture chosen (a look's address, or AI_AVATAR_PATH). */
  value?: string;
  onPick: (path: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const ws = useWorkspace();
  const name = useId();
  const own = ws.data?.aiAvatarAt;
  return (
    <fieldset data-testid="look-picker">
      <legend className="sr-only">{label}</legend>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3 lg:grid-cols-5">
        {own && (
          <Option
            name={name}
            path={AI_AVATAR_PATH}
            label="Your own picture"
            checked={value === AI_AVATAR_PATH}
            disabled={disabled}
            src={avatarSrc(AI_AVATAR_PATH, own)}
            own
            onPick={onPick}
          />
        )}
        {EMBER_LOOKS.map((l) => (
          <Option
            key={l.id}
            name={name}
            path={l.path}
            label={l.path === EMBER_LOOK ? `${l.label} (default)` : l.label}
            checked={value === l.path}
            disabled={disabled}
            src={l.path}
            onPick={onPick}
          />
        ))}
      </div>
    </fieldset>
  );
}

/**
 * "Choose from your library": your AI's own picture, made square and small in the browser and
 * checked by the server like yours. Removing it puts every voice that used it back on its own
 * default picture.
 */
export function AiPictureUpload({ onChosen }: { onChosen?: () => void }) {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["workspace"] }),
      qc.invalidateQueries({ queryKey: ["voice"] }),
    ]);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/api/ai/avatar", { data: await squareJpeg(file) });
      await refresh();
      onChosen?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The picture could not be saved.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", "/api/ai/avatar");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The picture could not be removed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="ai-picture">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => void pick(e.target.files?.[0])}
        data-testid="ai-picture-input"
      />
      <Button disabled={busy} onClick={() => input.current?.click()}>
        {busy
          ? "Saving…"
          : ws.data?.aiAvatarAt
            ? "Choose another picture"
            : "Choose from your library"}
      </Button>
      {ws.data?.aiAvatarAt && (
        <Button tone="quiet" disabled={busy} onClick={() => void remove()}>
          Remove your picture
        </Button>
      )}
      {error && (
        <p role="alert" className="w-full text-[0.8rem] text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
