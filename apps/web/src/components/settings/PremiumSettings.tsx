import { packageWords } from "../shell/PremiumSetup";
import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  PREMIUM_FEATURES,
  PREMIUM_INFO,
  SPONSORS_OPEN,
  SPONSORS_URL,
  founderPriceLine,
  type FeatureAccess,
  type PremiumGrantScope,
} from "@dragon-control/core";
import {
  useAddLicense,
  useIssuer,
  useIssuerAction,
  usePremium,
  usePremiumTour,
  useRedeem,
  type IssuerGrant,
} from "../../data/premium";
import { Modal } from "../workspace/dialogs";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../data/api";
import { AddonSlot } from "../AddonSlot";
import { Button, Section, Skeleton, cx } from "../ui";

/**
 * Settings, Premium (docs/design/PREMIUM.md): the premium features and whether this Hearth
 * has them, adding a licence key or redeeming a code, and, on the owner's issuing Hearth only,
 * grants and promo codes. Hearth itself stays free: nothing here limits a free feature.
 */

const field =
  "min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";
const day = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })
    : "";

function accessWords(f: FeatureAccess) {
  const how = f.kind === "complimentary" ? "Complimentary" : f.kind === "trial" ? "Trial" : "Paid";
  switch (f.state) {
    case "active":
      return `${how}, ${f.end ? `until ${day(f.end)}` : "for good"}`;
    case "expired":
      return `Ended ${day(f.end)}`;
    case "revoked":
      return "Taken back by the issuer";
    case "scheduled":
      return `Starts ${day(f.start)}`;
    case "pending":
      return "Waiting: this computer's clock looks wrong. Set it right and it comes back.";
    default:
      return "Not included";
  }
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      tone="quiet"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 2000);
        });
      }}
    >
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

function Problem({ error }: { error: Error | null }) {
  return error ? (
    <p role="alert" className="text-[0.82rem] text-bad">
      {error.message}
    </p>
  ) : null;
}

/** The Premium tour, any time (11-22): the same tour Welcome to Premium offers. */
function TourButton() {
  const tour = usePremiumTour();
  const navigate = useNavigate();
  return (
    <div className="mt-4">
      <Button
        tone="primary"
        disabled={tour.isPending}
        data-testid="premium-tour"
        onClick={() =>
          tour.mutate(undefined, {
            onSuccess: (r) => navigate(`/ask/${encodeURIComponent(r.conversationId)}`),
          })
        }
      >
        {tour.isPending ? "Starting…" : "Show me around Premium"}
      </Button>
      <p className="mt-1.5 text-[0.8rem] text-faint">
        A new conversation where Ember shows you each Premium extra on screen, out loud.
      </p>
      <Problem error={tour.error} />
    </div>
  );
}

