import type { Fetch } from "./http";

/**
 * A stand-in Wizarr (port 5690) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install): its API as Wizarr 2.2 answers it (checked against a real test Wizarr, 2026-11-01), with one
 * Plex server, two libraries linked to it and one an older Wizarr left unlinked, three users whose access
 * can be disabled, enabled, extended, dated, or removed, and invitations that can be created and
 * deleted. Times without a zone, as Wizarr writes them.
 */

const KEY_PREFIX = "e2e-";
/** The stand-in's admin sign-in; "passkey" as the username plays an admin with a passkey. */
export const FAKE_WIZARR_ADMIN = { username: "admin", password: "e2e-wizarr-admin" };
const CSRF = "fake-csrf-token";

const esc = (t: string) =>
  t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export interface FakeWizarr {
  fetch: Fetch;
  reset(): void;
}

export function fakeWizarr(): FakeWizarr {
  const day = 86_400_000;
  /** Wizarr's own format: ISO without a zone (UTC). */
  const naive = (t: number) => new Date(t).toISOString().replace("Z", "");
  const initial = () => ({
    next: 4,
    invites: [
      {
        id: 1,
        code: "OLDLINK",
        used: false,
        used_by: null as string | null,
        used_at: null as string | null,
        created: new Date(Date.now() - 40 * day).toISOString(),
        expires: new Date(Date.now() - 10 * day).toISOString() as string | null,
        duration: "unlimited",
        libs: [] as number[],
      },
      {
        id: 2,
        code: "SAM2026",
        used: true,
        used_by: "sam",
        used_at: new Date(Date.now() - 11 * day).toISOString(),
        created: new Date(Date.now() - 12 * day).toISOString(),
        expires: null,
        duration: "30",
        libs: [1],
      },
      {
        id: 3,
        code: "FAMILY7",
        used: false,
        used_by: null,
        used_at: null,
        created: new Date(Date.now() - day).toISOString(),
        expires: new Date(Date.now() + 6 * day).toISOString(),
        duration: "unlimited",
        libs: [],
      },
    ],
    users: [
      {
        id: 1,
        username: "sam",
        email: "sam@example.com",
        expires: naive(Date.now() + 4 * day),
        created_at: naive(Date.now() - 11 * day),
        disabled: false,
      },
      {
        id: 2,
        username: "alex",
        email: null,
        expires: null as string | null,
        created_at: naive(Date.now() - 90 * day),
        disabled: false,
      },
      {
        id: 3,
        username: "kim",
        email: null,
        expires: null as string | null,
        created_at: naive(Date.now() - 200 * day),
        disabled: false,
      },
    ] as {
      id: number;
      username: string;
      email: string | null;
      expires: string | null;
      created_at: string;
      disabled: boolean;
    }[],
    // Its admin pages: invite steps for Plex, and General settings.
    nextStep: 4,
    steps: [
      {
        id: 1,
        server: "plex",
        category: "pre_invite",
        position: 0,
        title: "Welcome",
        markdown: "# Welcome\n\nYou are invited to the family Plex.",
        require: false,
      },
      {
        id: 2,
        server: "plex",
        category: "post_invite",
        position: 0,
        title: "Get the app",
        markdown: "# Get the app\n\nInstall Plex, then sign in.",
        require: true,
      },
      {
        id: 3,
        server: "plex",
        category: "post_invite",
        position: 1,
        title: "You're in: Plex",
        markdown: "# You're in\n\nEnjoy & ask if anything is missing.",
        require: false,
      },
    ] as {
      id: number;
      server: string;
      category: string;
      position: number;
      title: string;
      markdown: string;
      require: boolean;
    }[],
    general: {
      server_name: "Family Media",
      wizard_acl_enabled: true,
      expiry_action: "delete",
      cinema_posters_source: "",
    },
  });
  let state = initial();
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const statusOf = (i: (typeof state.invites)[number]) =>
    i.used ? "used" : i.expires && Date.parse(i.expires) < Date.now() ? "expired" : "pending";
  const view = (i: (typeof state.invites)[number]) => ({
    id: i.id,
    code: i.code,
    url: `http://wizarr.test/j/${i.code}`,
    status: statusOf(i),
    created: i.created,
    expires: i.expires,
    used_at: i.used_at,
    used_by: i.used_by,
    duration: i.duration,
    specific_libraries: i.libs,
    server_names: ["Plex"],
  });

  const page = (status: number, html: string, headers: Record<string, string> = {}) => ({
    ok: status < 400,
    status,
    json: async () => ({}),
    text: async () => html,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  });
  const form = (body?: string) => Object.fromEntries(new URLSearchParams(body ?? ""));
  const stepsHtml = () => {
    const servers = [...new Set(state.steps.map((x) => x.server))];
    if (!servers.length) return '<p class="text-gray-600">No steps found.</p>';
    return servers
      .map((server) =>
        ["pre_invite", "post_invite"]
          .map((category) => {
            const items = state.steps
              .filter((x) => x.server === server && x.category === category)
              .sort((a, b) => a.position - b.position)
              .map(
                (x) =>
                  `<li class="flex items-center" data-id="${x.id}"><span class="flex-1">${esc(x.title || "Untitled")}</span><button hx-get="/settings/wizard/${x.id}/edit">Edit</button></li>`,
              )
              .join("");
            return `<ol class="wizard-steps" data-server="${server}" data-category="${category}" data-reorder-url="/settings/wizard/reorder">${items || '<li class="empty-state-item">No steps</li>'}</ol>`;
          })
          .join(""),
      )
      .join("");
  };
  const stepForm = (x?: (typeof state.steps)[number]) =>
    `<form hx-post="/settings/wizard/${x ? `${x.id}/edit` : "create"}"><input id="csrf_token" name="csrf_token" type="hidden" value="${CSRF}">` +
    `<select id="server_type" name="server_type"><option ${x?.server !== "jellyfin" ? "selected " : ""}value="plex">Plex</option><option value="jellyfin">Jellyfin</option></select>` +
    `<select id="category" name="category"><option ${x?.category === "pre_invite" ? "selected " : ""}value="pre_invite">Before Invite Acceptance</option><option ${x?.category !== "pre_invite" ? "selected " : ""}value="post_invite">After Invite Acceptance</option></select>` +
    `<input id="title" name="title" type="text" value="${esc(x?.title ?? "")}">` +
    `<textarea id="markdown" name="markdown" rows="10">\r\n${esc(x?.markdown ?? "")}</textarea>` +
    `<input ${x?.require ? "checked " : ""}id="require_interaction" name="require_interaction" type="checkbox" value="y"></form>`;
  const generalHtml = () => {
    const g = state.general;
    const opt = (v: string, label: string, now: string) =>
      `<option ${v === now ? "selected " : ""}value="${v}">${label}</option>`;
    return (
      `<form hx-post="/settings/general"><input id="csrf_token" name="csrf_token" type="hidden" value="${CSRF}">` +
      `<input id="server_name" name="server_name" required type="text" value="${esc(g.server_name)}">` +
      `<input ${g.wizard_acl_enabled ? "checked " : ""}class="sr-only peer" id="wizard_acl_enabled" name="wizard_acl_enabled" type="checkbox" value="y">` +
      `<select id="expiry_action" name="expiry_action">${opt("delete", "Delete User", g.expiry_action)}${opt("disable", "Disable User (if supported)", g.expiry_action)}</select>` +
      `<select id="cinema_posters_source" name="cinema_posters_source">${opt("", "First server (default)", g.cinema_posters_source)}${opt("invite", "The server the invite is for", g.cinema_posters_source)}${opt("1", "Plex", g.cinema_posters_source)}</select>` +
      `<button hx-post="/settings/clean-expired-users">Clean Expired Users</button></form>`
    );
  };
  /** Wizarr's admin web pages (session sign-in, HTML and HTMX), not its API. */
  const admin = (u: URL, method: string, init: Parameters<Fetch>[1]) => {
    const p = u.pathname;
    if (p === "/login" && method === "POST") {
      const f = form(init.body);
      if (f.username === "passkey" && f.password === FAKE_WIZARR_ADMIN.password)
        return page(
          200,
          "<h1>Two-Factor Authentication</h1><p>Please authenticate with your passkey to complete login.</p>",
        );
      if (f.username === FAKE_WIZARR_ADMIN.username && f.password === FAKE_WIZARR_ADMIN.password)
        return page(302, "", {
          location: "/",
          "set-cookie":
            "session=fake-admin; Expires=Wed, 05 Nov 2036 10:00:00 GMT; HttpOnly; Path=/",
        });
      return page(
        200,
        '<form action="/login"><input name="username"><input name="password" type="password"></form><p>Invalid username or password</p>',
      );
    }
    if (!/(?:^|;\s*)session=fake-admin/.test(init.headers.Cookie ?? ""))
      return page(302, "", { location: `/login?next=${encodeURIComponent(p)}` });
    const body = form(init.body);
    if (p === "/settings/wizard/" && method === "GET") return page(200, stepsHtml());
    if (p === "/settings/wizard/create") {
      if (method === "GET") return page(200, stepForm());
      if (body.csrf_token !== CSRF) return page(400, "The CSRF token is missing.");
      const mine = state.steps.filter(
        (x) => x.server === body.server_type && x.category === body.category,
      );
      state.steps.push({
        id: state.nextStep++,
        server: body.server_type ?? "plex",
        category: body.category ?? "post_invite",
        position: Math.max(0, ...mine.map((x) => x.position)) + 1,
        title: body.title ?? "",
        markdown: body.markdown ?? "",
        require: body.require_interaction === "y",
      });
      return page(200, stepsHtml());
    }
    const one = /^\/settings\/wizard\/(\d+)\/(edit|delete)$/.exec(p);
    if (one) {
      const x = state.steps.find((y) => y.id === Number(one[1]));
      if (!x) return page(404, "Not Found");
      if (one[2] === "delete" && method === "POST") {
        state.steps = state.steps.filter((y) => y !== x);
        return page(200, stepsHtml());
      }
      if (method === "GET") return page(200, stepForm(x));
      if (body.csrf_token !== CSRF) return page(400, "The CSRF token is missing.");
      Object.assign(x, {
        server: body.server_type,
        category: body.category,
        title: body.title ?? "",
        markdown: body.markdown ?? "",
        require: body.require_interaction === "y",
      });
      return page(200, stepsHtml());
    }
    if (p === "/settings/wizard/reorder" && method === "POST") {
      const d = JSON.parse(init.body ?? "{}") as {
        server_type?: string;
        category?: string;
        order?: number[];
      };
      (d.order ?? []).forEach((id, i) => {
        const x = state.steps.find((y) => y.id === id);
        if (x) Object.assign(x, { position: i, category: d.category, server: d.server_type });
      });
      return page(200, '{"status":"ok"}');
    }
    if (p === "/settings/general") {
      if (method === "POST") {
        if (body.csrf_token !== CSRF) return page(400, "The CSRF token is missing.");
        state.general = {
          server_name: body.server_name ?? "",
          wizard_acl_enabled: body.wizard_acl_enabled === "y",
          expiry_action: body.expiry_action ?? "delete",
          cinema_posters_source: body.cinema_posters_source ?? "",
        };
      }
      return page(200, generalHtml());
    }
    if (p === "/settings/clean-expired-users" && method === "POST") {
      if (state.general.expiry_action === "delete")
        state.users = state.users.filter(
          (x) => !x.expires || Date.parse(`${x.expires}Z`) > Date.now(),
        );
      return page(200, "<button>Clean Expired Users</button>");
    }
    return page(404, "Not Found");
  };

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    if (!u.pathname.startsWith("/api/")) return admin(u, init.method ?? "GET", init);
    if (!init.headers["X-API-Key"]?.startsWith(KEY_PREFIX))
      return reply(401, { error: "Invalid or missing API key" });
    const p = u.pathname;
    const method = init.method ?? "GET";
    if (p === "/api/invitations" && method === "GET")
      return reply(200, { invitations: state.invites.map(view), count: state.invites.length });
    if (p === "/api/invitations" && method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as {
        server_ids?: number[];
        expires_in_days?: number;
        duration?: string;
        library_ids?: number[];
      };
      if (!body.server_ids?.length)
        return reply(400, {
          error: "Server selection is required.",
          available_servers: [{ id: 1, name: "Plex" }],
        });
      const id = state.next++;
      const code = `NEW${id}X`;
      state.invites.push({
        id,
        code,
        used: false,
        used_by: null,
        used_at: null,
        created: new Date().toISOString(),
        expires: body.expires_in_days
          ? new Date(Date.now() + body.expires_in_days * day).toISOString()
          : null,
        duration: body.duration ?? "unlimited",
        libs: body.library_ids ?? [],
      });
      return reply(201, {
        message: "Invitation created successfully",
        invitation: { id, code, url: `http://wizarr.test/j/${code}` },
      });
    }
    const one = /^\/api\/invitations\/(\d+)$/.exec(p);
    if (one && method === "DELETE") {
      const before = state.invites.length;
      state.invites = state.invites.filter((i) => i.id !== Number(one[1]));
      return before === state.invites.length
        ? reply(404, { error: "Invitation not found" })
        : reply(200, { message: "deleted" });
    }
    if (p === "/api/users")
      return reply(200, {
        users: state.users.map((u) => ({
          ...u,
          disabled: undefined,
          server: "Plex",
          server_type: "plex",
        })),
        count: state.users.length,
      });
    const user = /^\/api\/users\/(\d+)(?:\/([a-z-]+))?$/.exec(p);
    if (user) {
      const u = state.users.find((x) => x.id === Number(user[1]));
      if (!u) return reply(404, { error: "User not found" });
      const what = user[2] ?? "";
      if (!what && method === "DELETE") {
        state.users = state.users.filter((x) => x !== u);
        return reply(200, { message: `User ${u.username} deleted successfully` });
      }
      if ((what === "disable" || what === "enable") && method === "POST") {
        u.disabled = what === "disable";
        return reply(200, { message: `User ${u.username} ${what}d successfully` });
      }
      if (what === "extend" && method === "POST") {
        const days = Number((JSON.parse(init.body ?? "{}") as { days?: number }).days ?? 30);
        const from = u.expires ? Date.parse(`${u.expires}Z`) : Date.now();
        u.expires = naive(from + days * day);
        return reply(200, { message: "extended", new_expiry: `${u.expires}+00:00` });
      }
      if (what === "update-expiry" && method === "PUT") {
        const body = JSON.parse(init.body ?? "{}") as { expires?: unknown };
        if (body.expires === null || body.expires === "")
          return reply(400, { message: "Input payload validation failed" });
        u.expires = typeof body.expires === "string" ? naive(Date.parse(body.expires)) : null;
        return reply(200, { message: "updated", new_expiry: u.expires });
      }
      return reply(405, { error: "Method not allowed" });
    }
    if (p === "/api/servers")
      return reply(200, {
        servers: [
          {
            id: 1,
            name: "Plex",
            server_type: "plex",
            server_url: "http://plex:32400",
            external_url: "https://plex.example.com",
            verified: true,
            allow_downloads: false,
            allow_live_tv: true,
            allow_mobile_uploads: false,
          },
        ],
        count: 1,
      });
    if (p === "/api/libraries")
      return reply(200, {
        libraries: [
          { id: 1, name: "Movies", server_id: 1, server_name: "Plex", enabled: true },
          { id: 2, name: "TV Shows", server_id: 1, server_name: "Plex", enabled: true },
          { id: 9, name: "Old Movies", server_id: null, server_name: "Unknown", enabled: true },
        ],
        count: 3,
      });
    return reply(404, { error: "Not found" });
  };
  return { fetch: fetchImpl, reset: () => (state = initial()) };
}
