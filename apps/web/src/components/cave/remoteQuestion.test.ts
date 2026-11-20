import { describe, expect, it } from "vitest";
import { remoteQuestion } from "./Thread";

describe("remoteQuestion", () => {
  it("reads Claude Code's Full access warning as a question with its answers", () => {
    const q = remoteQuestion(
      [
        "Claude Code is asking: Claude Code's one-time warning for Full access (Bypass Permissions mode)",
        "> With Full access on, Claude Code runs commands without asking first.",
        "Accept Bypass Permissions mode?",
        "1. No, exit",
        "2. Yes, I accept",
        "Answer here: Claude Code waits on this before the Claude app can connect.",
      ].join("\n"),
    );
    expect(q?.title).toContain("one-time warning");
    expect(q?.details).toEqual([
      "With Full access on, Claude Code runs commands without asking first.",
    ]);
    expect(q?.question).toBe("Accept Bypass Permissions mode?");
    expect(q?.options).toEqual([
      { key: "1", label: "No, exit" },
      { key: "2", label: "Yes, I accept" },
    ]);
  });

  it("leaves other notes alone", () => {
    expect(remoteQuestion("Starting Remote Control for this conversation…")).toBeUndefined();
    expect(remoteQuestion("Claude Code is asking: something with no answers")).toBeUndefined();
  });
});
