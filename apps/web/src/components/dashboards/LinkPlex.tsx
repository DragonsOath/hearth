import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Link2 } from "lucide-react";
import { ApiError, api } from "../../data/api";
import { ConfirmIdentity } from "../../pages/auth/ConfirmIdentity";
import { Button } from "../ui";

/**
 * Link Plex (feature request 11): plex.tv's own sign-in by code. The access it
 * gives is stated before anything starts; the token goes straight into Secure
 * Vault (read-only scope) and never comes back to this page.
 */
export function LinkPlex({ serviceId, why }: { serviceId: string; why?: string }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [pin, setPin] = useState<{ pinId: number; code: string; authUrl: string }>();
  const [state, setState] = useState<"idle" | "starting" | "waiting" | "linked" | "failed">("idle");
  const [message, setMessage] = useState<string>();

  const start = async () => {
    setState("starting");
    setMessage(undefined);
    try {
      const p = await api<{ pinId: number; code: string; authUrl: string }>(
        "POST",
        `/api/credentials/${encodeURIComponent(serviceId)}/plex-link`,
        {},
      );
      setPin(p);
      setState("waiting");
      window.open(p.authUrl, "_blank", "noopener");
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setConfirming(true);
        setState("idle");
        return;
      }
      setState("failed");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (state !== "waiting" || !pin) return;
    const timer = setInterval(async () => {
      try {
        const r = await api<{ state: string; message?: string }>(
          "GET",
          `/api/credentials/${encodeURIComponent(serviceId)}/plex-link/${pin.pinId}`,
        );
        if (r.state === "linked") {
          setState("linked");
          void qc.invalidateQueries({ queryKey: ["dashboard", serviceId] });
          void qc.invalidateQueries({ queryKey: ["credentials"] });
        } else if (r.state === "expired") {
          setState("failed");
          setMessage(r.message);
        }
      } catch (error) {
        setState("failed");
        setMessage(error instanceof Error ? error.message : String(error));
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [state, pin, serviceId, qc]);

  return (
    <div
      className="space-y-3 rounded-xl border border-gold/30 p-4 text-[0.86rem]"
      data-testid="link-plex"
    >
      <p className="flex items-center gap-2 text-ink">
        <Link2 strokeWidth={1.5} className="h-4 w-4 text-gold" /> Link Plex to see your libraries
        and who is watching
      </p>
      {why && <p className="text-[0.8rem] text-faint">{why}</p>}
      <div className="space-y-1.5 text-[0.82rem] leading-relaxed text-muted">
        <p>
          <span className="text-ink">What it grants:</span> Plex issues a token for "Hearth" with
          the access of the Plex account that approves it. Plex has no read-only token, so the token
          itself could do anything that account can.
        </p>
        <p>
          <span className="text-ink">What Hearth does with it:</span> it only reads this server's
          libraries, playback sessions, and library activity. It is stored in Secure Vault,
          read-only scope, never shown to you or the AI, and you can revoke it any time on plex.tv
          (Account &gt; Authorized Devices &gt; Hearth).
        </p>
      </div>
      {confirming ? (
        <ConfirmIdentity
          reason="Confirm it's you to link Plex."
          onConfirmed={() => {
            setConfirming(false);
            void start();
          }}
        />
      ) : state === "waiting" && pin ? (
        <div className="space-y-2" data-testid="link-plex-waiting">
          <p className="text-ink">
            Approve code <span className="font-mono text-gold">{pin.code}</span> on plex.tv. This
            page notices on its own.
          </p>
          <a
            href={pin.authUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line-strong px-3 text-ink hover:border-gold hover:text-gold"
          >
            <ExternalLink strokeWidth={1.5} className="h-4 w-4" /> Open plex.tv
          </a>
        </div>
      ) : state === "linked" ? (
        <p className="text-live">Linked. Reading Plex now.</p>
      ) : (
        <Button tone="primary" onClick={() => void start()} disabled={state === "starting"}>
          {state === "starting" ? "Starting" : "Link Plex"}
        </Button>
      )}
      {message && <p className="text-[0.82rem] text-amber">{message}</p>}
    </div>
  );
}
