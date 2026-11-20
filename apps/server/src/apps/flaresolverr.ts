/**
 * FlareSolverr's panel, read from its own log (it has no statistics API, and it usually runs
 * inside a VPN container's network with no address of its own): each request it handled, the
 * site, whether there was a challenge and whether it was solved, and how long it took. Lines are
 * already redacted by the container tools; only the site's host name is kept from each URL.
 */

export interface FlareRequest {
  at?: string;
  site: string;
  outcome: "solved" | "no-challenge" | "failed";
  seconds?: number;
  why?: string;
}

export interface FlarePanel {
  version?: string;
  requests: FlareRequest[];
  sites: { site: string; requests: number; solved: number; failed: number; avgSeconds?: number }[];
}

const TIME = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "a site";
  }
};

/** Reads the request, the challenge verdict, and the response time that follow each other in its log. */
export function parseFlareLog(lines: string[]): FlarePanel {
  let version: string | undefined;
  const requests: FlareRequest[] = [];
  let open: FlareRequest | undefined;
  for (const raw of lines) {
    const line = raw.replace(/^\S+Z\s+(?=\d{4}-)/, "");
    const v = /FlareSolverr (\d+\.\d+\.\d+)/.exec(line);
    if (v) version = v[1];
    const at = TIME.exec(line)?.[1];
    const req =
      /Incoming request => POST \/v1 body: .*'cmd': 'request\.(?:get|post)'.*'url': '([^']+)'/.exec(
        line,
      );
    if (req) {
      if (open) requests.push({ ...open, outcome: open.outcome });
      open = {
        site: hostOf(req[1]!),
        outcome: "no-challenge",
        ...(at ? { at: at.replace(" ", "T") } : {}),
      };
      continue;
    }
    if (!open) continue;
    if (/Challenge solved/i.test(line)) open.outcome = "solved";
    else if (/Challenge not detected/i.test(line)) open.outcome = "no-challenge";
    else if (/ERROR|Error solving|timeout|Timeout/i.test(line)) {
      open.outcome = "failed";
      open.why = line
        .replace(TIME, "")
        .replace(/^\s*(ERROR|INFO|WARNING)\s*/, "")
        .trim()
        .slice(0, 200);
    }
    const resp = /Response in ([\d.]+) s/.exec(line);
    if (resp) {
      open.seconds = Number(resp[1]);
      requests.push(open);
      open = undefined;
    }
  }
  if (open) requests.push(open);
  const bySite = new Map<string, FlareRequest[]>();
  for (const r of requests) bySite.set(r.site, [...(bySite.get(r.site) ?? []), r]);
  return {
    ...(version ? { version } : {}),
    requests: requests.slice(-15).reverse(),
    sites: [...bySite.entries()]
      .map(([site, rs]) => {
        const timed = rs.filter((r) => r.seconds !== undefined);
        return {
          site,
          requests: rs.length,
          solved: rs.filter((r) => r.outcome === "solved").length,
          failed: rs.filter((r) => r.outcome === "failed").length,
          ...(timed.length
            ? {
                avgSeconds:
                  Math.round((timed.reduce((n, r) => n + r.seconds!, 0) / timed.length) * 10) / 10,
              }
            : {}),
        };
      })
      .sort((a, b) => b.failed - a.failed || b.requests - a.requests),
  };
}
