import { describe, expect, it } from "vitest";
import { arrSignsIn, setupArr } from "./setup";

/**
 * Radarr's sign-in check (11-22): the app keeps user names in lower case, so reading the name back
 * and comparing it failed a working sign-in for any name with a capital letter. Now Hearth signs
 * in on the app's own sign-in page, as the owner will.
 */
function fakeRadarr(opts: { method?: string; login: "ok" | "fails" }) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "json" } });
    if (url.pathname === "/api/v3/system/status") return json({ version: "6.0" });
    if (url.pathname === "/api/v3/config/host" && init?.method === "PUT")
      return new Response("{}", { status: 202 });
    if (url.pathname === "/api/v3/config/host")
      // Kept in lower case, as Radarr does.
      return json({ authenticationMethod: opts.method ?? "forms", username: "alexsmith" });
    if (url.pathname === "/login") {
      const body = new URLSearchParams(String(init?.body));
      const good = opts.login === "ok" && body.get("password") === "Pass-1";
      return new Response(null, {
        status: 302,
        headers: good
          ? { location: "/", "set-cookie": "RadarrAuth=abc; path=/" }
          : { location: "/login?returnUrl=%2F&loginFailed=true" },
      });
    }
    if (url.pathname === "/api/v3/rootfolder" && init?.method === "POST")
      return new Response("{}", { status: 201 });
    if (url.pathname === "/api/v3/rootfolder") return json([]);
    return new Response("nope", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, wait: async () => undefined };
}

const account = { username: "AlexSmith", password: "Pass-1" };

describe("setupArr", () => {
  it("passes when the owner's account signs in, whatever case the app keeps the name in", async () => {
    const r = fakeRadarr({ login: "ok" });
    await setupArr("radarr", "http://127.0.0.1:7878", "k", account, ["/data/Movies"], r);
    expect(r.calls).toContain("POST /login");
    expect(r.calls).toContain("POST /api/v3/rootfolder");
  });

  it("fails plainly when signing in does not work", async () => {
    const r = fakeRadarr({ login: "fails" });
    await expect(setupArr("radarr", "http://127.0.0.1:7878", "k", account, [], r)).rejects.toThrow(
      "Radarr turned its sign-in on, but signing in as AlexSmith did not work.",
    );
  });

  it("fails when the sign-in was not turned on", async () => {
    const r = fakeRadarr({ method: "none", login: "ok" });
    await expect(setupArr("sonarr", "http://127.0.0.1:8989", "k", account, [], r)).rejects.toThrow(
      /Sonarr|answered 404/,
    );
  });

  it("arrSignsIn reads the app's answer: home with its cookie, or back with loginFailed", async () => {
    expect(await arrSignsIn("http://127.0.0.1:7878", account, fakeRadarr({ login: "ok" }))).toBe(
      true,
    );
    expect(await arrSignsIn("http://127.0.0.1:7878", account, fakeRadarr({ login: "fails" }))).toBe(
      false,
    );
  });
});
