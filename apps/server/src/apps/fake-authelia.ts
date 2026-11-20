import type { Fetch } from "./http";

/**
 * A stand-in Authelia for tests and safe previews (DC_FAKE_APPS=1, never in a real install): its
 * health check on port 9092 and its Prometheus metrics on 9959, answering as a throwaway
 * ghcr.io/authelia/authelia 4.39.28 did after sign-ins, failed sign-ins and a ban. With metrics off,
 * port 9959 does not answer, as when telemetry is not turned on.
 */

export interface FakeAuthelia {
  fetch: Fetch;
  reset(): void;
  metricsOff(off: boolean): void;
}

export function fakeAuthelia(): FakeAuthelia {
  let off = false;
  const reset = () => {
    off = false;
  };
  const start = Math.round(Date.now() / 1000 - 2 * 86_400);
  const metrics = () =>
    [
      "# HELP authelia_authn The number of authentication attempts.",
      "# TYPE authelia_authn counter",
      'authelia_authn{banned="false",success="false"} 4',
      'authelia_authn{banned="false",success="true"} 142',
      'authelia_authn{banned="true",success="false"} 2',
      'authelia_authn_duration_sum{success="true"} 30.53',
      'authelia_authn_duration_count{success="true"} 142',
      'authelia_request{code="200",method="GET"} 9120',
      'authelia_request{code="401",method="POST"} 6',
      'authelia_request{code="500",method="GET"} 1',
      `process_start_time_seconds ${start}`,
      "process_resident_memory_bytes 4.1943040e+07",
      'go_info{version="go1.27.1"} 1',
    ].join("\n") + "\n";

  const reply = (status: number, body: string, type = "application/json") => ({
    ok: status < 400,
    status,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? type : null) },
  });

  const fetchImpl: Fetch = async (url) => {
    const u = new URL(url);
    if (u.port === "9959") {
      if (off) throw new Error("connect ECONNREFUSED");
      return u.pathname === "/metrics"
        ? reply(200, metrics(), "text/plain")
        : reply(404, "404 page not found", "text/plain");
    }
    if (u.pathname === "/api/health") return reply(200, JSON.stringify({ status: "OK" }));
    return reply(404, JSON.stringify({ status: "KO" }));
  };

  return { fetch: fetchImpl, reset, metricsOff: (v) => (off = v) };
}
