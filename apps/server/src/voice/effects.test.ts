import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ffmpegEffect, wavRate, withEffect } from "./effects";
import { wav } from "./wyoming";

// Half a second of a 220 Hz tone at 22,050 Hz, as Piper would send it.
function tone(): Buffer {
  const rate = 22050;
  const samples = Buffer.alloc(rate);
  for (let i = 0; i < rate / 2; i++)
    samples.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  return wav({ audio: samples, rate, width: 2, channels: 1 });
}

const hasRubberband = (() => {
  try {
    return execFileSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).includes(
      "rubberband",
    );
  } catch {
    return false;
  }
})();

describe("voice effects", () => {
  it("passes the voice through untouched when a profile has no effect", async () => {
    const plain = tone();
    let ran = false;
    const out = await withEffect(plain, undefined, async () => {
      ran = true;
      return Buffer.from("x");
    });
    expect(out).toBe(plain);
    expect(ran).toBe(false);
  });

  it("runs the effect's filter at the voice's own sample rate", async () => {
    const seen: { filter: string; rate: number }[] = [];
    const out = await withEffect(tone(), "voicebox", async (w, filter, rate) => {
      seen.push({ filter, rate });
      return Buffer.from("changed");
    });
    expect(out.toString()).toBe("changed");
    expect(seen[0]).toMatchObject({ rate: 22050, filter: expect.stringContaining("chorus=") });
    expect(wavRate(tone())).toBe(22050);
  });

  it("falls back to the plain voice when the effect cannot run, and says why", async () => {
    const plain = tone();
    const errors: unknown[] = [];
    const out = await withEffect(
      plain,
      "voicebox",
      async () => {
        throw new Error("ffmpeg not found");
      },
      (e) => errors.push(e),
    );
    expect(out).toBe(plain);
    expect(String(errors[0])).toContain("ffmpeg not found");
  });

  it.runIf(hasRubberband)("with real ffmpeg: returns a WAV at the same rate", async () => {
    const out = await withEffect(tone(), "voicebox", ffmpegEffect);
    expect(out.subarray(0, 4).toString()).toBe("RIFF");
    expect(wavRate(out)).toBe(22050);
    expect(out.length).toBeGreaterThan(10_000);
  });
});
