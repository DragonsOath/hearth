import { describe, expect, it } from "vitest";
import { HEARTH_NOT_IN_SERVER, brokenReason } from "./notify";

describe("brokenReason", () => {
  it("names a deleted webhook, a lost channel and a dead token; ignores failures that pass", () => {
    expect(brokenReason("The server answered 404 Not Found", "discord")).toMatch(
      /deleted in Discord/,
    );
    expect(brokenReason('{"message": "Unknown Webhook", "code": 10015}', "discord")).toMatch(
      /deleted in Discord/,
    );
    expect(brokenReason("The server answered 404 Not Found", "webhook")).toMatch(
      /no longer exists/,
    );
    expect(
      brokenReason("That channel is not in a server you added Hearth to. Add Hearth there first."),
    ).toBe(HEARTH_NOT_IN_SERVER);
    // A private channel the bot can't see, and a deleted one: each says its own fix.
    expect(brokenReason('{"message": "Missing Access", "code": 50001}', "hearth-bot")).toMatch(
      /channel is private.*Permissions/,
    );
    expect(brokenReason('{"message": "Unknown Channel", "code": 10003}')).toMatch(
      /no longer exists in Discord/,
    );
    expect(brokenReason("The server answered 401 Unauthorized")).toMatch(/no longer works/);
    expect(brokenReason("The server answered 503 Service Unavailable")).toBeUndefined();
    expect(brokenReason("Timed out after 10 s")).toBeUndefined();
    expect(brokenReason(undefined)).toBeUndefined();
  });
});
