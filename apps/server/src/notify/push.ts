import webpush from "web-push";

/**
 * Browser push (11-13, Talome Gap Plan item 4): Hearth's messages as notifications on the devices
 * you turn it on for (a phone with Hearth on its home screen, a desktop browser), with no
 * account anywhere. Standard Web Push: Hearth signs with its own keys (VAPID), made once, and each
 * device's subscription says where its browser's push service is.
 *
 * Everything lives in the channel's one vault entry: Hearth's keys and the devices. A device whose
 * browser forgot it (404 or 410) is dropped on the next send.
 *
 * The browser hands Hearth the address to send to, so only the browsers' own push services are
 * accepted, never any other address (tests add a local one with DC_TEST_PUSH).
 */

export interface PushDevice {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  name: string;
  addedAt: string;
}

export interface PushVault {
  publicKey: string;
  privateKey: string;
  devices: PushDevice[];
}

const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
  /\.push\.apple\.com$/,
];

/** Is this an address of a browser's push service (https, a known host)? */
export function pushEndpointAllowed(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (process.env.DC_TEST_PUSH === "1" && u.hostname === "127.0.0.1") return true;
  return u.protocol === "https:" && PUSH_HOSTS.some((h) => h.test(u.hostname));
}

/** New keys for this Hearth (made once, when push is first turned on). */
export function newPushKeys(): Pick<PushVault, "publicKey" | "privateKey"> {
  return webpush.generateVAPIDKeys();
}

export function readPushVault(secret: string | undefined): PushVault | undefined {
  if (!secret) return undefined;
  try {
    const v = JSON.parse(secret) as PushVault;
    return v.publicKey && v.privateKey && Array.isArray(v.devices) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sends one notification to every device. Returns the endpoints the browsers no longer know (to
 * drop); throws only when no device got it.
 */
export async function sendPush(
  vault: PushVault,
  message: { title: string; lines: string[]; severity: string; link?: string },
  subject: string,
): Promise<string[]> {
  const payload = JSON.stringify({
    title: message.title.slice(0, 120),
    body: message.lines.join("\n").slice(0, 600),
    severity: message.severity,
    url: message.link ?? "/",
  });
  const gone: string[] = [];
  let sent = 0;
  let lastError = "";
  for (const d of vault.devices) {
    if (!pushEndpointAllowed(d.endpoint)) continue;
    try {
      await webpush.sendNotification({ endpoint: d.endpoint, keys: d.keys }, payload, {
        vapidDetails: { subject, publicKey: vault.publicKey, privateKey: vault.privateKey },
        TTL: 24 * 60 * 60,
        urgency: message.severity === "critical" ? "high" : "normal",
        timeout: 10_000,
      });
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) gone.push(d.endpoint);
      else
        lastError = status
          ? `the push service answered ${status}`
          : "the push service did not answer";
    }
  }
  if (!sent) {
    if (!vault.devices.length) throw new Error("No device has browser push turned on.");
    if (gone.length === vault.devices.length)
      throw new Error("Every device that had push turned it off. Turn it on again on a device.");
    throw new Error(`No device got it: ${lastError || "nothing answered"}.`);
  }
  return gone;
}
