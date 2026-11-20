import { describe, expect, it } from "vitest";
import { todoCommands } from "./todo-words";

const of = (text: string) => [...todoCommands(text)].sort();

describe("Ember: what the owner asks about the to-do list", () => {
  it("recognises saving, deferring, working on, dropping, and closing items", () => {
    expect(of("Add it to the to-do list")).toEqual(["save"]);
    expect(of("add that")).toEqual(["save"]);
    expect(of("Put that on our list please")).toEqual(["save"]);
    expect(of("Remind me about that later")).toEqual(["defer", "save"]);
    expect(of("Put that on the back burner")).toEqual(["defer", "save"]);
    expect(of("Let's work on it now")).toEqual(["work"]);
    expect(of("let's fix the second one")).toEqual(["work"]);
    expect(of("We can ignore that")).toEqual(["dismiss"]);
    expect(of("Mark that done")).toEqual(["done"]);
    expect(of("mark #4 as resolved")).toEqual(["done"]);
    expect(of("make it high priority")).toEqual(["edit"]);
  });

  it("recognises questions about the list", () => {
    for (const q of [
      "What's on our list?",
      "What should we tackle today?",
      "What did we put off?",
      "Show me unresolved server issues",
    ]) {
      expect([q, todoCommands(q).has("show")]).toEqual([q, true]);
    }
  });

  it("enthusiasm and ordinary requests grant nothing", () => {
    expect(of("That would be cool")).toEqual([]);
    expect(of("Is Plex down?")).toEqual([]);
    expect(of("add the Prowlarr key to the vault")).toEqual([]);
    expect(of("yes do it")).toEqual([]);
  });
});
