import { KeyRound } from "lucide-react";
import type { CaveMessage } from "@dragon-control/core";
import { useCredentials } from "../../data/credentials";
import { AppKeyLink, CredentialButton, CredentialStateText } from "./AddCredential";

/**
 * Under an answer: services it involved whose credential is missing, refused,
 * or protected, each with an Add (or Replace) button. The credential is typed
 * into the vault form, never into the conversation; once saved, Ember
 * uses it without being told.
 */
export function CredentialPrompts({ answer, asked }: { answer: CaveMessage; asked?: CaveMessage }) {
  const creds = useCredentials();
  if (!creds.data) return null;
  const refs = new Set(
    [...(answer.evidence ?? []).map((e) => e.ref), ...(asked?.activity ?? []).map((a) => a.ref)]
      .filter((r): r is string => Boolean(r?.startsWith("service:")))
      .map((r) => r.slice("service:".length)),
  );
  const needing = creds.data
    .filter((c) => refs.has(c.serviceId))
    .filter((c) => c.state === "missing" || c.state === "failing" || c.state === "protected")
    .slice(0, 3);
  if (!needing.length) return null;
  return (
    <li className="max-w-[96%] pl-11" data-testid="cave-credentials">
      <div className="rounded-xl border border-gold/30 bg-gold/5 px-4 py-3">
        {needing.map((c) => (
          <div key={c.serviceId} className="flex flex-wrap items-center gap-3 py-1">
            <KeyRound strokeWidth={1.5} className="h-4 w-4 shrink-0 text-gold" />
            <p className="min-w-0 flex-1 text-[0.86rem] text-ink">
              <AppKeyLink status={c}>{c.serviceName}</AppKeyLink>'s {c.need.label}:{" "}
              <CredentialStateText status={c} />
            </p>
            <CredentialButton serviceId={c.serviceId} className="min-h-9 px-4" />
          </div>
        ))}
        <p className="mt-1 text-[0.74rem] text-faint">
          Entered into the Secure Vault, never into this conversation.
        </p>
      </div>
    </li>
  );
}
