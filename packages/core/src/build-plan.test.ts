import { describe, expect, it } from "vitest";
import { recommendBuild, type BuildAnswers, type HostScan } from "./build-plan";

const GB = 1024 ** 3;
const scan = (over: Partial<HostScan> = {}): HostScan => ({
  hostname: "server",
  os: "Ubuntu 24.04 LTS",
  platform: "linux",
  cpu: "AMD Ryzen 7",
  cores: 8,
  memoryBytes: 32 * GB,
  freeMemoryBytes: 24 * GB,
  gpus: [],
  disks: [
    { name: "/", totalBytes: 1000 * GB, freeBytes: 800 * GB },
    { name: "/srv/media", totalBytes: 8000 * GB, freeBytes: 6000 * GB },
  ],
  network: "wired",
  docker: true,
  running: [],
  ...over,
});
const answers = (over: Partial<BuildAnswers> = {}): BuildAnswers => ({
  wants: [],
  devices: [],
  ...over,
});
const apps = (plan: ReturnType<typeof recommendBuild>, starter = true) =>
  plan.capabilities.filter((c) => c.starter === starter).flatMap((c) => c.apps.map((a) => a.id));

/** The owner's example: an old 4 GB Windows laptop, a drive of films, no budget. */
const laptop = scan({
  hostname: "LAPTOP-7F3",
  os: "Windows 10",
  platform: "win32",
  cores: 4,
  memoryBytes: 4 * GB,
  freeMemoryBytes: 1.2 * GB,
  gpus: [{ vendor: "intel", name: "Intel UHD Graphics" }],
  disks: [
    { name: "C:\\", totalBytes: 240 * GB, freeBytes: 60 * GB },
    {
      name: "E:\\",
      totalBytes: 500 * GB,
      freeBytes: 380 * GB,
      media: { videos: 412, audio: 0, photos: 0 },
    },
  ],
  network: "wifi",
  docker: false,
});

