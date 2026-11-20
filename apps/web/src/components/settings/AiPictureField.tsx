import { useState } from "react";
import {
  AI_AVATAR_PATH,
  EMBER_LOOKS,
  LOOK_PERSONA_MAX,
  currentLook,
  personaForLook,
} from "@dragon-control/core";
import { useAiName, useWorkspace } from "../../data/api";
import { useChooseAiLook, useLookPersona } from "../../data/voice";
import { FormError } from "../../pages/auth/AuthFrame";
import { useAiPicture } from "../shell/DragonEmblem";
import { Button, Sheet, Switch, cx } from "../ui";
import { AiPictureUpload, LookPicker, avatarSrc } from "./LookPicker";

/**
 * The AI's picture, in Settings beside its name. One button opens every picture: your own (once
 * chosen from your library), then the ten Ember pictures. Tapping one previews it; Save puts it
 * everywhere the AI appears (46.16).
 */
export function AiPictureField() {
  const aiName = useAiName();
  const now = useAiPicture("large");
  const look = useChooseAiLook();
  const ws = useWorkspace();
  const persona = useLookPersona();
  const [open, setOpen] = useState(false);
  // "Turn on persona" and the owner's own persona text, until saved (design, 11-07).
  const [personaOn, setPersonaOn] = useState<boolean | null>(null);
  const [own, setOwn] = useState<string | null>(null);
  // The picture being previewed, until it is saved or the sheet is closed.
  const [picked, setPicked] = useState<string | null>(null);
  const saved = currentLook(look.current);
  const value = picked ?? saved;
  const on = personaOn ?? persona.data?.on ?? false;
  const ownText = own ?? persona.data?.own ?? "";
  const close = () => {
    setOpen(false);
    setPicked(null);
    setPersonaOn(null);
    setOwn(null);
  };
  const personaChanged =
    on !== (persona.data?.on ?? false) || ownText.trim() !== (persona.data?.own ?? "");
  const save = async () => {
    try {
      if (personaChanged)
        await persona.save.mutateAsync({ on, ...(ownText.trim() ? { own: ownText.trim() } : {}) });
      if (value !== saved) await look.choose(value);
      close();
    } catch {
      /* the error shows in the sheet */
    }
  };
  const pending = look.pending || persona.save.isPending;
  const sample = personaForLook(value)?.preview;
  const previewLabel =
    value === AI_AVATAR_PATH
      ? "Your own picture"
      : (EMBER_LOOKS.find((l) => l.path === value)?.label ?? "Classic Ember");
  return (
    <div className="mt-6" data-testid="ai-picture-field">
      <p className="mb-1.5 text-[0.85rem] text-ink">{aiName}'s picture</p>
      <div className="flex flex-wrap items-center gap-4">
        <img
          src={now.src}
          alt={`${aiName}'s picture`}
          width={80}
          height={80}
          className={cx("h-20 w-20", now.look ? "rounded-full object-cover" : "object-contain")}
        />
        <Button tone="primary" disabled={!look.ready} onClick={() => setOpen(true)}>
          Change picture
        </Button>
      </div>
      {look.loading && <p className="mt-2 text-[0.78rem] text-faint">Reading your settings…</p>}
      {!open && <FormError error={look.error} />}
      {open && (
        <Sheet
          label={`Choose ${aiName}'s picture`}
          eyebrow="Picture"
          title={`Choose ${aiName}'s picture`}
          onClose={close}
          wide
        >
          <div data-testid="ai-picture-sheet">
            <div
              className="mb-4 flex items-center gap-4 rounded-xl border border-line p-3"
              data-testid="ai-picture-preview"
            >
              <img
                src={avatarSrc(value, ws.data?.aiAvatarAt)}
                alt={`Preview: ${previewLabel}`}
                width={96}
                height={96}
                className={cx(
                  "h-24 w-24 shrink-0",
                  value === AI_AVATAR_PATH ? "rounded-full object-cover" : "object-contain",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[0.95rem] text-ink">{previewLabel}</p>
                <p className="text-[0.8rem] leading-relaxed text-muted">
                  {value === saved
                    ? `This is ${aiName}'s picture now.`
                    : "A preview. Save to use it everywhere."}
                </p>
              </div>
            </div>
            <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
              <p className="min-w-0 flex-1 text-[0.88rem] text-ink">Use a picture of your own</p>
              <AiPictureUpload onChosen={() => setPicked(AI_AVATAR_PATH)} />
            </div>
            <div
              className="mb-5 space-y-2 rounded-xl border border-line p-3"
              data-testid="look-persona"
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[0.88rem] text-ink">Turn on persona</p>
                  <p className="text-[0.78rem] leading-relaxed text-muted">
                    {on
                      ? `${aiName} talks in the personality of the chosen picture. It changes how she talks, never what she may do; plans and warnings stay plain.`
                      : `Off: ${aiName} talks with her normal personality, whatever picture you choose.`}
                  </p>
                </div>
                <Switch checked={on} label="Turn on persona" onChange={setPersonaOn} />
              </div>
              {on && value !== AI_AVATAR_PATH && sample && (
                <p
                  className="rounded-lg bg-raised px-3 py-2 text-[0.84rem] text-ink italic"
                  data-testid="look-persona-preview"
                >
                  &ldquo;{sample}&rdquo;
                </p>
              )}
              {on && value === AI_AVATAR_PATH && (
                <label className="block space-y-1">
                  <span className="text-[0.8rem] text-muted">
                    Describe the persona for your picture (empty: her normal personality)
                  </span>
                  <textarea
                    value={ownText}
                    maxLength={LOOK_PERSONA_MAX}
                    onChange={(e) => setOwn(e.target.value)}
                    rows={4}
                    className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-[0.86rem] text-ink focus:border-gold/60"
                    data-testid="look-persona-own"
                  />
                  <span className="block text-right text-[0.72rem] text-faint">
                    {ownText.length} / {LOOK_PERSONA_MAX}
                  </span>
                </label>
              )}
            </div>
            <LookPicker label="Pictures" value={value} onPick={setPicked} disabled={pending} />
            <FormError error={look.error ?? persona.save.error} />
            <div className="mt-6 flex flex-wrap gap-3">
              <Button tone="primary" disabled={pending} onClick={() => void save()}>
                {pending ? "Saving…" : "Save"}
              </Button>
              <Button tone="quiet" disabled={pending} onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
