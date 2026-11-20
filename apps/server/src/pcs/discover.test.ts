import { describe, expect, it } from "vitest";
import { findHearths, homeCandidates } from "./discover";

describe("finding your Hearth from a new PC", () => {
  it("asks every other address on this PC's home network", () => {
    const list = homeCandidates({
      eth0: [
        {
          address: "192.168.1.50",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
          mac: "",
          cidr: null,
        },
      ],
      lo: [
        {
          address: "127.0.0.1",
          family: "IPv4",
          internal: true,
          netmask: "255.0.0.0",
          mac: "",
          cidr: null,
        },
      ],
    });
    expect(list).toHaveLength(253);
    expect(list).toContain("http://192.168.1.77:7600");
    expect(list).not.toContain("http://192.168.1.50:7600");
  });

  it("lists each Hearth once, home network first", async () => {
    const found = await findHearths({
      home: () => ["http://192.168.1.77:7600", "http://192.168.1.9:7600"],
      tailscale: async () => ["http://100.64.10.26:7600"],
      ask: async (url) =>
        url.includes("192.168.1.77") || url.includes("100.64.10")
          ? {
              url,
              name: "Homeserver",
              linkable: true,
              via: url.includes("100.") ? "tailscale" : "home",
            }
          : null,
    });
    expect(found).toEqual([
      { url: "http://192.168.1.77:7600", name: "Homeserver", linkable: true, via: "home" },
    ]);
  });
});
