import { createHash, createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { BLUEPRINT_FILE, type BlueprintCloud } from "@dragon-control/core";

/**
 * Where Lab Blueprint versions go: a folder (a disk, a network share, or a folder a cloud app
 * syncs), or cloud storage reached directly: any S3-compatible service (Backblaze B2, Cloudflare
 * R2, Wasabi, Amazon S3, MinIO) or WebDAV (Nextcloud, most NAS). Every write is read back and
 * compared before it counts, and only Hearth's own dated files are ever listed or removed.
 */

export interface BlueprintStore {
  /** Where it is, in words ("Backblaze B2: my-bucket/hearth"). */
  where: string;
  /** Why it can't take a version now, or undefined when a test file wrote and went. */
  check(): Promise<string | undefined>;
  /** Hearth's version files there, oldest first. */
  list(): Promise<string[]>;
  /** Writes a new file (never over another); false when that name is taken. */
  put(name: string, bytes: Uint8Array): Promise<boolean>;
  get(name: string): Promise<Uint8Array | undefined>;
  remove(name: string): Promise<void>;
}

export class StoreError extends Error {}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- a folder

export function folderStore(dir: string): BlueprintStore {
  return {
    where: dir,
    async check() {
      if (!path.isAbsolute(dir)) return "Give the folder's full path.";
      const st = await fs.stat(dir).catch(() => undefined);
      if (!st)
        return `${dir} doesn't exist. Connect the drive or share, or create the folder first.`;
      if (!st.isDirectory()) return `${dir} is a file, not a folder.`;
      const probe = path.join(dir, `.hearth-blueprint-check-${process.pid}`);
      try {
        await fs.writeFile(probe, "check", { flag: "w" });
        await fs.rm(probe, { force: true });
      } catch {
        return `Hearth can't write to ${dir}. Choose a folder Hearth's account can write to.`;
      }
      return undefined;
    },
    async list() {
      return (await fs.readdir(dir)).filter((f) => BLUEPRINT_FILE.test(f)).sort();
    },
    async put(name, bytes) {
      try {
        await fs.writeFile(path.join(dir, name), bytes, { flag: "wx", mode: 0o600 });
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
      }
    },
    async get(name) {
      return fs.readFile(path.join(dir, name)).then(
        (b) => new Uint8Array(b),
        () => undefined,
      );
    },
    async remove(name) {
      await fs.rm(path.join(dir, name), { force: true });
    },
  };
}

// ---------------------------------------------------------------- the cloud

export type CloudFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

const realFetch: CloudFetch = (url, init) =>
  fetch(url, { ...init, ...(init.body ? { body: init.body } : {}) });

/** The cloud login (from the Secure Vault, never kept anywhere else). */
export interface CloudLogin {
  /** S3: the access key ID. WebDAV: the user name. */
  username: string;
  /** S3: the secret access key. WebDAV: the password (an app password is best). */
  secret: string;
}

const PROVIDERS: [RegExp, string][] = [
  [/backblazeb2\.com$/, "Backblaze B2"],
  [/r2\.cloudflarestorage\.com$/, "Cloudflare R2"],
  [/wasabisys\.com$/, "Wasabi"],
  [/amazonaws\.com$/, "Amazon S3"],
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** A plain-http address is allowed only inside the home network (a MinIO or NAS on the LAN). */
function isLocal(host: string): boolean {
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".lan")) return true;
  const h = host.replace(/^\[|\]$/g, "");
  if (isIP(h) === 4)
    return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
      h,
    );
  if (isIP(h) === 6) return h === "::1" || /^f[cd]/i.test(h) || /^fe80/i.test(h);
  return false;
}

/** Why a cloud target isn't usable as given, or undefined. */
export function cloudProblem(c: BlueprintCloud): string | undefined {
  const url = c.kind === "s3" ? c.endpoint : c.url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return c.kind === "s3"
      ? "Give the service's S3 endpoint as a full address, like https://s3.us-west-004.backblazeb2.com."
      : "Give the WebDAV folder's full address, like https://cloud.example.com/remote.php/dav/files/you/Hearth.";
  }
  if (u.username || u.password)
    return "Put the user name and password in their own boxes, not in the address.";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u.hostname)))
    return "Use an https:// address. Plain http:// is allowed only for a server inside your home network.";
  if (c.kind === "s3") {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.bucket))
      return "That bucket name isn't valid: 3 to 63 lowercase letters, numbers, dots or dashes.";
    if (c.prefix && !/^[A-Za-z0-9._\-/ ]{1,200}$/.test(c.prefix))
      return "Keep the folder inside the bucket to letters, numbers, spaces, dots, dashes and slashes.";
  }
  return undefined;
}

/** The region S3 signatures need, read from the endpoint where the service puts it there. */
export function regionOf(endpoint: string, given?: string): string {
  if (given?.trim()) return given.trim();
  const host = hostOf(endpoint);
  if (host.endsWith("r2.cloudflarestorage.com")) return "auto";
  const m = /(?:^|\.)s3[.-]([a-z0-9-]+)\.(?:amazonaws|backblazeb2|wasabisys)\.com$/.exec(host);
  return m?.[1] ?? "us-east-1";
}

