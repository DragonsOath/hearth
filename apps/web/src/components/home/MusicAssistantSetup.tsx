import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import { api } from "../../data/api";
import { Button } from "../ui";

/**
 * Setting up Music Assistant from Hearth (11-05): every sign-in opens on screen, and Hearth
 * does the rest. 1. Music Assistant's own sign-in page in a window; 2. Hearth finishes its setup
 * and adds it to Home Assistant; 3. YouTube Music: an ordinary Chrome window opens on this
 * computer for the YouTube sign-in (Google refuses remote-controlled browsers), and Done hands it
 * to Music Assistant. Nothing typed here but the address and the YouTube account's name.
 */

type Phase = "address" | "signin" | "linking" | "linked" | "youtube" | "channel" | "done";

interface Channel {
  id?: string;
  name: string;
  byline?: string;
  photo?: string;
}

const input =
  "mt-1 min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold focus:outline-none";

export function MusicAssistantSetup({
  service,
  onDone,
  youtubeOnly,
}: {
  service?: string;
  onDone: () => void;
  /** Change YouTube account: straight to YouTube Music, with the Music Assistant key Hearth keeps. */
  youtubeOnly?: boolean;
}) {
  const [address, setAddress] = useState(() =>
    typeof window === "undefined" ? "" : `http://${window.location.hostname}:8095`,
  );
  const [phase, setPhase] = useState<Phase>(youtubeOnly ? "linking" : "address");
  const [state, setState] = useState<string>();
  const [loginUrl, setLoginUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const win = useRef<Window | null>(null);

  // Change YouTube account: a setup with Hearth's own Music Assistant key, at the YouTube step.
  useEffect(() => {
    if (!youtubeOnly) return;
    let live = true;
    api<{ state: string; address: string }>("POST", "/api/home/music-assistant/youtube", {})
      .then((r) => {
        if (!live) return;
        setState(r.state);
        setAddress(r.address);
        setPhase("linked");
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [youtubeOnly]);

  const call = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  // Ends the setup (closes the YouTube window, forgets the session) when the dialog closes.
  const stateRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(
    () => () => {
      if (stateRef.current)
        void api("POST", `/api/home/music-assistant/${stateRef.current}`, { action: "end" }).catch(
          () => undefined,
        );
    },
    [],
  );

  const linkHomeAssistant = async (s: string) => {
    setPhase("linking");
    const r = await call(() =>
      api<{ type: string; reason?: string; errors?: Record<string, string>; youtube?: boolean }>(
        "POST",
        `/api/home/music-assistant/${s}`,
        { action: "home-assistant", ...(service ? { service } : {}) },
      ),
    );
    // YouTube Music already in Music Assistant: nothing more to ask.
    if (r?.type === "done") setPhase(r.youtube ? "done" : "linked");
    else {
      if (r)
        setError(
          `Home Assistant didn't finish: ${(r.reason ?? r.errors?.base ?? r.type).replace(/_/g, " ")}.`,
        );
      setPhase("signin");
    }
  };

  // Signed in: the window says so, or Hearth notices on its own.
  useEffect(() => {
    if (phase !== "signin" || !state) return;
    let stop = false;
    const check = async () => {
      const s = await api<{ signedIn: boolean }>("GET", `/api/home/music-assistant/${state}`).catch(
        () => undefined,
      );
      if (!stop && s?.signedIn) {
        stop = true;
        void linkHomeAssistant(state);
      }
    };
    const onMsg = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data?.hearth === "music-assistant-signed-in")
        void check();
    };
    window.addEventListener("message", onMsg);
    const t = window.setInterval(() => void check(), 2000);
    return () => {
      stop = true;
      window.removeEventListener("message", onMsg);
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, state]);

  const openSignIn = (url: string) => {
    win.current = window.open(url, "hearth-music-assistant", "popup,width=520,height=720");
  };

  return (
    <div className="space-y-3" data-testid="ma-setup">
      {error && (
        <p className="text-[0.88rem] text-amber" role="alert" data-testid="ma-error">
          {error}
        </p>
      )}
      {phase === "address" && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            // Opened now, while it is still a click, so the browser doesn't block it.
            win.current = window.open("", "hearth-music-assistant", "popup,width=520,height=720");
            void call(async () => {
              const r = await api<{ state: string; loginUrl: string; address: string }>(
                "POST",
                "/api/home/music-assistant/start",
                { address },
              );
              setState(r.state);
              setLoginUrl(r.loginUrl);
              setAddress(r.address);
              setPhase("signin");
              if (win.current && !win.current.closed) win.current.location.href = r.loginUrl;
              else openSignIn(r.loginUrl);
            }).then((r) => {
              if (r === undefined) win.current?.close();
            });
          }}
        >
          <p className="text-[0.86rem] text-muted">
            Hearth opens Music Assistant&apos;s sign-in in a window. Sign in there and Hearth does
            the rest: it finishes Music Assistant&apos;s setup, adds it to Home Assistant, then
            helps you add YouTube Music.
          </p>
          <label className="block text-[0.84rem] text-muted">
            Music Assistant&apos;s address
            <input
              className={input}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              data-testid="ma-address"
            />
          </label>
          <Button type="submit" tone="primary" disabled={busy} data-testid="ma-start">
            {busy ? "Checking..." : "Sign in to Music Assistant"}
          </Button>
        </form>
      )}
      {phase === "signin" && (
        <div className="space-y-3">
          <p className="text-[0.9rem] text-ink">
            Sign in to Music Assistant in the window that opened. Hearth carries on by itself when
            you do.
          </p>
          {loginUrl && (
            <Button onClick={() => openSignIn(loginUrl)} data-testid="ma-signin-again">
              Open the sign-in window again <ExternalLink className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
      {phase === "linking" && (
        <p className="text-[0.9rem] text-muted" data-testid="ma-linking">
          Signed in. Finishing Music Assistant&apos;s setup and adding it to Home Assistant...
        </p>
      )}
      {(phase === "linked" || phase === "youtube" || phase === "channel") && (
        <div className="space-y-3">
          {!youtubeOnly && (
            <p className="flex items-center gap-2 text-[0.92rem] text-ink" data-testid="ma-linked">
              <Check className="h-4 w-4 text-ok" /> Music Assistant is set up and in Home Assistant.
              Your speakers show on the dashboard in a moment.
            </p>
          )}
          {phase === "linked" ? (
            <div className="space-y-2">
              <p className="text-[0.86rem] text-muted">
                {youtubeOnly ? "Change YouTube Music's account" : "Add YouTube Music"}: Hearth opens
                a normal Chrome window on this computer, just for this. Sign in to YouTube Music
                there, then come back and press Done; you pick the channel after. (Music Assistant
                needs YouTube Music Premium.)
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  tone="primary"
                  disabled={busy}
                  data-testid="ma-youtube-open"
                  onClick={() =>
                    void call(async () => {
                      await api("POST", `/api/home/music-assistant/${state}`, {
                        action: "youtube-open",
                      });
                      setPhase("youtube");
                    })
                  }
                >
                  Open YouTube Music
                </Button>
                <Button onClick={onDone}>Not now</Button>
              </div>
            </div>
          ) : phase === "youtube" ? (
            <div className="space-y-3">
              <p className="text-[0.9rem] text-ink">
                A Chrome window opened with YouTube Music. Sign in there, then press Done here.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  tone="primary"
                  disabled={busy}
                  data-testid="ma-youtube-done"
                  onClick={() =>
                    void call(async () => {
                      const r = await api<
                        | { signedIn: false; message: string }
                        | { signedIn: true; channels: Channel[] }
                      >("POST", `/api/home/music-assistant/${state}`, { action: "youtube-read" });
                      if (!r.signedIn) return setError(r.message);
                      setChannels(r.channels);
                      setPhase("channel");
                    })
                  }
                >
                  {busy ? "Reading the sign-in..." : "Done, I signed in"}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void call(() =>
                      api("POST", `/api/home/music-assistant/${state}`, { action: "youtube-open" }),
                    )
                  }
                >
                  Open the window again
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3" data-testid="ma-channels">
              <p className="text-[0.9rem] text-ink">Which channel is your music on?</p>
              <div className="grid gap-2">
                {channels.map((ch) => (
                  <button
                    key={ch.id ?? "own"}
                    type="button"
                    disabled={busy}
                    className="flex min-h-14 items-center gap-3 rounded-lg border border-line-strong px-3 text-left hover:border-gold"
                    data-testid="ma-channel"
                    onClick={() =>
                      void call(async () => {
                        const r = await api<{ added: boolean; message?: string }>(
                          "POST",
                          `/api/home/music-assistant/${state}`,
                          {
                            action: "youtube-done",
                            channel: { ...(ch.id ? { id: ch.id } : {}), name: ch.name },
                          },
                        );
                        if (r.added) setPhase("done");
                        else setError(r.message ?? "YouTube Music wasn't added.");
                      })
                    }
                  >
                    {ch.photo ? (
                      <img
                        src={ch.photo}
                        alt=""
                        className="h-9 w-9 rounded-full"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span className="grid h-9 w-9 place-items-center rounded-full bg-gold/20 text-gold">
                        {ch.name.slice(0, 2).toUpperCase()}
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-[0.92rem] text-ink">{ch.name}</span>
                      <span className="block truncate text-[0.78rem] text-muted">
                        {ch.id ? "Brand channel" : "Your own channel"}
                        {ch.byline ? ` · ${ch.byline}` : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-[0.78rem] text-faint">
                This replaces the YouTube Music account in Music Assistant, so your library is one
                account, not two mixed. It syncs again in a few minutes.
              </p>
            </div>
          )}
        </div>
      )}
      {phase === "done" && (
        <div className="space-y-3" data-testid="ma-done">
          <p className="flex items-center gap-2 text-[0.95rem] text-ink">
            <Check className="h-4 w-4 text-ok" />{" "}
            {youtubeOnly
              ? "YouTube Music is on that channel now. Your Media page shows its rows in a moment."
              : "Music Assistant is set up, with YouTube Music. Your music is on the Media page."}
          </p>
          <Button tone="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      )}
    </div>
  );
}
