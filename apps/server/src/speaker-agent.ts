import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { HostSpeaker } from "./apps/host-speaker";

/**
 * Hearth Speaker: another computer as a speaker, in the background (11-06: the browser
 * tab over remote desktop skipped, lagged and dropped off the list). Runs on that computer,
 * plays through its own sound, and talks to Hearth's speaker relay, so Music Assistant's key
 * never leaves Hearth. Signs in once with a one-time pairing code, then keeps the session.
 *
 *   node hearth-speaker.mjs --hearth http://hearth:7600 --code ABCD-1234 [--name "Den PC"]
 *   node hearth-speaker.mjs            (after the first time)
 */

const dir = path.join(
  process.env.APPDATA ?? path.join(process.env.HOME ?? ".", ".config"),
  "Hearth Speaker",
);
const file = path.join(dir, "settings.json");
type Settings = { hearth?: string; cookie?: string; name?: string; clientId?: string };

const read = (): Settings => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Settings;
  } catch {
    return {};
  }
};
const write = (s: Settings) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
};

/** Started hidden, nobody sees the console: what it says also goes to speaker.log. */
function say(line: string) {
  console.log(line);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, "speaker.log"),
      `${new Date().toISOString()} ${line}
`,
    );
  } catch {
    // no log, still plays
  }
}

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function pair(hearth: string, code: string): Promise<string> {
  const r = await fetch(`${hearth}/api/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) throw new Error(`Hearth didn't accept the code (${r.status}). Make a new one.`);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("Hearth didn't sign this speaker in.");
  return cookie;
}

async function main() {
  const saved = read();
  const hearth = (arg("hearth") ?? saved.hearth ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(hearth)) throw new Error("Give Hearth's address: --hearth http://…");
  const name = arg("name") ?? saved.name ?? `${hostname()} speakers`;
  const code = arg("code");
  const cookie = code ? await pair(hearth, code) : saved.cookie;
  if (!cookie) throw new Error("Pair it first: --code with a code from Hearth's Speakers.");
  write({ ...saved, hearth, cookie, name });

  const relay = `${hearth.replace(/^http/, "ws")}/api/home/speaker/socket`;
  const speaker = new HostSpeaker(
    {
      dataDir: dir,
      upstream: async () => ({ url: relay }),
      // Node's WebSocket can't send the session cookie; ws can.
      open: (url) => {
        return new WebSocket(`${url}?client=${clientId()}`, {
          headers: { cookie },
        }) as unknown as globalThis.WebSocket;
      },
      prebufferMs: 300,
    },
    name,
  );
  const st = await speaker.set(true);
  say(`Hearth Speaker "${name}": ${st.state}${st.detail ? ` (${st.detail})` : ""}`);
  setInterval(() => {
    const s = speaker.get();
    if (s.state === "error" || s.state === "not-linked") say(`${s.state} ${s.detail ?? ""}`);
  }, 60_000);
  const stop = () => {
    speaker.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** The same id every time, so Music Assistant keeps it as one speaker. */
function clientId() {
  const s = read();
  if (s.clientId) return s.clientId;
  const id = `hearth-speaker-${Math.random().toString(36).slice(2, 12)}`;
  write({ ...s, clientId: id });
  return id;
}

main().catch((e: unknown) => {
  say(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
