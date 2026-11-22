import { describe, expect, it } from "vitest";
import { vpnWhy } from "./service";

/** The VPN's refusal in plain words, not Compose's wall of text (11-22, the laptop retest). */
describe("why the VPN did not come up", () => {
  it("a refused login: says so, and where the VPN's own pair is", () => {
    const log = "2026-11-22T05:15:01Z INFO [openvpn] AUTH: Received control message: AUTH_FAILED";
    const why = vpnWhy(log, "proton")!;
    expect(why).toContain("Proton VPN turned down the VPN login");
    expect(why).toContain("a separate pair from the one you sign in to Proton VPN with");
    expect(why).toContain("account.proton.me/u/0/vpn/OpenVpnIKEv2");
    expect(why).toContain('"Your VPN login" on the plan page');
  });

  it("a WireGuard key it did not take", () => {
    expect(vpnWhy("ERROR [wireguard] handshake did not complete", "airvpn")).toContain(
      "did not accept the WireGuard key",
    );
  });

  it("anything else: the usual message stays", () => {
    expect(vpnWhy("INFO [healthcheck] program has been unhealthy", "proton")).toBeUndefined();
  });
});
