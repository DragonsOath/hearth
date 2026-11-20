import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useHomeConnect, useMusicHome, type FlowStep } from "../../data/home";
import { MusicServices } from "./MusicServices";
import { Modal } from "../workspace/dialogs";
import { Button, cx } from "../ui";
import { MusicAssistantSetup } from "./MusicAssistantSetup";
import { useVault } from "../../data/auth";

/**
 * Connecting a service for the home dashboard (11-04), through Home Assistant's own setup, a
 * step at a time: Hearth shows each of Home Assistant's questions, sends you to a service's own
 * sign-in page when it has one, and says plainly when something is missing. Passwords and secrets
 * typed here go straight to Home Assistant; Hearth never keeps them.
 */

export type ConnectFor = "music" | "calendar" | "lists" | "weather" | "travel" | "youtube";

const CHOICES: Record<ConnectFor, { handler: string; label: string; hint: string }[]> = {
  // Change YouTube account: its own window (MusicAssistantSetup), no choices.
  youtube: [],
  music: [
    {
      handler: "spotify",
      label: "Spotify",
      hint: "Plays on your Spotify speakers and apps. You sign in on Spotify's own page.",
    },
    {
      handler: "music_assistant",
      label: "Music Assistant",
      hint: "YouTube Music, Amazon Music, Apple Music, Tidal, Plex and more, on any speaker. You sign in to Music Assistant and YouTube in windows Hearth opens; Hearth does the rest.",
    },
  ],
  calendar: [
    {
      handler: "google",
      label: "Google Calendar",
      hint: "You sign in on Google's own page.",
    },
    {
      handler: "caldav",
      label: "Apple iCloud (or another CalDAV calendar)",
      hint: "For iCloud: the address https://caldav.icloud.com, your Apple Account email, and an app-specific password made at account.apple.com (Sign-In and Security).",
    },
    {
      handler: "remote_calendar",
      label: "Proton, Outlook or any calendar link",
      hint: "A calendar's .ics link. In Proton Calendar: Settings, Calendars, Share, Share with anyone, then copy the link.",
    },
    {
      handler: "local_calendar",
      label: "A calendar kept in Home Assistant",
      hint: "A family calendar that lives on your server.",
    },
  ],
  lists: [
    {
      handler: "local_todo",
      label: "A new list",
      hint: "Name it, like Groceries or Chores. Make one for each.",
    },
    {
      handler: "shopping_list",
      label: "Home Assistant's shopping list",
      hint: "The shopping list Home Assistant's own app and voice assistant use.",
    },
  ],
  weather: [
    {
      handler: "met",
      label: "Weather for your home",
      hint: "From the Norwegian Meteorological Institute, for your home's location in Home Assistant. No account needed.",
    },
  ],
  travel: [
    {
      handler: "waze_travel_time",
      label: "Travel time with Waze",
      hint: "Drive time between two places, like home and work. Give a name and the two addresses. No account needed; add one for each trip.",
    },
  ],
};

/** Services that need an app of your own first (a client id and secret Home Assistant keeps). */
const APPS: Record<string, { site: string; where: string }> = {
  spotify: {
    site: "https://developer.spotify.com/dashboard",
    where: "Create an app in Spotify's developer dashboard",
  },
  google: {
    site: "https://console.cloud.google.com/apis/credentials",
    where:
      "In Google Cloud, turn on the Google Calendar API, then make an OAuth client (Web application)",
  },
};
const REDIRECT = "https://my.home-assistant.io/redirect/oauth";

const words = (name: string) =>
  ({
    url: "Address",
    username: "Username",
    password: "Password",
    verify_ssl: "Check the address's certificate",
    calendar_name: "Name",
    todo_list_name: "Name",
    name: "Name",
    latitude: "Latitude",
    longitude: "Longitude",
    elevation: "Elevation",
  })[name] ?? name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const input =
  "mt-1 min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold focus:outline-none";

