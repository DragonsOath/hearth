import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmberBrowser, findBrowser, followable, isPrivateAddress } from "./manager";

// Ember's Browser against a real installed browser and a page served here. Skipped where no
// Edge, Chrome or Chromium is installed.

describe("Ember's Browser: a link worth opening after its click went nowhere", () => {
  it("a real page elsewhere, not this page's own anchor or a script link", () => {
    expect(followable("https://a.test/m/1", "https://a.test/")).toBe(true);
    expect(followable("https://a.test/#top", "https://a.test/")).toBe(false);
    expect(followable("javascript:void(0)", "https://a.test/")).toBe(false);
    expect(followable("not a url", "https://a.test/")).toBe(false);
  });
});

describe("Ember's Browser: which addresses", () => {
  it("knows the owner's own network, this machine and Tailscale from the internet", () => {
    for (const ip of [
      "10.0.0.5",
      "127.0.0.1",
      "192.168.1.77",
      "172.20.1.1",
      "100.101.2.3",
      "169.254.1.1",
      "::1",
      "fd12::1",
      "::ffff:192.168.1.5",
    ])
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    for (const ip of ["93.184.215.14", "1.1.1.1", "172.32.0.1", "2606:4700::1111"])
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
  });
});

const exe = findBrowser();
describe.skipIf(!exe)("Ember's Browser: a real browser", () => {
  let server: Server;
  let base = "";
  const posted: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === "POST") {
        posted.push(req.url ?? "");
        res.end("posted");
        return;
      }
      res.setHeader("Content-Type", "text/html");
      if (req.url?.startsWith("/check"))
        return res.end(`<title>Check</title><body style="margin:0"><h1 id="out">waiting</h1>
          <div id="box" style="position:absolute;left:0;top:20%;width:100%;height:30%"
            onclick="document.getElementById('out').textContent='clicked'">I am human</div>
          <form style="position:absolute;left:0;top:60%;width:100%;height:30%;margin:0" onsubmit="event.preventDefault();document.getElementById('out').textContent='typed '+document.getElementById('p').value.length">
            <input type="password" id="p" aria-label="Password" style="width:100%;height:100%"></form></body>`);
      if (req.url?.startsWith("/refuse")) {
        res.statusCode = 403;
        return res.end("<title>Forbidden</title><h1>403 Forbidden</h1>");
      }
      if (req.url?.startsWith("/covered"))
        // Like Rotten Tomatoes: smooth scrolling, and a layer over the link that eats the click.
        return res.end(`<title>Covered</title><style>html{scroll-behavior:smooth}</style>
          <div style="height:2400px"></div>
          <div style="position:relative"><a href="/next" style="display:block;height:40px">Read reviews</a>
          <div style="position:absolute;inset:0" onclick="event.preventDefault()"></div></div>
          <div style="height:2400px"></div>`);
      if (req.url?.startsWith("/next"))
        return res.end("<title>Next page</title><h1>You arrived</h1>");
      if (req.url?.startsWith("/menus"))
        return res.end(`<title>Menus</title>
          <label for="day">First day</label>
          <select id="day"><option value="0">Sunday</option><option value="1">Monday</option></select>
          <p id="out">none</p>
          <div id="custom" style="cursor:pointer">Theme: Light</div>
          <div id="list" hidden style="position:absolute;top:120px;left:10px;width:200px">
            <div class="opt"><span>Light</span></div>
            <div class="opt"><span>Dark</span></div>
          </div>
          <input aria-label="Name" id="name">
          <script>
            const out = document.getElementById("out");
            document.getElementById("day").addEventListener("change", (e) => (out.textContent = "day " + e.target.value));
            document.getElementById("custom").addEventListener("click", () => (document.getElementById("list").hidden = false));
            for (const o of document.querySelectorAll(".opt")) o.addEventListener("click", () => {
              document.getElementById("custom").textContent = "Theme: " + o.innerText;
              document.getElementById("list").hidden = true;
            });
            document.getElementById("name").addEventListener("keydown", (e) => (out.textContent = "key " + e.key));
          </script>`);
      res.end(`<title>Test page</title>
        <h1>Ratings</h1><p>Night of the Living Dead: 96%</p>
        <a href="/next">Go on</a>
        <form method="get" action="/next"><input type="search" name="q" aria-label="Search"></form>
        <form method="post" action="/submit"><input name="x" aria-label="Field"><button>Send it</button></form>
        <input type="password" aria-label="Password">`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(() => server.close());

  it("opens, reads, clicks, types, sends ordinary forms, refuses passwords, and cleans up", async () => {
    const b = new EmberBrowser({ allowLocal: true });
    try {
      const page = await b.open(`${base}/`, "ember");
      expect(page.title).toBe("Test page");
      const read = await b.read();
      expect(read.text).toContain("Night of the Living Dead: 96%");
      const link = read.controls.find((c) => c.name === "Go on")!;
      const after = await b.click(link.ref);
      expect(after.title).toBe("Next page");
      // The marker is where Hearth really clicked.
      expect(b.state().pointer).toMatchObject({ kind: "click" });

      await b.history("back", "ember");
      const again = await b.read();
      const search = again.controls.find((c) => c.name === "Search")!;
      const searched = await b.type(search.ref, "horror", true);
      expect(searched.url).toContain("/next?q=horror");

      await b.history("back", "ember");
      const third = await b.read();
      await expect(
        b.type(third.controls.find((c) => c.role === "password")!.ref, "x"),
      ).rejects.toThrow(/never types into a password box/);
      // An ordinary form on a website is sent (what matters is the operation, not the browser).
      await b.click(third.controls.find((c) => c.name === "Send it")!.ref);
      expect(posted).toEqual(["/submit"]);
      expect(b.state().status).toBe("live");
    } finally {
      await b.close();
    }
    expect(b.state().status).toBe("off");
  }, 60_000);

  it("a link whose click goes nowhere still opens where it leads", async () => {
    const b = new EmberBrowser({ allowLocal: true });
    try {
      await b.open(`${base}/covered`, "ember");
      const link = (await b.read()).controls.find((c) => c.name === "Read reviews")!;
      const after = await b.click(link.ref);
      expect(after.title).toBe("Next page");
      expect(b.state().last?.label ?? "").toMatch(/Opened the link "Read reviews"/);
    } finally {
      await b.close();
    }
  }, 60_000);

  it("takes the panel's shape so the page fills it, within the sizes a page can have", async () => {
    const b = new EmberBrowser({ allowLocal: true });
    try {
      await b.open(`${base}/`, "ember");
      expect(await b.resize(1500, 1100)).toEqual({ width: 1500, height: 1100 });
      expect(b.state().viewport).toEqual({ width: 1500, height: 1100 });
      const read = await b.read();
      expect(read.title).toBe("Test page");
      // The page itself is that size now.
      const inner = b as unknown as {
        send: (m: string, p: object, t: unknown) => Promise<unknown>;
        tab: () => unknown;
      };
      const m = (await inner.send("Page.getLayoutMetrics", {}, inner.tab())) as {
        cssLayoutViewport: { clientWidth: number; clientHeight: number };
      };
      expect(m.cssLayoutViewport.clientHeight).toBe(1100);
      expect(await b.resize(100, 99_999)).toEqual({ width: 640, height: 1600 });
    } finally {
      await b.close();
    }
  }, 60_000);

  it("hands the page to the owner for a CAPTCHA or a password, then carries on (45.18)", async () => {
    const b = new EmberBrowser({ allowLocal: true });
    try {
      await b.open(`${base}/check`, "ember");
      await expect(b.ownerInput({ kind: "type", text: "x" })).rejects.toThrow(/Take over first/);
      const r = await b.read();
      b.handOver("solve the check", "ember", "c1");
      expect(b.state().handover).toMatchObject({ reason: "solve the check", by: "ember" });
      // Ember waits while the owner has it.
      await expect(b.click(r.controls[0]!.ref)).rejects.toThrow(/owner has Ember's Browser/);
      await expect(b.open(`${base}/next`, "ember")).rejects.toThrow(/owner has/);
      // The owner clicks on the picture where the box is, and types a password Ember never could.
      await b.ownerInput({ kind: "click", fx: 0.5, fy: 0.35 });
      expect((await b.read()).text).toContain("clicked");
      await b.ownerInput({ kind: "click", fx: 0.5, fy: 0.75 });
      await b.ownerInput({ kind: "type", text: "hunter2" });
      await b.ownerInput({ kind: "key", key: "Enter" });
      const back = b.giveBack();
      expect(back.handed).toMatchObject({ reason: "solve the check", conversationId: "c1" });
      expect(b.state().handover).toBeUndefined();
      const after = await b.read();
      expect(after.text).toContain("typed 7");
      // What the owner typed is nowhere Ember or the panel can see.
      expect(JSON.stringify([after, b.state()])).not.toContain("hunter2");
      await b.click(after.controls[0]!.ref);
    } finally {
      await b.close();
    }
  }, 60_000);

  it("a site that refuses the background browser opens in a visible window when the owner says yes (45.19)", async () => {
    let saved: string[] = [];
    const b = new EmberBrowser({
      allowLocal: true,
      testHeadless: true,
      visibleSites: { load: async () => [], save: async (h) => void (saved = h) },
    });
    const before = process.env.DC_BROWSER_SCREEN;
    try {
      const page = await b.open(`${base}/refuse`, "ember");
      expect(page.status).toBe(403);
      expect((await b.open(`${base}/next`, "ember")).status).toBe(200);
      // No screen here: she says so instead of asking.
      process.env.DC_BROWSER_SCREEN = "0";
      expect(b.state().screen).toBe(false);
      await expect(b.askVisible(`${base}/refuse`, "it refuses", "c1")).rejects.toThrow(/no screen/);
      process.env.DC_BROWSER_SCREEN = "1";
      // She asks; nothing changes until the owner answers.
      const r = await b.askVisible(`${base}/refuse`, "it refuses", "c1");
      expect(r).toMatchObject({ asked: { host: "127.0.0.1", conversationId: "c1" } });
      expect(b.state()).toMatchObject({ window: "background", visibleAsk: { host: "127.0.0.1" } });
      // No: the ask goes, the browser stays as it was.
      expect((await b.answerVisible("no")).page).toBeUndefined();
      expect(b.state().visibleAsk).toBeUndefined();
      expect(b.state().window).toBe("background");
      // Always: it opens in a visible window, and the site is remembered.
      await b.askVisible(`${base}/next`, "it refuses", "c1");
      const yes = await b.answerVisible("always");
      expect(yes.page?.title).toBe("Next page");
      expect(b.state()).toMatchObject({ window: "visible", visibleSites: ["127.0.0.1"] });
      expect(saved).toEqual(["127.0.0.1"]);
      // Already visible and still refused: she leaves it.
      await expect(b.askVisible(`${base}/refuse`, "again")).rejects.toThrow(
        /already a visible window/,
      );
      // Closed: the next start is the background browser; an always-allowed site opens straight away.
      await b.close();
      expect(b.state().window).toBe("background");
      await b.open(`${base}/refuse`, "ember");
      const again = await b.askVisible(`${base}/next`, "it refuses");
      expect(again).toMatchObject({ opened: { title: "Next page" } });
      expect(b.state().window).toBe("visible");
      await b.forgetSite("127.0.0.1");
      expect(b.state().visibleSites).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.DC_BROWSER_SCREEN;
      else process.env.DC_BROWSER_SCREEN = before;
      await b.close();
    }
  }, 60_000);

  it("works custom menus, dropdown lists and keys, the way a person would", async () => {
    const b = new EmberBrowser({ allowLocal: true });
    try {
      await b.open(`${base}/menus`, "ember");
      let r = await b.read();
      // A dropdown list shows its options and value; choosing one fires the page's own handler.
      const day = r.controls.find((c) => c.role === "select")!;
      expect(day).toMatchObject({
        name: "First day",
        options: ["Sunday", "Monday"],
        value: "Sunday",
      });
      await b.choose(day.ref, "Monday");
      r = await b.read();
      expect(r.text).toContain("day 1");
      expect(r.controls.find((c) => c.role === "select")!.value).toBe("Monday");
      await expect(b.choose(day.ref, "Friday")).rejects.toThrow(/Its options: Sunday, Monday/);
      // A custom menu: a plain element with only a click handler is still a control, and so are
      // its choices, plain alike elements in the pop-up it opens (as Radarr draws them).
      await b.click(r.controls.find((c) => c.name === "Theme: Light")!.ref);
      r = await b.read();
      await b.click(r.controls.find((c) => c.name === "Dark")!.ref);
      r = await b.read();
      expect(r.text).toContain("Theme: Dark");
      // Keys for menus and forms, never anything else.
      await b.click(r.controls.find((c) => c.name === "Name")!.ref);
      await b.key("Escape");
      expect((await b.read()).text).toContain("key Escape");
      await expect(b.key("Delete")).rejects.toThrow(/can press/);
    } finally {
      await b.close();
    }
  }, 60_000);

  it("never closes itself under an active task, recovers when the browser dies, and cleans up after", async () => {
    const b = new EmberBrowser({ allowLocal: true, idleMs: 1500 });
    try {
      // The task holds it before anything opens (a slow machine may take longer than the idle time).
      b.use("task-1");
      await b.open(`${base}/`, "ember");
      await new Promise((r) => setTimeout(r, 3500));
      // Idle for longer than its idle time, but a task is using it: still open.
      expect(b.state().status).toBe("live");
      b.release("task-1");
      for (let i = 0; i < 80 && b.state().status === "live"; i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(b.state().status).toBe("off");

      // The browser process dies mid-task: the next call starts a fresh one.
      await b.open(`${base}/`, "ember");
      (b as unknown as { proc: { kill: () => void } }).proc.kill();
      for (let i = 0; i < 30 && b.state().status === "live"; i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(b.state().status).toBe("off");
      const again = await b.open(`${base}/`, "ember");
      expect(again.title).toBe("Test page");
      expect((await b.read()).text).toContain("Night of the Living Dead");
    } finally {
      await b.close();
    }
    expect(b.state().status).toBe("off");
  }, 60_000);

  it("refuses this machine and the owner's network outside tests", async () => {
    const b = new EmberBrowser();
    try {
      await expect(b.open(`${base}/`, "ember")).rejects.toThrow(/your own network/);
      await expect(b.open("http://192.168.1.77:7878/", "ember")).rejects.toThrow(
        /your own network/,
      );
      await expect(b.open("file:///etc/passwd", "ember")).rejects.toThrow(/web pages only/);
    } finally {
      await b.close();
    }
  }, 30_000);
});

describe.skipIf(!exe)("Ember's Browser: the owner's apps", () => {
  // "app" plays one of the owner's apps (registered in Hearth); "site" plays a website.
  let appServer: Server;
  let siteServer: Server;
  let app = "";
  let site = "";
  const writes: string[] = [];
  const SECRET = "SuperSecretApiKey-1234567";
  beforeAll(async () => {
    appServer = createServer((req, res) => {
      if (req.method !== "GET") {
        writes.push(`${req.method} ${req.url}`);
        return res.end("saved");
      }
      res.setHeader("Content-Type", "text/html");
      if (req.url === "/backup")
        return res
          .writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="radarr_backup.zip"',
          })
          .end("PK-backup-bytes");
      const signed = (req.headers.cookie ?? "").includes("RadarrAuth=sess-777");
      res.end(`<title>Radarr</title><h1>${signed ? "Signed in" : "Sign in please"}</h1>
        <p>API key: ${SECRET}</p>
        <a href="/backup">Download backup</a>
        <button onclick="fetch('/api/v3/config', { method: 'PUT', body: '{}' }).then(() => document.title = 'Saved')">Save</button>`);
    });
    siteServer = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<title>Evil</title><button onclick="fetch('${app}/api/v3/config', { method: 'PUT', body: '{}', mode: 'no-cors' }).catch(() => {}).finally(() => document.title = 'Tried')">Go</button>`,
      );
    });
    await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => siteServer.listen(0, "127.0.0.1", r));
    const port = (s: Server) => (s.address() as { port: number }).port;
    app = `http://127.0.0.1:${port(appServer)}`;
    site = `http://127.0.0.1:${port(siteServer)}`;
  });
  afterAll(() => {
    appServer.close();
    siteServer.close();
  });

  it("signs in, hides the app's secrets, needs approval for changes, and blocks other sites", async () => {
    let approved = false;
    const dir = mkdtempSync(path.join(tmpdir(), "ember-dl-"));
    const b = new EmberBrowser({
      allowLocal: true,
      downloads: dir,
      scope: async (origin) =>
        origin === app
          ? { serviceId: "radarr-test", name: "Radarr (test)", origin, protected: false }
          : undefined,
      signIn: async () => ({
        cookies: [{ name: "RadarrAuth", value: "sess-777", httpOnly: true }],
        how: "The app's own sign-in form, sent by Hearth",
      }),
      mayChange: async () => (approved ? undefined : "Changing Radarr (test) needs your approval."),
      secrets: async () => [SECRET],
    });
    try {
      await b.open(`${app}/`, "ember");
      expect(b.signInFor(app)).toMatchObject({ state: "signed-in" });
      const read = await b.read();
      expect(read.text).toContain("Signed in");
      // The key the page prints never leaves in what Ember reads, and no picture of it is taken.
      expect(read.text).not.toContain(SECRET);
      expect(read.text).toContain("API key: [hidden]");
      await expect(b.screenshot()).rejects.toThrow(/shows one of the app's secrets/);
      expect(JSON.stringify(b.state())).not.toContain("sess-777");

      // A change without approval is not sent; with it, it is.
      await b.click(read.controls.find((c) => c.name === "Save")!.ref);
      await new Promise((r) => setTimeout(r, 500));
      expect(writes).toEqual([]);
      approved = true;
      b.lookOnly(true);
      await b.click((await b.read()).controls.find((c) => c.name === "Save")!.ref);
      await new Promise((r) => setTimeout(r, 500));
      expect(writes).toEqual([]);
      b.lookOnly(false);
      await b.click((await b.read()).controls.find((c) => c.name === "Save")!.ref);
      await new Promise((r) => setTimeout(r, 800));
      expect(writes).toEqual(["PUT /api/v3/config"]);

      // A download lands in Hearth's folder.
      await b.click((await b.read()).controls.find((c) => c.name === "Download backup")!.ref);
      for (let i = 0; i < 40 && b.state().downloads?.[0]?.state !== "done"; i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(b.state().downloads?.[0]).toMatchObject({ name: "radarr_backup.zip", state: "done" });

      // Another site's page can never reach the app, approved or not.
      await b.open(`${site}/`, "ember");
      await b.click((await b.read()).controls.find((c) => c.name === "Go")!.ref);
      await new Promise((r) => setTimeout(r, 800));
      expect(writes).toEqual(["PUT /api/v3/config"]);
    } finally {
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("holds a change for approval instead of sending it: the exact request, with the page's session", async () => {
    const before = writes.length;
    const staged: { method: string; url: string; body?: string; cookie?: string }[] = [];
    const b = new EmberBrowser({
      allowLocal: true,
      scope: async (origin) =>
        origin === app
          ? { serviceId: "radarr-test", name: "Radarr (test)", origin, protected: false }
          : undefined,
      signIn: async () => ({ cookies: [{ name: "RadarrAuth", value: "sess-777" }], how: "form" }),
      mayChange: async () => "Changing Radarr (test) needs your approval.",
      stage: async (input) => {
        staged.push(input);
        return {
          id: "h1",
          serviceId: input.serviceId,
          serviceName: input.serviceName,
          method: input.method,
          path: "/api/v3/config",
          changes: [],
          summary: "Radarr (test): a change",
          at: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    });
    try {
      await b.open(`${app}/`, "ember");
      await b.click((await b.read()).controls.find((c) => c.name === "Save")!.ref);
      await new Promise((r) => setTimeout(r, 800));
      expect(writes.length).toBe(before);
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({ method: "PUT", url: `${app}/api/v3/config`, body: "{}" });
      expect(staged[0]!.cookie).toContain("RadarrAuth=sess-777");
      expect(b.takeHeld().map((h) => h.id)).toEqual(["h1"]);
      expect(b.takeHeld()).toEqual([]);
      expect(b.state().blocked?.why).toMatch(/Held for your approval, not sent/);
    } finally {
      await b.close();
    }
  }, 60_000);
});
