import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { PC_ICONS, type DiscoveryReport } from "@dragon-control/core";
import { Button, cx } from "../../components/ui";
import { api } from "../../data/api";
import { useJoinHub } from "../../data/auth";
import { FormError, TextField } from "./AuthFrame";

/**
 * "Connect to my existing Hearth", in a new PC's setup (the owner, 11-24: "install Hearth,
 * paste one code"): Hearth finds the Hearth you already have (home network and Tailscale), you
 * type the short code it shows (Settings, PCs and devices, Add a PC; the Hearth API key still
 * works), this PC scans itself and keeps the apps you tick, then you name it and pick its icon.
 * No new account, no password: this PC is used through your Hearth from then on.
 *
 * Signed in (Settings, PCs and devices, Join another Hearth): the same steps for a PC that was set
 * up on its own first. No setup code: its owner just confirmed it is them. Its account, projects,
 * systems, memory and vault stay on it.
 */

interface Found {
  url: string;
  name: string;
  linkable: boolean;
  via: "home" | "tailscale";
}

export function LinkPc({
  setupCode: givenCode,
  onBack,
  signedIn = false,
}: {
  setupCode: string;
  onBack: () => void;
  /** A PC that is set up already: its signed-in owner joins it, no setup code. */
  signedIn?: boolean;
}) {
  const [code, setCode] = useState(givenCode);
  const withCode = (c: string) => (signedIn ? {} : { setupCode: c });
  const find = useMutation({
    mutationFn: (setupCode: string) =>
      api<{ thisPc: string; found: Found[] }>("POST", "/api/pcs/find", withCode(setupCode)),
  });
  const start = useMutation({
    mutationFn: (b: { setupCode: string; hubUrl: string; key: string }) =>
      api<{ joinLink: string; hubName: string; taken: { name: string; icon: string }[] }>(
        "POST",
        "/api/pcs/link-start",
        signedIn ? { hubUrl: b.hubUrl, key: b.key } : b,
      ),
  });
  const join = useJoinHub();
  const [hub, setHub] = useState<string>("");
  const [typed, setTyped] = useState(false);
  const [key, setKey] = useState("");
  // The short code your Hearth shows (Add a PC), or the Hearth API key for those who have it.
  const [joinCode, setJoinCode] = useState("");
  const [useKey, setUseKey] = useState(false);
  const [byCode, setByCode] = useState<{ joinLink: string; hubName: string; taken: [] }>();
  // This PC scanned (and its apps kept) before it joins; a set-up PC keeps what it has.
  const [scanned, setScanned] = useState(signedIn);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);

  // Look as soon as the setup code is known.
  const { mutate: look } = find;
  useEffect(() => {
    if (signedIn || code.trim()) look(code.trim());
  }, [code, look, signedIn]);
  const found = find.data?.found ?? [];
  const linkable = found.filter((f) => f.linkable);
  const picked = hub || linkable[0]?.url || "";
  const linked = start.data ?? byCode;

  if (join.data) {
    return (
      <div role="status" data-testid="link-done">
        <p className="mb-4 text-[0.95rem] text-ink">
          Linked. This PC is part of {join.data.hubName}.
        </p>
        <p className="mb-6 text-[0.86rem] leading-relaxed text-muted">
          It shows up there under PCs and devices, with its name and icon. Its projects run here,
          with this PC's own Claude Code or Codex: the War Room asks you to sign it in the first
          time.
          {signedIn &&
            " Everything that was on this PC stays on it (its projects, systems, memory and keys), and a backup was made first. If your Hearth ever removes it, it goes back to its own account."}
        </p>
        <a
          href={join.data.hubUrl}
          className="flex min-h-11 w-full items-center justify-center rounded-lg bg-gold px-4 text-[0.9rem] text-bg hover:bg-gold-bright"
        >
          Open your Hearth
        </a>
      </div>
    );
  }

  // Step 2: what's on this PC, kept as it joins.
  if (linked && !scanned) {
    return (
      <ScanThisPc
        setupCode={code.trim()}
        hubName={linked.hubName}
        onDone={() => setScanned(true)}
      />
    );
  }

  // Step 3: this PC's name and icon.
  if (linked) {
    const takenBy = new Map(linked.taken.map((t) => [t.icon, t.name]));
    const chosen = icon ?? PC_ICONS.find((i) => !takenBy.has(i.id))?.id ?? null;
    const pcName = name || find.data?.thisPc || "";
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          join.mutate({
            link: linked.joinLink,
            ...withCode(code.trim()),
            ...(pcName.trim() ? { name: pcName.trim() } : {}),
            ...(chosen ? { icon: chosen } : {}),
          });
        }}
        data-testid="link-this-pc"
      >
        <p className="mb-4 text-[0.88rem] text-muted">
          {linked.hubName} is ready for this PC. Name it and pick its icon.
        </p>
        <TextField
          id="pc-name"
          label="What's this PC called?"
          value={pcName}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
        />
        <div role="radiogroup" aria-label="Icon" className="mb-5 flex flex-wrap gap-2">
          {PC_ICONS.map((i) => {
            const usedBy = takenBy.get(i.id);
            const on = chosen === i.id;
            return (
              <button
                key={i.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={usedBy ? `${i.label} (used by ${usedBy})` : i.label}
                title={usedBy ? `Used by ${usedBy}` : i.label}
                disabled={Boolean(usedBy)}
                onClick={() => setIcon(i.id)}
                className={cx(
                  "rounded-full p-0.5",
                  usedBy ? "cursor-not-allowed opacity-30 grayscale" : "hover:scale-105",
                )}
                style={on ? { boxShadow: `0 0 0 2px ${i.color}` } : undefined}
              >
                <img src={`/pc-icons/${i.id}.webp`} alt="" className="h-12 w-12 rounded-full" />
              </button>
            );
          })}
        </div>
        {chosen && (
          <p
            className="mb-5 text-center text-[1rem] font-medium"
            style={{ color: PC_ICONS.find((i) => i.id === chosen)?.color }}
          >
            {pcName}
          </p>
        )}
        <Button tone="primary" type="submit" className="w-full" disabled={join.isPending}>
          {join.isPending ? "Linking" : "Finish linking"}
        </Button>
        <FormError error={join.error} />
      </form>
    );
  }

  // Step 1: which Hearth, and its key.
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!picked) return;
        if (useKey) {
          if (key.trim()) start.mutate({ setupCode: code.trim(), hubUrl: picked, key: key.trim() });
          return;
        }
        if (!joinCode.trim()) return;
        let hubUrl = picked.trim().replace(/\/+$/, "");
        if (!/^https?:\/\//.test(hubUrl))
          hubUrl = `http://${hubUrl}${/:\d+$/.test(hubUrl) ? "" : ":7600"}`;
        setByCode({
          joinLink: `${hubUrl}/join?code=${encodeURIComponent(joinCode.trim())}`,
          hubName: found.find((x) => x.url === picked)?.name ?? "your Hearth",
          taken: [],
        });
      }}
      data-testid="link-pc"
    >
      {!givenCode && !signedIn && (
        <TextField
          id="link-setup-code"
          label="Setup code"
          hint="Shown where Hearth was installed on this PC."
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
      )}
      <p className="mb-2 text-[0.85rem] text-ink">Your Hearth</p>
      {find.isPending ? (
        <p className="mb-4 text-[0.86rem] text-muted" role="status">
          Looking on your home network and Tailscale…
        </p>
      ) : !typed && linkable.length > 0 ? (
        <div role="radiogroup" aria-label="Your Hearth" className="mb-2 space-y-2">
          {linkable.map((f) => (
            <label
              key={f.url}
              className={cx(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3",
                picked === f.url ? "border-gold/70 bg-gold/10" : "border-line",
              )}
            >
              <input
                type="radio"
                name="hub"
                checked={picked === f.url}
                onChange={() => setHub(f.url)}
                className="accent-[var(--color-gold)]"
              />
              <span className="text-[0.92rem] text-ink">Hearth on {f.name}</span>
              <span className="ml-auto text-[0.74rem] text-faint">
                {f.via === "tailscale" ? "Tailscale" : "Home network"}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <>
          {!typed && find.isSuccess && (
            <p className="mb-3 text-[0.84rem] leading-relaxed text-warn" role="status">
              No Hearth answered on this network or your Tailscale. On your Hearth, open Settings,
              then PCs and devices, and press Open to my home network. Or type its address.
            </p>
          )}
          <TextField
            id="hub-address"
            label="Your Hearth's address"
            hint="Like 192.168.1.10:7600, or its Tailscale name"
            value={hub}
            onChange={(e) => setHub(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </>
      )}
      {!find.isPending && (
        <div className="mb-4 flex gap-3 text-[0.8rem]">
          {!typed && linkable.length > 0 && (
            <button
              type="button"
              className="text-gold hover:underline"
              onClick={() => {
                setTyped(true);
                setHub("");
              }}
            >
              Type its address instead
            </button>
          )}
          <button
            type="button"
            className="text-muted hover:text-ink"
            onClick={() => (signedIn || code.trim()) && find.mutate(code.trim())}
          >
            Look again
          </button>
        </div>
      )}
      {useKey ? (
        <TextField
          id="hearth-api-key"
          label="Hearth API key"
          hint="On your Hearth: Secure Vault, Hearth API key, Copy."
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
      ) : (
        <TextField
          id="join-code"
          label="The code from your Hearth"
          hint="On your Hearth: Settings, PCs and devices, Add a PC. It shows a code like ABCD-1234."
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          autoComplete="off"
          spellCheck={false}
          required
        />
      )}
      <button
        type="button"
        className="mb-4 text-[0.8rem] text-muted hover:text-ink"
        onClick={() => setUseKey(!useKey)}
        data-testid="link-use-key"
      >
        {useKey ? "Use a code from your Hearth instead" : "Use the Hearth API key instead"}
      </button>
      <Button
        tone="primary"
        type="submit"
        className="w-full"
        disabled={start.isPending || !picked || !(useKey ? key.trim() : joinCode.trim())}
      >
        {start.isPending ? "Checking the key" : "Next"}
      </Button>
      <FormError error={start.error ?? find.error} />
      <Button tone="quiet" className="mt-3 w-full" onClick={onBack}>
        Back
      </Button>
    </form>
  );
}

/**
 * What's on this PC (11-24): the same scan as Discover, before it joins, so its apps come with it
 * into your Hearth. What Discover would tick is ticked; Skip keeps nothing (scan later from
 * Discover).
 */
function ScanThisPc({
  setupCode,
  hubName,
  onDone,
}: {
  setupCode: string;
  hubName: string;
  onDone: () => void;
}) {
  const scan = useMutation({
    mutationFn: () => api<DiscoveryReport>("POST", "/api/pcs/setup-scan", { setupCode }),
  });
  const add = useMutation({
    mutationFn: (selections: { key: string; name: string }[]) =>
      api<{ services: number }>("POST", "/api/pcs/setup-add", {
        setupCode,
        reportId: scan.data!.id,
        selections,
      }),
    onSuccess: onDone,
  });
  const [picked, setPicked] = useState<Set<string>>();
  const { mutate: run } = scan;
  useEffect(() => run(), [run]);
  const r = scan.data;
  const apps = (r?.findings ?? []).filter((f) => f.recognised || f.selectedByDefault);
  const on = picked ?? new Set(apps.filter((f) => f.selectedByDefault).map((f) => f.key));
  return (
    <div data-testid="link-scan">
      <p className="mb-1 text-[0.95rem] text-ink">What&apos;s on this PC</p>
      <p className="mb-4 text-[0.84rem] leading-relaxed text-muted">
        Hearth checks this PC for apps and drives, so they come with it into {hubName}.
      </p>
      {scan.isPending ? (
        <p className="mb-4 text-[0.86rem] text-muted" role="status">
          Looking at this PC…
        </p>
      ) : r ? (
        <>
          <p className="mb-2 text-[0.84rem] text-ink" data-testid="link-scan-host">
            {r.host.name}: {r.host.os}
            {r.host.volumes.length
              ? `, ${r.host.volumes.length} drive${r.host.volumes.length === 1 ? "" : "s"}`
              : ""}
          </p>
          {apps.length ? (
            <ul className="mb-4 max-h-64 space-y-1 overflow-y-auto" aria-label="Apps found">
              {apps.map((f) => (
                <li key={f.key}>
                  <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg border border-line px-3 text-[0.88rem] text-ink">
                    <input
                      type="checkbox"
                      checked={on.has(f.key)}
                      onChange={(e) => {
                        const next = new Set(on);
                        if (e.target.checked) next.add(f.key);
                        else next.delete(f.key);
                        setPicked(next);
                      }}
                      className="accent-[var(--color-gold)]"
                      data-testid="link-scan-app"
                    />
                    {f.name}
                    <span className="ml-auto text-[0.72rem] text-faint">{f.state}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-4 text-[0.84rem] text-muted">
              No apps found on this PC. Its drives come along; add apps later from Discover.
            </p>
          )}
          <Button
            tone="primary"
            className="w-full"
            disabled={add.isPending}
            onClick={() =>
              on.size
                ? add.mutate(
                    apps.filter((f) => on.has(f.key)).map((f) => ({ key: f.key, name: f.name })),
                  )
                : onDone()
            }
            data-testid="link-scan-keep"
          >
            {add.isPending
              ? "Adding"
              : on.size
                ? `Keep ${on.size} app${on.size === 1 ? "" : "s"} and continue`
                : "Continue"}
          </Button>
        </>
      ) : null}
      <FormError error={scan.error ?? add.error} />
      {!scan.isPending && (
        <Button tone="quiet" className="mt-3 w-full" onClick={onDone} data-testid="link-scan-skip">
          Skip for now
        </Button>
      )}
    </div>
  );
}
