import { useUpdateSettings, useWorkspace } from "../../data/api";
import { DragonEmblem } from "./DragonEmblem";
import { OwnerAvatar } from "./OwnerAvatar";
import { SaveNote, Switch, cx } from "../ui";

/**
 * The picture beside a message in a conversation: yours, or the AI's (whatever look and name
 * you chose), so it is clear at a glance who wrote what (10-26). Settings can turn them
 * off; then nothing is drawn and the bubbles take the room.
 */

/** Whether conversations show pictures beside messages (on unless turned off in Settings). */
export function useChatPictures(): boolean {
  return useWorkspace().data?.chatPictures !== false;
}

export function MessagePicture({ who, className }: { who: "you" | "ai"; className?: string }) {
  const size = cx("h-8 w-8", className);
  return (
    <span aria-hidden="true" className="shrink-0" data-testid={`message-picture-${who}`}>
      {who === "you" ? (
        <OwnerAvatar className={cx(size, "text-[0.68rem]")} />
      ) : (
        <DragonEmblem className={size} />
      )}
    </span>
  );
}

/** Settings: pictures beside messages, on or off. Saves as it changes. */
export function ChatPicturesSwitch() {
  const on = useChatPictures();
  const update = useUpdateSettings();
  const shown = update.isPending ? (update.variables?.chatPictures ?? on) : on;
  return (
    <div className="flex items-center gap-2 sm:justify-end" data-testid="chat-pictures">
      <Switch
        checked={shown}
        onChange={(next) => update.mutate({ chatPictures: next })}
        label="Pictures beside messages"
      />
      <SaveNote status={update.status} error={update.error} />
    </div>
  );
}