export function PremiumSettings() {
  const q = usePremium();
  const add = useAddLicense();
  const redeem = useRedeem();
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  // A gifted code says so when it is redeemed (Flint, 11-13).
  const [gifted, setGifted] = useState(false);
  const showIssuer =
    Boolean(q.data?.issuer) ||
    (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("issuer"));
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (!q.data)
    return (
      <p className="text-[0.88rem] text-faint" role="alert">
        Couldn&apos;t read Premium just now. {q.error?.message}
      </p>
    );
  const s = q.data;
  return (
    <>
      <Section title="Premium" id="premium">
        <p className="mb-5 max-w-2xl text-[0.88rem] leading-relaxed text-muted">
          Hearth is free for your homelab: every panel, dashboard and widget, Docker and media
          management, Home Assistant, and Ember&apos;s help, with no limits. Three extras are part
          of Premium.
        </p>
        {s.open ? (
          <p
            className="mb-5 max-w-2xl rounded-lg border border-gold/40 bg-gold/5 px-4 py-3 text-[0.86rem] leading-relaxed text-ink"
            data-testid="premium-open"
          >
            Premium isn&apos;t switched on yet, so every extra is included on this Hearth for now. A
            licence you add today keeps them when it is.
          </p>
        ) : null}
        <ul className="grid gap-3 md:grid-cols-2" data-testid="premium-features">
          {PREMIUM_FEATURES.map((id) => {
            const f = s.features.find((x) => x.feature === id)!;
            const on = f.state === "active";
            return (
              <li
                key={id}
                data-testid={`premium-${id}`}
                data-state={f.state}
                className={cx(
                  "rounded-xl border p-4",
                  on ? "border-gold/60 bg-gold/5" : "border-line-strong",
                )}
              >
                <p className="flex items-center justify-between gap-3 text-[0.98rem] text-ink">
                  {PREMIUM_INFO[id].name}
                  <span
                    className={cx(
                      "rounded-full px-2.5 py-0.5 text-[0.74rem]",
                      on ? "bg-gold/15 text-gold" : "bg-line text-muted",
                    )}
                  >
                    {on ? "Included" : f.state === "free" ? "Not included" : "Not active"}
                  </span>
                </p>
                <p className="mt-2 text-[0.84rem] leading-relaxed text-muted">
                  {PREMIUM_INFO[id].what}
                </p>
                <p className="mt-2 text-[0.8rem] leading-relaxed text-faint">
                  {PREMIUM_INFO[id].free}
                </p>
                <p className="mt-3 text-[0.82rem] text-ink">{accessWords(f)}</p>
              </li>
            );
          })}
        </ul>

        {s.features.some((f) => f.state === "active") ? <TourButton /> : null}

        {packageWords(s.package) ? (
          <p
            className={cx(
              "mt-4 max-w-2xl rounded-lg border px-4 py-3 text-[0.86rem] leading-relaxed",
              s.package?.state === "failed" || s.package?.state === "restart-needed"
                ? "border-bad/50 text-ink"
                : "border-gold/40 bg-gold/5 text-ink",
            )}
            role="status"
            data-testid="premium-package"
            data-state={s.package?.state}
          >
            {packageWords(s.package)}
          </p>
        ) : null}

        {!s.features.every((f) => f.state === "active") || s.open ? (
          <Upgrade onCode={() => document.getElementById("premium-code")?.focus()} />
        ) : null}

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <form
            className="space-y-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (code.trim())
                redeem.mutate(code.trim(), {
                  onSuccess: (r) => {
                    setCode("");
                    setGifted(Boolean((r as { gifted?: boolean }).gifted));
                  },
                });
            }}
          >
            <label htmlFor="premium-code" className="block text-[0.86rem] text-ink">
              Redeem a code
            </label>
            <div className="flex gap-2">
              <input
                id="premium-code"
                className={field}
                placeholder="HRTH-XXXXX-XXXXX-XXXXX-XXXXX"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Button type="submit" disabled={redeem.isPending || !code.trim()}>
                {redeem.isPending ? "Checking…" : "Redeem"}
              </Button>
            </div>
            {!s.redeemOnline && (
              <p className="text-[0.78rem] text-faint">
                Codes are checked with Hearth&apos;s licence service, which isn&apos;t switched on
                yet. Whoever gave you a code can send a licence key for this installation instead.
              </p>
            )}
            <Problem error={redeem.error} />
            {gifted && (
              <p className="text-[0.84rem] text-ink" role="status" data-testid="premium-gifted">
                Premium was gifted to you. If you share or review Hearth, please mention you
                received Premium free.
              </p>
            )}
          </form>
          <form
            className="space-y-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (key.trim()) add.mutate(key.trim(), { onSuccess: () => setKey("") });
            }}
          >
            <label htmlFor="premium-key" className="block text-[0.86rem] text-ink">
              Add a licence key
            </label>
            <div className="flex gap-2">
              <input
                id="premium-key"
                className={field}
                placeholder="HEARTHL1…"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button type="submit" disabled={add.isPending || !key.trim()}>
                {add.isPending ? "Checking…" : "Add"}
              </Button>
            </div>
            <p className="text-[0.78rem] text-faint">
              Checked on this Hearth, no internet needed. A key is made for one installation.
            </p>
            <Problem error={add.error} />
          </form>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 text-[0.82rem] text-muted">
          <span>This installation&apos;s ID:</span>
          <code className="rounded bg-line px-2 py-1 text-ink" data-testid="premium-install-id">
            {s.installId}
          </code>
          <Copy text={s.installId} label="Copy this installation's ID" />
          <span className="text-faint">Give it to whoever makes your licence key.</span>
        </div>
        <PremiumPackage />
        <AddonSlot name="settings.premium" fallback={null} />
      </Section>
      {showIssuer && <IssuerSection installId={s.installId} />}
    </>
  );
}

