import type { Fetch } from "./http";

/**
 * A stand-in Uptime Kuma (port 3001) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering its socket (socket.io over polling) as a throwaway louislam/uptime-kuma
 * 2.5.9 did: an e2e- password, a group with two monitors (one down), a website whose certificate
 * runs out in 9 days (and sends no alerts), a paused ping check, a push monitor, maintenance, a status page and a
 * notification. Monitor and notification settings hold secrets (a password, a push token, a
 * webhook address, a token in an address) that must never reach the panel.
 */

export interface FakeKuma {
  fetch: Fetch;
  reset(): void;
  /** How many password sign-ins it has seen (the token is used after the first). */
  passwordLogins(): number;
}

const SECRET = "e2e-SECRET";
const SEP = "\x1e";

interface Mon {
  id: number;
  name: string;
  type: string;
  url: string | null;
  hostname: string | null;
  port: number | null;
  parent: number | null;
  active: boolean;
  interval: number;
  notificationIDList: Record<string, boolean>;
  tags: { name: string; value: string }[];
  // Settings a real monitor carries that Hearth must not pass on.
  basic_auth_pass: string | null;
  pushToken: string | null;
  headers: string | null;
}

export function fakeUptimeKuma(): FakeKuma {
  let monitors: Mon[] = [];
  let maintenance: { id: number; title: string; status: string; active: boolean }[] = [];
  let nextId = 10;
  let logins = 0;
  const sessions = new Map<string, { queue: string[]; user: boolean }>();
  const mon = (m: Partial<Mon> & Pick<Mon, "id" | "name" | "type">): Mon => ({
    url: null,
    hostname: null,
    port: null,
    parent: null,
    active: true,
    interval: 60,
    notificationIDList: { "1": true },
    tags: [],
    basic_auth_pass: null,
    pushToken: null,
    headers: null,
    ...m,
  });
  const reset = () => {
    monitors = [
      mon({ id: 1, name: "Media", type: "group" }),
      mon({
        id: 2,
        name: "Radarr",
        type: "http",
        url: `http://hearth:${SECRET}@radarr.lan:7878/?apikey=${SECRET}`,
        parent: 1,
        basic_auth_pass: SECRET,
        headers: `{"X-Api-Key":"${SECRET}"}`,
        tags: [{ name: "media", value: "" }],
      }),
      mon({ id: 3, name: "Sonarr", type: "http", url: "http://sonarr.lan:8989", parent: 1 }),
      mon({
        id: 4,
        name: "Home Assistant",
        type: "http",
        url: "https://ha.example.com",
        notificationIDList: {},
      }),
      mon({
        id: 5,
        name: "Old NAS",
        type: "ping",
        hostname: "192.168.1.20",
        active: false,
        notificationIDList: {},
      }),
      mon({ id: 6, name: "Nightly backup", type: "push", pushToken: SECRET, interval: 86400 }),
    ];
    maintenance = [{ id: 1, title: "NAS disk swap", status: "scheduled", active: true }];
    nextId = 10;
    logins = 0;
    sessions.clear();
  };
  reset();

  const now = Date.now();
  const at = (minutesAgo: number) =>
    new Date(now - minutesAgo * 60_000).toISOString().replace("T", " ").replace("Z", "");
  const beats = (m: Mon) => {
    if (m.type === "group" || !m.active) return [];
    const down = m.id === 3;
    return Array.from({ length: 30 }, (_, i) => ({
      id: m.id * 100 + i,
      monitor_id: m.id,
      status: down && i >= 26 ? 0 : 1,
      msg: down && i >= 26 ? "connect ECONNREFUSED 10.0.0.9:8989" : "200 - OK",
      time: at((30 - i) * 2),
      ping: down && i >= 26 ? null : 40 + ((i * 7) % 30),
      important: i === 0 || (down && i === 26) ? 1 : 0,
      duration: 120,
      down_count: 0,
    }));
  };
  const important = (m: Mon) =>
    beats(m)
      .filter((b) => b.important)
      .reverse()
      .map((b) => ({
        monitorID: m.id,
        status: b.status,
        time: b.time,
        msg: b.msg,
        ping: b.ping,
        important: true,
      }));
  const list = () =>
    Object.fromEntries(
      monitors.map((m) => [
        String(m.id),
        {
          ...m,
          pathName: m.parent
            ? `${monitors.find((x) => x.id === m.parent)?.name} / ${m.name}`
            : m.name,
        },
      ]),
    );
  const ev = (name: string, ...args: unknown[]) => `42${JSON.stringify([name, ...args])}`;
  const afterLogin = (q: string[]) => {
    q.push(ev("monitorList", list()));
    q.push(
      ev("info", {
        version: "2.5.9",
        latestVersion: "2.6.0",
        primaryBaseURL: null,
        serverTimezone: "UTC",
      }),
    );
    q.push(ev("maintenanceList", Object.fromEntries(maintenance.map((x) => [String(x.id), x]))));
    q.push(
      ev("notificationList", [
        {
          id: 1,
          name: "Discord",
          active: true,
          isDefault: true,
          config: JSON.stringify({
            discordWebhookUrl: `https://discord.com/api/webhooks/${SECRET}`,
          }),
        },
      ]),
    );
    q.push(
      ev("statusPageList", {
        "1": { id: 1, slug: "home", title: "Home services", published: true },
      }),
    );
  };
  const dashboard = (q: string[]) => {
    for (const m of monitors) {
      q.push(ev("heartbeatList", String(m.id), beats(m), false));
      const up = m.id === 3 ? 0.87 : m.active ? 1 : 0;
      q.push(ev("avgPing", String(m.id), m.active && m.type !== "group" ? 54.3 : null));
      q.push(ev("uptime", String(m.id), 24, up));
      q.push(ev("uptime", String(m.id), 720, m.id === 3 ? 0.981 : up));
      q.push(ev("uptime", String(m.id), "1y", up));
      if (m.id === 4)
        q.push(
          ev(
            "certInfo",
            String(m.id),
            JSON.stringify({ valid: true, certInfo: { daysRemaining: 9, subject: {} } }),
          ),
        );
    }
  };
  const handle = (sid: string, name: string, args: unknown[]): unknown => {
    const s = sessions.get(sid)!;
    const ok = (extra: object = {}) => ({ ok: true, ...extra });
    if (name === "login") {
      logins++;
      const l = args[0] as { username?: string; password?: string };
      if (!String(l.password ?? "").startsWith("e2e-"))
        return { ok: false, msg: "Incorrect username or password." };
      s.user = true;
      afterLogin(s.queue);
      return ok({ token: "kuma-e2e-token" });
    }
    if (name === "loginByToken") {
      if (args[0] !== "kuma-e2e-token") return { ok: false, msg: "Invalid token" };
      s.user = true;
      afterLogin(s.queue);
      return ok();
    }
    if (!s.user) return { ok: false, msg: "You are not logged in." };
    if (name === "monitorImportantHeartbeatListPaged") {
      const m = monitors.find((x) => x.id === Number(args[0]));
      return ok({ data: m ? important(m).slice(0, Number(args[2] ?? 10)) : [] });
    }
    if (name === "pauseMonitor" || name === "resumeMonitor") {
      const m = monitors.find((x) => x.id === Number(args[0]));
      if (!m) return { ok: false, msg: "You do not own this monitor." };
      m.active = name === "resumeMonitor";
      return ok({ msg: name === "pauseMonitor" ? "successPaused" : "successResumed" });
    }
    if (name === "add") {
      const m = args[0] as { name: string; url: string; interval: number; type: string };
      if (!Array.isArray((args[0] as { conditions?: unknown }).conditions))
        return { ok: false, msg: "conditions is not iterable" };
      const id = nextId++;
      monitors.push(
        mon({
          id,
          name: m.name,
          type: m.type,
          url: m.url,
          interval: m.interval,
          notificationIDList: {},
        }),
      );
      return ok({ msg: "successAdded", monitorID: id });
    }
    if (name === "deleteMonitor") {
      if (typeof args[1] !== "boolean") return { ok: false, msg: "deleteChildren must be given" };
      const id = Number(args[0]);
      if (!monitors.some((x) => x.id === id))
        return { ok: false, msg: "You do not own this monitor." };
      monitors = monitors
        .filter((x) => x.id !== id)
        .map((x) => (x.parent === id ? { ...x, parent: null } : x));
      return ok({ msg: "successDeleted" });
    }
    if (name === "pauseMaintenance" || name === "resumeMaintenance") {
      const w = maintenance.find((x) => x.id === Number(args[0]));
      if (!w) return { ok: false, msg: "Maintenance not found" };
      w.active = name === "resumeMaintenance";
      w.status = w.active ? "scheduled" : "inactive";
      return ok();
    }
    return { ok: false, msg: `Unknown event ${name}` };
  };

  const reply = (text: string, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  });

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname !== "/socket.io/") return reply("Not Found", 404);
    const sid = u.searchParams.get("sid");
    if (!sid) {
      const id = `fake${Math.random().toString(36).slice(2, 10)}`;
      sessions.set(id, { queue: [], user: false });
      return reply(
        `0${JSON.stringify({ sid: id, upgrades: ["websocket"], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1e6 })}`,
      );
    }
    const s = sessions.get(sid);
    if (!s) return reply(`{"code":1,"message":"Session ID unknown"}`, 400);
    if (init.method === "POST") {
      for (const p of String(init.body ?? "").split(SEP)) {
        if (p === "40") s.queue.push(`40${JSON.stringify({ sid: `${sid}-ns` })}`);
        else if (p === "41" || p === "1") sessions.delete(sid);
        else {
          const m = /^42(\d*)([\s\S]*)$/.exec(p);
          if (!m) continue;
          const [name, ...args] = JSON.parse(m[2]!) as [string, ...unknown[]];
          if (name === "dashboardRendered") {
            if (s.user) dashboard(s.queue);
            continue;
          }
          const answer = handle(sid, name, args);
          if (m[1]) s.queue.push(`43${m[1]}${JSON.stringify([answer])}`);
        }
      }
      return reply("ok");
    }
    // A GET waits briefly for packets, as the real server's long poll does.
    for (let i = 0; i < 20 && sessions.has(sid) && !s.queue.length; i++)
      await new Promise((r) => setTimeout(r, 25));
    if (!sessions.has(sid)) return reply("1");
    const out = s.queue.splice(0);
    return reply(out.length ? out.join(SEP) : "6");
  };

  return { fetch: fetchImpl, reset, passwordLogins: () => logins };
}
