/**
 * Tinyauth's panel, read from its own log (it has no statistics API): every time Caddy asked
 * "may this visitor in?", the answer (let in because signed in, sent to the sign-in page, or
 * refused), sign-ins that worked or failed, and where the asks came from. Only the time, the
 * visitor's address, the path, and the answer are kept from each line; lines are already
 * redacted by the container tools, and Tinyauth never logs passwords.
 */

export interface TinyauthAddress {
  address: string;
  allowed: number;
  sentToSignIn: number;
  refused: number;
}

export interface TinyauthPanel {
  /** The span the log lines cover, oldest to newest. */
  from?: string;
  to?: string;
  checks: { allowed: number; sentToSignIn: number; refused: number };
  signIns: { at?: string; address: string; ok: boolean }[];
  /** Asks per hour, oldest first (hour start, count). */
  hours: { hour: string; checks: number }[];
  /** Hours with far more asks than usual, and who made most of them. */
  bursts: { hour: string; checks: number; mostly?: string; signedIn: boolean }[];
  addresses: TinyauthAddress[];
  errors: { at?: string; text: string }[];
}

// Tinyauth logs in colour; Docker may put its own timestamp first.
const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
const TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;
const field = (line: string, name: string) =>
  new RegExp(String.raw`\b${name}=("[^"]*"|\S+)`).exec(line)?.[1]?.replace(/^"|"$/g, "");

export function parseTinyauthLog(lines: string[]): TinyauthPanel {
  const checks = { allowed: 0, sentToSignIn: 0, refused: 0 };
  const signIns: TinyauthPanel["signIns"] = [];
  const errors: TinyauthPanel["errors"] = [];
  const byAddress = new Map<string, TinyauthAddress>();
  const byHour = new Map<string, { checks: number; who: Map<string, number>; allowed: number }>();
  let from: string | undefined;
  let to: string | undefined;
  for (const raw of lines) {
    const line = raw.replace(ANSI, "").replace(/^\S+Z\s+(?=\d{4}-)/, "");
    const at = TIME.exec(line)?.[1];
    if (at) {
      from ??= `${at}Z`;
      to = `${at}Z`;
    }
    const path = field(line, "path")?.split("?")[0];
    const status = Number(field(line, "status") ?? 0);
    const address = field(line, "client_ip") ?? "unknown";
    if (path?.startsWith("/api/auth/")) {
      const kind =
        status === 200 ? "allowed" : status >= 300 && status < 400 ? "sentToSignIn" : "refused";
      checks[kind] += 1;
      const a = byAddress.get(address) ?? { address, allowed: 0, sentToSignIn: 0, refused: 0 };
      a[kind] += 1;
      byAddress.set(address, a);
      if (at) {
        const hour = `${at.slice(0, 13)}:00:00Z`;
        const h = byHour.get(hour) ?? { checks: 0, who: new Map(), allowed: 0 };
        h.checks += 1;
        if (kind === "allowed") h.allowed += 1;
        h.who.set(address, (h.who.get(address) ?? 0) + 1);
        byHour.set(hour, h);
      }
      continue;
    }
    if (path === "/api/user/login" && field(line, "method") === "POST") {
      signIns.push({ ...(at ? { at: `${at}Z` } : {}), address, ok: status === 200 });
      continue;
    }
    // Its own warnings and errors; a visitor's 4xx is already counted above.
    if (/\b(ERR|ERROR|FTL)\b/.test(line) && !/Client Error/.test(line))
      errors.push({
        ...(at ? { at: `${at}Z` } : {}),
        text: line
          .replace(TIME, "")
          .replace(/^\S*\s*/, "")
          .trim()
          .slice(0, 200),
      });
  }
  const hours = [...byHour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, h]) => ({ hour, checks: h.checks }));
  const sorted = hours.map((h) => h.checks).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const bursts = [...byHour.entries()]
    .filter(([, h]) => h.checks >= 1000 && h.checks > Math.max(median, 50) * 5)
    .map(([hour, h]) => {
      const top = [...h.who.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        hour,
        checks: h.checks,
        ...(top && top[1] > h.checks / 2 ? { mostly: top[0] } : {}),
        signedIn: h.allowed > h.checks / 2,
      };
    })
    .sort((a, b) => b.hour.localeCompare(a.hour));
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    checks,
    signIns: signIns.slice(-15).reverse(),
    hours: hours.slice(-24),
    bursts: bursts.slice(0, 5),
    addresses: [...byAddress.values()]
      .sort(
        (a, b) => b.allowed + b.sentToSignIn + b.refused - (a.allowed + a.sentToSignIn + a.refused),
      )
      .slice(0, 12),
    errors: errors.slice(-8).reverse(),
  };
}
