import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** An address other devices can open this Hearth at. */
export interface HearthAddress {
  url: string;
  kind: "this-page" | "home" | "tailscale";
  label: string;
}

export interface Reachable {
  addresses: HearthAddress[];
  /** Hearth listens on this PC only, with nothing in front of it: other devices cannot reach it. */
  localOnly: boolean;
}

export function useAddresses() {
  return useQuery({
    queryKey: ["devices", "addresses"],
    queryFn: () => api<Reachable>("GET", "/api/devices/addresses"),
  });
}

/** A one-time code that signs one device in (needs a fresh "it's you"). */
/** Open to my home network: Hearth changes its own setting and restarts. */
export function useOpenNetwork() {
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean; message: string }>("POST", "/api/devices/open-network", {}),
  });
}

/** A one-time code: a device with all of Hearth, or a home tablet with the home dashboard only. */
export function useDeviceCode() {
  return useMutation({
    mutationFn: (purpose: "device" | "home" = "device") =>
      api<Reachable & { code: string; expiresAt: string }>("POST", "/api/devices/codes", {
        purpose,
      }),
  });
}

/** The link a device opens to sign in with a code (what the QR holds). */
export const pairLink = (base: string, code: string) =>
  `${base.replace(/\/$/, "")}/pair?code=${encodeURIComponent(code)}`;
