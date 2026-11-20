import { X } from "lucide-react";
import type { CaveAttachment } from "@dragon-control/core";
import { api } from "../../data/api";
import { useCave } from "../shell/cave-context";

/** What a capture shows, in a few words. */
export function captureLabel(a: CaveAttachment): string {
  const c = a.context;
  if (c.mode === "upload") return c.fileName ?? "Photo";
  if (c.mode === "screen") return c.panel ? `Screen: ${c.panel}` : "Whole screen";
  const what = c.mode === "region" ? "Region" : c.mode === "item" ? (c.item ?? "Item") : "Panel";
  return c.panel && c.mode !== "item" ? `${what} of ${c.panel}` : what;
}

/**
 * Captures waiting to go with your next message. They are stored on your Hearth only;
 * the AI provider receives them when Ember looks at them while answering that message.
 */
export function AttachedImages() {
  const cave = useCave();
  if (!cave.attached.length) return null;
  return (
    <div className="mb-2" data-testid="cave-attached">
      <ul className="flex flex-wrap gap-2">
        {cave.attached.map((a) => (
          <li
            key={a.id}
            className="flex items-center gap-2 rounded-lg border border-gold/40 bg-raised/60 p-1 pr-1.5"
          >
            <img
              src={`/api/attachments/${encodeURIComponent(a.id)}`}
              alt={`Attached: ${captureLabel(a)}`}
              className="h-10 w-14 rounded object-cover object-top"
            />
            <span className="max-w-[10rem] truncate text-[0.76rem] text-ink">
              {captureLabel(a)}
            </span>
            <button
              type="button"
              aria-label={`Remove ${captureLabel(a)}`}
              onClick={() => {
                cave.detach(a.id);
                void api("DELETE", `/api/attachments/${encodeURIComponent(a.id)}`).catch(
                  () => undefined,
                );
              }}
              className="flex h-8 w-8 items-center justify-center rounded-md text-faint hover:text-gold"
            >
              <X strokeWidth={1.5} className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[0.72rem] text-faint">
        Stored on your Hearth. Sent to the AI provider only with this message, when Ember looks at
        it.
      </p>
    </div>
  );
}
