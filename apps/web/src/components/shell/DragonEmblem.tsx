import type { CSSProperties } from "react";
import { AI_AVATAR_PATH, currentLook } from "@dragon-control/core";
import { useVoice } from "../../data/voice";
import { useWorkspace } from "../../data/api";
import { avatarSrc } from "../settings/LookPicker";

/**
 * The AI's picture: the one chosen for the voice in use (an Ember picture or the owner's own),
 * Classic Ember when none is chosen, and Classic Ember for a retired picture (46.16). Every place
 * the AI appears uses this, so a new picture shows everywhere at once. `look` is true for the
 * owner's own picture (shown round); Ember pictures have no background and are shown whole.
 */
export function useAiPicture(_size: "small" | "large" = "small"): { src: string; look: boolean } {
  const voice = useVoice();
  const ws = useWorkspace();
  const active = voice.data?.profiles.find((p) => p.id === voice.data?.active);
  const avatar = currentLook(active?.avatar);
  return { src: avatarSrc(avatar, ws.data?.aiAvatarAt), look: avatar === AI_AVATAR_PATH };
}

/** The AI's small picture: the sidebar, top bar, and panel headers. */
export function DragonEmblem({ className = "h-10 w-10" }: { className?: string }) {
  const { src, look } = useAiPicture("small");
  return (
    <img
      src={src}
      alt=""
      width={160}
      height={160}
      draggable={false}
      className={
        className +
        (look ? " rounded-full object-cover select-none" : " object-contain select-none")
      }
    />
  );
}

/** The AI's portrait at full size, for the hub. */
export function WardenPortrait({
  className = "h-64 w-64",
  style,
}: {
  className?: string;
  /** An exact size (Home's command center fits it to the window). */
  style?: CSSProperties;
}) {
  const { src, look } = useAiPicture("large");
  return (
    <img
      src={src}
      alt=""
      width={640}
      height={640}
      draggable={false}
      style={style}
      className={
        className +
        (look
          ? " rounded-full border border-line object-cover select-none"
          : " object-contain select-none")
      }
    />
  );
}
