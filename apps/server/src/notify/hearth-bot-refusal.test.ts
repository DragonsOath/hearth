import { describe, expect, it } from "vitest";
import { HEARTH_NOT_IN_SERVER, brokenReason } from "@dragon-control/core";
import { postRefusal } from "./hearth-bot";

// A refused post through the Hearth bot (11-14): a private channel and a server Hearth isn't in
// need different fixes, so they get different words.
describe("why the Hearth bot couldn't post", () => {
  it("a private channel says so, whether Discord or the relay answered", () => {
    const discord = postRefusal('{"message": "Missing Access", "code": 50001}', "111");
    expect(brokenReason(discord, "hearth-bot")).toMatch(/channel is private/);
    // The relay's answer, for a channel in a server Hearth is in: private too.
    const relay = postRefusal(
      '{"error":"That channel is not in a server you added Hearth to."}',
      "111",
      ["111", "222"],
    );
    expect(brokenReason(relay, "hearth-bot")).toMatch(/channel is private/);
  });

  it("a server Hearth isn't in offers Add Hearth to that server", () => {
    const r = postRefusal(
      '{"error":"That channel is not in a server you added Hearth to."}',
      "333",
      ["111"],
    );
    expect(brokenReason(r, "hearth-bot")).toBe(HEARTH_NOT_IN_SERVER);
    // The list couldn't be read: the relay's own words stand.
    expect(brokenReason(postRefusal("{}", "333"), "hearth-bot")).toBe(HEARTH_NOT_IN_SERVER);
  });
});