/**
 * Upgrade (the owner, 11-13): one place to get Premium on a Hearth that is already installed,
 * whether you pay or were given a code. Paying happens on GitHub Sponsors, never in Hearth:
 * Hearth never asks for card details. A code (bought, gifted or from a promotion) is entered
 * right here, at any time.
 */
function Upgrade({ onCode }: { onCode: () => void }) {
  return (
    <div
      id="upgrade"
      className="mt-6 rounded-xl border border-gold/50 bg-gold/5 p-4"
      data-testid="premium-upgrade"
    >
      <p className="text-[1rem] font-semibold text-ink">Upgrade to Premium</p>
      <p className="mt-1 max-w-2xl text-[0.84rem] text-muted">
        Already using Hearth for free? Upgrade any time: everything you set up stays as it is.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-line p-3">
          <p className="text-[0.9rem] text-ink">Sponsor Dragon&apos;s Oath</p>
          <p className="mt-1 text-[0.8rem] text-muted">
            Supporter: $5 a month, Premium while you sponsor.
            <br />
            <span data-testid="premium-founder-price">{founderPriceLine()}</span>, once: Premium for
            life.
            <br />
            Paid on GitHub Sponsors; you then claim a code and enter it here.
          </p>
          {SPONSORS_OPEN ? (
            <a
              href={SPONSORS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex min-h-10 items-center rounded-lg border border-gold/60 px-3 text-[0.84rem] text-gold hover:bg-gold/10"
              data-testid="premium-sponsor"
            >
              Sponsor on GitHub
            </a>
          ) : (
            <p className="mt-3 text-[0.8rem] text-faint" data-testid="premium-sponsor-soon">
              Opens with Hearth&apos;s public launch. Hearth never asks for card details.
            </p>
          )}
        </div>
        <div className="rounded-lg border border-line p-3">
          <p className="text-[0.9rem] text-ink">I have a code</p>
          <p className="mt-1 text-[0.8rem] text-muted">
            A code from sponsoring, a gift or a promotion works at any time, on a Hearth you already
            use.
          </p>
          <Button className="mt-3" onClick={onCode} data-testid="premium-enter-code">
            Enter a code
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------ the owner's issuer ------------------------------------------------ */

const AUDIENCE: Record<string, string> = {
  self: "Me",
  family: "Family",
  friend: "Friend",
  creator: "Creator",
  tester: "Tester",
  partner: "Partner",
  other: "Other",
};
const SCOPES: { value: PremiumGrantScope; label: string }[] = [
  { value: "premium_all", label: "All of Premium" },
  { value: "hearth_interconnectivity", label: PREMIUM_INFO.hearth_interconnectivity.name },
  { value: "ember_show_and_tell", label: PREMIUM_INFO.ember_show_and_tell.name },
  { value: "panel_builder", label: PREMIUM_INFO.panel_builder.name },
];
const scopeWords = (scope: PremiumGrantScope[]) =>
  scope.includes("premium_all")
    ? "All of Premium"
    : scope.map((x) => SCOPES.find((o) => o.value === x)?.label ?? x).join(", ");

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[0.8rem] text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * The owner's saved copy of the signing key (their password manager or offline drive), back into
 * this Hearth's vault: same key, so every licence it signed keeps working and no release is needed.
 */
function RestoreKey({ open = false }: { open?: boolean }) {
  const act = useIssuerAction();
  const [shown, setShown] = useState(open);
  const [key, setKey] = useState("");
  const done = act.data as { keyId: string; trusted: boolean } | undefined;
  if (!shown)
    return (
      <button
        type="button"
        className="text-[0.82rem] text-gold underline"
        onClick={() => setShown(true)}
        data-testid="premium-issuer-restore-open"
      >
        Use a key you saved
      </button>
    );
  return (
    <form
      className="max-w-2xl space-y-2"
      data-testid="premium-issuer-restore"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim())
          act.mutate(
            { url: "/restore", body: { key: key.trim() } },
            { onSuccess: () => setKey("") },
          );
      }}
    >
      <label htmlFor="premium-restore-key" className="block text-[0.86rem] text-ink">
        Use a key you saved
      </label>
      <p className="text-[0.8rem] text-faint">
        Paste the whole saved text, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----.
        It goes straight into this Hearth&apos;s Secure Vault, protected, and is never shown again
        here.
      </p>
      <textarea
        id="premium-restore-key"
        className="min-h-28 w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[0.78rem] text-ink"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <Button type="submit" disabled={act.isPending || !key.trim()}>
        {act.isPending ? "Checking…" : "Use this key"}
      </Button>
      {done && !done.trusted && (
        <p className="text-[0.82rem] text-muted" data-testid="premium-issuer-restored">
          Key {done.keyId} is back. No Hearth release trusts it yet, so it can&apos;t issue until
          one does.
        </p>
      )}
      <Problem error={act.error} />
    </form>
  );
}

