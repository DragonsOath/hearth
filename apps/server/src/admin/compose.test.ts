import { describe, expect, it } from "vitest";
import { classify } from "./scope";
import {
  guardService,
  homelabRootsFrom,
  newIssues,
  semanticDiff,
  type ComposeServiceSpec,
} from "./compose";

const policy = {
  homelabRoots: ["/mnt/storage/docker", "/mnt/d"],
  classify: (p: string) =>
    classify(p, { secretRoots: ["/mnt/storage/secrets"], protectedRoots: [] }),
};

const svc = (over: Partial<ComposeServiceSpec> = {}): ComposeServiceSpec => ({
  name: "app",
  volumes: [],
  ports: [],
  environment: [],
  privileged: false,
  capAdd: [],
  devices: [],
  securityOpt: [],
  ...over,
});
const bind = (source: string, readOnly = false) => ({
  type: "bind",
  source,
  target: "/x",
  readOnly,
});

describe("the mount guard", () => {
  it("allows the homelab's own folders and the clock, and judges the rest", () => {
    expect(
      guardService(
        svc({ volumes: [bind("/mnt/d/tv"), bind("/mnt/storage/docker/config/app")] }),
        policy,
      ),
    ).toEqual([]);
    expect(guardService(svc({ volumes: [bind("/etc/localtime", true)] }), policy)).toEqual([]);
    // The clock, writable, is a different matter.
    expect(guardService(svc({ volumes: [bind("/etc/localtime")] }), policy)[0]?.verdict).toBe(
      "protected",
    );
    expect(guardService(svc({ volumes: [bind("/home/me/stuff")] }), policy)[0]).toMatchObject({
      verdict: "protected",
      why: expect.stringMatching(/outside your homelab folders/),
    });
    expect(guardService(svc({ volumes: [bind("/var/run/docker.sock")] }), policy)[0]).toMatchObject(
      {
        verdict: "protected",
        why: expect.stringMatching(/control of Docker/),
      },
    );
    expect(
      guardService(svc({ volumes: [bind("/mnt/storage/secrets/hearth")] }), policy)[0]?.verdict,
    ).toBe("refused");
    expect(guardService(svc({ volumes: [bind("/")] }), policy)[0]?.verdict).toBe("refused");
    // Named volumes are Docker's own storage, not host folders.
    expect(
      guardService(
        svc({ volumes: [{ type: "volume", source: "db", target: "/data", readOnly: false }] }),
        policy,
      ),
    ).toEqual([]);
  });

  it("asks you about host access, privileges, and devices", () => {
    const issues = guardService(
      svc({
        privileged: true,
        networkMode: "host",
        capAdd: ["NET_ADMIN"],
        devices: ["/dev/dri:/dev/dri"],
        securityOpt: ["apparmor:unconfined"],
      }),
      policy,
    );
    expect(issues.map((i) => i.verdict)).toEqual(Array(5).fill("protected"));
  });

  it("with no homelab folders configured, every folder mount needs you", () => {
    expect(homelabRootsFrom({})).toEqual([]);
    expect(homelabRootsFrom({ DC_HOMELAB_ROOTS: "/mnt/d, /, relative ,/srv/x/" })).toEqual([
      "/mnt/d",
      "/srv/x/",
    ]);
    const none = { ...policy, homelabRoots: [] };
    expect(guardService(svc({ volumes: [bind("/mnt/d/tv")] }), none)[0]?.why).toMatch(
      /no homelab folders/,
    );
  });

  it("judges only what a change adds, and describes it in Compose's terms", () => {
    const before = [
      svc({
        name: "jellyfin",
        image: "jellyfin:10.9",
        devices: ["/dev/dri:/dev/dri"],
        environment: ["TZ"],
      }),
    ];
    const after = [
      svc({
        name: "jellyfin",
        image: "jellyfin:10.10",
        devices: ["/dev/dri:/dev/dri"],
        environment: ["TZ", "JELLYFIN_URL"],
        volumes: [bind("/home/me/x")],
      }),
    ];
    const added = newIssues(
      before.flatMap((s) => guardService(s, policy)),
      after.flatMap((s) => guardService(s, policy)),
    );
    expect(added.map((i) => i.what)).toEqual(["/home/me/x mounted at /x"]);
    expect(semanticDiff(before, after).map((d) => d.change)).toEqual([
      "Image: jellyfin:10.9 to jellyfin:10.10",
      "Volumes added: /home/me/x:/x",
      "Environment variables added: JELLYFIN_URL",
    ]);
  });
});
