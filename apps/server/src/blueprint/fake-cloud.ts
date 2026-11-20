import { createHash } from "node:crypto";
import { signS3, type CloudFetch } from "./store";

/**
 * A stand-in cloud for tests and safe previews (DC_FAKE_APPS=1, never in a real install). It
 * answers as S3-compatible storage (any address; the bucket "hearth-test" exists; requests must
 * carry a correct AWS Signature V4 for the access key e2e-access-key and secret e2e-secret-key) and
 * as WebDAV (any address whose folder ends /hearth exists; user e2e, password e2e-password).
 * Files live in memory.
 */

export const FAKE_CLOUD = {
  s3: { accessKey: "e2e-access-key", secretKey: "e2e-secret-key", bucket: "hearth-test" },
  webdav: { username: "e2e", password: "e2e-password", folder: "/hearth" },
};

export interface FakeCloud {
  fetch: CloudFetch;
  files: Map<string, Uint8Array>;
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function reply(status: number, body: string | Uint8Array = "") {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    status,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

const s3Error = (status: number, code: string) =>
  reply(status, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`);

export function fakeCloud(): FakeCloud {
  const files = new Map<string, Uint8Array>();

  const s3: CloudFetch = async (url, init) => {
    const u = new URL(url);
    const h = Object.fromEntries(
      Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const auth =
      /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(
        h.authorization ?? "",
      );
    if (!auth) return s3Error(403, "AccessDenied");
    const [, key, , region, signed] = auth;
    if (key !== FAKE_CLOUD.s3.accessKey) return s3Error(403, "InvalidAccessKeyId");
    if (h["x-amz-content-sha256"] !== sha(init.body ?? ""))
      return s3Error(400, "XAmzContentSHA256Mismatch");
    const amz = h["x-amz-date"]!;
    const now = new Date(
      `${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`,
    );
    const extra: Record<string, string> = {};
    for (const n of signed!.split(";"))
      if (!["host", "x-amz-date", "x-amz-content-sha256"].includes(n)) extra[n] = h[n] ?? "";
    const want = signS3({
      method: init.method,
      host: u.host,
      path: decodeURIComponent(u.pathname),
      query: Object.fromEntries(u.searchParams),
      headers: extra,
      payloadHash: h["x-amz-content-sha256"]!,
      region: region!,
      accessKey: key!,
      secretKey: FAKE_CLOUD.s3.secretKey,
      now,
    });
    if (want.authorization !== h.authorization) return s3Error(403, "SignatureDoesNotMatch");
    const [, bucket, ...rest] = decodeURIComponent(u.pathname).split("/");
    if (bucket !== FAKE_CLOUD.s3.bucket) return s3Error(404, "NoSuchBucket");
    const objectKey = rest.join("/");
    const id = `s3:${objectKey}`;
    if (!objectKey && init.method === "GET") {
      const prefix = u.searchParams.get("prefix") ?? "";
      const keys = [...files.keys()]
        .filter((k) => k.startsWith(`s3:${prefix}`))
        .map((k) => `<Contents><Key>${k.slice(3)}</Key></Contents>`);
      return reply(
        200,
        `<ListBucketResult><IsTruncated>false</IsTruncated>${keys.join("")}</ListBucketResult>`,
      );
    }
    if (init.method === "PUT") {
      files.set(id, Uint8Array.from(init.body ?? new Uint8Array()));
      return reply(200);
    }
    if (init.method === "GET")
      return files.has(id) ? reply(200, files.get(id)!) : s3Error(404, "NoSuchKey");
    if (init.method === "DELETE") {
      files.delete(id);
      return reply(204);
    }
    return s3Error(405, "MethodNotAllowed");
  };

  const webdav: CloudFetch = async (url, init) => {
    const u = new URL(url);
    const want = `Basic ${Buffer.from(`${FAKE_CLOUD.webdav.username}:${FAKE_CLOUD.webdav.password}`).toString("base64")}`;
    if (init.headers.authorization !== want) return reply(401);
    const p = decodeURIComponent(u.pathname);
    const folder = p.endsWith("/") ? p.slice(0, -1) : p.slice(0, p.lastIndexOf("/"));
    const name = p.endsWith("/") ? "" : p.slice(p.lastIndexOf("/") + 1);
    const exists = folder.endsWith(FAKE_CLOUD.webdav.folder);
    const id = `dav:${name}`;
    if (init.method === "PROPFIND") {
      if (!exists) return reply(404);
      const hrefs = [...files.keys()]
        .filter((k) => k.startsWith("dav:"))
        .map(
          (k) =>
            `<d:response><d:href>${encodeURI(`${folder}/${k.slice(4)}`)}</d:href></d:response>`,
        );
      return reply(
        207,
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${encodeURI(folder)}/</d:href></d:response>${hrefs.join("")}</d:multistatus>`,
      );
    }
    if (!exists) return reply(init.method === "PUT" ? 409 : 404);
    if (init.method === "PUT") {
      if (init.headers["if-none-match"] === "*" && files.has(id)) return reply(412);
      files.set(id, Uint8Array.from(init.body ?? new Uint8Array()));
      return reply(201);
    }
    if (init.method === "GET") return files.has(id) ? reply(200, files.get(id)!) : reply(404);
    if (init.method === "DELETE") {
      const had = files.delete(id);
      return reply(had ? 204 : 404);
    }
    return reply(405);
  };

  return {
    files,
    fetch: (url, init) =>
      /^AWS4-HMAC-SHA256/.test(init.headers.authorization ?? "")
        ? s3(url, init)
        : webdav(url, init),
  };
}
