import type { Fetch } from "./http";

/**
 * A stand-in Gitea (port 3030) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering as a throwaway gitea/gitea 1.27.3 did: a token starting "e2e-", repositories
 * (one private, one a pull mirror that is late), two Actions runners (one offline), a failed workflow
 * run, people, and Gitea's scheduled tasks. Syncing, re-running, runners on, off and removed change
 * what it answers next. Totals come in the X-Total-Count header, as Gitea sends them.
 */

export interface FakeGitea {
  fetch: Fetch;
  reset(): void;
}

/**
 * With forgejo, it answers as a throwaway Forgejo 13.0.5 did instead: the same API, but no runner
 * list, no site-wide run list and no re-run; runs are listed per repository, in Forgejo's shape.
 */
export function fakeGitea(options: { forgejo?: boolean } = {}): FakeGitea {
  const ago = (min: number) =>
    new Date(Date.now() - min * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  let mirrorUpdated = "";
  let runners: { id: number; name: string; status: string; busy: boolean; disabled: boolean }[] =
    [];
  let attempt = 1;
  const reset = () => {
    mirrorUpdated = ago(60 * 30);
    runners = [
      { id: 2, name: "garage-runner", status: "online", busy: false, disabled: false },
      { id: 1, name: "shed-runner", status: "offline", busy: false, disabled: false },
    ];
    attempt = 1;
  };
  reset();

  const owner = { login: "alex" };
  const repos = () => [
    {
      id: 1,
      name: "homelab",
      full_name: "alex/homelab",
      owner,
      private: true,
      mirror: false,
      archived: false,
      size: 2048,
      updated_at: ago(20),
    },
    {
      id: 2,
      name: "notes",
      full_name: "alex/notes",
      owner,
      private: false,
      mirror: false,
      archived: false,
      size: 512,
      updated_at: ago(60 * 5),
    },
    {
      id: 3,
      name: "upstream-mirror",
      full_name: "alex/upstream-mirror",
      owner,
      private: false,
      mirror: true,
      archived: false,
      size: 4096,
      updated_at: ago(60 * 30),
      mirror_interval: "8h0m0s",
      mirror_updated: mirrorUpdated,
    },
    {
      id: 4,
      name: "old-site",
      full_name: "alex/old-site",
      owner,
      private: false,
      mirror: false,
      archived: true,
      size: 128,
      updated_at: ago(60 * 24 * 90),
    },
  ];
  const run = () => ({
    id: 7,
    display_title: "Update compose files",
    path: "ci.yml@refs/heads/main",
    head_branch: "main",
    status: attempt > 1 ? "running" : "completed",
    conclusion: attempt > 1 ? "" : "failure",
    run_attempt: attempt,
    started_at: ago(45),
    repository: { name: "homelab", owner },
  });

  const reply = (status: number, body: unknown, total?: number) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    return {
      ok: status < 400,
      status,
      json: async () => JSON.parse(text || "null") as unknown,
      text: async () => text,
      headers: {
        get: (n: string) =>
          n.toLowerCase() === "x-total-count" && total !== undefined ? String(total) : null,
      },
    };
  };

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1/, "");
    const method = init.method ?? "GET";
    if (!(init.headers.Authorization ?? "").startsWith("token e2e-"))
      return reply(401, { message: "user does not exist [uid: 0, name: ]" });
    if (path === "/version")
      return reply(200, { version: options.forgejo ? "13.0.5+gitea-1.22.0" : "1.27.3" });
    if (options.forgejo) {
      if (path.startsWith("/admin/actions/") || path.includes("/rerun")) return reply(404, null);
      if (path === "/repos/alex/homelab/actions/runs")
        return reply(200, {
          workflow_runs: [
            {
              id: 3,
              title: "Update compose files",
              workflow_id: "ci.yml",
              prettyref: "main",
              status: "waiting",
              started: "1970-01-01T00:00:00Z",
              created: ago(10),
              // Forgejo sends the whole push with each run; Hearth never keeps it.
              event_payload: '{"pusher":{"email":"alex@example.com"}}',
              repository: { name: "homelab", owner },
            },
            {
              id: 2,
              title: "Bump images",
              workflow_id: "ci.yml",
              prettyref: "main",
              status: "failure",
              started: ago(60),
              created: ago(61),
              repository: { name: "homelab", owner },
            },
          ],
          total_count: 2,
        });
      if (/^\/repos\/alex\/[^/]+\/actions\/runs$/.test(path))
        return reply(200, { workflow_runs: [], total_count: 0 });
    }
    if (path === "/repos/search") {
      const list =
        u.searchParams.get("mode") === "mirror" ? repos().filter((r) => r.mirror) : repos();
      return reply(200, { ok: true, data: list }, list.length);
    }
    if (path === "/admin/users")
      return reply(
        200,
        [
          { login: "alex", is_admin: true },
          { login: "sam", is_admin: false },
          { login: "kid", is_admin: false },
        ],
        3,
      );
    if (path === "/admin/orgs") return reply(200, [{ username: "family" }], 1);
    if (path === "/admin/actions/runners")
      return reply(200, {
        runners: runners.map((r) => ({
          ...r,
          ephemeral: false,
          labels: [{ id: 0, name: "ubuntu-latest", type: "custom" }],
        })),
        total_count: runners.length,
      });
    const rn = /^\/admin\/actions\/runners\/(\d+)$/.exec(path);
    if (rn) {
      const r = runners.find((x) => x.id === Number(rn[1]));
      if (!r) return reply(404, { message: `runner with id ${rn[1]}: resource does not exist` });
      if (method === "PATCH")
        r.disabled = Boolean((JSON.parse(init.body ?? "{}") as { disabled?: boolean }).disabled);
      if (method === "DELETE") {
        runners = runners.filter((x) => x !== r);
        return reply(204, undefined);
      }
      return reply(200, r);
    }
    if (path === "/admin/actions/runs")
      return reply(200, { workflow_runs: [run()], total_count: 1 });
    if (path === "/admin/cron")
      return reply(200, [
        {
          name: "update_mirrors",
          schedule: "@every 10m",
          next: ago(-5),
          prev: ago(5),
          exec_times: 12,
        },
        {
          name: "repo_health_check",
          schedule: "@midnight",
          next: ago(-600),
          prev: "0001-01-01T00:00:00Z",
          exec_times: 0,
        },
      ]);
    if (/^\/admin\/cron\/(update_mirrors|repo_health_check)$/.test(path) && method === "POST")
      return reply(204, undefined);
    if (path === "/repos/alex/upstream-mirror/mirror-sync" && method === "POST") {
      mirrorUpdated = ago(0);
      return reply(200, undefined);
    }
    if (path === "/repos/alex/upstream-mirror") return reply(200, repos()[2]);
    if (path === "/repos/alex/homelab/actions/runs/7/rerun-failed-jobs" && method === "POST") {
      attempt += 1;
      return reply(201, run());
    }
    if (path === "/repos/alex/homelab/actions/runs/7") return reply(200, run());
    return reply(404, { message: "not found" });
  };

  return { fetch: fetchImpl, reset };
}
