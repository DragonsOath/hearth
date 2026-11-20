import type {
  WizarrSettings,
  WizarrStep,
  WizarrStepCategory,
  WizarrWizard,
} from "@dragon-control/core";
import {
  AppBlockedError,
  AppIncompatibleError,
  AppKeyError,
  AppUnreachableError,
  joinUrl,
  TIMEOUT_MS,
  type Fetch,
} from "./http";

/**
 * Wizarr's own setup pages (Settings: General, and Wizard, the invite steps people see), which its
 * API key cannot reach: they sit behind Wizarr's admin sign-in. Hearth signs in with the admin
 * login kept in the vault, only to Wizarr's own address, and drives the same pages Wizarr's admin
 * screens use (checked against Wizarr 2026.9.1 and 2026.11). The session lives only in memory, and
 * neither it nor the login is ever returned, logged or shown.
 */

export interface WizarrLogin {
  username: string;
  password: string;
}

/** Wizarr's admin login uses a passkey as a second step, which Hearth cannot answer. */
export class WizarrPasskeyError extends AppKeyError {}

export const WIZARR_STEP_SERVERS = [
  "plex",
  "jellyfin",
  "emby",
  "audiobookshelf",
  "romm",
  "komga",
  "kavita",
] as const;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the HTML entities Jinja and WTForms write. */
export function decodeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decodeHtml(m[2] ?? m[3] ?? m[4] ?? "") : undefined;
};
const hasAttr = (tag: string, name: string) => new RegExp(`\\s${name}(\\s|=|>|/)`, "i").test(tag);

/** The fields of a form as Wizarr renders it (WTForms): text and hidden inputs, checkboxes, selects, textareas. */
export function parseForm(html: string): {
  values: Record<string, string>;
  checks: Record<string, boolean>;
  selects: Record<string, { value: string; choices: { value: string; label: string }[] }>;
} {
  const values: Record<string, string> = {};
  const checks: Record<string, boolean> = {};
  const selects: Record<string, { value: string; choices: { value: string; label: string }[] }> =
    {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = attr(tag, "name");
    if (!name) continue;
    const type = (attr(tag, "type") ?? "text").toLowerCase();
    if (type === "checkbox") checks[name] = hasAttr(tag, "checked");
    else if (type !== "submit" && type !== "button") values[name] = attr(tag, "value") ?? "";
  }
  for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const name = attr(m[0], "name");
    // A textarea's first newline is not part of its value (WTForms writes one).
    if (name) values[name] = decodeHtml(m[2]!.replace(/^\r?\n/, ""));
  }
  for (const m of html.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/gi)) {
    const name = attr(m[0], "name");
    if (!name) continue;
    const choices: { value: string; label: string }[] = [];
    let value: string | undefined;
    for (const o of m[1]!.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)) {
      const v = attr(o[0], "value") ?? decodeHtml(o[1]!.trim());
      choices.push({ value: v, label: decodeHtml(o[1]!.replace(/<[^>]*>/g, "").trim()) });
      if (hasAttr(o[0].slice(0, o[0].indexOf(">") + 1), "selected")) value = v;
    }
    selects[name] = { value: value ?? choices[0]?.value ?? "", choices };
  }
  return { values, checks, selects };
}

/** The steps list (Settings, Wizard): each server's two lists and their step ids, in order. */
export function parseStepLists(
  html: string,
): { server: string; category: WizarrStepCategory; ids: number[] }[] {
  const out: { server: string; category: WizarrStepCategory; ids: number[] }[] = [];
  const opens = [...html.matchAll(/<(ol|ul)\b[^>]*data-server\s*=[^>]*>/gi)];
  opens.forEach((m, i) => {
    const server = attr(m[0], "data-server");
    const category = attr(m[0], "data-category");
    if (!server || (category !== "pre_invite" && category !== "post_invite")) return;
    const end = html.indexOf(`</${m[1]}>`, m.index! + m[0].length);
    const next = opens[i + 1]?.index ?? html.length;
    const body = html.slice(m.index! + m[0].length, end < 0 ? next : Math.min(end, next));
    const ids = [...body.matchAll(/<li\b[^>]*\sdata-id\s*=\s*"(\d+)"/gi)].map((x) => Number(x[1]));
    out.push({ server, category, ids });
  });
  return out;
}

/** Cookies from Set-Cookie (several may be joined by commas; dates contain commas too). */
export function readCookies(header: string | null | undefined, into: Map<string, string>) {
  if (!header) return;
  for (const m of header.matchAll(/(?:^|,)\s*([A-Za-z0-9_.-]+)=([^;,]*)/g)) {
    // "Expires=Wed, 05 Nov" splits at the comma: "05 Nov" never matches a name, so nothing leaks.
    if (/^(expires|max-age|path|domain|samesite)$/i.test(m[1]!)) continue;
    into.set(m[1]!, m[2]!);
  }
}