export function cloudWhere(c: BlueprintCloud): string {
  if (c.kind === "s3") {
    const host = hostOf(c.endpoint);
    const name = PROVIDERS.find(([re]) => re.test(host))?.[1] ?? host;
    return `${name}: ${c.bucket}${c.prefix ? `/${c.prefix.replace(/^\/+|\/+$/g, "")}` : ""}`;
  }
  const u = new URL(c.url);
  return `WebDAV: ${u.host}${decodeURIComponent(u.pathname).replace(/\/+$/, "")}`;
}

/** AWS's URI encoding: everything but unreserved characters, slashes kept in paths. */
const awsEncode = (s: string, keepSlash: boolean) =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, "/");

/**
 * Signs an S3 request (AWS Signature Version 4, the scheme every S3-compatible service uses).
 * Returns the headers to send: host, x-amz-date, x-amz-content-sha256 and Authorization.
 */
export function signS3(r: {
  method: string;
  host: string;
  /** The path, not yet encoded. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKey: string;
  secretKey: string;
  now: Date;
}): Record<string, string> {
  const amzDate = r.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()]),
    ),
    host: r.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": r.payloadHash,
  };
  const names = Object.keys(headers).sort();
  const query = Object.entries(r.query ?? {})
    .map(([k, v]) => [awsEncode(k, false), awsEncode(v, false)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    r.method,
    awsEncode(r.path, true),
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    names.join(";"),
    r.payloadHash,
  ].join("\n");
  const scope = `${day}/${r.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
  const kDate = hmac(`AWS4${r.secretKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, r.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${r.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

const TIMEOUT_MS = 60_000;

function plainError(status: number, body: string, where: string): StoreError {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  if (
    status === 401 ||
    status === 403 ||
    code === "InvalidAccessKeyId" ||
    code === "SignatureDoesNotMatch"
  )
    return new StoreError(
      `${where} turned the login down${code ? ` (${code})` : ""}. Check the key or password, and that it may write there.`,
    );
  if (status === 404 || code === "NoSuchBucket")
    return new StoreError(`${where} doesn't exist. Create the bucket or folder first.`);
  if (status === 507) return new StoreError(`${where} is full.`);
  return new StoreError(`${where} answered ${status}${code ? ` (${code})` : ""}.`);
}

async function call(
  f: CloudFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
  where: string,
) {
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new StoreError(`Couldn't reach ${where}: ${(e as Error).message}.`);
  }
}

export function s3Store(
  c: Extract<BlueprintCloud, { kind: "s3" }>,
  login: CloudLogin,
  opts: { fetch?: CloudFetch; clock?: () => Date } = {},
): BlueprintStore {
  const f = opts.fetch ?? realFetch;
  const clock = opts.clock ?? (() => new Date());
  const base = new URL(c.endpoint);
  const basePath = base.pathname.replace(/\/+$/, "");
  const prefix = c.prefix ? `${c.prefix.replace(/^\/+|\/+$/g, "")}/` : "";
  const region = regionOf(c.endpoint, c.region);
  const where = cloudWhere(c);
  const send = async (
    method: string,
    key: string,
    o: { query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string> } = {},
  ) => {
    const p = `${basePath}/${c.bucket}${key ? `/${key}` : ""}`;
    const headers = signS3({
      method,
      host: base.host,
      path: p,
      ...(o.query ? { query: o.query } : {}),
      ...(o.headers ? { headers: o.headers } : {}),
      payloadHash: sha(o.body ?? ""),
      region,
      accessKey: login.username,
      secretKey: login.secret,
      now: clock(),
    });
    const qs = o.query
      ? `?${Object.entries(o.query)
          .map(([k, v]) => `${awsEncode(k, false)}=${awsEncode(v, false)}`)
          .join("&")}`
      : "";
    const { host: _h, ...sendHeaders } = headers;
    return call(
      f,
      `${base.protocol}//${base.host}${awsEncode(p, true)}${qs}`,
      { method, headers: sendHeaders, ...(o.body ? { body: o.body } : {}) },
      where,
    );
  };
  const store: BlueprintStore = {
    where,
    async check() {
      const probe = `${prefix}.hearth-blueprint-check-${Date.now()}`;
      try {
        const put = await send("PUT", probe, { body: new TextEncoder().encode("check") });
        if (put.status >= 300) throw plainError(put.status, await put.text(), where);
        await send("DELETE", probe);
        await store.list();
      } catch (e) {
        return (e as Error).message;
      }
      return undefined;
    },
    async list() {
      const out: string[] = [];
      let token: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = await send("GET", "", {
          query: {
            "list-type": "2",
            prefix,
            ...(token ? { "continuation-token": token } : {}),
          },
        });
        const text = await r.text();
        if (r.status >= 300) throw plainError(r.status, text, where);
        for (const m of text.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          const name = m[1]!.replace(/&amp;/g, "&").slice(prefix.length);
          if (BLUEPRINT_FILE.test(name)) out.push(name);
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(text)
          ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(text)?.[1]
          : undefined;
        if (!token) break;
      }
      return out.sort();
    },
    async put(name, bytes) {
      // Not every S3-compatible service takes a conditional write, so the list says if it's taken.
      if ((await store.list()).includes(name)) return false;
      const r = await send("PUT", `${prefix}${name}`, { body: bytes });
      if (r.status >= 300) throw plainError(r.status, await r.text(), where);
      return true;
    },
    async get(name) {
      const r = await send("GET", `${prefix}${name}`);
      if (r.status === 404) return undefined;
      if (r.status >= 300) throw plainError(r.status, await r.text(), where);
      return new Uint8Array(await r.arrayBuffer());
    },
    async remove(name) {
      const r = await send("DELETE", `${prefix}${name}`);
      if (r.status >= 300 && r.status !== 404) throw plainError(r.status, await r.text(), where);
    },
  };
  return store;
}

export function webdavStore(
  c: Extract<BlueprintCloud, { kind: "webdav" }>,
  login: CloudLogin,
  opts: { fetch?: CloudFetch } = {},
): BlueprintStore {
  const f = opts.fetch ?? realFetch;
  const folder = c.url.replace(/\/+$/, "");
  const where = cloudWhere(c);
  const auth = `Basic ${Buffer.from(`${login.username}:${login.secret}`).toString("base64")}`;
  const send = (
    method: string,
    name: string,
    extra: Record<string, string> = {},
    body?: Uint8Array,
  ) =>
    call(
      f,
      `${folder}/${name ? encodeURIComponent(name) : ""}`,
      { method, headers: { authorization: auth, ...extra }, ...(body ? { body } : {}) },
      where,
    );
  const store: BlueprintStore = {
    where,
    async check() {
      const probe = `.hearth-blueprint-check-${Date.now()}`;
      try {
        const put = await send("PUT", probe, {}, new TextEncoder().encode("check"));
        if (put.status === 409)
          throw new StoreError(`${where} doesn't exist. Create the folder first.`);
        if (put.status >= 300) throw plainError(put.status, await put.text(), where);
        await send("DELETE", probe);
        await store.list();
      } catch (e) {
        return (e as Error).message;
      }
      return undefined;
    },
    async list() {
      const r = await send("PROPFIND", "", { depth: "1", "content-type": "application/xml" });
      const text = await r.text();
      if (r.status !== 207) throw plainError(r.status, text, where);
      const out: string[] = [];
      for (const m of text.matchAll(/<(?:[\w-]+:)?href>([^<]+)<\/(?:[\w-]+:)?href>/gi)) {
        const name = decodeURIComponent(m[1]!.replace(/\/+$/, "").split("/").pop() ?? "");
        if (BLUEPRINT_FILE.test(name)) out.push(name);
      }
      return [...new Set(out)].sort();
    },
    async put(name, bytes) {
      const r = await send("PUT", name, { "if-none-match": "*" }, bytes);
      if (r.status === 412) return false;
      if (r.status >= 300) throw plainError(r.status, await r.text(), where);
      return true;
    },
    async get(name) {
      const r = await send("GET", name);
      if (r.status === 404) return undefined;
      if (r.status >= 300) throw plainError(r.status, await r.text(), where);
      return new Uint8Array(await r.arrayBuffer());
    },
    async remove(name) {
      const r = await send("DELETE", name);
      if (r.status >= 300 && r.status !== 404) throw plainError(r.status, await r.text(), where);
    },
  };
  return store;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/**
 * Writes one new dated version, never over another, then reads it back and checks the bytes stored
 * are the bytes written. Only then are the oldest beyond `keep` removed (Hearth's own versions only).
 */
export async function writeVersion(
  store: BlueprintStore,
  bytes: Uint8Array,
  now: Date,
  keep: number,
): Promise<{ file: string; bytes: number; removed: string[] }> {
  let at = now;
  let file = `hearth-blueprint-${stamp(at)}.age`;
  // Two versions in one second (Update now twice): the next free second, never an overwrite.
  for (let i = 0; ; i++) {
    if (await store.put(file, bytes)) break;
    if (i === 4) throw new StoreError(`${store.where} already holds ${file}.`);
    at = new Date(at.getTime() + 1000);
    file = `hearth-blueprint-${stamp(at)}.age`;
  }
  const back = await store.get(file);
  if (!back || sha(back) !== sha(bytes)) {
    await store.remove(file).catch(() => undefined);
    throw new StoreError(
      `The copy written to ${store.where} doesn't match what Hearth wrote; it was removed.`,
    );
  }
  const removed: string[] = [];
  const ours = await store.list();
  for (const old of ours.slice(0, Math.max(0, ours.length - keep))) {
    await store.remove(old);
    removed.push(old);
  }
  return { file, bytes: back.length, removed };
}
