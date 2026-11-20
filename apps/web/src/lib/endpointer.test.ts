import { describe, expect, it } from "vitest";
import { Endpointer, isNoiseTranscript, rmsOf, stripEcho } from "./endpointer";

const CHUNK = 85; // ms, a 4096-sample chunk at 48 kHz

function feed(e: Endpointer, rms: number, ms: number) {
  const events: string[] = [];
  for (let t = 0; t < ms; t += CHUNK) {
    const ev = e.push(rms, CHUNK);
    if (ev !== "none") events.push(ev);
  }
  return events;
}

describe("conversation mode end-of-speech detection", () => {
  it("starts when you speak and ends after you pause", () => {
    const e = new Endpointer();
    expect(feed(e, 0.003, 1000)).toEqual([]);
    expect(feed(e, 0.08, 1500)).toEqual(["start"]);
    // A pause between words (up to about 1.7 s) does not end it.
    expect(feed(e, 0.003, 500)).toEqual([]);
    expect(feed(e, 0.07, 800)).toEqual([]);
    expect(feed(e, 0.003, 1900)).toEqual(["end"]);
    expect(e.speaking).toBe(false);
  });

  it("ignores a click or a cough", () => {
    const e = new Endpointer();
    feed(e, 0.003, 800);
    expect(feed(e, 0.2, CHUNK)).toEqual([]);
    expect(feed(e, 0.003, 2000)).toEqual([]);
    const f = new Endpointer({ startMs: 100 });
    feed(f, 0.003, 800);
    expect([...feed(f, 0.2, 200), ...feed(f, 0.003, 1900)]).toEqual(["start", "discard"]);
  });

  it("learns a noisy room, so the hum is not speech but talking over it is", () => {
    const e = new Endpointer();
    expect(feed(e, 0.02, 4000)).toEqual([]);
    expect(feed(e, 0.15, 600)).toEqual(["start"]);
  });

  it("cuts off a very long utterance", () => {
    const e = new Endpointer({ maxMs: 2000 });
    feed(e, 0.003, 500);
    // Cut at the limit; still talking, so the next part starts at once.
    expect(feed(e, 0.1, 3000)).toEqual(["start", "end", "start"]);
  });

  it("measures loudness and drops Whisper's noise words", () => {
    expect(rmsOf(new Float32Array(400).fill(0.5))).toBeCloseTo(0.5);
    expect(isNoiseTranscript(" You ")).toBe(true);
    expect(isNoiseTranscript("Thank you.")).toBe(true);
    expect(isNoiseTranscript("Is Plex okay?")).toBe(false);
  });
});

describe("the AI's own last words are not taken as yours", () => {
  const said = "Radarr is downloading two movies right now. Anything else, my lord?";
  it("takes the echoed tail off the start", () => {
    expect(stripEcho("Anything else my lord? Turn on the lights", said)).toBe("Turn on the lights");
    expect(stripEcho("my lord. What about Sonarr?", said)).toBe("What about Sonarr?");
  });
  it("leaves nothing when it only heard the echo", () => {
    // Ember ended "...tell me if you want any changes first." and the mic sent "changes first."
    expect(
      stripEcho(
        "changes first.",
        "Approve them whenever you are ready, or tell me if you want any changes first.",
      ),
    ).toBe("");
    expect(stripEcho("anything else, my lord", said)).toBe("");
  });
  it("never removes a real answer", () => {
    expect(stripEcho("Lord of the Rings please", said)).toBe("Lord of the Rings please");
    expect(stripEcho("Yes", "Want me to? Yes")).toBe("Yes");
    expect(stripEcho("Check Plex", undefined)).toBe("Check Plex");
  });
});
