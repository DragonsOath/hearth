import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Companion } from "./client";
import { briefingText, recallText } from "./format";
import { isHomelab } from "./relevance";
import { onPrompt, onTurnEnd } from "./sessions";
import { readSession } from "./transcript";

/**
 * A stand-in for Hearth with just the routes the companion uses,
 * so outages can be switched on and off exactly. The real server's side
 * of each route is tested in apps/server.
 */
function fakeDragonControl() {
  const entries: Record<string, unknown>[] = [];
  const transcripts: {
    id: string;
    sessionRef: string;
    messages: Map<number, string>;
    ended: boolean;
  }[] = [];
  const requests: string[] = [];
  let down = false;
  const server = http.createServer((req, res) => {
    if (down) {
      req.socket.destroy();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (req.headers.authorization !== "Bearer dc_test") return send(401, { message: "no" });
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const url = new URL(req.url!, "http://x");
      if (url.pathname === "/api/companion/briefing") {
        return send(200, {
          asOf: new Date().toISOString(),
          installation: "Home",
          sampleData: false,
          needsYou: [],
          system: {
            servicesTotal: 30,
            notHealthy: [],
            hosts: [
              {
                name: "Homeserver",
                os: "Homeserver OS 18",
                connection: "this-machine",
                health: "healthy",
              },
            ],
            openIncidents: 0,
          },
          backups: { lastOkAt: new Date().toISOString() },
          since: "2026-10-01T00:00:00Z",
          recent: [],
          openThreads: entries.filter((e) => e.kind === "thread"),
          projects: [
            {
              id: "plezy",
              name: "Plezy",
              summary: "",
              status: "active",
              entries: 0,
              openThreads: 0,
              createdAt: "",
              updatedAt: "",
            },
          ],
          howYouWork: [],
          hardware: [],
          recentSessions: [],
          counts: { memories: entries.length, transcripts: transcripts.length },
          ownerName: "Sam",
          vocabulary: ["Homeserver", "Tasterr"],
          opening: [
            { kind: "win", text: "Every app moved to Homeserver (2 days ago)." },
            { kind: "idea", text: "Media on Homeserver is 91% full." },
          ],
        });
      }
      if (url.pathname === "/api/memory/entries" && req.method === "POST") {
        if (!body.title) return send(400, { message: "title: Give it a title" });
        const existing = entries.find((e) => e.clientRef && e.clientRef === body.clientRef);
        if (existing) return send(201, existing);
        const entry = {
          id: `e${entries.length + 1}`,
          links: [],
          status: body.kind === "thread" ? "open" : undefined,
          happenedAt: new Date().toISOString(),
          ...body,
        };
        entries.push(entry);
        return send(201, entry);
      }
      if (url.pathname === "/api/memory/entries" && req.method === "GET") return send(200, entries);
      if (url.pathname === "/api/memory/projects") return send(200, []);
      if (url.pathname === "/api/memory/transcripts" && req.method === "POST") {
        let t = transcripts.find((x) => x.sessionRef === body.sessionRef);
        if (!t) {
          t = {
            id: `t${transcripts.length + 1}`,
            sessionRef: String(body.sessionRef),
            messages: new Map(),
            ended: false,
          };
          transcripts.push(t);
        }
        return send(201, { id: t.id });
      }
      const m = /^\/api\/memory\/transcripts\/(\w+)\/(messages|end)$/.exec(url.pathname);
      if (m) {
        const t = transcripts.find((x) => x.id === m[1])!;
        if (m[2] === "end") {
          t.ended = true;
          return send(200, {});
        }
        for (const msg of body.messages as { seq: number; text: string }[])
          t.messages.set(msg.seq, msg.text);
        return send(200, { added: 1, skipped: 0, lastSeq: 0 });
      }
      return send(404, { message: "not here" });
    });
  });
  return {
    entries,
    transcripts,
    requests,
    setDown: (value: boolean) => (down = value),
    start: () =>
      new Promise<string>((resolve) =>
        server.listen(0, "127.0.0.1", () =>
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
        ),
      ),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let home: string;
let dc: ReturnType<typeof fakeDragonControl>;
let companion: Companion;

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "dc-companion-"));
  process.env.DC_COMPANION_HOME = home;
  dc = fakeDragonControl();
  const url = await dc.start();
  companion = new Companion({ url, key: "dc_test" }, 1500);
});

