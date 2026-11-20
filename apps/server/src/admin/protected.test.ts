import { describe, expect, it } from "vitest";
import { currentEndpoint, switchEdits, type VpnServer } from "./protected";
import { applyEdits } from "./files";

const compose = `services:
  gluetun:
    environment:
      - VPN_SERVICE_PROVIDER=custom
      - VPN_TYPE=wireguard
      - WIREGUARD_ENDPOINT_IP=192.144.21.2
      - WIREGUARD_ENDPOINT_PORT=51820
      - WIREGUARD_PUBLIC_KEY=oldPublicKey=
      - WIREGUARD_PRIVATE_KEY=secretPrivateKey=
`;
const to: VpnServer = {
  name: "US-CA#149",
  country: "United States",
  city: "Los Angeles",
  hostname: "node-us-149.protonvpn.net",
  ip: "146.70.195.98",
  publicKey: "newPublicKey=",
  portForward: true,
  streaming: true,
};

describe("switching a Gluetun VPN server", () => {
  it("changes only the server's address and public key, never the private key", () => {
    expect(currentEndpoint(compose)).toBe("192.144.21.2");
    const edits = switchEdits(compose, to);
    if (typeof edits === "string") throw new Error(edits);
    const after = applyEdits(compose, edits).after;
    expect(after).toContain("WIREGUARD_ENDPOINT_IP=146.70.195.98");
    expect(after).toContain("WIREGUARD_PUBLIC_KEY=newPublicKey=");
    expect(after).toContain("WIREGUARD_PRIVATE_KEY=secretPrivateKey=");
    expect(JSON.stringify(edits)).not.toContain("secretPrivateKey");
  });

  it("refuses a Gluetun that is not set up with its own WireGuard server", () => {
    expect(switchEdits(compose.replace("custom", "protonvpn"), to)).toMatch(/not set up/);
  });
});