describe("the beginner's plan", () => {
  it("starts the 4 GB laptop with Jellyfin from its own installer, using the films where they are", () => {
    const plan = recommendBuild(
      answers({
        wants: ["watch"],
        budget: "free",
        media: "external",
        devices: ["roku", "phone"],
        experience: "new",
      }),
      laptop,
    );
    expect(apps(plan)).toEqual(["jellyfin"]);
    expect(plan.installMethod.method).toBe("native");
    expect(plan.installMethod.why).toMatch(
      /1\.2 GB of memory free, and Docker would use about 2 GB/,
    );
    // A laptop in daily use: 1.2 GB is free now (measured), but 4 GB less the system (3 GB)
    // and everyday use (1 GB) leaves nothing to count on, so the plan uses its floor of 0.5 GB.
    expect(plan.memoryBudget).toEqual({ gb: 0.5, measured: true, basis: "free-now", spareGb: 0.5 });
    expect(plan.notes[0]).toMatch(
      /1\.2 GB is free right now \(measured\), but on a computer you also use, that changes/,
    );
    // Still the starter, honestly marked: tight on a laptop that's also used every day.
    expect(plan.capabilities[0]!.apps[0]).toMatchObject({
      install: "native",
      fit: "slow",
      cost: "Free",
    });
    expect(plan.capabilities[0]!.apps[0]!.fitReason).toMatch(/^Possible with trade-offs/);
    expect(plan.notes).toContainEqual(
      expect.stringMatching(/Found 412 videos on E:.*nothing is copied, moved, or renamed/),
    );
    expect(plan.approvals).toContainEqual(expect.stringMatching(/own installer/));
    // Windows: the choice is explained, keeping Windows is recommended, and the person decides.
    expect(plan.choices.map((c) => c.id)).toEqual(["media-app", "downloads", "system"]);
    // Watching their own films: downloads are offered, explained, and not assumed.
    expect(plan.choices[1]).toMatchObject({ recommended: "no" });
    expect(plan.choices[2]).toMatchObject({ recommended: "keep" });
  });

  it("makes Docker-only apps wait on a small Windows machine, and says why", () => {
    const plan = recommendBuild(answers({ wants: ["watch", "photos"], budget: "free" }), laptop);
    const photos = plan.capabilities.find((c) => c.id === "photos")!;
    expect(photos.starter).toBe(false);
    expect(photos.waitReason).toMatch(/only comes for Docker/);
    expect(photos.apps[0]!.fit).toBe("wait");
  });

  it("lays out Jellyfin and Plex, recommends one for this person, and honours their pick", () => {
    const free = recommendBuild(
      answers({ wants: ["watch"], budget: "free", devices: ["roku"] }),
      scan(),
    );
    expect(free.choices[0]).toMatchObject({ id: "media-app", recommended: "jellyfin" });
    expect(free.choices[0]!.options.map((o) => o.id)).toEqual(["jellyfin", "plex"]);
    const spends = recommendBuild(
      answers({ wants: ["watch"], budget: "low", devices: ["roku"] }),
      scan(),
    );
    expect(spends.choices[0]!.recommended).toBe("plex");
    expect(
      recommendBuild(answers({ wants: ["watch"], existingServer: "plex", budget: "free" }), scan())
        .choices[0]!.recommended,
    ).toBe("plex");
    // The person's own choice wins.
    expect(
      apps(
        recommendBuild(answers({ wants: ["watch"], budget: "free" }), scan(), {
          "media-app": "plex",
        }),
      ),
    ).toContain("plex");
  });

  it("brings the download tools with a request wish, with the P2P VPN said up front and approved", () => {
    const plan = recommendBuild(answers({ wants: ["request"], budget: "low" }), scan(), {
      "vpn-needed": "get",
    });
    expect(apps(plan)).toEqual(
      expect.arrayContaining(["jellyfin", "seerr", "radarr", "sonarr", "prowlarr", "qbittorrent"]),
    );
    const q = plan.capabilities.flatMap((c) => c.apps).find((a) => a.id === "qbittorrent")!;
    expect(q.needs[0]).toMatch(/A VPN that allows P2P/);
    expect(plan.approvals).toContain("Linking your VPN before any download starts");
    // Watching your own films never brings them.
    expect(apps(recommendBuild(answers({ wants: ["watch"] }), scan()))).not.toContain(
      "qbittorrent",
    );
  });

  it("gives someone exploring the full media starter, with a VPN recommended for their budget", () => {
    const plan = recommendBuild(
      answers({ wants: ["explore"], away: "away", budget: "unsure" }),
      scan(),
      { "vpn-needed": "get" },
    );
    expect(apps(plan)).toEqual([
      "jellyfin",
      "seerr",
      "radarr",
      "sonarr",
      "prowlarr",
      "qbittorrent",
      "tailscale",
    ]);
    expect(plan.choices.map((c) => c.id)).toEqual(["media-app", "downloads", "vpn-needed", "vpn"]);
    expect(plan.choices[1]!.recommended).toBe("yes");
    expect(plan.choices[3]).toMatchObject({ recommended: "proton" });
    expect(plan.choices[3]!.options.map((o) => o.id)).toEqual(["proton", "airvpn", "mullvad"]);
    const q = plan.capabilities.flatMap((c) => c.apps).find((x) => x.id === "qbittorrent")!;
    expect(q.why).toMatch(/only ever through Proton VPN,/);
    // A free budget is told plainly there is no good free option; Proton stays the best value.
    const free = recommendBuild(answers({ wants: ["explore"], budget: "free" }), scan(), {
      "vpn-needed": "get",
    });
    expect(free.choices[3]).toMatchObject({ recommended: "proton" });
    expect(free.choices[3]!.why).toMatch(/no free VPN Hearth will use/);
    // Saying no to downloads leaves just the media server.
    expect(
      apps(recommendBuild(answers({ wants: ["explore"] }), scan(), { downloads: "no" })),
    ).toEqual(["jellyfin"]);
  });

  it("counts AMD Radeon graphics as able to convert video", () => {
    const plan = recommendBuild(
      answers({ wants: ["watch"], quality: "4k" }),
      scan({ gpus: [{ vendor: "amd", name: "AMD Radeon 780M Graphics" }] }),
    );
    expect(plan.warnings.join(" ")).not.toMatch(/may stutter/);
    expect(plan.notes).toContainEqual(
      expect.stringMatching(/^AMD Radeon 780M Graphics can convert video/),
    );
  });

  it("waits on what does not fit the memory free, and warns about 4K without video conversion", () => {
    const plan = recommendBuild(
      answers({ wants: ["watch", "ai"], quality: "4k" }),
      scan({ memoryBytes: 8 * GB, freeMemoryBytes: 3 * GB }),
    );
    const ai = plan.capabilities.find((c) => c.id === "ai")!;
    expect(ai.starter).toBe(false);
    expect(ai.waitReason).toMatch(
      /needs about 6\.0 GB of memory, and about 1\.6 GB is left once watch your movies .* is running, which come first/,
    );
    expect(plan.warnings[0]).toMatch(/^4K may stutter/);
  });

  it("adds safe remote access only when wanted, and backups for what can't be replaced", () => {
    const plan = recommendBuild(
      answers({ wants: ["photos"], away: "away", importance: "irreplaceable" }),
      scan(),
    );
    expect(apps(plan)).toEqual(["immich", "tailscale", "backups"]);
    expect(plan.approvals).toContain("Anything that reaches outside your home network");
    expect(apps(recommendBuild(answers({ wants: ["watch"] }), scan()))).not.toContain("tailscale");
  });

  it("reuses what already runs instead of installing it again", () => {
    const plan = recommendBuild(
      answers({ wants: ["watch"], existingServer: "jellyfin" }),
      scan({ running: ["Jellyfin"] }),
    );
    expect(plan.capabilities[0]!.apps[0]).toMatchObject({ id: "jellyfin", installed: true });
  });

  it("reuses a VPN the person already has, said or found, instead of buying another", () => {
    const said = recommendBuild(answers({ wants: ["request"], existingVpn: "nord" }), scan());
    const vpn = said.choices.find((c) => c.id === "vpn")!;
    expect(vpn.recommended).toBe("have-nord");
    expect(vpn.options[0]!.name).toBe("The NordVPN you already have");
    expect(vpn.options[0]!.summary).toMatch(/no port forwarding/);
    const q = said.capabilities.flatMap((c) => c.apps).find((x) => x.id === "qbittorrent")!;
    expect(q.why).toMatch(/only ever through NordVPN/);

    const found = recommendBuild(answers({ wants: ["request"] }), scan({ vpns: ["proton"] }));
    const fv = found.choices.find((c) => c.id === "vpn")!;
    expect(fv.recommended).toBe("have-proton");
    expect(fv.options[0]!.summary).toMatch(/^Found on this computer/);
    // Proton is not offered twice.
    expect(fv.options.map((o) => o.id)).toEqual(["have-proton", "airvpn", "mullvad"]);
  });
});
