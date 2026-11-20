import { useEffect, useState } from "react";
import { Wifi } from "lucide-react";
import { Button } from "../ui";
import { ApiError, api } from "../../data/api";
import { useOpenNetwork, type Reachable } from "../../data/devices";
import { ConfirmIdentity } from "../../pages/auth/ConfirmIdentity";

/**
 * When this Hearth only listens on this PC, other PCs and devices can't reach it. One button opens
 * it to the home network: Hearth changes its own setting, restarts, and this waits until it can be
 * reached, then carries on (`onOpen`), so the join command or QR code appears without leaving here.
 */
export function OpenNetwork({ what, onOpen }: { what: "PCs" | "devices"; onOpen: () => void }) {
  const open = useOpenNetwork();
  const [confirming, setConfirming] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [late, setLate] = useState(false);

  // After the restart: back as soon as Hearth has a home network address.
  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const r = await api<Reachable>("GET", "/api/devices/addresses");
          if (!r.localOnly && r.addresses.some((a) => a.kind !== "this-page")) {
            setWaiting(false);
            onOpen();
            return;
          }
        } catch {
          // Restarting.
        }
        if (Date.now() - started > 60_000) setLate(true);
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [waiting, onOpen]);

  const run = () =>
    open.mutate(undefined, {
      onSuccess: (r) => r.ok && setWaiting(true),
      onError: (e) => {
        if (e instanceof ApiError && e.status === 403) setConfirming(true);
      },
    });

  return (
    <div
      className="mt-4 max-w-xl rounded-xl border border-gold/40 bg-gold/5 p-4"
      data-testid="open-network"
    >
      <p className="text-[0.9rem] text-ink">
        This Hearth only listens on this PC, so your other {what} can't reach it yet.
      </p>
      <p className="mt-1 text-[0.82rem] text-muted">
        Open it to your home network and they can. You still sign in for everything, and nothing
        here is open to the internet.
      </p>
      {confirming ? (
        <div className="mt-3">
          <ConfirmIdentity
            reason="Confirm it's you to open Hearth to your home network."
            onConfirmed={() => {
              setConfirming(false);
              run();
            }}
          />
        </div>
      ) : waiting ? (
        <p className="mt-3 text-[0.86rem] text-gold" role="status" data-testid="open-network-wait">
          {late
            ? "Still restarting. If it does not come back, restart the PC; the setting is saved."
            : "Opening… Hearth restarts and comes back in a few seconds."}
        </p>
      ) : (
        <Button
          className="mt-3"
          tone="primary"
          onClick={run}
          disabled={open.isPending}
          data-testid="open-network-button"
        >
          <Wifi strokeWidth={1.6} className="h-4 w-4" />
          Open to my home network
        </Button>
      )}
      {open.data && !open.data.ok && (
        <p role="alert" className="mt-2 text-[0.84rem] text-bad">
          {open.data.message}
        </p>
      )}
    </div>
  );
}
