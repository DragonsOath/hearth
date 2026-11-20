import { describe, expect, it } from "vitest";
import { asksToDo, focusApplies, isClearStop } from "./chat-intent";

describe("a clear stop (11-13)", () => {
  it("stops on a clear stop, said a few ways", () => {
    for (const t of [
      "stop",
      "Stop.",
      "STOP!",
      "stop it",
      "cancel",
      "never mind",
      "nevermind",
      "ok stop",
      "please stop",
      "stop please",
      "that's enough",
    ])
      expect(isClearStop(t), t).toBe(true);
  });

  it("never stops on a question or request that only contains the word", () => {
    for (const t of [
      "where is the show and tell browser",
      "how do I stop following?",
      "stop the radarr container",
      "cancel the movie night on Saturday",
      "can you stop showing me things and just tell me",
      "go",
      "resume",
      "turn it on",
    ])
      expect(isClearStop(t), t).toBe(false);
  });
});

describe("the About chip applies only when the message is about it (11-13)", () => {
  it("applies when the message points at it or names it", () => {
    expect(focusApplies("what is wrong with this?", "Home Assistant")).toBe(true);
    expect(focusApplies("restart it", "Home Assistant")).toBe(true);
    expect(focusApplies("is home assistant up?", "Home Assistant")).toBe(true);
  });

  it("leaves it out for something else", () => {
    expect(focusApplies("how do I plan a movie night?", "Home Assistant")).toBe(false);
    expect(focusApplies("where is the show and tell browser", "Home Assistant")).toBe(false);
    expect(focusApplies("and how do I invite friends?", "Home Assistant")).toBe(false);
  });
});

describe("isEverydayQuestion", () => {
  it("is a plain how-to, not a request to do something", async () => {
    const { isEverydayQuestion, asksFullMode } = await import("./chat-intent");
    for (const q of [
      "how do I add a new movie night?",
      "What is a quality profile in Radarr?",
      "where can I see my backups",
      "Explain what Show & Tell does",
      "is there a way to rename a speaker?",
    ])
      expect(isEverydayQuestion(q), q).toBe(true);
    for (const q of [
      "Can you fix Sonarr for me?",
      "how do I fix it, please restart Radarr",
      "set up Tautulli",
      "Radarr is broken",
      "how do I " + "x".repeat(400),
    ])
      expect(isEverydayQuestion(q), q).toBe(false);
    expect(asksFullMode("NEEDS_FULL_MODE")).toBe(true);
    expect(asksFullMode("`NEEDS_FULL_MODE`.")).toBe(true);
    expect(asksFullMode("You open Settings, then NEEDS_FULL_MODE")).toBe(false);
  });
});

describe("asksToDo (11-14)", () => {
  it("tells a request to do something from a question", () => {
    for (const t of [
      "Can you restart Radarr for me?",
      "Make me a 15-song playlist called Late Night Coding",
      "Find a movie that came out recently and request it in Seerr for me.",
      "Please delete the invite you made",
      "Set up a movie night for Saturday",
    ])
      expect(asksToDo(t), t).toBe(true);
    for (const t of [
      "Which of my drives is filling up fastest, and what's taking the space?",
      "Is anything stuck in my downloads right now?",
      "What should I watch tonight?",
      "How do I add a new friend to my Plex so they get the welcome guide?",
    ])
      expect(asksToDo(t), t).toBe(false);
  });
});
