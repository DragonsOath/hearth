import { existsSync } from "node:fs";
import http from "node:http";

/**
 * A deliberately tiny Docker Engine API client that can only issue GET
 * requests. Discovery is read-only by construction: there is no code path
 * here that can start, stop, or change anything.
 */
export interface DockerReader {
  endpoint: string;
  get<T>(path: string): Promise<T>;
  /** Raw bytes, for endpoints that are not JSON (logs). Still GET only. */
  getRaw(path: string): Promise<Buffer>;
}

function getRaw(socketPath: string, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: "GET", timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`Docker responded ${res.statusCode} for ${path}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on("timeout", () =>
      req.destroy(new Error(`Docker did not answer within ${TIMEOUT_MS / 1000}s`)),
    );
    req.on("error", reject);
    req.end();
  });
}

const TIMEOUT_MS = 8000;

function candidateSockets(env: NodeJS.ProcessEnv): string[] {
  const fromEnv = env.DOCKER_HOST;
  const list: string[] = [];
  if (fromEnv?.startsWith("npipe://"))
    list.push(fromEnv.replace(/^npipe:\/\//, "").replace(/\//g, "\\"));
  else if (fromEnv?.startsWith("unix://")) list.push(fromEnv.replace(/^unix:\/\//, ""));
  if (process.platform === "win32") {
    // Docker Desktop's Linux engine, then the classic engine pipe.
    list.push("\\\\.\\pipe\\dockerDesktopLinuxEngine", "\\\\.\\pipe\\docker_engine");
  } else {
    list.push("/var/run/docker.sock", `${env.HOME ?? ""}/.docker/run/docker.sock`);
  }
  return [...new Set(list)];
}

function getJson<T>(socketPath: string, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: "GET",
        headers: { accept: "application/json" },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Docker responded ${res.statusCode} for ${path}`));
            return;
          }
          // /_ping answers with plain "OK", not JSON.
          if (path === "/_ping") {
            resolve(body as T);
            return;
          }
          try {
            resolve((body ? JSON.parse(body) : null) as T);
          } catch {
            reject(new Error(`Docker returned unreadable data for ${path}`));
          }
        });
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`Docker did not answer within ${TIMEOUT_MS / 1000}s`)),
    );
    req.on("error", reject);
    req.end();
  });
}

/** Finds a Docker endpoint that answers, or explains why none did. */
export async function connectDocker(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ reader: DockerReader } | { error: string }> {
  if (env.DOCKER_HOST?.startsWith("tcp://")) {
    return { error: "DOCKER_HOST points at a TCP endpoint, which discovery does not support yet." };
  }
  const tried: string[] = [];
  const reasons: string[] = [];
  for (const socketPath of candidateSockets(env)) {
    if (process.platform !== "win32" && !existsSync(socketPath)) continue;
    tried.push(socketPath);
    try {
      await getJson<unknown>(socketPath, "/_ping");
      return {
        reader: {
          endpoint: socketPath,
          get: (path) => getJson(socketPath, path),
          getRaw: (path) => getRaw(socketPath, path),
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      reasons.push(
        code === "EACCES"
          ? `${socketPath}: permission denied (the user running Hearth needs to be in the docker group)`
          : `${socketPath}: ${code ?? (error as Error).message}`,
      );
    }
  }
  return {
    error: tried.length
      ? `Docker is installed but did not answer. ${reasons.join("; ")}.`
      : "Docker was not found on this machine.",
  };
}
