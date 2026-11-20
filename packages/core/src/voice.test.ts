import { describe, expect, it } from "vitest";
import {
  AI_AVATAR_PATH,
  ARCHETYPES,
  DEFAULT_VOICE_PROFILES,
  EMBER_LOOK,
  EMBER_LOOKS,
  PROFILE_AVATAR,
  VOICE_EFFECTS,
  currentLook,
  defaultAvatarFor,
  speakableText,
  spokenAddress,
} from "./voice";
import { AI_PLATFORM_NAME, DEFAULT_AI_NAME, aiDisplayName } from "./cave";

describe("speaking addresses", () => {
  it("reads an IP address the way people say it", () => {
    expect(spokenAddress("192.168.1.10")).toBe("one nine two dot one six eight dot one dot ten");
    expect(spokenAddress("10.0.0.254")).toBe("ten dot zero dot zero dot two five four");
  });

  it("spells addresses out inside a sentence, and leaves other numbers and versions alone", () => {
    expect(speakableText("Prowlarr at 192.168.1.10 on port 9696 is down.")).toBe(
      "Prowlarr at one nine two dot one six eight dot one dot ten on port 9696 is down.",
    );
    expect(speakableText("Version 1.2.3 and 4.5 GB free.")).toBe("Version 1.2.3 and 4.5 GB free.");
    // Said like "hart" with a "th", not "heerth"; only the whole word, keeping its capital.
    expect(speakableText("Welcome to Hearth. The hearth's warm; hearthstone stays.")).toBe(
      "Welcome to Harth. The harth's warm; hearthstone stays.",
    );
    expect(speakableText("Not an address: 1.2.3.4.5")).toBe("Not an address: 1.2.3.4.5");
  });
});

describe("the five archetypes", () => {
  it("are built in, each with its own voice and picture; only the Companion has an effect", () => {
    expect(DEFAULT_VOICE_PROFILES.map((p) => p.id)).toEqual([
      "warden",
      "operator",
      "enchantress",
      "scholar",
      "companion",
    ]);
    for (const p of DEFAULT_VOICE_PROFILES) {
      expect(p.voice).toBe(`en_US-${p.id}-medium`);
      expect(p.avatar).toMatch(/^\/archetypes\/[a-z]+\.webp$/);
      expect(p.persona.length).toBeGreaterThan(80);
    }
    expect(DEFAULT_VOICE_PROFILES.filter((p) => p.effect).map((p) => p.id)).toEqual(["companion"]);
    expect(VOICE_EFFECTS.voicebox.filter).toContain("rubberband=pitch=1.04");
  });
});

describe("profile pictures and default names", () => {
  it("allows built-in pictures, gallery looks, and the owner's own picture only", () => {
    for (const ok of [
      "/archetypes/guardian.webp",
      "/avatars/scholar-3.webp",
      "/avatars/companion-5.webp",
      AI_AVATAR_PATH,
    ])
      expect(PROFILE_AVATAR.test(ok), ok).toBe(true);
    for (const refused of [
      "https://example.com/a.webp",
      "//example.com/avatars/a.webp",
      "/avatars/../secret.webp",
      "/avatars/scholar-3.png",
      "/avatars/Scholar.webp",
      "/uploads/a.webp",
      "/api/ai/avatar?x=1",
      "/api/owner/avatar",
      "javascript:alert(1)",
      "",
    ])
      expect(PROFILE_AVATAR.test(refused), refused).toBe(false);
  });

  it("gives each archetype five looks, its default first", () => {
    expect(ARCHETYPES.map((a) => a.id)).toEqual([
      "guardian",
      "operator",
      "enchantress",
      "scholar",
      "companion",
    ]);
    for (const a of ARCHETYPES) {
      expect(a.looks).toHaveLength(5);
      expect(a.looks[0]).toBe(`/archetypes/${a.id}.webp`);
      for (const look of a.looks) expect(PROFILE_AVATAR.test(look)).toBe(true);
    }
    // Classic Ember by default, on new installs and on installs from before Hearth alike.
    expect(defaultAvatarFor("warden")).toBe("/avatars/ember-classic.webp");
    expect(defaultAvatarFor("warden", "classic")).toBe("/avatars/ember-classic.webp");
    expect(defaultAvatarFor("belle")).toBeUndefined();
    expect(defaultAvatarFor("belle", "classic")).toBeUndefined();
  });

  it("calls the AI Ember until a name is typed, whichever voice is in use", () => {
    expect(aiDisplayName(undefined)).toBe("Ember");
    expect(aiDisplayName("  ")).toBe("Ember");
    expect(aiDisplayName("Warden")).toBe("Warden");
    expect(DEFAULT_AI_NAME).toBe("Ember");
    // The system keeps its own name.
    expect(AI_PLATFORM_NAME).toBe("Ember");
  });
});

describe("built-in personas", () => {
  it("describe a style only and never give the AI a name", () => {
    for (const p of DEFAULT_VOICE_PROFILES) {
      expect(p.persona, p.id).not.toMatch(
        /Warden|Guardian|Operator|Enchantress|Scholar|Companion|Ember|\bCove\b/,
      );
      expect(p.persona.length, p.id).toBeGreaterThan(100);
    }
  });
});

describe("the ten Ember pictures (46.16)", () => {
  it("are named, Classic first, each a picture Hearth serves and accepts", () => {
    expect(EMBER_LOOKS.map((l) => l.label)).toEqual([
      "Classic Ember",
      "Chatty Ember",
      "Manager Ember",
      "Detective Ember",
      "Engineer Ember",
      "Gamer Ember",
      "IT Ember",
      "Cosmic Ember",
      "Arcane Ember",
      "Cozy Ember",
    ]);
    expect(EMBER_LOOK).toBe("/avatars/ember-classic.webp");
    for (const l of EMBER_LOOKS) expect(PROFILE_AVATAR.test(l.path), l.path).toBe(true);
  });

  it("show a retired picture as Classic Ember, and keep Ember pictures and your own", () => {
    for (const old of [
      "/avatars/ember.webp",
      "/archetypes/guardian.webp",
      "/avatars/scholar-3.webp",
      undefined,
    ])
      expect(currentLook(old), String(old)).toBe(EMBER_LOOK);
    expect(currentLook("/avatars/ember-cosmic.webp")).toBe("/avatars/ember-cosmic.webp");
    expect(currentLook("/api/ai/avatar")).toBe("/api/ai/avatar");
  });
});