afterEach(async () => {
  await dc.stop();
  delete process.env.DC_COMPANION_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("homelab mode", () => {
  it("recognises homelab talk, including names it learned, and leaves other work alone", () => {
    expect(isHomelab("Plex keeps buffering on the tablet")).toBe(true);
    expect(isHomelab("why is Sonarr not grabbing anything")).toBe(true);
    expect(isHomelab("the arr stack is acting up")).toBe(true);
    expect(isHomelab("help me with this resume bullet")).toBe(false);
    expect(isHomelab("fix the flexbox in my react component")).toBe(false);
    expect(isHomelab("the hero rows look off again", ["Hero rows"])).toBe(true);
    // Your own machine names are learned, never built in.
    expect(isHomelab("tasterr is down")).toBe(false);
  });

  it("opens with what's up, uses the owner's name, and learns their words from the briefing", async () => {
    const text = briefingText(await companion.briefing());
    expect(text).toContain("## What's up");
    expect(text).toContain("- Win: Every app moved to Homeserver (2 days ago).");
    expect(text).toContain("- Idea: Media on Homeserver is 91% full.");
    expect(text).toContain("The owner's name is Sam.");
    expect(text).toContain("## Needs Sam");
    expect(text).not.toMatch(/the owner/);
    // The names it learned now switch homelab mode on.
    const names = JSON.parse(readFileSync(path.join(home, "cache", "names.json"), "utf8"));
    expect(names).toEqual(expect.arrayContaining(["Homeserver", "Tasterr"]));
  });

  it("labels history as history, so it is never taken for the current setup", () => {
    const text = recallText(
      {
        live: true,
        at: new Date().toISOString(),
        data: {
          hits: [],
          entries: [
            {
              id: "e1",
              kind: "note",
              title: "Plex",
              body: "Runs on Windows.",
              happenedAt: "2026-08-01T12:00:00Z",
              basis: "documented",
              source: "import",
              links: [],
              createdAt: "",
              updatedAt: "",
              superseded: { at: "2026-10-08T00:00:00Z", reason: "Plex now runs on Homeserver." },
            },
          ],
        },
      },
      "http://dc",
    );
    expect(text).toMatch(/HISTORY: no longer how things are.*Plex now runs on Homeserver\./);
  });

  it("turns on with the first homelab prompt, hands Claude a live briefing, and stays quiet after", async () => {
    expect(
      await onPrompt(companion, { session_id: "s1", prompt: "write a cover letter" }),
    ).toBeUndefined();
    expect(dc.requests).toEqual([]); // no network for unrelated prompts

    const context = await onPrompt(companion, {
      session_id: "s1",
      prompt: "Plex is buffering again",
    });
    expect(context).toContain("You are in homelab mode");
    expect(context).toContain("[Hearth: LIVE.");
    expect(context).toContain("Plezy");
    expect(
      await onPrompt(companion, { session_id: "s1", prompt: "and Jellyfin too" }),
    ).toBeUndefined();
  });
});

describe("when Hearth is unreachable", () => {
  it("answers from the cached copy, marked as cached with its age, never as live", async () => {
    expect((await companion.briefing()).live).toBe(true);
    dc.setDown(true);
    const cached = await companion.briefing();
    expect(cached.live).toBe(false);
    const text = briefingText(cached, "https://homeserver");
    expect(text).toMatch(
      /^\[Hearth: CACHED copy from .+ \(\d+ minutes old\)\. Hearth could not be reached just now/,
    );
    expect(text).toContain("Nothing below was verified now");
    expect(text).not.toContain("LIVE");
  });

  it("says plainly when there is nothing cached at all", async () => {
    dc.setDown(true);
    const text = briefingText(await companion.briefing());
    expect(text).toContain("UNREACHABLE and nothing cached");
  });

  it("queues saves while away and sends them, once each and in order, when it is back", async () => {
    dc.setDown(true);
    const first = await companion.remember({
      kind: "thread",
      title: "Move Caddy to Homeserver",
      basis: "stated",
    });
    const second = await companion.remember({
      kind: "journal",
      title: "Plex fixed",
      basis: "observed",
    });
    expect(first).toMatchObject({ sent: false, queued: 1 });
    expect(second).toMatchObject({ sent: false, queued: 2 });
    // Offline recall still finds the unsent save.
    const recall = await companion.search("caddy");
    expect(recall.live).toBe(false);
    expect(recall.data!.entries.map((e) => e.title)).toEqual(["Move Caddy to Homeserver"]);

    dc.setDown(false);
    expect(await companion.flush()).toEqual({ sent: 2, left: 0 });
    expect(dc.entries.map((e) => e.title)).toEqual(["Move Caddy to Homeserver", "Plex fixed"]);
    // Sending again (say, the reply was lost) never duplicates: each save carries its own id.
    const ref = dc.entries[0]!.clientRef as string;
    expect(ref).toBeTruthy();
    expect(await companion.flush()).toEqual({ sent: 0, left: 0 });
    expect(dc.entries).toHaveLength(2);
  });

  it("sets aside a save Hearth refuses instead of retrying it forever", async () => {
    dc.setDown(true);
    await companion.remember({ kind: "note", title: "", basis: "unknown" });
    await companion.remember({ kind: "note", title: "fine", basis: "unknown" });
    dc.setDown(false);
    expect(await companion.flush()).toEqual({ sent: 1, left: 0 });
    expect(readdirSync(path.join(home, "rejected"))).toHaveLength(1);
  });
});

describe("saving sessions word for word", () => {
  function sessionFile(lines: unknown[], partial = "") {
    const file = path.join(home, "session.jsonl");
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + partial);
    return file;
  }
  const said = (text: string) => ({
    type: "user",
    message: { content: text },
    timestamp: "2026-10-08T10:00:00Z",
  });
  const wrote = (content: unknown[]) => ({
    type: "assistant",
    message: { content },
    timestamp: "2026-10-08T10:00:05Z",
  });

  it("keeps what was said and done, leaves out reasoning, tool output, and system text", () => {
    const file = sessionFile(
      [
        said("Why is Plex buffering?"),
        {
          type: "user",
          isMeta: true,
          message: { content: "<system-reminder>x</system-reminder>" },
        },
        wrote([{ type: "thinking", thinking: "private" }]),
        wrote([{ type: "tool_use", name: "Bash", input: { command: "docker ps" } }]),
        { type: "user", message: { content: [{ type: "tool_result", content: "secret output" }] } },
        wrote([{ type: "text", text: "The transcoder is pegged." }]),
        { type: "ai-title", aiTitle: "Plex buffering" },
      ],
      '{"type":"user","message":{"content":"half wri',
    );
    const { messages, title, lines } = readSession(file);
    expect(title).toBe("Plex buffering");
    expect(lines).toBe(7);
    expect(messages).toEqual([
      { seq: 1, role: "you", text: "Why is Plex buffering?", at: "2026-10-08T10:00:00Z" },
      {
        seq: 4,
        role: "tool",
        text: 'Used Bash({"command":"docker ps"})',
        at: "2026-10-08T10:00:05Z",
      },
      { seq: 6, role: "ai", text: "The transcoder is pegged.", at: "2026-10-08T10:00:05Z" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("secret output");
    expect(JSON.stringify(messages)).not.toContain("private");
  });

  it("saves only homelab sessions, only new lines each time, and catches up after an outage", async () => {
    const lines: unknown[] = [
      said("help with my resume"),
      wrote([{ type: "text", text: "Sure." }]),
    ];
    const file = sessionFile(lines);
    await onTurnEnd(companion, { session_id: "plain", transcript_path: file });
    expect(dc.transcripts).toEqual([]); // not a homelab session: nothing saved

    await onPrompt(companion, {
      session_id: "lab",
      prompt: "Plex is buffering",
      transcript_path: file,
    });
    lines.push(
      said("Plex is buffering"),
      wrote([{ type: "text", text: "Checking the transcoder." }]),
    );
    sessionFile(lines);
    await onTurnEnd(companion, { session_id: "lab", transcript_path: file });
    expect([...dc.transcripts[0]!.messages.keys()]).toEqual([1, 2, 3, 4]);

    dc.setDown(true);
    lines.push(said("fixed?"), wrote([{ type: "text", text: "Yes, it is back." }]));
    sessionFile(lines);
    await onTurnEnd(companion, { session_id: "lab", transcript_path: file }, true);
    expect(companion.pending().map((p) => p.op)).toEqual(["transcript"]);

    dc.setDown(false);
    const { syncSession } = await import("./sessions");
    expect(await companion.flush((id) => syncSession(companion, id))).toEqual({ sent: 1, left: 0 });
    expect([...dc.transcripts[0]!.messages.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(dc.transcripts).toHaveLength(1);
    // It ended while Hearth was away; that is passed on with the catch-up.
    expect(dc.transcripts[0]!.ended).toBe(true);
  });
});
