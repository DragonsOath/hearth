import { useState, type ReactNode } from "react";
import { Check, Laptop, MonitorSmartphone, Server, Speaker } from "lucide-react";
import { ApiError } from "../../data/api";
import { pairLink, useDeviceCode } from "../../data/devices";
import { useHostSpeaker, useSetHostSpeaker, useSpeakerReady } from "../../data/home";
import { OpenNetwork } from "../devices/OpenNetwork";
import { ConfirmIdentity } from "../../pages/auth/ConfirmIdentity";
import { Modal } from "../workspace/dialogs";
import type { Ctx } from "./parts";
import { startSpeakerHere, stopSpeakerHere, useSpeakerHere } from "./speakerHere";
import { SpeakerChoice } from "./SpeakerChoice";

/**
 * Speakers (11-06: "What is this mess", "Idk how to use this"): a short list. The speakers
 * there are now (tap one to play on it), then three ways to add one, each one line and one
 * button: this computer, another computer or phone (a link it opens; the PC you remote desktop
 * from), and the Hearth computer itself (on by itself).
 */
export function AddSpeaker({ c, onClose }: { c: Ctx; onClose: () => void }) {
  const ready = useSpeakerReady();
  const linked = ready.data?.linked;
  return (
    <Modal title="Speakers" onCancel={onClose}>
      <div className="mt-3 space-y-4" data-testid="home-add-speaker">
        <div className="space-y-1.5">
          {c.d.music.length ? (
            c.d.music.map((x) => {
              const on = x.entity === c.keep.speaker;
              return (
                <SpeakerChoice
                  key={x.entity}
                  x={x}
                  className="hd-spk-line"
                  pressed={on}
                  onPick={() => {
                    c.keep.setSpeaker(x.entity);
                    onClose();
                  }}
                >
                  <Speaker size={16} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{x.name}</span>
                  <span className="text-[0.76rem] text-muted">
                    {x.state === "playing" ? "playing" : x.state === "off" ? "off" : ""}
                  </span>
                  {on && <Check size={16} aria-label="Plays here now" />}
                </SpeakerChoice>
              );
            })
          ) : (
            <p className="text-[0.85rem] text-muted">No speakers yet.</p>
          )}
        </div>

        <div>
          <p className="mb-2 text-[0.78rem] tracking-wide text-faint uppercase">Add a speaker</p>
          {ready.isPending ? (
            <p className="text-[0.85rem] text-muted">Checking…</p>
          ) : !linked ? (
            <Option
              icon={<Speaker size={18} />}
              title="Link Music Assistant first"
              hint="Then computers and phones can be speakers too."
            >
              {!c.d.tablet && (
                <button
                  type="button"
                  className="hd-pill hd-pill-sm"
                  onClick={() => {
                    onClose();
                    c.connect("music");
                  }}
                >
                  Link
                </button>
              )}
            </Option>
          ) : (
            <div className="space-y-2">
              <ThisDevice />
              {!c.d.tablet && <OtherComputer />}
              {!c.d.tablet && <HearthComputer />}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** One way to add a speaker: an icon, a name, one line, one button. */
function Option({
  icon,
  title,
  hint,
  children,
  testId,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="hd-spk-card" data-testid={testId}>
      <div className="flex items-center gap-3">
        <span className="flex-none text-gold">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[0.92rem] text-ink">{title}</p>
          <p className="text-[0.78rem] text-muted">{hint}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function ThisDevice() {
  const here = useSpeakerHere();
  // Opened on the Hearth computer itself: over remote desktop the sound stutters.
  const onServer = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  return (
    <Option
      icon={<Laptop size={18} />}
      title="This computer"
      hint={
        here.error ??
        (here.on
          ? here.playing
            ? `Playing here as ${here.name}.`
            : `Ready: pick "${here.name}" above.`
          : onServer
            ? "On remote desktop? Use Another computer instead."
            : "Plays while this page stays open.")
      }
      testId="home-speaker-here"
    >
      {here.on || here.connecting ? (
        <button type="button" className="hd-pill hd-pill-sm" onClick={stopSpeakerHere}>
          {here.connecting ? "Connecting…" : "Stop"}
        </button>
      ) : (
        <button
          type="button"
          className="hd-pill hd-pill-sm hd-on"
          onClick={() => void startSpeakerHere()}
          data-testid="home-speaker-start"
        >
          Play here
        </button>
      )}
    </Option>
  );
}

/** Another computer or phone: a link (and QR) it opens to become a speaker. */
function OtherComputer() {
  const make = useDeviceCode();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = (text: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  // The link is copied straight away (remote desktop shares the clipboard with the PC you sit at).
  const start = () =>
    make.mutate("home", {
      onSuccess: (d) => {
        const a = d.addresses[0]?.url ?? window.location.origin;
        void copy(`${pairLink(a, d.code)}&next=speaker`);
      },
      onError: (e) => {
        if (e instanceof ApiError && e.status === 403) setConfirming(true);
      },
    });
  const data = make.data;
  const address = data?.addresses[0];
  // Without a home network address, only a browser on this computer can open it.
  const link = data
    ? `${pairLink(address?.url ?? window.location.origin, data.code)}&next=speaker`
    : undefined;
  return (
    <div data-testid="home-speaker-other">
      <Option
        icon={<MonitorSmartphone size={18} />}
        title="Another computer or phone"
        hint="Like the PC you remote desktop from: copy a link, open it in that PC's browser."
      >
        {!data && !confirming && (
          <button
            type="button"
            className="hd-pill hd-pill-sm"
            onClick={start}
            disabled={make.isPending}
            data-testid="home-speaker-link"
          >
            {make.isPending ? "…" : "Copy link"}
          </button>
        )}
      </Option>
      {confirming && (
        <div className="mt-2">
          <ConfirmIdentity
            reason="Confirm it's you to add a speaker."
            onConfirmed={() => {
              setConfirming(false);
              start();
            }}
          />
        </div>
      )}
      {data && link && (
        <div className="hd-spk-card mt-2">
          {data.addresses.length === 0 && (
            <div className="mb-2 text-[0.8rem] text-amber">
              <p>Other computers can't reach this Hearth yet.</p>
              <OpenNetwork what="devices" onOpen={start} />
            </div>
          )}
          <ol className="list-decimal space-y-1 pl-5 text-[0.84rem] text-ink">
            <li>
              {copied ? "The link is copied." : "Copy the link:"}{" "}
              <button type="button" className="text-gold underline" onClick={() => void copy(link)}>
                {copied ? "Copy again" : "Copy"}
              </button>
            </li>
            <li>On the other PC, open Chrome there (not inside remote desktop).</li>
            <li>Paste the link in the address bar and press Enter.</li>
            <li>Press Play here. Its speakers show in this list.</li>
          </ol>
          <p className="mt-2 break-all text-[0.74rem] text-faint" data-testid="home-speaker-url">
            {link}
          </p>
          <p className="text-[0.74rem] text-faint">Works once, for 10 minutes.</p>
        </div>
      )}
      {make.error && !confirming && (
        <p className="mt-2 text-[0.8rem] text-amber" role="alert">
          {make.error.message}
        </p>
      )}
    </div>
  );
}

/** The computer Hearth runs on, as a speaker by itself (no page needs to stay open). */
function HearthComputer() {
  const q = useHostSpeaker();
  const set = useSetHostSpeaker();
  const s = q.data;
  if (!s) return null;
  const words: Record<typeof s.state, string> = {
    off: "Off.",
    connecting: "Connecting…",
    ready: `On: pick "${s.name}" above.`,
    playing: `Playing as "${s.name}".`,
    "no-sound": "This computer has no sound output Hearth can use.",
    "not-linked": "Waiting for Music Assistant.",
    error: "It couldn't connect; Hearth keeps trying.",
  };
  return (
    <Option
      icon={<Server size={18} />}
      title="The Hearth computer"
      hint={words[s.state]}
      testId="home-speaker-host"
    >
      <button
        type="button"
        className={`hd-pill hd-pill-sm${s.on ? "" : " hd-on"}`}
        disabled={set.isPending}
        onClick={() => set.mutate({ on: !s.on })}
        data-testid="home-speaker-host-toggle"
      >
        {s.on ? "Turn off" : "Turn on"}
      </button>
    </Option>
  );
}

/** While this page is a speaker: a small reminder with Stop (it must stay open). */
export function SpeakerHereBar({ onOpen }: { onOpen: () => void }) {
  const here = useSpeakerHere();
  if (!here.on && !here.connecting) return null;
  return (
    <div className="hd-spk-bar" role="status" data-testid="home-speaker-bar">
      <Speaker size={16} />
      <button type="button" onClick={onOpen}>
        {here.connecting
          ? "Connecting speaker…"
          : here.needsTap
            ? `Speaker: ${here.name} · tap to turn on sound`
            : `Speaker: ${here.name}`}
      </button>
      <button type="button" onClick={stopSpeakerHere} aria-label="Stop playing here">
        Stop
      </button>
    </div>
  );
}
