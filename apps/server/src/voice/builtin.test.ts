import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STANDARD_VOICE } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { InvalidRequestError } from "../store/errors";
import { FakeVoicePack, type VoicePackApi } from "./pack";
import { pieces } from "./pieces";
import { Voice } from "./service";

/** Standard voice: built into Hearth, nothing to set up (the owner, 2026-10-26). */

const handles: DbHandle[] = [];
afterEach(() => handles.splice(0).forEach((h) => h.sqlite.close()));

async function voiceWith(pack: VoicePackApi, defaultHost?: string) {
  const handle = openDatabase(":memory:");
  handles.push(handle);
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  return new Voice(handle, { pack, ...(defaultHost ? { defaultHost } : {}) });
}

/** A pack that records what it was asked to say, in which voice. */
class Recording extends FakeVoicePack {
  said: { text: string; voice: string }[] = [];
  override async synthesize(text: string, voice: string) {
    this.said.push({ text, voice });
    return super.synthesize(text, voice);
  }
}

describe("Standard voice", () => {
  it("is what a new install uses, with nothing to set up", async () => {
    const voice = await voiceWith(new FakeVoicePack());
    const s = await voice.status();
    expect(s).toMatchObject({ engine: "builtin", configured: true });
    expect(s.builtin).toMatchObject({ state: "missing", sizeMb: 500 });
  });

  it("keeps an install with a speech machine on its machine (Advanced)", async () => {
    const voice = await voiceWith(new FakeVoicePack(), "speech.lan");
    expect((await voice.status()).engine).toBe("machine");
  });

  it("gets ready by itself the first time it is asked to speak, then speaks in the one Standard voice", async () => {
    const pack = new Recording();
    const voice = await voiceWith(pack);
    await expect(voice.speak("Hello there.", "warden")).rejects.toThrow(InvalidRequestError);
    await expect(voice.speak("Hello there.")).rejects.toThrow(/getting ready/);
    expect((await voice.status()).builtin.state).toBe("downloading");
    await new Promise((r) => setTimeout(r, 700));
    expect((await voice.status()).builtin.state).toBe("ready");
    const wav = await voice.speak("Hello there.", "enchantress");
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    // Every character speaks with the same Standard voice: the characters are Advanced.
    expect(pack.said.at(-1)).toEqual({ text: "Hello there.", voice: STANDARD_VOICE });
    const s = await voice.status();
    expect(s.tts.ok).toBe(true);
    expect(s.tts.voices).toEqual(s.profiles.map((p) => p.voice));
  });

  it("listens with the built-in voice", async () => {
    const voice = await voiceWith(new FakeVoicePack(true));
    expect(await voice.transcribe(Buffer.alloc(16000 * 2), 16000)).toBe(
      "hello from the built-in voice",
    );
  });

  it("switches to Advanced and back, and a save that doesn't name the engine keeps it", async () => {
    const voice = await voiceWith(new FakeVoicePack(true));
    const c = await voice.config();
    await voice.save({ ...c, engine: "machine", host: "speech.lan" });
    expect((await voice.status()).engine).toBe("machine");
    const { engine: _left, ...rest } = await voice.config();
    await voice.save({ ...rest, engine: "builtin" });
    await voice.save({ ...rest, active: "scholar" });
    expect((await voice.status()).engine).toBe("builtin");
  });
});

describe("splitting text for the voice", () => {
  it("keeps sentences whole and pieces short", () => {
    const text = "One. Two is longer! Three? " + "Four ".repeat(80) + "end.";
    const out = pieces(text, 60);
    expect(out[0]).toBe("One. Two is longer! Three?");
    expect(out.every((p) => p.length <= 60 || !p.includes(". "))).toBe(true);
    expect(out.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
  });
});
