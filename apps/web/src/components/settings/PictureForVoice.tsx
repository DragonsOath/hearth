import { useState } from "react";
import { AI_AVATAR_PATH, type VoiceProfile } from "@dragon-control/core";
import { useAiName } from "../../data/api";
import { Button, Sheet } from "../ui";
import { useAiPicture } from "../shell/DragonEmblem";
import { AiPictureUpload, LookPicker } from "./LookPicker";

/**
 * Switching the AI to another voice asks which picture goes with it (the owner, 2026-10-16):
 * keep the one it has now, choose Ember's flame or a character, or upload one from your library.
 * Any picture goes with any voice. Nothing changes until a picture is confirmed; Cancel keeps the
 * voice and picture as they were.
 */
export function PictureForVoice({
  voice,
  current,
  busy,
  onChoose,
  onCancel,
}: {
  /** The voice being switched to. */
  voice: VoiceProfile;
  /** The picture the AI has now (a look's address, or your own), if it has one. */
  current?: string;
  busy: boolean;
  onChoose: (avatar: string) => void;
  onCancel: () => void;
}) {
  const aiName = useAiName();
  const now = useAiPicture("large");
  const [choice, setChoice] = useState<string | undefined>(current);
  const name = voice.name.trim() || "this voice";
  return (
    <Sheet
      label={`A picture for ${name}`}
      eyebrow="New voice"
      title={`${aiName}'s picture with ${name}'s voice`}
      onClose={onCancel}
      wide
    >
      <div data-testid="picture-for-voice">
        <div className="mb-5 flex items-center gap-4 rounded-xl border border-line p-3">
          <img
            src={now.src}
            alt={`${aiName}'s picture now`}
            className={
              now.look ? "h-16 w-16 rounded-full object-cover" : "h-16 w-16 object-contain"
            }
          />
          <div className="min-w-0 flex-1">
            <p className="text-[0.92rem] text-ink">Keep the picture {aiName} has now</p>
            <p className="text-[0.8rem] leading-relaxed text-muted">
              {current ? "It stays the same; only the voice changes." : "Choose a picture below."}
            </p>
          </div>
          <Button
            tone="outline"
            disabled={!current || busy}
            onClick={() => current && onChoose(current)}
          >
            Keep it
          </Button>
        </div>
        <p className="mb-2 text-[0.88rem] text-ink">Or choose another</p>
        <LookPicker label="Pictures" value={choice} onPick={setChoice} disabled={busy} />
        <div className="mt-3">
          <AiPictureUpload onChosen={() => setChoice(AI_AVATAR_PATH)} />
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button
            tone="primary"
            disabled={!choice || busy}
            onClick={() => choice && onChoose(choice)}
          >
            Use {name} with this picture
          </Button>
          <Button tone="quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
