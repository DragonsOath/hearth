import { afterEach, describe as group, expect, it } from "vitest";
import type net from "node:net";
import path from "node:path";
import { openDatabase, runMigrations } from "../db/client";
import { SERVER_ROOT } from "../config";
import { describe, synthesize } from "./wyoming";
import { serveWyomingTts, VoiceShare } from "./share";

const tone = (text: string) => ({
  audio: Buffer.alloc(text.length * 2400, 1),
  rate: 24000,
  width: 2,
  channels: 1,
});

const open: net.Server[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

group("Hearth's voice for Home Assistant (Wyoming)", () => {
  it("answers describe with Hearth's Standard voice, and synthesize with its audio", async () => {
    const spoken: string[] = [];
    const server = await serveWyomingTts({
      host: "127.0.0.1",
      port: 0,
      version: "test",
      speak: async (text) => {
        spoken.push(text);
        return tone(text);
      },
    });
    open.push(server);
    const port = (server.address() as net.AddressInfo).port;
    // The same calls Home Assistant's Wyoming integration makes.
    const info = await describe({ host: "127.0.0.1", port });
    expect(info.tts[0]?.name).toBe("hearth");
    expect(info.tts[0]?.voices.map((v) => v.name)).toEqual(["af_heart"]);
    const pcm = await synthesize({ host: "127.0.0.1", port }, "The porch light is on.", "af_heart");
    expect(spoken).toEqual(["The porch light is on."]);
    expect(pcm.rate).toBe(24000);
    expect(pcm.audio.length).toBe("The porch light is on.".length * 2400);
  });

  it("is off until the owner turns it on, remembers it, and stops when turned off", async () => {
    const handle = openDatabase(":memory:");
    await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
    const share = new VoiceShare(handle, {
      port: 0,
      host: "127.0.0.1",
      version: "test",
      speak: async (t) => tone(t),
    });
    expect(await share.state()).toMatchObject({ on: false, listening: false });
    const on = await share.set(true);
    expect(on).toMatchObject({ on: true, listening: true, problem: null });
    expect((await describe({ host: "127.0.0.1", port: on.port })).tts[0]?.name).toBe("hearth");
    // A restart picks it up again.
    const again = new VoiceShare(handle, {
      port: 0,
      host: "127.0.0.1",
      version: "test",
      speak: async (t) => tone(t),
    });
    await again.resume();
    expect((await again.state()).listening).toBe(true);
    await again.close();
    expect(await share.set(false)).toMatchObject({ on: false, listening: false });
  });
});
