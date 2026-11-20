import https from "node:https";
import http from "node:http";
import { isIP } from "node:net";
import tls, { type TLSSocket } from "node:tls";
import type { Fetch } from "./http";

/**
 * HTTPS to an app that uses its own self-signed certificate, as Proxmox does out of the box
 * (port 8006). Normal certificate checks stay on for public addresses. For an address on the
 * local network a self-signed certificate is accepted, but pinned: the first certificate Hearth
 * sees for that address is remembered for as long as Hearth runs, and a different one later is
 * refused before anything (an API token included) is sent.
 */

const PINS = new Map<string, string>();

/** Forget the pinned certificates (tests). */
export function forgetPins() {
  PINS.clear();
}

/** A private (local network) address: 10/8, 172.16/12, 192.168/16, loopback, link-local, or a bare or .local/.lan/.home name. */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^(10\.|127\.|192\.168\.|169\.254\.)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (h === "localhost" || h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith("fe80:"))
    return true;
  if (!h.includes(".")) return true;
  return /\.(local|lan|home|internal|home\.arpa)$/.test(h);
}

/** A TLS connection whose certificate is checked against the pin before it is handed over. */
function pinnedSocket(
  host: string,
  port: number,
  key: string,
  signal: AbortSignal,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: false,
    });
    const fail = (e: Error) => {
      socket.destroy();
      reject(e);
    };
    signal.addEventListener("abort", () => fail(new Error("timed out")), { once: true });
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const print = socket.getPeerCertificate()?.fingerprint256;
      if (!print) return fail(new Error(`${key} sent no certificate`));
      const known = PINS.get(key);
      if (known && known !== print)
        return fail(
          new Error(
            `the certificate at ${key} changed since Hearth first saw it, so nothing was sent. If you replaced it, restart Hearth`,
          ),
        );
      PINS.set(key, print);
      resolve(socket);
    });
  });
}

export const localTlsFetch: Fetch = async (url, init) => {
  const u = new URL(url);
  const secure = u.protocol === "https:";
  const local = isLocalHost(u.hostname);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const port = Number(u.port || (secure ? 443 : 80));
  const key = `${host}:${port}`;
  // A local, self-signed server: the certificate is checked first, and only then is the request
  // (with its token) written on that same connection.
  const socket = secure && local ? await pinnedSocket(host, port, key, init.signal) : undefined;
  const lib = secure ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      {
        method: init.method ?? "GET",
        headers: init.headers,
        signal: init.signal,
        // No agent: Node then writes the request on exactly this socket.
        ...(socket ? { createConnection: () => socket } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            json: async () => JSON.parse(body) as unknown,
            text: async () => body,
            headers: { get: (n: string) => (res.headers[n.toLowerCase()] as string) ?? null },
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
};