export function ConnectDialog({
  service,
  what,
  renew,
  onClose,
}: {
  service: string;
  what: ConnectFor;
  /** A service Home Assistant is waiting for a sign-in again: start there, no choosing. */
  renew?: string;
  onClose: () => void;
}) {
  const go = useHomeConnect(service);
  const [step, setStep] = useState<FlowStep>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [app, setApp] = useState<{ handler: string; id: string; secret: string }>();
  const [error, setError] = useState<string>();
  // An app sign-in kept in Secure Vault (its client ID and secret), or keep the typed one there.
  const vault = useVault();
  const [fromVault, setFromVault] = useState("");
  const [save, setSave] = useState(true);
  // Music Assistant has its own setup: its sign-in, Home Assistant, then YouTube Music.
  const [musicAssistant, setMusicAssistant] = useState(what === "youtube");
  const [youtubeOnly, setYoutubeOnly] = useState(false);
  // Music Assistant linked to Hearth (it keeps the key): music opens the list of services.
  const music = useMusicHome(what === "music");
  const maLinked = Boolean(music.data?.linked);
  const choice = CHOICES[what].find((c) => c.handler === step?.handler);

  const run = (body: Parameters<typeof go.mutate>[0]) =>
    go.mutate(body, {
      onSuccess: (r) => {
        setError(undefined);
        if ("type" in r) {
          setStep(r);
          setValues(
            Object.fromEntries(
              (r.fields ?? [])
                .filter((f) => f.default !== undefined)
                .map((f) => [f.name, f.default]),
            ),
          );
        }
      },
      onError: (e) => setError(e.message),
    });

  // Sign in again (11-18): straight to that service's own setup, which goes on with Home
  // Assistant's waiting one.
  useEffect(() => {
    if (renew) run({ start: renew });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Home Assistant finishing on its own: ask again in a moment.
  useEffect(() => {
    if (step?.type !== "progress" || !step.flowId) return;
    const t = window.setTimeout(
      () => run({ handler: step.handler, flowId: step.flowId!, data: {} }),
      2000,
    );
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const needsApp =
    step?.type === "stopped" &&
    APPS[step.handler] &&
    /credential|configuration|oauth|application|missing/i.test(step.reason ?? "");

  return (
    <Modal
      title={
        what === "youtube" || youtubeOnly
          ? "Change YouTube Music account"
          : what === "music" && maLinked && !musicAssistant && !step
            ? "Add a music service"
            : musicAssistant
              ? "Set up Music Assistant"
              : choice
                ? `Connect ${choice.label}`
                : "Connect a service"
      }
      onCancel={onClose}
    >
      <div className="mt-3 space-y-3" data-testid="home-connect">
        {musicAssistant && (
          <MusicAssistantSetup
            service={service}
            onDone={onClose}
            youtubeOnly={what === "youtube" || youtubeOnly}
          />
        )}
        {error && (
          <p className="text-[0.88rem] text-amber" role="alert">
            {error}
          </p>
        )}
        {/* Music with Music Assistant linked to Hearth: every service it has, set up from here. */}
        {what === "music" && !step && !musicAssistant && maLinked && (
          <MusicServices
            onYoutube={() => {
              setYoutubeOnly(true);
              setMusicAssistant(true);
            }}
            onDone={onClose}
          />
        )}
        {!step && !musicAssistant && !(what === "music" && maLinked) && (
          <ul className="space-y-2">
            {CHOICES[what].map((c) => (
              <li key={c.handler}>
                <button
                  type="button"
                  className="w-full rounded-xl border border-line p-3 text-left hover:border-gold/60 disabled:opacity-50"
                  disabled={go.isPending}
                  onClick={() =>
                    c.handler === "music_assistant"
                      ? setMusicAssistant(true)
                      : run({ start: c.handler })
                  }
                  data-testid="home-connect-choice"
                  data-handler={c.handler}
                >
                  <span className="text-[0.95rem] text-ink">{c.label}</span>
                  <span className="mt-0.5 block text-[0.8rem] text-muted">{c.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {step?.type === "form" && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              run({ handler: step.handler, flowId: step.flowId!, data: values });
            }}
          >
            {choice && <p className="text-[0.84rem] text-muted">{choice.hint}</p>}
            {(step.fields ?? []).map((f) => {
              const err = step.errors?.[f.name] ?? (f.name === "base" ? undefined : undefined);
              const v = values[f.name];
              const set = (x: unknown) => setValues({ ...values, [f.name]: x });
              return (
                <label key={f.name} className="block text-[0.84rem] text-muted">
                  {f.type === "boolean" ? (
                    <span className="flex min-h-11 items-center gap-2 text-ink">
                      <input
                        type="checkbox"
                        checked={Boolean(v)}
                        onChange={(e) => set(e.target.checked)}
                      />
                      {words(f.name)}
                    </span>
                  ) : (
                    <>
                      {words(f.name)}
                      {f.required ? "" : " (optional)"}
                      {f.options ? (
                        <select
                          className={input}
                          value={String(v ?? "")}
                          onChange={(e) => set(e.target.value)}
                        >
                          <option value="">Choose</option>
                          {f.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className={input}
                          type={
                            f.secret
                              ? "password"
                              : f.type === "integer" || f.type === "float" || f.type === "number"
                                ? "number"
                                : "text"
                          }
                          autoComplete={f.secret ? "new-password" : "off"}
                          value={String(v ?? "")}
                          required={f.required}
                          onChange={(e) =>
                            set(
                              f.type === "integer" || f.type === "float" || f.type === "number"
                                ? Number(e.target.value)
                                : e.target.value,
                            )
                          }
                          data-testid={`home-connect-field-${f.name}`}
                        />
                      )}
                    </>
                  )}
                  {err && <span className="mt-0.5 block text-amber">{err.replace(/_/g, " ")}</span>}
                </label>
              );
            })}
            {step.errors?.base && (
              <p className="text-[0.84rem] text-amber" role="alert">
                Home Assistant said: {step.errors.base.replace(/_/g, " ")}
              </p>
            )}
            <Button
              type="submit"
              tone="primary"
              disabled={go.isPending}
              data-testid="home-connect-next"
            >
              {go.isPending ? "Checking..." : "Next"}
            </Button>
          </form>
        )}
        {step?.type === "external" && (
          <div className="space-y-3">
            <p className="text-[0.9rem] text-ink">
              Sign in on {choice?.label ?? "the service"}&apos;s own page, then come back.
            </p>
            {step.renewing && (
              <p className="text-[0.84rem] text-ok" data-testid="home-connect-renewing">
                This renews the connection you already have: everything you set up stays as it was.
              </p>
            )}
            {step.homeAddress && (
              <p className="text-[0.82rem] text-muted" data-testid="home-connect-address">
                If a My Home Assistant page asks for your Home Assistant&apos;s address, enter{" "}
                <Copy text={step.homeAddress} /> and press Save, then Link account. It asks once on
                each browser.
              </p>
            )}
            <p className="text-[0.82rem] text-muted">
              If it ends on &quot;This site can&apos;t be reached&quot;, that&apos;s fine: copy that
              page&apos;s address from the address bar and paste it below. Hearth finishes from
              there.
            </p>
            {step.notYet && (
              <p
                className="text-[0.84rem] text-amber"
                role="alert"
                data-testid="home-connect-not-yet"
              >
                Home Assistant hasn&apos;t heard back from that page yet. Finish signing in there
                (if it asks to link your account, check the address it shows is your Home
                Assistant&apos;s), then press this again.
              </p>
            )}
            <a
              href={step.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-gold px-4 text-[0.9rem] text-bg"
              data-testid="home-connect-signin"
            >
              Open the sign-in page <ExternalLink className="h-4 w-4" />
            </a>
            <Button
              disabled={go.isPending}
              onClick={() => run({ handler: step.handler, flowId: step.flowId!, data: {} })}
              data-testid="home-connect-signed-in"
            >
              I&apos;ve signed in
            </Button>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const v = new FormData(e.currentTarget).get("callback");
                if (typeof v === "string" && v.trim())
                  run({ handler: step.handler, flowId: step.flowId!, callback: v.trim() });
              }}
            >
              <input
                name="callback"
                className="min-h-11 min-w-0 flex-1 rounded-lg border border-line-strong bg-bg px-3 text-[0.85rem] text-ink focus:border-gold focus:outline-none"
                placeholder="Paste the address it ended on"
                aria-label="The address the sign-in ended on"
                autoComplete="off"
                data-testid="home-connect-callback"
              />
              <Button type="submit" disabled={go.isPending}>
                Finish
              </Button>
            </form>
          </div>
        )}
        {step?.type === "progress" && (
          <p className="text-[0.9rem] text-muted">Home Assistant is finishing...</p>
        )}
        {step?.type === "done" && (
          <div className="space-y-3" data-testid="home-connect-done">
            <p className="text-[0.95rem] text-ink">
              Connected: {step.title}. It shows on the dashboard in a moment.
            </p>
            <Button tone="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        )}
        {step?.type === "stopped" && !needsApp && (
          <div className="space-y-3">
            <p className="text-[0.9rem] text-amber" role="alert" data-testid="home-connect-stopped">
              Home Assistant stopped: {step.reason?.replace(/_/g, " ")}.
            </p>
            <Button onClick={() => setStep(undefined)}>Choose again</Button>
          </div>
        )}
        {needsApp && step && (
          <form
            className="space-y-3"
            data-testid="home-connect-app"
            onSubmit={(e) => {
              e.preventDefault();
              const body = fromVault
                ? { app: step.handler, vaultSecret: fromVault }
                : app
                  ? {
                      app: step.handler,
                      clientId: app.id.trim(),
                      clientSecret: app.secret.trim(),
                      ...(save ? { saveAs: `${choice?.label ?? step.handler} app sign-in` } : {}),
                    }
                  : undefined;
              if (!body) return;
              go.mutate(body, {
                onSuccess: () => {
                  setApp(undefined);
                  run({ start: step.handler });
                },
                onError: (er) => setError(er.message),
              });
            }}
          >
            <p className="text-[0.9rem] text-ink">
              {choice?.label} needs an app of your own first, so Home Assistant can sign in to it.
            </p>
            {step.handler === "google" ? (
              <GoogleAppGuide />
            ) : (
              <ol className="list-decimal space-y-1 pl-5 text-[0.84rem] text-muted">
                <li>
                  <a
                    href={APPS[step.handler]!.site}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-gold hover:underline"
                  >
                    {APPS[step.handler]!.where}
                  </a>
                  .
                </li>
                <li>
                  Add this redirect address: <code className="break-all text-ink">{REDIRECT}</code>
                </li>
                <li>
                  Copy its client ID and client secret here. They go to Home Assistant, not Hearth.
                </li>
              </ol>
            )}
            {vault.data && !vault.data.locked && (
              <label className="block text-[0.84rem] text-muted">
                From Secure Vault
                <select
                  className={input}
                  value={fromVault}
                  onChange={(e) => setFromVault(e.target.value)}
                  data-testid="home-app-vault"
                >
                  <option value="">Type them in below</option>
                  {vault.data.secrets
                    .filter((s) => s.kind === "oauth-app")
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {vault.data?.locked && (
              <p className="text-[0.8rem] text-faint">
                Secure Vault is locked, so its app sign-ins aren&apos;t listed here. You can type
                them below.
              </p>
            )}
            {!fromVault && (
              <>
                <label className="block text-[0.84rem] text-muted">
                  Client ID
                  <input
                    className={input}
                    autoComplete="off"
                    value={app?.id ?? ""}
                    onChange={(e) =>
                      setApp({
                        handler: step.handler,
                        id: e.target.value,
                        secret: app?.secret ?? "",
                      })
                    }
                    data-testid="home-app-id"
                  />
                </label>
                <label className="block text-[0.84rem] text-muted">
                  Client secret
                  <input
                    className={input}
                    type="password"
                    autoComplete="new-password"
                    value={app?.secret ?? ""}
                    onChange={(e) =>
                      setApp({ handler: step.handler, id: app?.id ?? "", secret: e.target.value })
                    }
                    data-testid="home-app-secret"
                  />
                </label>
                <label className="flex min-h-11 items-center gap-2 text-[0.84rem] text-muted">
                  <input
                    type="checkbox"
                    checked={save}
                    onChange={(e) => setSave(e.target.checked)}
                  />
                  Also keep them in Secure Vault
                </label>
              </>
            )}
            <Button
              type="submit"
              tone="primary"
              disabled={go.isPending || (!fromVault && (!app?.id || !app.secret))}
            >
              Give it to Home Assistant
            </Button>
          </form>
        )}
        <p className={cx("text-[0.76rem] text-faint", step?.type === "done" && "hidden")}>
          This uses Home Assistant&apos;s own setup. It is listed under Settings, Devices and
          services in Home Assistant afterwards.
        </p>
      </div>
    </Modal>
  );
}

/** A value to paste somewhere, with a Copy button. */
function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <code className="break-all text-ink">{text}</code>
      <button
        type="button"
        className="rounded-md border border-line px-2 py-0.5 text-[0.75rem] text-muted hover:text-ink"
        onClick={() =>
          void navigator.clipboard
            ?.writeText(text)
            .then(() => {
              setDone(true);
              window.setTimeout(() => setDone(false), 1500);
            })
            .catch(() => undefined)
        }
      >
        {done ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

/**
 * Google's app, a step at a time (11-05: "Why does it take a PhD to connect my Google
 * calendar", "I cannot find my secret", "Access blocked"). Each step opens the exact Google
 * Cloud page in a new tab, with every value to paste one Copy away. Published, not left in
 * Testing: Google signs a Testing app out after 7 days, which would stop the calendar weekly.
 */
function GoogleAppGuide() {
  const open = (href: string, label: string) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-gold hover:underline"
    >
      {label} <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
  return (
    <ol
      className="list-decimal space-y-2.5 pl-5 text-[0.84rem] text-muted"
      data-testid="google-guide"
    >
      <li>
        {open("https://console.cloud.google.com/projectcreate", "Make a Google Cloud project")}
        , named <Copy text="Hearth Home Assistant" />. Free; no card needed.
      </li>
      <li>
        {open(
          "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
          "Turn on the Google Calendar API",
        )}{" "}
        (press Enable).
      </li>
      <li>
        {open("https://console.cloud.google.com/auth/branding", "Set up the sign-in screen")}: app
        name <Copy text="Hearth" />, your email for support and contact, audience External. Google
        only lets you publish with a home page and privacy policy link: Application home page{" "}
        <Copy text="https://www.home-assistant.io" />, privacy policy link{" "}
        <Copy text="https://www.home-assistant.io/privacy/" />, authorized domain{" "}
        <Copy text="home-assistant.io" />. Leave the logo empty (a logo makes Google review the
        app). Press Save.
      </li>
      <li>
        {open("https://console.cloud.google.com/auth/audience", "Publish it")} (Publish app). Left
        in Testing, Google signs it out every 7 days. Publish app greyed out means the sign-in
        screen still misses the home page or privacy link. When you sign in later, Google says it
        hasn&apos;t checked the app: that&apos;s your own app, so press Advanced, then Go to Hearth.
        Published after you already signed in? Sign in again once: a sign-in made while it was in
        Testing still ends after 7 days.
      </li>
      <li>
        {open("https://console.cloud.google.com/auth/clients/create", "Make the app sign-in")}: type
        Web application, and under Authorized redirect URIs add <Copy text={REDIRECT} />. Press
        Create.
      </li>
      <li>
        Google shows the Client ID and Client secret once: paste both below now (Hearth keeps them
        in Secure Vault, so you never need to find them again).
      </li>
    </ol>
  );
}
