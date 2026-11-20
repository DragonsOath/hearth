import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: { endpoint: string; payload: string }[] = [];
let answer: (endpoint: string) => number = () => 201;

vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "BPUB", privateKey: "PRIV" }),
    sendNotification: async (sub: { endpoint: string }, payload: string) => {
      const status = answer(sub.endpoint);
      if (status >= 300) throw Object.assign(new Error("push failed"), { statusCode: status });
      sent.push({ endpoint: sub.endpoint, payload });
      return { statusCode: status };
    },
  },
}));

const { pushEndpointAllowed, sendPush, newPushKeys } = await import("./push");

const device = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: "p".repeat(40), auth: "a".repeat(16) },
  name: "Chrome on Android",
  addedAt: "2026-11-13T00:00:00Z",
});
const msg = { title: "Disk almost full", lines: ["Media is 91% full."], severity: "warning" };

describe("browser push", () => {
  beforeEach(() => {
    sent.length = 0;
    answer = () => 201;
  });

  it("sends only to the browsers' own push services", () => {
    expect(pushEndpointAllowed("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(pushEndpointAllowed("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(pushEndpointAllowed("https://web.push.apple.com/QF")).toBe(true);
    expect(pushEndpointAllowed("https://wns2-db5p.notify.windows.com/w/?token=x")).toBe(true);
    // Never another address a page could hand Hearth (it would make Hearth call it).
    expect(pushEndpointAllowed("https://evil.example.com/fcm.googleapis.com")).toBe(false);
    expect(pushEndpointAllowed("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(pushEndpointAllowed("https://192.168.1.10/push")).toBe(false);
    expect(pushEndpointAllowed("not a url")).toBe(false);
  });

  it("sends to every device, drops the ones the browser forgot, and says why when none got it", async () => {
    expect(newPushKeys()).toEqual({ publicKey: "BPUB", privateKey: "PRIV" });
    const a = "https://fcm.googleapis.com/fcm/send/a";
    const b = "https://fcm.googleapis.com/fcm/send/b";
    answer = (e) => (e === b ? 410 : 201);
    const gone = await sendPush(
      { publicKey: "BPUB", privateKey: "PRIV", devices: [device(a), device(b)] },
      { ...msg, link: "https://hearth.local/notifications" },
      "https://hearth.dragonsoath.com",
    );
    expect(gone).toEqual([b]);
    expect(sent.map((s) => s.endpoint)).toEqual([a]);
    expect(JSON.parse(sent[0]!.payload)).toEqual({
      title: "Disk almost full",
      body: "Media is 91% full.",
      severity: "warning",
      url: "https://hearth.local/notifications",
    });
    answer = () => 410;
    await expect(
      sendPush({ publicKey: "BPUB", privateKey: "PRIV", devices: [device(a)] }, msg, "https://x"),
    ).rejects.toThrow(/Turn it on again on a device/);
    await expect(
      sendPush({ publicKey: "BPUB", privateKey: "PRIV", devices: [] }, msg, "https://x"),
    ).rejects.toThrow(/No device has browser push/);
  });
});
