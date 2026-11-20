import { createHash } from "node:crypto";
import type { Fetch } from "./http";

/**
 * A stand-in Portainer CE (port 9000) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering as a throwaway portainer/portainer-ce 2.45.3 did: an e2e- access token, one
 * Docker environment and one offline, two stacks (one runs a VPN, so it is protected), containers
 * (one unhealthy, one stopped, and Hearth's own), and the stack and container calls. A stack's
 * environment variables hold a secret that must never reach the panel. Image updates answer 404,
 * as in the Community edition.
 */

export interface FakePortainer {
  fetch: Fetch;
  reset(): void;
  containers(): Box[];
}

interface Box {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels: Record<string, string>;
}

export function fakePortainer(): FakePortainer {
  let boxes: Box[] = [];
  let stacks: {
    Id: number;
    Name: string;
    EndpointId: number;
    Status: number;
    Type: number;
    Env: { name: string; value: string }[];
    UpdateDate: number;
    UpdatedBy: string;
    file: string;
  }[] = [];
  const box = (n: string, image: string, state: string, status: string, project?: string): Box => ({
    // A 64-character hex id, like Docker's.
    Id: createHash("sha256").update(n).digest("hex"),
    Names: [`/${n}`],
    Image: image,
    State: state,
    Status: status,
    Labels: project ? { "com.docker.compose.project": project } : {},
  });
  const reset = () => {
    boxes = [
      box("media-radarr-1", "linuxserver/radarr", "running", "Up 3 days", "media"),
      box("media-sonarr-1", "linuxserver/sonarr", "running", "Up 3 days (unhealthy)", "media"),
      box("vpn-gluetun-1", "qmcgaw/gluetun", "running", "Up 9 days (healthy)", "vpn"),
      box("old-test", "busybox", "exited", "Exited (0) 2 weeks ago"),
      box("hearth", "ghcr.io/hearth/hearth", "running", "Up 1 day"),
    ];
    stacks = [
      {
        Id: 1,
        Name: "media",
        EndpointId: 1,
        Status: 1,
        Type: 2,
        Env: [{ name: "API_KEY", value: "e2e-SECRET" }],
        UpdateDate: Math.floor(Date.now() / 1000) - 86400,
        UpdatedBy: "alex",
        file: "services:\n  radarr: {}\n",
      },
      {
        Id: 2,
        Name: "vpn",
        EndpointId: 1,
        Status: 1,
        Type: 2,
        Env: [],
        UpdateDate: 0,
        UpdatedBy: "",
        file: "services:\n  gluetun: {}\n",
      },
    ];
  };
  reset();
  const reply = (status: number, data?: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () =>
      data === undefined ? "" : typeof data === "string" ? data : JSON.stringify(data),
  });
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api/, "");
    const method = init.method ?? "GET";
    if (!String((init.headers as Record<string, string>)["X-API-Key"] ?? "").startsWith("e2e-"))
      return reply(401, { message: "Unauthorized", details: "Invalid API key" });
    if (p === "/system/status") return reply(200, { Version: "2.45.3", InstanceID: "e2e" });
    if (p === "/endpoints")
      return reply(200, [
        {
          Id: 1,
          Name: "local",
          Type: 1,
          Status: 1,
          Snapshots: [{ ImageCount: 24, TotalCPU: 8, TotalMemory: 34359738368 }],
        },
        { Id: 2, Name: "nas", Type: 2, Status: 2, Snapshots: [] },
      ]);
    if (p === "/stacks")
      return reply(
        200,
        stacks.map(({ file: _f, ...s }) => s),
      );
    if (p === "/endpoints/1/docker/containers/json") return reply(200, boxes);
    if (/^\/docker\/\d+\/containers\/[^/]+\/image_status$/.test(p))
      return reply(404, "404 page not found");
    const st = p.match(/^\/stacks\/(\d+)(\/(start|stop|file))?$/);
    if (st) {
      const s = stacks.find((x) => x.Id === Number(st[1]));
      if (!s)
        return reply(404, {
          message: "Unable to find a stack with the specified identifier inside the database",
        });
      const { file, ...shown } = s;
      if (st[3] === "file") return reply(200, { StackFileContent: file });
      if (st[3] === "start" || st[3] === "stop") {
        const on = st[3] === "start";
        if ((s.Status === 1) === on)
          return reply(400, { message: `Stack is already ${on ? "active" : "inactive"}` });
        s.Status = on ? 1 : 2;
        for (const b of boxes.filter((x) => x.Labels["com.docker.compose.project"] === s.Name)) {
          b.State = on ? "running" : "exited";
          b.Status = on ? "Up 1 second" : "Exited (0) 1 second ago";
        }
        return reply(200, shown);
      }
      if (method === "PUT") {
        for (const b of boxes.filter((x) => x.Labels["com.docker.compose.project"] === s.Name)) {
          b.State = "running";
          b.Status = "Up 1 second";
        }
        s.UpdateDate = Math.floor(Date.now() / 1000);
        return reply(200, shown);
      }
      return reply(200, shown);
    }
    const ct = p.match(
      /^\/endpoints\/1\/docker\/containers\/([a-f0-9]{12})[a-f0-9]*\/(start|stop|restart)$/,
    );
    if (ct) {
      const b = boxes.find((x) => x.Id.startsWith(ct[1]!));
      if (!b) return reply(404, { message: "No such container" });
      b.State = ct[2] === "stop" ? "exited" : "running";
      b.Status = ct[2] === "stop" ? "Exited (0) 1 second ago" : "Up 1 second";
      return reply(204);
    }
    return reply(404, "404 page not found");
  };
  return { fetch: fetchImpl, reset, containers: () => boxes };
}
