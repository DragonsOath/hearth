import { describe, expect, it } from "vitest";
import { looksLikeMachineName, speakerName } from "./speakers";

describe("speaker names (11-13: no model numbers or IPs in the picker)", () => {
  it("keeps a real name the system already has (Music Assistant, Sonos, Cast)", () => {
    expect(speakerName({ entityId: "media_player.living_room", friendly: "Living Room" })).toBe(
      "Living Room",
    );
    expect(
      speakerName({
        entityId: "media_player.ma_kitchen",
        friendly: "Kitchen Echo",
        model: "Echo Dot",
      }),
    ).toBe("Kitchen Echo");
  });

  it("prefers the name the owner gave it in Home Assistant", () => {
    expect(
      speakerName({
        entityId: "media_player.srs_xb33",
        friendly: "SRS-XB33",
        registryName: "Patio",
        area: "Backyard",
      }),
    ).toBe("Patio");
    expect(
      speakerName({
        entityId: "media_player.x",
        friendly: "192.168.1.55",
        deviceNameByUser: "Bedroom TV",
      }),
    ).toBe("Bedroom TV");
  });

  it("uses the room when all it has is a model number or an address", () => {
    expect(
      speakerName({
        entityId: "media_player.sonos_era_100",
        friendly: "Sonos Era 100",
        model: "Era 100",
        manufacturer: "Sonos",
        area: "Kitchen",
      }),
    ).toBe("Kitchen speaker");
    expect(
      speakerName({
        entityId: "media_player.192_168_1_217",
        friendly: "192.168.1.55",
        area: "Den",
      }),
    ).toBe("Den speaker");
  });

  it("with no room either, at least drops the address", () => {
    expect(
      speakerName({ entityId: "media_player.tv", friendly: "Google TV Streamer (192.168.1.55)" }),
    ).toBe("Google TV Streamer");
  });

  it("tells machine names from people's names", () => {
    for (const n of [
      "192.168.1.40",
      "SRS-XB33",
      "media_player.den",
      "aa:bb:cc:dd:ee:ff",
      "LGWebOSTV2",
    ])
      expect(looksLikeMachineName(n, { entityId: "media_player.x" }), n).toBe(true);
    for (const n of ["Living Room", "Kitchen Echo", "Alex's Office", "TV"])
      expect(looksLikeMachineName(n, { entityId: "media_player.x" }), n).toBe(false);
  });
});
