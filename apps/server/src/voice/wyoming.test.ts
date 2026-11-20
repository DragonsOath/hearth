import { afterEach, describe, expect, it } from "vitest";
import { speakableText } from "@dragon-control/core";
import {
  describe as wyDescribe,
  encodeEvent,
  eventReader,
  synthesize,
  transcribe,
  wav,
} from "./wyoming";
import { fakeWyoming } from "./fake-wyoming";

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

describe("Wyoming client", () => {
  it("describes, transcribes, and synthesizes over the real protocol", async () => {
    const s = await fakeWyoming();
    servers.push(s);
    const target = { host: "127.0.0.1", port: s.port };
    const info = await wyDescribe(target);
    expect(info.asr[0]!.models[0]!.name).toBe("small.en");
    expect(info.tts[0]!.voices.map((v) => v.name)).toContain("en_US-belle-medium");

    const pcm = { audio: Buffer.alloc(16000 * 2 * 2), rate: 16000, width: 2, channels: 1 };
    expect(await transcribe(target, pcm)).toBe("Restart Plex please.");
    expect(s.heard).toEqual([{ bytes: 64000, rate: 16000 }]);

    const out = await synthesize(target, "Hello", "en_US-warden-medium");
    expect(out.audio).toHaveLength(8820);
    expect(out.rate).toBe(22050);
    expect(s.spoken).toEqual([{ text: "Hello", voice: "en_US-warden-medium" }]);
    // A voice the machine does not have: no audio, never a different voice.
    expect((await synthesize(target, "Hello", "en_US-nobody")).audio).toHaveLength(0);

    const file = wav(out);
    expect(file.subarray(0, 4).toString()).toBe("RIFF");
    expect(file.readUInt32LE(24)).toBe(22050);
    expect(file).toHaveLength(44 + 8820);
  });

  it("says plainly when the speech machine is off", async () => {
    const s = await fakeWyoming();
    await s.close();
    await expect(wyDescribe({ host: "127.0.0.1", port: s.port })).rejects.toThrow(
      /unreachable at 127\.0\.0\.1/,
    );
  });

  it("reads events split across chunks", () => {
    const read = eventReader();
    const bytes = encodeEvent("audio-chunk", { rate: 1 }, Buffer.from("abcdef"));
    expect(read(bytes.subarray(0, 7))).toEqual([]);
    const [e] = read(bytes.subarray(7));
    expect(e!.type).toBe("audio-chunk");
    expect(e!.payload!.toString()).toBe("abcdef");
  });

  it("speaks plain words: no citation ids, markdown, or links", () => {
    expect(
      speakableText(
        "**Plex** is up [E2][C3].\n- Check `docker ps` at https://example.com/x\n## Done",
      ),
    ).toBe("Plex is up. Check docker ps at a link Done");
  });
});
