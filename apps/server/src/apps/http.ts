/**
 * How app readers talk to apps: plain HTTP with a short timeout. Credentials
 * go in headers (or, for SABnzbd, the query string the app requires); URLs
 * and credentials are never put in errors, logs, or reports.
 */

export type Fetch = (
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
    /** "manual": answer a redirect itself, to keep the cookies it sets (a sign-in). */
    redirect?: "manual";
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
}>;

/**
 * Why a use of a credential failed, so the vault (and Ember) can tell
 * a wrong credential from everything that is not the credential's fault.
 */
export type FailureKind = "rejected" | "unreachable" | "blocked" | "incompatible" | "internal";

/** The credential was refused: the vault entry needs replacing. */
export class AppKeyError extends Error {
  readonly kind: FailureKind = "rejected";
}
/** The app could not be reached or answered with an error. */
export class AppUnreachableError extends Error {
  readonly kind: FailureKind = "unreachable";
}
/** The app is temporarily refusing Hearth (for example after failed sign-ins). */
export class AppBlockedError extends AppUnreachableError {
  override readonly kind: FailureKind = "blocked";
}
/** The app answered in a way Hearth does not handle: its problem, not the credential's. */
export class AppIncompatibleError extends AppUnreachableError {
  override readonly kind: FailureKind = "incompatible";
}

export const TIMEOUT_MS = 8000;

export const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`;

/** A GET with the *arr-style API key header; errors name the app and path, never the key. */
export async function getJson<T>(
  fetchImpl: Fetch,
  app: string,
  base: string,
  path: string,
  key: string,
): Promise<T> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      headers: { "X-Api-Key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `${app} did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new AppKeyError(`${app} refused the API key. Check the key in the vault.`);
  }
  if (!res.ok) {
    throw new AppUnreachableError(`${app} answered ${res.status} for ${path.split("?")[0]}.`);
  }
  return (await res.json()) as T;
}

export const mb = (bytes?: number) =>
  bytes === undefined || !Number.isFinite(bytes) ? undefined : Math.round(bytes / 1048576);

export function worst(issues: { level: "warning" | "error" }[]): "ok" | "attention" | "failing" {
  return issues.some((i) => i.level === "error") ? "failing" : issues.length ? "attention" : "ok";
}

/**
 * The same call with bytes in the body: only for a file upload (a .torrent or .nzb in a
 * multipart form). The platform's fetch takes bytes as they are; a stand-in app reads them back.
 */
export type UploadFetch = (
  url: string,
  init: Omit<Parameters<Fetch>[1], "body"> & { body: Uint8Array },
) => ReturnType<Fetch>;

/** A request body as text (an upload's bytes read one byte per character, as multipart parsers do). */
export const bodyText = (body: unknown): string =>
  typeof body === "string"
    ? body
    : body instanceof Uint8Array
      ? Buffer.from(body).toString("latin1")
      : "";

/** A multipart form with text fields and files, as bytes. */
export function multipart(
  fields: Record<string, string>,
  files: { field: string; filename: string; type: string; data: Uint8Array }[],
): { body: Uint8Array; contentType: string } {
  const boundary = `----hearth${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  for (const f of files) {
    const safe = f.filename.replace(/["\r\n]/g, "_");
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${safe}"\r\nContent-Type: ${f.type}\r\n\r\n`,
      ),
      Buffer.from(f.data),
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: new Uint8Array(Buffer.concat(parts)),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