interface Answer {
  status: number;
  text: string;
  location?: string;
}

/**
 * One signed-in session with Wizarr's admin pages. It signs in when first used and again when
 * Wizarr sends it back to its login page (a session ends after a while).
 */
export class WizarrAdmin {
  private signedIn: boolean;

  constructor(
    private readonly fetchImpl: Fetch,
    private readonly base: string,
    private readonly login: WizarrLogin,
    /** The session's cookies, kept between uses by the caller (never the password). */
    private readonly cookies = new Map<string, string>(),
  ) {
    this.signedIn = cookies.size > 0;
  }

  private async send(
    method: string,
    path: string,
    body?: { form?: Record<string, string>; json?: unknown },
    hx = true,
  ): Promise<Answer> {
    const headers: Record<string, string> = { Accept: "text/html,application/json" };
    if (hx) headers["HX-Request"] = "true";
    if (this.cookies.size)
      headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let payload: string | undefined;
    if (body?.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(body.form).toString();
    } else if (body?.json !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body.json);
    }
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchImpl(joinUrl(this.base, path), {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new AppUnreachableError(
        `Wizarr did not answer at ${this.base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    readCookies(res.headers?.get("set-cookie"), this.cookies);
    const location = res.headers?.get("location") ?? undefined;
    const text = res.text ? await res.text() : "";
    return { status: res.status, text, ...(location ? { location } : {}) };
  }

  /** Signs in to Wizarr's admin pages with the vault's login. */
  async signIn(): Promise<void> {
    this.cookies.clear();
    const r = await this.send(
      "POST",
      "/login",
      {
        form: {
          username: this.login.username,
          password: this.login.password,
          auth_method: "local",
        },
      },
      false,
    );
    if (r.status === 429)
      throw new AppBlockedError(
        "Wizarr is refusing sign-ins for a minute (too many tries). Hearth tries again later.",
      );
    if (r.status === 403)
      throw new AppIncompatibleError(
        "Wizarr's admin pages are behind Cloudflare Access, which Hearth cannot sign in through.",
      );
    if (r.status >= 300 && r.status < 400 && !/\/login/.test(r.location ?? "")) {
      this.signedIn = true;
      return;
    }
    // The passkey step is the login page without its password form.
    if (
      r.status === 200 &&
      !/name=["']?password/i.test(r.text) &&
      /passkey|two-factor/i.test(r.text)
    )
      throw new WizarrPasskeyError(
        "Wizarr asks this admin for a passkey after the password, which Hearth cannot give. Use an admin account without a passkey for Hearth (Wizarr, Settings, Admins).",
      );
    if (r.status >= 500) throw new AppUnreachableError(`Wizarr answered ${r.status} at sign-in.`);
    throw new AppKeyError(
      "Wizarr refused the admin sign-in. Check the username and password in the vault.",
    );
  }

  /** One admin request; signs in first, and once more if the session has ended. */
  async request(
    method: string,
    path: string,
    body?: { form?: Record<string, string>; json?: unknown },
  ): Promise<Answer> {
    if (!this.signedIn) await this.signIn();
    let r = await this.send(method, path, body);
    if (
      r.status === 401 ||
      (r.status >= 300 && r.status < 400 && /\/login/.test(r.location ?? ""))
    ) {
      await this.signIn();
      r = await this.send(method, path, body);
    }
    if (r.status >= 300 && r.status < 400 && /\/login/.test(r.location ?? ""))
      throw new AppKeyError("Wizarr did not keep the admin signed in.");
    if (r.status === 404)
      throw new AppIncompatibleError(`Wizarr has no ${path.split("?")[0]} page.`);
    if (r.status >= 400)
      throw new AppUnreachableError(`Wizarr answered ${r.status} for ${path.split("?")[0]}.`);
    return r;
  }
}

/** One step's own fields, from its edit form. */
async function readStep(
  admin: WizarrAdmin,
  id: number,
  server: string,
  category: WizarrStepCategory,
  position: number,
): Promise<WizarrStep> {
  const r = await admin.request("GET", `/settings/wizard/${id}/edit`);
  const f = parseForm(r.text);
  return {
    id,
    server,
    category,
    position,
    title: f.values.title ?? "",
    markdown: f.values.markdown ?? "",
    requireInteraction: Boolean(f.checks.require_interaction),
  };
}

/** Every invite step, grouped by media server type (only the types Wizarr has a server for). */
export async function readWizarrWizard(admin: WizarrAdmin): Promise<WizarrWizard> {
  const list = await admin.request("GET", "/settings/wizard/");
  const groups = parseStepLists(list.text);
  if (!groups.length && !/No steps found/i.test(list.text) && !/data-server/i.test(list.text))
    throw new AppIncompatibleError("Wizarr's Wizard page did not look as Hearth expects.");
  const servers: WizarrWizard["servers"] = [];
  for (const g of groups) {
    let entry = servers.find((s) => s.server === g.server);
    if (!entry) servers.push((entry = { server: g.server, steps: [] }));
    const steps = await Promise.all(
      g.ids.map((id, i) => readStep(admin, id, g.server, g.category, i)),
    );
    entry.steps.push(...steps);
  }
  return { servers };
}

/** Wizarr's General settings, with every field its form has (to send back unchanged). */
export async function readGeneralForm(admin: WizarrAdmin) {
  const r = await admin.request("GET", "/settings/general");
  const form = parseForm(r.text);
  if (!("server_name" in form.values) || !form.selects.expiry_action)
    throw new AppIncompatibleError("Wizarr's General settings did not look as Hearth expects.");
  return form;
}

export function settingsOf(form: Awaited<ReturnType<typeof readGeneralForm>>): WizarrSettings {
  const posters = form.selects.cinema_posters_source;
  return {
    displayName: form.values.server_name ?? "",
    protectWizard: Boolean(form.checks.wizard_acl_enabled),
    expiryAction: form.selects.expiry_action?.value === "disable" ? "disable" : "delete",
    ...(posters ? { posters: { value: posters.value, choices: posters.choices } } : {}),
  };
}

export async function readWizarrSettings(admin: WizarrAdmin): Promise<WizarrSettings> {
  return settingsOf(await readGeneralForm(admin));
}

/** The CSRF token a Wizarr form needs, from that form's own page. */
async function csrf(admin: WizarrAdmin, path: string): Promise<string> {
  const token = parseForm((await admin.request("GET", path)).text).values.csrf_token;
  if (!token) throw new AppIncompatibleError("Wizarr's form did not carry its security token.");
  return token;
}

export interface StepInput {
  server: string;
  category: WizarrStepCategory;
  title: string;
  markdown: string;
  requireInteraction: boolean;
}

const stepForm = (token: string, s: StepInput): Record<string, string> => ({
  csrf_token: token,
  server_type: s.server,
  category: s.category,
  title: s.title,
  markdown: s.markdown,
  ...(s.requireInteraction ? { require_interaction: "y" } : {}),
});

export async function createStep(admin: WizarrAdmin, s: StepInput): Promise<void> {
  const token = await csrf(admin, "/settings/wizard/create");
  await admin.request("POST", "/settings/wizard/create", { form: stepForm(token, s) });
}

export async function editStep(admin: WizarrAdmin, id: number, s: StepInput): Promise<void> {
  const token = await csrf(admin, `/settings/wizard/${id}/edit`);
  await admin.request("POST", `/settings/wizard/${id}/edit`, { form: stepForm(token, s) });
}

export async function deleteStep(admin: WizarrAdmin, id: number): Promise<void> {
  await admin.request("POST", `/settings/wizard/${id}/delete`);
}

/** Puts a list in this order; a step from the other list moves into this one. */
export async function orderSteps(
  admin: WizarrAdmin,
  server: string,
  category: WizarrStepCategory,
  order: number[],
): Promise<void> {
  await admin.request("POST", "/settings/wizard/reorder", {
    json: { server_type: server, category, order },
  });
}

/** Saves General settings: every field as it was, with the changed ones replaced. */
export async function saveSettings(
  admin: WizarrAdmin,
  change: Partial<Pick<WizarrSettings, "displayName" | "protectWizard" | "expiryAction">> & {
    posters?: string;
  },
): Promise<void> {
  const form = await readGeneralForm(admin);
  const out: Record<string, string> = { ...form.values };
  for (const [name, s] of Object.entries(form.selects)) out[name] = s.value;
  for (const [name, on] of Object.entries(form.checks)) if (on) out[name] = "y";
  if (change.displayName !== undefined) out.server_name = change.displayName;
  if (change.expiryAction !== undefined) out.expiry_action = change.expiryAction;
  if (change.posters !== undefined && form.selects.cinema_posters_source)
    out.cinema_posters_source = change.posters;
  if (change.protectWizard !== undefined) {
    if (change.protectWizard) out.wizard_acl_enabled = "y";
    else delete out.wizard_acl_enabled;
  }
  await admin.request("POST", "/settings/general", { form: out });
}

/** Runs Wizarr's "Clean Expired Users": deletes or disables everyone whose access has ended. */
export async function cleanExpiredUsers(admin: WizarrAdmin): Promise<void> {
  await admin.request("POST", "/settings/clean-expired-users");
}
