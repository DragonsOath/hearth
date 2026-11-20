import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { homeRanges, realSetupDeps, VoiceAssist } from "./assist";
import { Voice, type SpeechClient } from "./service";

/** Voice set up from Hearth's pages: finding speech services, using one, installing here. */

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

/** Speech services that answer only at the addresses given, like real ones on a network. */
function network(answers: Record<string, { tts?: string[]; stt?: boolean }>): SpeechClient {
  return {
    async describe({ host, port }) {
      const a = answers[host];
      if (!a) throw new Error("no answer");
      if (port === 10200 && a.tts)
        return {
          asr: [],
          tts: [{ name: "piper", voices: a.tts.map((name) => ({ name, installed: true })) }],
        };
      if (port === 10300 && a.stt)
        return { asr: [{ name: "whisper", models: [{ name: "small-int8" }] }], tts: [] };
      throw new Error("no answer");
    },
    transcribe: async () => "",
    synthesize: async () => ({ audio: Buffer.alloc(0), rate: 22050, width: 2, channels: 1 }),
  };
}

async function setup(
  answers: Record<string, { tts?: string[]; stt?: boolean }>,
  install?: ConstructorParameters<typeof VoiceAssist>[3]["install"],
) {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  const client = network(answers);
  const voice = new Voice(handle, { client });
  const assist = new VoiceAssist(handle, voice, client, {
    dataDir: process.cwd(),
    setup: realSetupDeps(SERVER_ROOT),
    candidates: async () => [
      { host: "127.0.0.1", name: "This computer" },
      { host: "192.168.1.60", name: "Gaming-PC" },
      { host: "192.168.1.20" },
    ],
    ...(install ? { install } : {}),
  });
  return { assist, voice };
}

describe("finding speech services", () => {
  it("offers only real ones, best first, counting Hearth's own voices", async () => {
    const { assist } = await setup({
      "192.168.1.20": { tts: ["en_US-lessac-medium"] },
      "192.168.1.60": {
        tts: ["en_US-warden-medium", "en_US-operator-medium", "en_US-lessac-medium"],
        stt: true,
      },
    });
    const found = await assist.find();
    expect(found.map((f) => f.host)).toEqual(["192.168.1.60", "192.168.1.20"]);
    expect(found[0]).toMatchObject({
      name: "Gaming-PC",
      stt: { port: 10300 },
      tts: { voices: 3, hearthVoices: 2 },
    });
  });

  it("uses one only if it still answers, keeping the voice profiles", async () => {
    const { assist, voice } = await setup({ "192.168.1.60": { tts: ["x"], stt: true } });
    const before = (await voice.config()).profiles.length;
    await assist.use("192.168.1.60");
    expect((await voice.config()).host).toBe("192.168.1.60");
    expect((await voice.config()).profiles.length).toBe(before);
    await expect(assist.use("192.168.1.99")).rejects.toThrow(/No speech service answers/);
    await expect(assist.use("bad host;rm")).rejects.toThrow(/Not a usable address/);
  });

  it("knows the home network from this machine's own addresses, not Docker's", () => {
    const ranges = homeRanges({
      eth0: [{ address: "192.168.1.77", family: "IPv4", internal: false } as never],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false } as never],
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      tailscale0: [{ address: "100.64.0.5", family: "IPv4", internal: false } as never],
    });
    expect(ranges).toEqual(["192.168.1"]);
  });
});

describe("setting voice up on this computer", () => {
  it("reports each step, then switches voice on", async () => {
    const { assist, voice } = await setup(
      { "127.0.0.1": { tts: ["x"], stt: true } },
      async (say) => {
        say("Downloading the voices", "en_US-warden-medium.onnx: downloaded and checked");
        return { host: "127.0.0.1" };
      },
    );
    const started = await assist.install();
    expect(started.status).toBe("running");
    await expect.poll(async () => (await assist.state()).install.status).toBe("done");
    expect((await voice.config()).host).toBe("127.0.0.1");
  });

  it("says what went wrong when it fails", async () => {
    const { assist } = await setup({}, async () => {
      throw new Error("The voices could not all be downloaded: no internet.");
    });
    await assist.install();
    await expect.poll(async () => (await assist.state()).install.status).toBe("failed");
    const s = await assist.state();
    expect(s.install.status === "failed" && s.install.detail).toMatch(/no internet/);
  });
});
