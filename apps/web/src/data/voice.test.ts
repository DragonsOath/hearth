import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** A fake audio element: "plays" for a set time, then ends; pausing stops it mid-line. */
const log: string[] = [];
class FakeAudio {
  onended: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly src: string) {}
  play() {
    log.push(`start ${this.src}`);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      log.push(`end ${this.src}`);
      this.onended?.();
    }, 200);
    return Promise.resolve();
  }
  pause() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      log.push(`cut ${this.src}`);
    }
  }
}

beforeAll(() => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const text = (JSON.parse(init.body) as { text: string }).text;
      return { ok: true, blob: async () => text } as unknown as Response;
    }),
  );
  URL.createObjectURL = (b: Blob | MediaSource) => String(b);
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => {
  log.length = 0;
});

describe("Show & Tell's voice never cuts itself off (11-13)", () => {
  it("reads a queued line only after the one being read has finished", async () => {
    const { speaker } = await import("./voice");
    const first = speaker.queue("one");
    const second = speaker.queue("two");
    await first;
    await second;
    expect(log).toEqual(["start one", "end one", "start two", "end two"]);
  });

  it("a queued line waits for a line already playing", async () => {
    const { speaker } = await import("./voice");
    await speaker.say("answer");
    await speaker.queue("caption");
    expect(log).toEqual(["start answer", "end answer", "start caption", "end caption"]);
  });

  it("Stop clears what was waiting", async () => {
    const { speaker } = await import("./voice");
    const a = speaker.queue("a");
    const b = speaker.queue("b");
    await new Promise((r) => setTimeout(r, 50));
    speaker.stop();
    await a;
    await b;
    expect(log).toEqual(["start a", "cut a"]);
  });
});
