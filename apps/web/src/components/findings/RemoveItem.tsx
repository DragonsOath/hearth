import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "../ui";
import { useFindingAction } from "../../data/findings";
import { useDismissIncident } from "../../data/api";

/**
 * Take something off "Needs you". A finding: snooze it for a week, accept it as it is (it comes
 * back if it changes), or dismiss it. An incident: dismiss it (it comes back if it changes, or
 * if it recovers and happens again). Nothing in the app itself is changed.
 */
export function RemoveItem(props: { finding: { id: string } } | { incident: { id: string } }) {
  const [open, setOpen] = useState(false);
  const act = useFindingAction();
  const dismissIncident = useDismissIncident();
  const busy = act.isPending || dismissIncident.isPending;
  const error = act.error ?? dismissIncident.error;
  if (!open)
    return (
      <Button
        tone="quiet"
        className="px-2"
        onClick={() => setOpen(true)}
        data-testid="remove-item"
        aria-label="Remove from Needs you"
      >
        <X strokeWidth={1.6} className="h-4 w-4" aria-hidden="true" />
        Remove
      </Button>
    );
  const finding = "finding" in props ? props.finding : undefined;
  const choice = (label: string, testid: string, run: () => void) => (
    <Button tone="outline" className="px-3" disabled={busy} onClick={run} data-testid={testid}>
      {label}
    </Button>
  );
  return (
    <div
      className="flex w-full flex-wrap items-center justify-end gap-2"
      data-testid="remove-choices"
    >
      {finding ? (
        <>
          {choice("Snooze a week", "remove-snooze", () =>
            act.mutate({ id: finding.id, action: { type: "snooze", hours: 24 * 7 } }),
          )}
          {choice("It's fine as it is", "remove-accept", () =>
            act.mutate({ id: finding.id, action: { type: "accept" } }),
          )}
          {choice("Dismiss", "remove-dismiss", () =>
            act.mutate({ id: finding.id, action: { type: "dismiss" } }),
          )}
        </>
      ) : (
        "incident" in props &&
        choice("Dismiss", "remove-dismiss", () => dismissIncident.mutate(props.incident.id))
      )}
      <Button tone="quiet" className="px-2" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error && (
        <p role="alert" className="w-full text-right text-[0.8rem] text-bad">
          {error.message}
        </p>
      )}
    </div>
  );
}
