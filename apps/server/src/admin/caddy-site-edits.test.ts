import { describe, expect, it } from "vitest";
import { siteEdits } from "./caddy-panel";

/** The Caddy form's edits, against a Caddyfile written the way the real one is (tabs, snippets). */

const FILE = [
  "{",
  "\temail admin@example.com",
  "\tdefault_bind 192.168.1.77",
  "}",
  "",
  "(login) {",
  "\tforward_auth 192.168.1.77:3000 {",
  "\t\turi /api/auth/caddy",
  "\t}",
  "}",
  "",
  "photos.example.com {",
  "\treverse_proxy 192.168.1.77:2283 {",
  "\t\theader_up X-Forwarded-For 127.0.0.1",
  "\t\theader_up X-Real-IP 127.0.0.1",
  "\t}",
  "}",
  "",
  "sonarr.example.com {",
  "\timport login",
  "\treverse_proxy 192.168.1.77:8989 {",
  "\t\theader_up X-Forwarded-For 127.0.0.1",
  "\t\theader_up X-Real-IP 127.0.0.1",
  "\t}",
  "}",
  "",
  "files.example.com {",
  "\troot * /srv/files",
  "\tfile_server",
  "}",
  "",
].join("\n");

/** Applies edits the way the config-edit plan does: each find must appear exactly once. */
function apply(file: string, edits: { find: string; replace: string }[]) {
  let out = file;
  for (const e of edits) {
    expect(out.split(e.find).length - 1).toBe(1);
    out = out.replace(e.find, () => e.replace);
  }
  return out;
}

describe("siteEdits", () => {
  it("adds a site at the end in the file's own style, behind the shared sign-in when asked", () => {
    const out = apply(
      FILE,
      siteEdits(FILE, {
        op: "add",
        site: "Books.Example.com",
        upstream: "192.168.1.77:13378",
        signIn: "sign-in service",
      }),
    );
    expect(out).toContain(
      [
        "books.example.com {",
        "\timport login",
        "\treverse_proxy 192.168.1.77:13378 {",
        "\t\theader_up X-Forwarded-For 127.0.0.1",
        "\t\theader_up X-Real-IP 127.0.0.1",
        "\t}",
        "}",
      ].join("\n"),
    );
    expect(out.startsWith(FILE.trimEnd())).toBe(true);
  });

  it("changes where a site goes without touching the others", () => {
    const out = apply(
      FILE,
      siteEdits(FILE, { op: "change", site: "photos.example.com", upstream: "10.0.0.5:2283" }),
    );
    expect(out).toContain("\treverse_proxy 10.0.0.5:2283 {");
    expect(out).toContain("\treverse_proxy 192.168.1.77:8989 {");
  });

  it("turns the shared sign-in on and off", () => {
    const on = apply(
      FILE,
      siteEdits(FILE, { op: "change", site: "photos.example.com", signIn: "sign-in service" }),
    );
    expect(on).toContain("photos.example.com {\n\timport login\n\treverse_proxy");
    const off = apply(
      FILE,
      siteEdits(FILE, { op: "change", site: "sonarr.example.com", signIn: "none" }),
    );
    expect(off).toContain("sonarr.example.com {\n\treverse_proxy");
    expect(off).toContain("(login) {");
  });

  it("removes a site and its blank line, leaving the rest as it was", () => {
    const out = apply(FILE, siteEdits(FILE, { op: "remove", site: "sonarr.example.com" }));
    expect(out).not.toContain("sonarr.example.com");
    expect(out).toContain("}\n\nfiles.example.com {");
  });

  it("refuses changes that do not fit, in plain words", () => {
    expect(() =>
      siteEdits(FILE, { op: "add", site: "photos.example.com", upstream: "a:1" }),
    ).toThrow(/already in the Caddyfile/);
    expect(() => siteEdits(FILE, { op: "add", site: "not a name", upstream: "a:1" })).toThrow(
      /not a site name/,
    );
    expect(() => siteEdits(FILE, { op: "add", site: "x.example.com" })).toThrow(/address and port/);
    expect(() =>
      siteEdits(FILE, { op: "add", site: "x.example.com", upstream: "a:1; rm" }),
    ).toThrow(/address and port/);
    expect(() => siteEdits(FILE, { op: "remove", site: "nope.example.com" })).toThrow(
      /not in the Caddyfile/,
    );
    expect(() =>
      siteEdits(FILE, { op: "change", site: "files.example.com", upstream: "a:1" }),
    ).toThrow(/serves files or redirects/);
    expect(() =>
      siteEdits(FILE, { op: "change", site: "sonarr.example.com", signIn: "sign-in service" }),
    ).toThrow(/already looks like that/);
    const noSnippet = FILE.replace("(login) {", "(other) {");
    expect(() =>
      siteEdits(noSnippet, {
        op: "add",
        site: "x.example.com",
        upstream: "a:1",
        signIn: "sign-in service",
      }),
    ).toThrow(/no shared sign-in/);
  });

  it("matches a site exactly, not one whose name merely contains it", () => {
    const file = FILE.replace("photos.example.com {", "myphotos.example.com {");
    expect(() => siteEdits(file, { op: "remove", site: "photos.example.com" })).toThrow(
      /not in the Caddyfile/,
    );
  });
});
