import { useEffect, useRef } from "react";
import { Check, RefreshCw } from "lucide-react";
import type { ActionKind } from "@dragon-control/core";
import { Button, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";

/**
 * The big "Scan libraries" button at the top of a media server's panel (Plex, Jellyfin,
 * Audiobookshelf, Kavita). Pressing it is the owner's OK: Hearth plans the scan and confirms it
 * in one go, so it just happens, with the app's answer shown right under the button. Anything
 * that needs more from the owner (a key that may only read, an approval error) shows in place.
 */
export function ScanLibraries({
  serviceId,
  kind,
  name,
  testId,
}: {
  serviceId: string;
  kind: ActionKind;
  name: string;
  testId: string;
}) {
  const c = useConfirmedChange(serviceId);
  // Only the plan this button made is confirmed for the owner, and only once.
  const pressed = useRef<string | undefined>(undefined);
  const job = c.job;
  useEffect(() => {
    if (!job || job.status !== "awaiting-approval" || pressed.current === job.id) return;
    pressed.current = job.id;
    void c.confirm();
  }, [job, c]);

  const status = job?.status;
  const done = status === "succeeded";
  const result = job?.steps[0]?.result ?? job?.summary;
  // Errors and anything the owner must still do show in the usual change card.
  const needsOwner =
    Boolean(c.error) ||
    Boolean(c.approveError) ||
    status === "failed" ||
    status === "partial" ||
    status === "refused";
  const working = !needsOwner && (c.busy || status === "awaiting-approval" || status === "running");

  return (
    <div className="space-y-2" data-testid={testId}>
      <Button
        tone="primary"
        className="w-full @md:w-auto"
        disabled={working}
        onClick={() => void c.propose(kind, { op: "scan-all" }, `Scan all libraries in ${name}`)}
        data-testid={`${testId}-button`}
      >
        <RefreshCw className={cx("h-4 w-4", working && "animate-spin")} aria-hidden />
        {working ? "Starting the scan…" : "Scan libraries"}
      </Button>
      {done && (
        <p
          className="flex items-start gap-1.5 text-[0.82rem] text-live"
          data-testid={`${testId}-done`}
          role="status"
        >
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{result || `${name} is scanning.`}</span>
        </p>
      )}
      {needsOwner && <ChangeCard c={c} />}
    </div>
  );
}
