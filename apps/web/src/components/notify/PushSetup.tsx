import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../data/api";
import { Button } from "../ui";

/**
 * Browser push, turned on per device (11-13): this browser asks for permission, subscribes with
 * Hearth's key, and Hearth's messages arrive as notifications, even with Hearth closed. On a phone
 * it works with Hearth added to the home screen (iPhone needs that; Android works in Chrome too).
 */

const supported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

function keyBytes(base64url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone or iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : "this device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "browser";
  return `${browser} on ${os}`;
}

export function PushSetup() {
  const qc = useQueryClient();
  const [state, setState] = useState<"checking" | "on" | "off" | "blocked" | "unsupported">(() =>
    !supported() || !window.isSecureContext
      ? "unsupported"
      : Notification.permission === "denied"
        ? "blocked"
        : "checking",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Asked once, on the first show: does this browser already have Hearth's push?
  const check = useRef(state === "checking");
  useEffect(() => {
    if (!check.current) return;
    void navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then(async (sub) => {
        if (!sub) return setState("off");
        const r = await api<{ thisDevice: boolean }>(
          "GET",
          `/api/notifications/push?endpoint=${encodeURIComponent(sub.endpoint)}`,
        );
        setState(r.thisDevice ? "on" : "off");
      })
      .catch(() => setState("off"));
  }, []);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["workspace"] });

  const turnOn = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const { publicKey } = await api<{ publicKey: string }>("GET", "/api/notifications/push");
      const reg = await navigator.serviceWorker.ready;
      const old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe().catch(() => undefined);
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey) as BufferSource,
      });
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await api("POST", "/api/notifications/push", { subscription: json, name: deviceName() });
      setState("on");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api("DELETE", `/api/notifications/push?endpoint=${encodeURIComponent(sub.endpoint)}`);
        await sub.unsubscribe().catch(() => undefined);
      }
      setState("off");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="push-setup">
      {state === "unsupported" ? (
        <span className="max-w-xs text-[0.78rem] text-faint" data-testid="push-unsupported">
          This browser can&apos;t get notifications from here. It needs a secure (https) address,
          such as your Tailscale one; on an iPhone, add Hearth to the home screen first.
        </span>
      ) : state === "blocked" ? (
        <span className="max-w-xs text-[0.78rem] text-faint">
          Notifications are blocked for Hearth in this browser. Allow them in the browser&apos;s
          site settings, then come back.
        </span>
      ) : state === "on" ? (
        <Button tone="quiet" onClick={() => void turnOff()} disabled={busy}>
          Turn off for this device
        </Button>
      ) : (
        <Button onClick={() => void turnOn()} disabled={busy || state === "checking"}>
          Turn on for this device
        </Button>
      )}
      {error && (
        <span className="text-[0.8rem] text-bad" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
