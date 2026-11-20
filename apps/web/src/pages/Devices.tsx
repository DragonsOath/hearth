import { LayoutCopySection } from "../components/devices/LayoutCopy";
import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { Button, PageHeader, Panel, Section } from "../components/ui";
import { QrCode } from "../components/devices/QrCode";
import { ApiError } from "../data/api";
import { useDevices } from "../data/auth";
import { pairLink, useDeviceCode } from "../data/devices";
import { ConfirmIdentity } from "./auth/ConfirmIdentity";
import { Devices } from "./auth/Security";
import { PcsSection } from "../components/devices/Pcs";
import { OpenNetwork } from "../components/devices/OpenNetwork";

/**
 * PCs and devices (docs/design/ONE_ACCOUNT.md): every PC in your Hearth and every device signed
 * in to it, with Add, Remove and Uninstall.
 */
export function DevicesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Your account"
        title="PCs and devices"
        subtitle="Every PC in your Hearth and every phone, tablet or browser signed in to it. Add one, or remove one, from any device."
      />
      <DevicesContent />
    </>
  );
}

/** The PCs and the devices, on their own page and in Settings. */
export function DevicesContent() {
  return (
    <>
      <PcsSection />
      <LayoutCopySection />
      <Section title="Devices">
        <ThisApp />
        <AddDevice />
        <Devices />
      </Section>
    </>
  );
}

/** Add a device: a QR code (and a short code) that signs one phone, tablet or browser in. */
function AddDevice() {
  const make = useDeviceCode();
  // A home tablet (11-04) opens the home dashboard only; ?add=home picks it.
  const [kind, setKind] = useState<"device" | "home">(() =>
    new URLSearchParams(window.location.search).get("add") === "home" ? "home" : "device",
  );
  const [confirming, setConfirming] = useState(false);
  const [pick, setPick] = useState(0);
  const [madeAt, setMadeAt] = useState("");
  const devices = useDevices();
  const showing = Boolean(make.data);
  // While the code shows, watch for the new device to appear.
  useEffect(() => {
    if (!showing) return;
    const refetch = devices.refetch;
    const t = window.setInterval(() => void refetch(), 3000);
    return () => window.clearInterval(t);
  }, [showing, devices.refetch]);
  const start = () =>
    make.mutate(kind, {
      onSuccess: () => setMadeAt(new Date().toISOString()),
      onError: (e) => {
        if (e instanceof ApiError && e.status === 403) setConfirming(true);
      },
    });
  const data = make.data;
  const address = data?.addresses[pick] ?? data?.addresses[0];
  const signedIn = data
    ? devices.data?.devices.find(
        (d) => (d.method === "paired" || d.method === "home") && d.signedInAt >= madeAt,
      )
    : undefined;

  return (
    <Panel className="mb-6 p-5">
      <div className="flex flex-wrap items-start gap-4" data-testid="add-device">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-gold/40 bg-gold/10 text-gold">
          <Smartphone strokeWidth={1.5} className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[0.95rem] text-ink">Add a device</p>
          <p className="mt-1 max-w-xl text-[0.82rem] leading-relaxed text-muted">
            Sign in a phone, tablet, or the Hearth app with a QR code. Scan it with the app, or with
            the device's camera. It works once, for 10 minutes. The Hearth app for Android is on the
            releases page (the newest release that has it):{" "}
            <a
              className="text-gold underline"
              href="https://github.com/DragonsOath/hearth/releases"
              target="_blank"
              rel="noreferrer"
            >
              get hearth-android.apk
            </a>
            .
          </p>
          {confirming ? (
            <div className="mt-4 max-w-md">
              <ConfirmIdentity
                reason="Confirm it's you to add a device."
                onConfirmed={() => {
                  setConfirming(false);
                  start();
                }}
              />
            </div>
          ) : !data ? (
            <>
              <div
                role="radiogroup"
                aria-label="What it is"
                className="mt-4 flex flex-wrap gap-2"
                data-testid="add-device-kind"
              >
                {(
                  [
                    ["device", "A phone, tablet or browser (all of Hearth)"],
                    ["home", "A home tablet (the home dashboard only)"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kind === k}
                    onClick={() => setKind(k)}
                    className={
                      kind === k
                        ? "min-h-10 rounded-full border border-gold bg-gold/15 px-3 text-[0.84rem] text-gold"
                        : "min-h-10 rounded-full border border-line px-3 text-[0.84rem] text-muted hover:text-ink"
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              {kind === "home" && (
                <p className="mt-2 max-w-xl text-[0.8rem] text-muted">
                  A home tablet shows the home dashboard full screen: music, the calendar, lists,
                  lights, cameras and doors. It cannot reach the rest of Hearth, Ember, plans or the
                  vault, and opening a door asks for the unlock PIN.
                </p>
              )}
              <Button className="mt-4" tone="primary" onClick={start} disabled={make.isPending}>
                {make.isPending ? "Making a code…" : "Show a QR code"}
              </Button>
            </>
          ) : null}
          {make.error && !confirming && (
            <p role="alert" className="mt-3 text-[0.85rem] text-bad">
              {make.error.message}
            </p>
          )}
          {data && data.addresses.length === 0 && <OpenNetwork what="devices" onOpen={start} />}
          {data && (
            <div className="mt-5 flex flex-wrap items-start gap-6">
              {address && (
                <QrCode
                  text={pairLink(address.url, data.code)}
                  label={`QR code to sign a device in to Hearth at ${address.url}`}
                />
              )}
              <div className="min-w-0 flex-1 space-y-3 text-[0.85rem]">
                {data.addresses.length > 1 && (
                  <div
                    role="group"
                    aria-label="Which address the device uses"
                    className="flex flex-wrap gap-2"
                  >
                    {data.addresses.map((a, i) => (
                      <button
                        key={a.url}
                        type="button"
                        aria-pressed={i === pick}
                        onClick={() => setPick(i)}
                        className={
                          i === pick
                            ? "min-h-9 rounded-full border border-gold bg-gold/15 px-3 text-gold"
                            : "min-h-9 rounded-full border border-line px-3 text-muted hover:text-ink"
                        }
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-muted">
                  {address ? "Or open " : "In another browser on this PC, open "}
                  <span className="text-ink">
                    {address?.url ?? window.location.origin}/pair
                  </span>{" "}
                  and type this code:
                </p>
                <p
                  className="font-mono text-[1.6rem] tracking-[0.2em] text-gold"
                  data-testid="device-code"
                >
                  {data.code}
                </p>
                <p className="text-faint">
                  {signedIn
                    ? `Signed in: ${signedIn.device}.`
                    : "When the device signs in, it shows up in the list below."}
                </p>
                <Button tone="outline" onClick={() => make.reset()}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** Inside the Hearth app for Android: disconnect it from this Hearth (it forgets the sign-in). */
function ThisApp() {
  const app = (window as { HearthApp?: { disconnect(): void; version(): string } }).HearthApp;
  if (!app) return null;
  return (
    <Panel className="mb-6 flex flex-wrap items-center gap-3 p-5">
      <p className="min-w-0 flex-1 text-[0.88rem] text-muted" data-testid="this-app">
        You're in the Hearth app ({app.version()}). Disconnecting signs it out and forgets this
        Hearth; uninstall it like any other app.
      </p>
      <Button tone="outline" onClick={() => app.disconnect()}>
        Disconnect this app
      </Button>
    </Panel>
  );
}