function IssuerSection({ installId }: { installId: string }) {
  const q = useIssuer(true);
  const act = useIssuerAction();
  const [shown, setShown] = useState<{ title: string; value: string; note: string }>();
  const [revoking, setRevoking] = useState<IssuerGrant>();
  const [takingBack, setTakingBack] = useState<{ id: string; hint: string; uses: number }>();
  const v = q.data;
  return (
    <Section title="Issue Premium" id="premium-issuer">
      <div data-testid="premium-issuer" className="space-y-6">
        <p className="max-w-2xl text-[0.85rem] leading-relaxed text-muted">
          Complimentary grants and promo codes: $0, no card, nothing renews. Only the Hearth holding
          your licence signing key can issue them, and only while you&apos;re signed in with the
          vault unlocked.
        </p>
        {!v ? (
          <Skeleton className="h-24" />
        ) : !v.publicKey ? (
          <div className="space-y-2">
            <p className="text-[0.85rem] text-ink">This Hearth has no signing key.</p>
            <p className="max-w-2xl text-[0.8rem] text-faint">
              Make one only on the Hearth that will issue licences. Its private half stays in this
              Hearth&apos;s Secure Vault. Licences it signs are accepted once a Hearth release
              trusts its public half.
            </p>
            <Button
              onClick={() => act.mutate({ url: "/setup" })}
              disabled={act.isPending}
              data-testid="premium-issuer-setup"
            >
              Make the signing key
            </Button>
            <RestoreKey />
          </div>
        ) : v.keyMissing ? (
          <div className="space-y-2" data-testid="premium-issuer-missing">
            <p className="text-[0.85rem] text-ink">
              This Hearth&apos;s signing key (key id {v.keyId}) is no longer in its Secure Vault, so
              it can&apos;t issue. Licences it signed still work.
            </p>
            <p className="max-w-2xl text-[0.8rem] text-faint">
              Restore a backup of this Hearth (Settings, Backups), or use the copy you saved when
              you made the key.
            </p>
            <RestoreKey open />
          </div>
        ) : !v.active ? (
          <div className="space-y-2">
            <p className="text-[0.85rem] text-ink">
              The signing key is made, but no Hearth release trusts it yet, so it can&apos;t issue.
            </p>
            <p className="text-[0.8rem] text-faint">Its public half (safe to share):</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-line px-2 py-1 text-[0.78rem] text-ink">
                {v.publicKey}
              </code>
              <Copy text={v.publicKey} label="Copy the public key" />
            </div>
          </div>
        ) : (
          <>
            <GrantForm
              installId={installId}
              onDone={(r) =>
                r.licenseKey &&
                setShown({
                  title: "Licence key",
                  value: r.licenseKey,
                  note: "Send this to them: they add it in Settings, Premium. It's shown once.",
                })
              }
            />
            <CodeForm
              onDone={(c) =>
                setShown({
                  title: "Promo code",
                  value: c,
                  note: "Copy it now: Hearth keeps only a fingerprint of it, so it can't be shown again.",
                })
              }
            />
            <div>
              <h3 className="mb-2 text-[0.9rem] text-ink">Grants</h3>
              {!v.grants.length ? (
                <p className="text-[0.82rem] text-faint">None yet.</p>
              ) : (
                <ul
                  className="divide-y divide-line border-y border-line"
                  data-testid="premium-grants"
                >
                  {v.grants.map((g) => (
                    <li
                      key={g.id}
                      className="flex flex-wrap items-center gap-3 py-3 text-[0.84rem]"
                    >
                      <span className="min-w-40 flex-1">
                        <span className="text-ink">{g.recipient}</span>{" "}
                        <span className="text-faint">· {AUDIENCE[g.audience] ?? g.audience}</span>
                        <span className="block text-[0.78rem] text-muted">
                          {scopeWords(g.scope)} · {g.endsAt ? `until ${day(g.endsAt)}` : "for good"}
                          {g.codeId ? " · from a code" : ""}
                          {!g.installId ? " · no installation yet" : ""}
                        </span>
                        {g.note && (
                          <span className="block text-[0.76rem] text-faint">Note: {g.note}</span>
                        )}
                      </span>
                      <span className="text-[0.78rem] text-muted" data-state={g.state}>
                        {g.state[0]!.toUpperCase() + g.state.slice(1)}
                      </span>
                      {g.state === "revoked" ? (
                        <Button
                          tone="quiet"
                          onClick={() => act.mutate({ url: `/grants/${g.id}/reinstate` })}
                        >
                          Reinstate
                        </Button>
                      ) : (
                        <Button tone="quiet" onClick={() => setRevoking(g)}>
                          Revoke
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-[0.9rem] text-ink">Promo codes</h3>
              {!v.codes.length ? (
                <p className="text-[0.82rem] text-faint">None yet.</p>
              ) : (
                <ul
                  className="divide-y divide-line border-y border-line"
                  data-testid="premium-codes"
                >
                  {v.codes.map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center gap-3 py-3 text-[0.84rem]"
                    >
                      <span className="min-w-40 flex-1">
                        <code className="text-ink">{c.hint}…</code>{" "}
                        {c.campaign && <span className="text-faint">· {c.campaign}</span>}
                        <span className="block text-[0.78rem] text-muted">
                          {scopeWords(c.scope)} ·{" "}
                          {c.durationDays ? `${c.durationDays} days each` : "for good"} · {c.uses}{" "}
                          of {c.maxUses} used
                          {c.expiresAt ? ` · redeem by ${day(c.expiresAt)}` : ""}
                        </span>
                      </span>
                      <span className="text-[0.78rem] text-muted">{c.state}</span>
                      <Button
                        tone="quiet"
                        onClick={() =>
                          act.mutate({ url: `/codes/${c.id}/active`, body: { active: !c.active } })
                        }
                      >
                        {c.active ? "Switch off" : "Switch on"}
                      </Button>
                      {c.uses > 0 && (
                        <Button tone="quiet" onClick={() => setTakingBack(c)}>
                          Take back all
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[0.76rem] text-faint">
                Switching a code off stops new redemptions. Grants already made from it stay until
                you revoke them, or take back all of them at once.
              </p>
            </div>
          </>
        )}
        <Problem error={act.error} />
      </div>
      {shown && (
        <Modal title={shown.title} onCancel={() => setShown(undefined)}>
          <div className="space-y-3" data-testid="premium-shown-once">
            <code className="block break-all rounded-lg bg-line p-3 text-[0.82rem] text-ink">
              {shown.value}
            </code>
            <p className="text-[0.82rem] text-muted">{shown.note}</p>
            <div className="flex gap-2">
              <Copy text={shown.value} label={`Copy the ${shown.title.toLowerCase()}`} />
              <Button tone="primary" onClick={() => setShown(undefined)}>
                Done
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {revoking && (
        <Modal
          title="Revoke this grant?"
          role="alertdialog"
          onCancel={() => setRevoking(undefined)}
        >
          <div className="space-y-3">
            <p className="text-[0.86rem] text-muted">
              {revoking.recipient} loses {scopeWords(revoking.scope)} as soon as their Hearth hears
              from you. Their Hearth, settings and links are kept. You can reinstate it later.
            </p>
            <div className="flex gap-2">
              <Button
                tone="primary"
                onClick={() =>
                  act.mutate(
                    { url: `/grants/${revoking.id}/revoke` },
                    { onSettled: () => setRevoking(undefined) },
                  )
                }
              >
                Revoke
              </Button>
              <Button onClick={() => setRevoking(undefined)}>Keep it</Button>
            </div>
          </div>
        </Modal>
      )}
      {takingBack && (
        <Modal
          title="Take back every licence from this code?"
          role="alertdialog"
          onCancel={() => setTakingBack(undefined)}
        >
          <div className="space-y-3">
            <p className="text-[0.86rem] text-muted">
              The code {takingBack.hint}… goes off, and the {takingBack.uses} Hearth
              {takingBack.uses === 1 ? "" : "s"} that redeemed it lose what it gave as soon as they
              hear from the licence service. Their Hearths, settings and links are kept.
            </p>
            <div className="flex gap-2">
              <Button
                tone="primary"
                onClick={() =>
                  act.mutate(
                    { url: `/codes/${takingBack.id}/revoke-all` },
                    { onSettled: () => setTakingBack(undefined) },
                  )
                }
              >
                Take back all
              </Button>
              <Button onClick={() => setTakingBack(undefined)}>Keep them</Button>
            </div>
          </div>
        </Modal>
      )}
    </Section>
  );
}

function ScopePick({
  value,
  onChange,
}: {
  value: PremiumGrantScope;
  onChange: (v: PremiumGrantScope) => void;
}) {
  return (
    <select
      className={field}
      value={value}
      onChange={(e) => onChange(e.target.value as PremiumGrantScope)}
    >
      {SCOPES.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function GrantForm({
  installId,
  onDone,
}: {
  installId: string;
  onDone: (r: { grantId: string; licenseKey?: string }) => void;
}) {
  const act = useIssuerAction();
  const [recipient, setRecipient] = useState("");
  const [audience, setAudience] = useState("friend");
  const [scope, setScope] = useState<PremiumGrantScope>("premium_all");
  const [days, setDays] = useState("");
  const [install, setInstall] = useState("");
  const [note, setNote] = useState("");
  const forMe = audience === "self";
  return (
    <form
      className="space-y-3 rounded-xl border border-line-strong p-4"
      data-testid="premium-grant-form"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(days);
        act.mutate(
          {
            url: "/grants",
            body: {
              recipient: recipient.trim() || (forMe ? "Me" : ""),
              audience,
              scope: [scope],
              ...(n > 0 ? { end: new Date(Date.now() + n * 86_400_000).toISOString() } : {}),
              ...(forMe ? { installId } : install.trim() ? { installId: install.trim() } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
            },
          },
          {
            onSuccess: (r) => {
              setRecipient("");
              setNote("");
              setInstall("");
              onDone(r as { grantId: string; licenseKey?: string });
            },
          },
        );
      }}
    >
      <h3 className="text-[0.9rem] text-ink">Grant Premium</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="g-who" label="Who it's for">
          <input
            id="g-who"
            className={field}
            maxLength={80}
            placeholder={forMe ? "Me" : "A name"}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
        </Field>
        <Field id="g-aud" label="They are">
          <select
            id="g-aud"
            className={field}
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
          >
            {Object.entries(AUDIENCE).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field id="g-scope" label="Gives">
          <ScopePick value={scope} onChange={setScope} />
        </Field>
        <Field id="g-days" label="For how many days (empty: for good)">
          <input
            id="g-days"
            className={field}
            inputMode="numeric"
            value={days}
            onChange={(e) => setDays(e.target.value.replace(/\D/g, "").slice(0, 4))}
          />
        </Field>
        {!forMe && (
          <Field id="g-install" label="Their installation ID (from their Settings, Premium)">
            <input
              id="g-install"
              className={field}
              spellCheck={false}
              value={install}
              onChange={(e) => setInstall(e.target.value)}
            />
          </Field>
        )}
        <Field id="g-note" label="Your note (only you see it)">
          <input
            id="g-note"
            className={field}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          tone="primary"
          disabled={act.isPending || (!forMe && !recipient.trim())}
        >
          {forMe ? "Grant to this Hearth" : install.trim() ? "Grant and make their key" : "Grant"}
        </Button>
        <span className="text-[0.78rem] text-faint">$0, no card, never renews.</span>
      </div>
      <Problem error={act.error} />
    </form>
  );
}

function CodeForm({ onDone }: { onDone: (code: string) => void }) {
  const act = useIssuerAction();
  const [scope, setScope] = useState<PremiumGrantScope>("premium_all");
  const [campaign, setCampaign] = useState("");
  const [uses, setUses] = useState("1");
  const [days, setDays] = useState("");
  const [until, setUntil] = useState("");
  return (
    <form
      className="space-y-3 rounded-xl border border-line-strong p-4"
      data-testid="premium-code-form"
      onSubmit={(e) => {
        e.preventDefault();
        const d = Number(days);
        act.mutate(
          {
            url: "/codes",
            body: {
              scope: [scope],
              audience: "other",
              maxUses: Math.max(1, Number(uses) || 1),
              ...(campaign.trim() ? { campaign: campaign.trim() } : {}),
              ...(d > 0 ? { durationDays: d } : {}),
              ...(until ? { expiresAt: new Date(`${until}T23:59:59`).toISOString() } : {}),
            },
          },
          { onSuccess: (r) => onDone((r as { code: string }).code) },
        );
      }}
    >
      <h3 className="text-[0.9rem] text-ink">Make a promo code</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="c-scope" label="Gives">
          <ScopePick value={scope} onChange={setScope} />
        </Field>
        <Field id="c-campaign" label="Campaign (optional)">
          <input
            id="c-campaign"
            className={field}
            maxLength={60}
            value={campaign}
            onChange={(e) => setCampaign(e.target.value)}
          />
        </Field>
        <Field id="c-uses" label="How many can use it">
          <input
            id="c-uses"
            className={field}
            inputMode="numeric"
            value={uses}
            onChange={(e) => setUses(e.target.value.replace(/\D/g, "").slice(0, 5))}
          />
        </Field>
        <Field id="c-days" label="Days each grant lasts (empty: for good)">
          <input
            id="c-days"
            className={field}
            inputMode="numeric"
            value={days}
            onChange={(e) => setDays(e.target.value.replace(/\D/g, "").slice(0, 4))}
          />
        </Field>
        <Field id="c-until" label="Redeem by (optional)">
          <input
            id="c-until"
            type="date"
            className={field}
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </Field>
      </div>
      <Button type="submit" tone="primary" disabled={act.isPending}>
        Make the code
      </Button>
      <Problem error={act.error} />
    </form>
  );
}

/**
 * The Premium package (11-14): the Premium extras are a separate, closed-source add-on. This says
 * whether it is installed and, when one could not load, why.
 */
function PremiumPackage() {
  const q = useQuery({
    queryKey: ["addons"],
    queryFn: () =>
      api<{
        loaded: { name: string; version: string }[];
        skipped: { folder: string; why: string }[];
      }>("GET", "/api/addons"),
  });
  if (!q.data) return null;
  return (
    <div className="mt-4 space-y-1 text-[0.82rem]" data-testid="premium-package">
      {q.data.loaded.length ? (
        q.data.loaded.map((a) => (
          <p key={a.name} className="text-muted">
            Premium package installed: {a.name} {a.version}.
          </p>
        ))
      ) : (
        <p className="text-faint">
          The Premium package is not installed on this Hearth. Everything free works without it.
        </p>
      )}
      {q.data.skipped.map((x) => (
        <p key={x.folder} className="text-bad" role="alert">
          {x.folder} did not load. {x.why}
        </p>
      ))}
    </div>
  );
}
