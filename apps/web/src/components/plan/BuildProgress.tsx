import { useState } from "react";
import { Link } from "react-router";
import { VPN_PROVIDERS, type HomelabStep, type VpnProvider } from "@dragon-control/core";
import {
  useHomelabBuild,
  useProposeBuildStep,
  useSaveBuildVpn,
  useTailscaleLink,
} from "../../data/plan";
import { Button, LinkButton, cx } from "../ui";
import { FormError } from "../../pages/auth/AuthFrame";

/**
 * Build my plan, step by step (docs/design/BUILDER.md): every step in order with where it stands,
 * and, under a step, what the owner needs to do first. Nothing here installs anything by itself:
 * "Next step" makes the step a plan, and the plan waits for their approval like any other.
 */

const MARK: Record<HomelabStep["status"], { text: string; className: string }> = {
  done: { text: "Done", className: "text-live" },
  running: { text: "Under way", className: "text-gold" },
  "awaiting-approval": { text: "Waiting for your OK", className: "text-gold" },
  "needs-you": { text: "Needs you", className: "text-gold" },
  ready: { text: "Next", className: "text-ink" },
  failed: { text: "Didn't finish", className: "text-bad" },
  waiting: { text: "Later", className: "text-faint" },
};

const field =
  "mt-1 min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink";

function Dot({ status }: { status: HomelabStep["status"] }) {
  return (
    <span
      aria-hidden
      className={cx(
        "mt-1.5 inline-block h-3 w-3 shrink-0 rounded-full border",
        status === "done" && "border-live bg-live",
        (status === "running" || status === "awaiting-approval") &&
          "animate-pulse border-gold bg-gold/60",
        status === "needs-you" && "border-gold",
        status === "ready" && "border-ink",
        status === "failed" && "border-bad bg-bad/40",
        status === "waiting" && "border-line-strong",
      )}
    />
  );
}

function HelperNeed({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2">
      <p className="text-[0.82rem] leading-relaxed text-muted">
        Open a terminal on this computer, paste this, and type your password when asked. It sets up
        Hearth&apos;s small admin helper, which only ever does one step you approved.
      </p>
      <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-bg px-3 py-2 text-[0.78rem] text-ink">
        {command}
      </pre>
      <Button
        tone="quiet"
        className="mt-1"
        onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true))}
      >
        {copied ? "Copied" : "Copy the command"}
      </Button>
    </div>
  );
}

function VpnNeed({ provider: given }: { provider?: VpnProvider }) {
  const save = useSaveBuildVpn();
  const [provider, setProvider] = useState<VpnProvider>(given ?? "proton");
  const wireguardOnly = provider === "airvpn";
  const [type, setType] = useState<"openvpn" | "wireguard">("openvpn");
  const t = wireguardOnly ? "wireguard" : type;
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  return (
    <form
      className="mt-2 rounded-xl border border-line p-3"
      aria-label="Your VPN login"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(
          t === "wireguard"
            ? { provider, type: t, privateKey: a, ...(b ? { addresses: b } : {}) }
            : { provider, type: t, username: a, password: b },
          {
            onSuccess: () => {
              setA("");
              setB("");
            },
          },
        );
      }}
    >
      <p className="mb-2 text-[0.82rem] leading-relaxed text-muted">
        qBittorrent downloads only through your VPN. Its login goes straight into Secure Vault: your
        AI never sees it. Find it in your VPN account: most call it the OpenVPN (or manual setup)
        username and password, which is not the password you sign in with.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[0.82rem] text-muted">
          Your VPN
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as VpnProvider)}
            className={field}
          >
            {(Object.keys(VPN_PROVIDERS) as VpnProvider[]).map((p) => (
              <option key={p} value={p}>
                {VPN_PROVIDERS[p].name}
              </option>
            ))}
          </select>
        </label>
        {!wireguardOnly && (
          <label className="block text-[0.82rem] text-muted">
            Login type
            <select
              value={type}
              onChange={(e) => setType(e.target.value as "openvpn" | "wireguard")}
              className={field}
            >
              <option value="openvpn">Username and password (OpenVPN)</option>
              <option value="wireguard">WireGuard private key</option>
            </select>
          </label>
        )}
        <label className="block text-[0.82rem] text-muted">
          {t === "wireguard" ? "WireGuard private key" : "OpenVPN username"}
          <input
            value={a}
            onChange={(e) => setA(e.target.value)}
            type={t === "wireguard" ? "password" : "text"}
            autoComplete="off"
            className={field}
          />
        </label>
        <label className="block text-[0.82rem] text-muted">
          {t === "wireguard" ? "Address (if your VPN gives one)" : "OpenVPN password"}
          <input
            value={b}
            onChange={(e) => setB(e.target.value)}
            type={t === "wireguard" ? "text" : "password"}
            autoComplete="off"
            className={field}
          />
        </label>
      </div>
      <Button
        tone="primary"
        type="submit"
        className="mt-3"
        disabled={!a || (t === "openvpn" && !b) || save.isPending}
      >
        {save.isPending ? "Saving…" : "Save my VPN login"}
      </Button>
      <FormError error={save.error} />
    </form>
  );
}

