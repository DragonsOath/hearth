import { useEffect, useState } from "react";
import { Copy, Eye, EyeOff, KeyRound, RefreshCw } from "lucide-react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Button, Panel, Tag } from "../ui";
import { ApiError, api } from "../../data/api";
import { useRevealSecret } from "../../data/auth";
import { ConfirmIdentity } from "../../pages/auth/ConfirmIdentity";
import { FormError } from "../../pages/auth/AuthFrame";

/**
 * The Hearth API key, fixed at the top of the Secure Vault: what a new PC's setup asks for to link
 * to this Hearth. Showing or copying it needs the vault unlocked (your PIN or password); Refresh
 * makes a new one, and PCs already linked stay linked.
 */
export function useHearthKeyId() {
  return useQuery({
    queryKey: ["vault", "hearth-key"],
    queryFn: () => api<{ id: string }>("GET", "/api/vault/hearth-key"),
    staleTime: Infinity,
  });
}

const SHOW_FOR_MS = 30_000;

export function HearthKeyCard() {
  const id = useHearthKeyId().data?.id;
  const reveal = useRevealSecret();
  const qc = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => api<{ id: string }>("POST", "/api/vault/hearth-key/refresh", {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["vault"] }),
  });
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [after, setAfter] = useState<"show" | "copy" | "refresh">("show");
  const [sure, setSure] = useState(false);

  useEffect(() => {
    if (shown === null) return;
    const t = setTimeout(() => setShown(null), SHOW_FOR_MS);
    return () => clearTimeout(t);
  }, [shown]);

  if (!id) return null;
  const fetchValue = (then: "show" | "copy") => {
    setAfter(then);
    reveal.mutate(id, {
      onSuccess: (r) => {
        if (then === "copy") {
          void navigator.clipboard?.writeText(r.value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        } else setShown(r.value);
      },
    });
  };
  const doRefresh = () => {
    setAfter("refresh");
    refresh.mutate(undefined, {
      onSuccess: () => {
        setSure(false);
        fetchValue("show");
      },
    });
  };
  const needsYou =
    (reveal.error instanceof ApiError && reveal.error.status === 403) ||
    (refresh.error instanceof ApiError && refresh.error.status === 403);

  return (
    <Panel className="mb-8 border-gold/40 p-5">
      <div data-testid="hearth-key">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gold/15 text-gold">
            <KeyRound strokeWidth={1.4} className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[1rem] text-ink">Hearth API key</p>
            <p className="mt-0.5 max-w-2xl text-[0.8rem] leading-relaxed text-muted">
              Links a new PC to this Hearth: install Hearth on it, choose "Link to my Hearth", and
              paste this. Works on your home network and over Tailscale.
            </p>
          </div>
          <Tag tone="gold">Protected</Tag>
        </div>
        <p
          className="mt-3 rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[0.9rem] break-all text-ink"
          data-testid={shown !== null ? "hearth-key-value" : undefined}
          data-sensitive
        >
          {shown ?? "hearth_••••••••••••••••••••"}
        </p>
        <div className="mt-3 flex flex-wrap gap-1">
          {shown === null ? (
            <Button tone="quiet" onClick={() => fetchValue("show")} disabled={reveal.isPending}>
              <Eye strokeWidth={1.5} className="h-4 w-4" /> Show
            </Button>
          ) : (
            <Button tone="quiet" onClick={() => setShown(null)}>
              <EyeOff strokeWidth={1.5} className="h-4 w-4" /> Hide
            </Button>
          )}
          <Button
            tone="quiet"
            onClick={() =>
              shown !== null ? void navigator.clipboard?.writeText(shown) : fetchValue("copy")
            }
            disabled={reveal.isPending}
            data-testid="hearth-key-copy"
          >
            <Copy strokeWidth={1.5} className="h-4 w-4" /> {copied ? "Copied" : "Copy"}
          </Button>
          {sure ? (
            <Button
              tone="quiet"
              onClick={doRefresh}
              disabled={refresh.isPending}
              data-testid="hearth-key-refresh-sure"
            >
              <RefreshCw strokeWidth={1.5} className="h-4 w-4" /> Yes, make a new key
            </Button>
          ) : (
            <Button tone="quiet" onClick={() => setSure(true)} data-testid="hearth-key-refresh">
              <RefreshCw strokeWidth={1.5} className="h-4 w-4" /> Refresh
            </Button>
          )}
        </div>
        {sure && (
          <p className="mt-2 text-[0.8rem] text-muted">
            The old key stops working for new PCs. PCs already linked stay linked.
          </p>
        )}
        {needsYou && (
          <div className="mt-3">
            <ConfirmIdentity
              reason="Unlock with your passkey or password to see the Hearth API key."
              onConfirmed={() => (after === "refresh" ? doRefresh() : fetchValue(after))}
            />
          </div>
        )}
        {reveal.error && !needsYou && <FormError error={reveal.error} />}
        {refresh.error && !needsYou && <FormError error={refresh.error} />}
      </div>
    </Panel>
  );
}