function TailscaleNeed({ url: given }: { url?: string }) {
  const link = useTailscaleLink();
  const url = link.data?.url ?? given;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center rounded-lg bg-gold px-4 text-[0.88rem] text-bg hover:bg-gold-bright"
        >
          Sign in to Tailscale
        </a>
      )}
      <Button tone="quiet" disabled={link.isPending} onClick={() => link.mutate()}>
        {link.isPending ? "Getting a link…" : url ? "Get a new link" : "Get the sign-in link"}
      </Button>
      <p className="w-full text-[0.8rem] text-faint">
        Use a free Tailscale account. Then add the Tailscale app on your phone with the same
        account, and your apps open from anywhere.
      </p>
    </div>
  );
}

export function BuildProgress({ aiName }: { aiName: string }) {
  const build = useHomelabBuild();
  const propose = useProposeBuildStep();
  const b = build.data;
  if (!b) return null;
  const next = b.steps.find((s) => s.id === b.next);
  return (
    <section
      className="rounded-2xl border border-line-strong p-5"
      aria-label="Building your homelab"
      data-testid="build-progress"
    >
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[1.05rem] text-ink">Building your homelab</h3>
        <span className="text-[0.8rem] text-faint">
          {b.steps.filter((s) => s.status === "done").length} of {b.steps.length} done
        </span>
      </div>
      <p className="mb-4 text-[0.84rem] leading-relaxed text-muted">
        One step at a time, each one only after you approve it. Your files are never moved or
        deleted.{b.drive ? ` Your movies and shows stay where they are, on ${b.drive}.` : ""}
      </p>
      {b.blocker && (
        <p className="mb-4 rounded-lg border border-gold/40 bg-gold/5 px-3 py-2 text-[0.86rem] text-ink">
          {b.blocker}
        </p>
      )}
      <ol className="space-y-3" data-testid="build-steps">
        {b.steps.map((s) => (
          <li
            key={s.id}
            className="flex gap-3"
            data-testid={`build-step-${s.id}`}
            data-status={s.status}
          >
            <Dot status={s.status} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[0.95rem] text-ink">{s.name}</span>
                <span className={cx("text-[0.78rem]", MARK[s.status].className)}>
                  {MARK[s.status].text}
                </span>
              </div>
              <p className="text-[0.82rem] leading-relaxed text-muted">{s.detail ?? s.what}</p>
              {s.jobId && (s.status === "awaiting-approval" || s.status === "failed") && (
                <Link
                  to={`/jobs/${encodeURIComponent(s.jobId)}`}
                  className="text-[0.82rem] text-gold underline underline-offset-2"
                >
                  {s.status === "awaiting-approval" ? "Review and approve it" : "See what happened"}
                </Link>
              )}
              {s.status === "needs-you" && s.need?.kind === "helper" && (
                <HelperNeed command={s.need.command} />
              )}
              {s.status === "needs-you" && s.need?.kind === "vpn-login" && (
                <VpnNeed {...(s.need.provider ? { provider: s.need.provider } : {})} />
              )}
              {s.status === "needs-you" && s.need?.kind === "tailscale-login" && (
                <TailscaleNeed {...(s.need.url ? { url: s.need.url } : {})} />
              )}
            </div>
          </li>
        ))}
      </ol>
      {b.notBuilt.length > 0 && (
        <p className="mt-4 text-[0.8rem] leading-relaxed text-faint">
          Not built by Hearth yet: {b.notBuilt.map((x) => `${x.name} (${x.why})`).join("; ")}
        </p>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {b.conversationId && (
          <LinkButton to={`/ask/${encodeURIComponent(b.conversationId)}`} tone="outline">
            Back to {aiName}
          </LinkButton>
        )}
        {next && (
          <Button
            tone={b.conversationId ? "quiet" : "outline"}
            disabled={propose.isPending}
            onClick={() => propose.mutate(next.id)}
            data-testid="build-next"
          >
            {propose.isPending
              ? "Making the plan…"
              : next.status === "failed"
                ? `Try ${next.name} again`
                : `Next step: ${next.name}`}
          </Button>
        )}
        {propose.data?.status === "awaiting-approval" && (
          <Link
            to={`/jobs/${encodeURIComponent(propose.data.id)}`}
            className="text-[0.86rem] text-gold underline underline-offset-2"
          >
            Review and approve it
          </Link>
        )}
        {b.done && (
          <p role="status" className="text-[0.9rem] text-live">
            Everything in your plan is built.
          </p>
        )}
      </div>
      <FormError error={propose.error} />
    </section>
  );
}
