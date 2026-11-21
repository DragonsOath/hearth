import { describe, expect, it } from "vitest";
import {
  BUILD_QUESTIONS,
  comparePlans,
  includeAnywayEffects,
  leaveOutEffects,
  planGroups,
  PLANNING_ASSUMPTIONS,
  recommendBuild,
  type BuildAnswers,
  type BuildPlan,
  type BuildWant,
  type GoalDecisions,
  type HostScan,
} from "./build-plan";

// Issue #16: nothing the person asks for may quietly disappear from their plan.

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
  // A VPN found on this computer, so download goals can be met (the VPN rule has its own tests).
  vpns: ["proton"],
  ...over,
});
const answers = (over: Partial<BuildAnswers> = {}): BuildAnswers => ({
  wants: [],
  devices: [],
  ...over,
});
const req = (plan: BuildPlan, id: string) => plan.requirements.find((r) => r.id === id);

const MACHINES: [string, HostScan][] = [
  ["a big server", scan({ gpus: [{ vendor: "intel", name: "Intel UHD 770" }] })],
  [
    "a 4 GB Windows laptop",
    scan({
      platform: "win32",
      os: "Windows 10",
      cores: 4,
      memoryBytes: 4 * GB,
      freeMemoryBytes: 1.2 * GB,
      disks: [{ name: "C:\\", totalBytes: 240 * GB, freeBytes: 60 * GB }],
      docker: false,
    }),
  ],
  ["an 8 GB mini PC", scan({ memoryBytes: 8 * GB, freeMemoryBytes: 5 * GB, docker: false })],
];
const WANTS = BUILD_QUESTIONS.wants.options
  .map(([id]) => id)
  .filter((w) => w !== "explore") as BuildWant[];
const EXTRAS: Partial<BuildAnswers>[] = [
  {},
  { away: "away", importance: "irreplaceable", quality: "4k", streams: "4+", budget: "free" },
  { existingServer: "emby", existingVpn: "other", budget: "low" },
  { existingServer: "plex", existingVpn: "nord", away: "away", budget: "free" },
];

describe("every goal is traced to the plan", () => {
  it("never loses a wish, on any machine, with any mix of wishes, answers, and left-out apps", () => {
    let plans = 0;
    for (const [machine, host] of MACHINES)
      for (let mask = 1; mask < 1 << WANTS.length; mask++) {
        const wants = WANTS.filter((_, i) => mask & (1 << i));
        for (const extra of EXTRAS) {
          const a = answers({ wants, ...extra });
          const first = recommendBuild(a, host);
          // Leave out the first app of the plan too: that must show up, not vanish.
          const leaveOut = first.capabilities[0]!.apps[0]!.id;
          for (const removed of [[], [leaveOut]]) {
            const plan = removed.length ? recommendBuild(a, host, {}, removed) : first;
            plans++;
            const where = `${machine}, wants ${wants.join("+")}, ${JSON.stringify(extra)}, removed ${removed}`;
            const starterApps = plan.capabilities
              .filter((c) => c.starter)
              .flatMap((c) => c.apps.map((x) => x.id));
            const allApps = plan.capabilities.flatMap((c) => c.apps.map((x) => x.id));

            // Each wish comes back exactly once, as theirs.
            for (const w of wants) {
              const found = plan.requirements.filter((r) => r.id === `want:${w}`);
              expect(found, `${w}: ${where}`).toHaveLength(1);
              expect(found[0]!.source, where).toBe("customer");
            }
            expect(new Set(plan.requirements.map((r) => r.id)).size, where).toBe(
              plan.requirements.length,
            );
            for (const r of plan.requirements) {
              expect(r.reason.length, `${r.id}: ${where}`).toBeGreaterThan(10);
              expect(r.reason + r.wording, `${r.id}: ${where}`).not.toMatch(/\u2014/);
              // "Included" is only ever said of apps that are really in the starter, not left out.
              if (r.status === "included")
                for (const id of r.apps) {
                  expect(starterApps, `${r.id} -> ${id}: ${where}`).toContain(id);
                  expect(removed, `${r.id} -> ${id}: ${where}`).not.toContain(id);
                }
              for (const id of r.apps) expect(allApps, `${r.id} -> ${id}: ${where}`).toContain(id);
            }
            // A left-out app never leaves a goal that needs it looking complete.
            for (const r of plan.requirements.filter((x) => x.apps.includes(leaveOut)))
              if (removed.length) expect(r.status, `${r.id}: ${where}`).not.toBe("included");
            // No app's reason names a media server the plan doesn't have.
            for (const c of plan.capabilities)
              for (const x of c.apps)
                for (const [id, name] of [
                  ["jellyfin", "Jellyfin"],
                  ["plex", "Plex"],
                ] as const)
                  if (new RegExp(`\\b${name}\\b(?! Pass)`).test(x.why))
                    expect(allApps, `${x.id} names ${name}: ${where}`).toContain(id);
          }
        }
      }
    expect(plans).toBe(3 * 255 * 4 * 2);
    // Over six thousand plans: about 4 seconds on a fast machine, more on a shared CI runner.
  }, 30_000);

  it("asks for ten things on a small machine: keeps all ten, says why each one waits", () => {
    const plan = recommendBuild(
      answers({
        wants: WANTS,
        away: "away",
        importance: "irreplaceable",
      }),
      MACHINES[2]![1],
    );
    expect(plan.requirements.map((r) => r.id)).toEqual([
      "want:watch",
      "want:request",
      "want:music",
      "want:books",
      "want:photos",
      "want:files",
      "want:smart-home",
      "want:ai",
      "away",
      "importance",
    ]);
    const waiting = plan.requirements.filter((r) => r.status === "deferred");
    expect(waiting.length).toBeGreaterThan(0);
    for (const r of waiting)
      expect(r.reason).toMatch(
        /GB of memory, and (about .* GB|almost nothing) is left once .*It stays on your list either way/,
      );
    expect(req(plan, "want:watch")).toMatchObject({ status: "included" });
  });

  it("someone who wants music but not films still gets a server that plays it, and picks which", () => {
    const plan = recommendBuild(answers({ wants: ["music"], budget: "free" }), scan());
    const music = plan.capabilities.find((c) => c.id === "music")!;
    expect(music.apps.map((x) => x.id)).toEqual(["jellyfin", "audiobookshelf"]);
    expect(music.apps[1]!.why).not.toMatch(/Jellyfin/);
    expect(plan.choices[0]).toMatchObject({
      id: "media-app",
      question: "Which app plays your music?",
    });
    expect(req(plan, "want:music")).toMatchObject({
      status: "included",
      apps: ["jellyfin", "audiobookshelf"],
    });
  });

  it("keeps their words even when the software has another name", () => {
    const plan = recommendBuild(answers({ wants: ["photos", "smart-home"] }), scan());
    expect(req(plan, "want:photos")).toMatchObject({
      wording: "Keep my phone's photos safe at home",
      apps: ["immich"],
      status: "included",
    });
    expect(req(plan, "want:smart-home")).toMatchObject({
      wording: "Run my smart home",
      apps: ["home-assistant"],
    });
  });

  it("marks what it suggested for someone exploring as a suggestion, never as their wish", () => {
    const plan = recommendBuild(answers({ wants: ["explore"] }), scan());
    expect(plan.requirements.map((r) => [r.id, r.source])).toEqual([
      ["want:watch", "cove"],
      ["want:request", "cove"],
    ]);
    expect(req(plan, "want:watch")!.wording).toMatch(/suggested, since you're exploring/);
  });

  it("says plainly when it can't do something the way they said, instead of ignoring it", () => {
    // Emby isn't set up by Hearth: the closest app stands in, and theirs is untouched.
    const emby = recommendBuild(answers({ wants: ["watch"], existingServer: "emby" }), scan());
    expect(req(emby, "existing:emby")).toMatchObject({ status: "substituted", apps: ["jellyfin"] });
    expect(req(emby, "existing:emby")!.reason).toMatch(/Your Emby stays as it is/);

    // "A different VPN" is not treated as no VPN.
    const other = recommendBuild(answers({ wants: ["request"], existingVpn: "other" }), scan());
    expect(req(other, "existing:vpn")).toMatchObject({ status: "partial" });
    expect(req(other, "existing:vpn")!.reason).toMatch(/tell Ember which one/);

    // "Keep it free" with downloads and a VPN still to get: the one thing that costs money is named.
    const free = recommendBuild(
      answers({ wants: ["request"], budget: "free", existingVpn: "none" }),
      scan({ vpns: [] }),
      { "vpn-needed": "get" },
    );
    expect(req(free, "budget:free")).toMatchObject({ status: "partial" });
    expect(req(free, "budget:free")!.reason).toMatch(/except a VPN that allows P2P/);
    const ownVpn = recommendBuild(
      answers({ wants: ["request"], budget: "free", existingVpn: "proton" }),
      scan(),
    );
    expect(req(ownVpn, "budget:free")).toMatchObject({ status: "included" });

    // Plex for watching away from home needs Plex Pass, and "free" says so.
    const plexAway = recommendBuild(
      answers({ wants: ["watch"], existingServer: "plex", away: "away", budget: "free" }),
      scan(),
    );
    expect(req(plexAway, "budget:free")!.reason).toMatch(/Plex Pass/);
  });

  it("4K or several viewers without graphics that convert video is only partly met, and says why", () => {
    const a = answers({ wants: ["watch"], quality: "4k", streams: "4+" });
    const none = recommendBuild(a, scan());
    expect(req(none, "quality:4k")).toMatchObject({ status: "partial" });
    expect(req(none, "quality:4k")!.reason).toMatch(/may stutter/);
    expect(req(none, "streams:4+")).toMatchObject({ status: "partial" });
    const igpu = recommendBuild(a, scan({ gpus: [{ vendor: "intel", name: "Intel UHD 770" }] }));
    expect(req(igpu, "quality:4k")).toMatchObject({ status: "included" });
    // Measured that the chip is there; never that a number of streams will work.
    expect(req(igpu, "streams:4+")!.reason).toMatch(/estimate, not measured/);
  });

  it("backups on a single drive are only partly a backup", () => {
    const one = recommendBuild(
      answers({ wants: ["photos"], importance: "irreplaceable" }),
      scan({ disks: [{ name: "/", totalBytes: 1000 * GB, freeBytes: 800 * GB }] }),
    );
    expect(req(one, "importance")).toMatchObject({ status: "partial" });
    expect(req(one, "importance")!.reason).toMatch(/second drive/);
  });

  it("what they leave out is recorded as their choice, and a half-removed goal as partial", () => {
    const a = answers({ wants: ["request", "ai"] });
    const noAi = recommendBuild(a, scan(), {}, ["ollama"]);
    expect(req(noAi, "want:ai")).toMatchObject({ status: "declined" });
    expect(req(noAi, "want:ai")!.reason).toMatch(/You chose to leave out Ollama/);
    const noProwlarr = recommendBuild(a, scan(), {}, ["prowlarr"]);
    expect(req(noProwlarr, "want:request")).toMatchObject({ status: "partial" });
    const noDownloads = recommendBuild(a, scan(), { downloads: "no" });
    expect(req(noDownloads, "want:request")).toMatchObject({ status: "declined", apps: [] });
  });

  it("an app that can't run here at all is not currently possible, rather than just waiting", () => {
    // Immich only comes for Docker, and this laptop can't spare the memory Docker needs.
    const plan = recommendBuild(answers({ wants: ["watch", "photos"] }), MACHINES[1]![1]);
    expect(req(plan, "want:photos")).toMatchObject({ status: "infeasible" });
    expect(req(plan, "want:photos")!.reason).toMatch(/only comes for Docker.*becomes possible/);
  });
});

describe("priorities and what this computer can really do", () => {
  const mini = scan({ memoryBytes: 16 * GB, freeMemoryBytes: 7 * GB, gpus: [] });
  const ids = (plan: BuildPlan, starter = true) =>
    plan.capabilities.filter((c) => c.starter === starter).map((c) => c.id);

  it("fills the plan in their order, says what came first, and shows what a new order gains and loses", () => {
    const a = answers({ wants: ["photos", "ai"] });
    const usual = recommendBuild(a, mini);
    expect(ids(usual)).toEqual(["photos", "safety"]);
    expect(req(usual, "want:ai")).toMatchObject({ status: "deferred" });
    expect(req(usual, "want:ai")!.reason).toMatch(
      /needs about 6\.0 GB.*left once your phone's photos, backed up at home is running, which come first\. To fit it: rank it higher/,
    );

    const aiFirst = recommendBuild({ ...a, priorities: ["ai", "photos"] }, mini);
    expect(ids(aiFirst)).toEqual(["ai", "safety"]);
    expect(req(aiFirst, "want:ai")).toMatchObject({ priority: 1 });
    expect(req(aiFirst, "want:photos")).toMatchObject({ priority: 2, status: "deferred" });
    expect(req(aiFirst, "want:photos")!.reason).toMatch(/which come first in your ranking/);
    // "AI" keeps its capitals when a title starts a sentence's middle.
    expect(aiFirst.summary).toMatch(/^Your starter build: AI chat on your own computer/);
    expect(comparePlans(usual, aiFirst)).toEqual([
      expect.stringMatching(
        /^Now in your plan, with a trade-off: "Try running AI at home"\. .*Possible with trade-offs/,
      ),
      expect.stringMatching(
        /^Now waiting for room: "Keep my phone's photos safe at home"\. .*once AI chat on your own computer is running, which come first in your ranking/,
      ),
    ]);
    expect(comparePlans(usual, usual)).toEqual([]);
  });

  it("keeps the media server ahead of the download tools, however they're ranked", () => {
    const plan = recommendBuild(
      answers({ wants: ["watch", "request", "ai"], priorities: ["request", "ai", "watch"] }),
      mini,
    );
    const order = plan.capabilities.map((c) => c.id);
    expect(order.indexOf("watch")).toBeLessThan(order.indexOf("request"));
    expect(order.indexOf("request")).toBeLessThan(order.indexOf("ai"));
  });

  it("gives a capable server an ambitious plan: everything asked for, nothing held back", () => {
    const big = scan({
      memoryBytes: 64 * GB,
      freeMemoryBytes: 40 * GB,
      gpus: [{ vendor: "nvidia", name: "NVIDIA RTX 4070", memoryBytes: 12 * GB }],
    });
    const plan = recommendBuild(
      answers({ wants: WANTS, dedicated: "server", away: "away", importance: "irreplaceable" }),
      big,
    );
    expect(plan.capabilities.every((c) => c.starter)).toBe(true);
    expect(plan.requirements.every((r) => r.status === "included")).toBe(true);
    expect(plan.memoryBudget).toMatchObject({ basis: "dedicated", measured: true });
  });

  it("lets a computer that's only a server use its memory, and one in daily use keep its room", () => {
    const busy = scan({ memoryBytes: 16 * GB, freeMemoryBytes: 4 * GB });
    const a = answers({ wants: ["watch", "ai"] });
    const shared = recommendBuild({ ...a, dedicated: "shared" }, busy);
    expect(ids(shared)).toEqual(["watch"]);
    expect(shared.notes[0]).toMatch(
      /4\.0 GB is free right now \(measured\).*If this computer will only be a server, say so/,
    );
    const server = recommendBuild({ ...a, dedicated: "server" }, busy);
    expect(ids(server)).toEqual(["watch", "ai"]);
    expect(server.notes[0]).toMatch(
      /has 16 GB \(measured\), less about 1 GB for the system itself and 1\.6 GB kept spare .*\(both estimates\)/,
    );
  });

  it("keeps a small machine inside what it can comfortably run, with room to spare", () => {
    const small = scan({
      platform: "win32",
      memoryBytes: 4 * GB,
      freeMemoryBytes: 1.5 * GB,
      docker: false,
      cores: 4,
    });
    const plan = recommendBuild(answers({ wants: WANTS }), small);
    // The top wish always goes in, even past the budget, and then says so; nothing else is
    // added past it.
    const starter = plan.capabilities.filter((c) => c.starter && c.id !== "safety");
    const running = starter
      .flatMap((c) => c.apps)
      .reduce((n, x) => n + (x.installed ? 0 : x.memoryGb), 0);
    if (running > plan.memoryBudget.gb) {
      expect(starter).toHaveLength(1);
      for (const x of starter[0]!.apps) expect(x.fitReason).toMatch(/Possible with trade-offs/);
    }
    expect(plan.memoryBudget.gb).toBeLessThan(1.5);
    // Nothing they asked for is lost: what doesn't fit is saved, or said to be impossible here.
    for (const w of WANTS) expect(req(plan, `want:${w}`)).toBeDefined();
  });

  it("checks the processor and the disk, not just memory, and names the limit", () => {
    const twoCores = recommendBuild(answers({ wants: ["photos"] }), scan({ cores: 2 }));
    expect(req(twoCores, "want:photos")).toMatchObject({ status: "partial" });
    expect(req(twoCores, "want:photos")!.reason).toMatch(
      /works the processor hard, and this one has 2 cores/,
    );

    const tinyDisk = recommendBuild(
      answers({ wants: ["watch", "ai"] }),
      scan({ disks: [{ name: "/", totalBytes: 64 * GB, freeBytes: 5 * GB }] }),
    );
    expect(req(tinyDisk, "want:ai")).toMatchObject({ status: "deferred" });
    expect(req(tinyDisk, "want:ai")!.reason).toMatch(
      /needs about 8 GB of disk .* about 5 GB free \(measured\)/,
    );
  });

  it("says when the plan rests on an answer rather than a measurement", () => {
    const plan = recommendBuild(
      answers({ wants: ["watch"] }),
      scan({ freeMemoryBytes: undefined, platform: "unknown", memoryBytes: 8 * GB }),
    );
    expect(plan.memoryBudget).toMatchObject({ measured: false, basis: "answer" });
    expect(plan.notes[0]).toMatch(/worked out from your answer, not measured/);
  });
});

describe("leaving something out says what it breaks before it happens", () => {
  const media = answers({ wants: ["watch", "request"] });
  const host = scan();

  it("leaving out Prowlarr: Radarr and Sonarr still work, with their sources added by hand", () => {
    // Radarr and Sonarr can take indexers directly, so this is more work, not a break.
    const e = leaveOutEffects(media, host, {}, [], "prowlarr");
    expect(e.breaks).toEqual([]);
    expect(e.harder).toEqual([
      "Without Prowlarr, Radarr still works, but you add its download sources (indexers) to it yourself and keep them up to date.",
      "Without Prowlarr, Sonarr still works, but you add its download sources (indexers) to it yourself and keep them up to date.",
    ]);
    expect(e.summary).toMatch(/^Leaving out Prowlarr: Without Prowlarr, Radarr still works/);
    expect(e.summary).not.toMatch(/never arrive|can't|unusable/);
    expect(e.lost).toEqual([
      expect.stringMatching(/^Now only partly met: "Ask for a movie or show/),
    ]);
    // And once it's out, the goal says why, not just "in part".
    const plan = recommendBuild(media, host, {}, ["prowlarr"]);
    expect(req(plan, "want:request")!.reason).toMatch(
      /^You left out Prowlarr\. Without Prowlarr, Radarr still works, but you add its download sources/,
    );
  });

  it("names exactly what breaks, and not what still has what it needs", () => {
    expect(leaveOutEffects(media, host, {}, [], "qbittorrent").breaks).toEqual([
      "Without qBittorrent, Radarr finds movies but has nothing to download them with, unless you add a different download app yourself.",
      "Without qBittorrent, Sonarr finds episodes but has nothing to download them with, unless you add a different download app yourself.",
    ]);
    // Prowlarr still has Sonarr to search for, so only Seerr's movie requests break.
    expect(leaveOutEffects(media, host, {}, [], "radarr").breaks).toEqual([
      "Without Radarr, Seerr can take movie requests but nothing fetches them.",
    ]);
    expect(leaveOutEffects(media, host, {}, ["radarr"], "sonarr").breaks).toEqual([
      "Without Sonarr, Seerr can take show requests but nothing fetches them.",
      "Without Radarr or Sonarr, Prowlarr has nobody to search for, so it does nothing.",
      "Without Radarr or Sonarr, qBittorrent only downloads what you add to it by hand.",
    ]);
    const noServer = leaveOutEffects(media, host, {}, [], "jellyfin");
    expect(noServer.breaks).toContain(
      "Without a media server, Seerr can't see what you already have or play anything.",
    );
    expect(noServer.lost.join(" ")).toMatch(/Left out, as you chose: "Watch my own movies/);
  });

  it("only promises freed memory helps when something waiting really fits in it", () => {
    const mini = scan({ memoryBytes: 16 * GB, freeMemoryBytes: 7 * GB });
    // 9 GB free less 1.6 spare: photos (2.5) and AI (6) don't both fit; AI alone does.
    const roomier = scan({ memoryBytes: 16 * GB, freeMemoryBytes: 9 * GB });
    const helps = leaveOutEffects(answers({ wants: ["photos", "ai"] }), roomier, {}, [], "immich");
    expect(helps.freesGb).toBe(2.5);
    expect(helps.gained).toEqual([expect.stringMatching(/"Try running AI at home"/)]);
    expect(helps.summary).toMatch(/frees about 2\.5 GB .*enough for something that was waiting/);

    const doesnt = leaveOutEffects(
      answers({ wants: ["watch", "photos", "ai"] }),
      mini,
      {},
      [],
      "jellyfin",
    );
    expect(doesnt.gained).toEqual([]);
    expect(doesnt.summary).toMatch(
      /frees about 0\.6 GB .*but nothing that's waiting fits in that yet/,
    );
  });

  it("says plainly when leaving something out touches nothing else", () => {
    const e = leaveOutEffects(answers({ wants: ["watch", "books"] }), host, {}, [], "kavita");
    expect(e.breaks).toEqual([]);
    expect(e.summary).toMatch(/frees about 0\.3 GB/);
    expect(e.lost).toEqual(['Left out, as you chose: "Read my ebooks and comics".']);
  });

  it("offers realistic other ways to get what waits", () => {
    const mini = scan({ memoryBytes: 16 * GB, freeMemoryBytes: 7 * GB });
    const plan = recommendBuild(answers({ wants: ["photos", "ai"] }), mini);
    expect(req(plan, "want:ai")!.alternatives).toEqual([
      expect.stringMatching(/A smaller AI model, about 2 to 3 GB/),
      expect.stringMatching(/on another computer/),
    ]);
    expect(req(plan, "want:photos")!.alternatives).toBeUndefined(); // included, nothing to offer
  });
});

describe("the three groups: included, requested but not included, saved for later", () => {
  const mini = scan({ memoryBytes: 16 * GB, freeMemoryBytes: 7 * GB });
  const at = "2026-10-16T12:00:00.000Z";
  const groupOf = (plan: BuildPlan, id: string) => {
    const g = planGroups(plan);
    return (["included", "notIncluded", "later"] as const).filter((k) =>
      g[k].some((r) => r.id === id),
    );
  };

  it("puts every goal they asked for in exactly one group, whatever the ranking or decisions", () => {
    const orders: BuildWant[][] = [
      ["ai", "photos", "smart-home", "watch"],
      ["smart-home", "watch", "ai", "photos"],
      ["photos", "ai", "watch", "smart-home"],
    ];
    const choices: GoalDecisions[] = [
      {},
      { "want:ai": { choice: "include", at } },
      { "want:photos": { choice: "later", at } },
      { "want:ai": { choice: "later", at }, "want:smart-home": { choice: "include", at } },
    ];
    const hosts: [string, HostScan][] = [...MACHINES, ["a 16 GB desktop", mini]];
    for (const [machine, host] of hosts)
      for (const priorities of orders)
        for (const decisions of choices)
          for (const removed of [[], ["immich"], ["jellyfin"]]) {
            const a = answers({
              wants: ["watch", "photos", "smart-home", "ai"],
              priorities,
              existingServer: "emby",
            });
            const plan = recommendBuild(a, host, {}, removed, decisions);
            const g = planGroups(plan);
            const where = `${machine} ${priorities} ${JSON.stringify(decisions)} ${removed}`;
            for (const r of plan.requirements.filter((x) => x.source === "customer"))
              expect(groupOf(plan, r.id), `${r.id}: ${where}`).toHaveLength(1);
            // Nothing lands outside the groups.
            expect(g.included.length + g.notIncluded.length + g.later.length, where).toBe(
              plan.requirements.length,
            );
            for (const r of g.notIncluded) expect(r.reason.length, where).toBeGreaterThan(20);
            const starterApps = plan.capabilities
              .filter((c) => c.starter)
              .flatMap((c) => c.apps.map((x) => x.id));
            for (const r of g.included.filter((x) => x.status !== "substituted"))
              for (const id of r.apps.filter((x) => !removed.includes(x)))
                expect(starterApps, `${r.id}: ${where}`).toContain(id);
            // A waiting reason only names what's really in the starter as having gone first.
            for (const c of plan.capabilities.filter((x) => !x.starter && x.waitReason))
              for (const other of plan.capabilities)
                if (other !== c && c.waitReason!.toLowerCase().includes(other.title.toLowerCase()))
                  expect(other.starter, `${c.title} names ${other.title}: ${where}`).toBe(true);
          }
  });

  it("include it anyway: says the risks first, then plans it in, and undoing leaves no trace", () => {
    const a = answers({ wants: ["photos", "ai"] });
    const plan = recommendBuild(a, mini);
    expect(groupOf(plan, "want:ai")).toEqual(["notIncluded"]);
    expect(req(plan, "want:ai")).toMatchObject({ status: "deferred", canInclude: true });

    const e = includeAnywayEffects(a, mini, {}, [], {}, "want:ai");
    expect(e.allowed).toBe(true);
    expect(e.risks).toEqual([
      expect.stringMatching(
        /^Included at your request\. The plan now needs about 8\.5 GB of memory, and about 5\.4 GB is comfortably free/,
      ),
      expect.stringMatching(/^It shares this computer's memory with Immich, so/),
      "This changes your plan only. Nothing is installed yet, and each install, account, and network change still asks for your approval.",
    ]);

    const decided = { "want:ai": { choice: "include" as const, at } };
    const anyway = recommendBuild(a, mini, {}, [], decided);
    expect(groupOf(anyway, "want:ai")).toEqual(["included"]);
    expect(req(anyway, "want:ai")).toMatchObject({ status: "partial", decision: "include" });
    expect(req(anyway, "want:ai")!.reason).toMatch(/Included at your request/);
    // The approvals are the same: an override never skips one.
    expect(anyway.approvals).toEqual(plan.approvals);
    // Taking the decision back gives exactly the plan before: nothing stale.
    expect(recommendBuild(a, mini, {}, [], {})).toEqual(plan);
  });

  it("refuses to include anyway past a hard limit, and says which", () => {
    const eight = MACHINES[2]![1];
    const a = answers({ wants: ["watch", "smart-home", "ai"] });
    const ai = req(recommendBuild(a, eight), "want:ai")!;
    // An 8 GB mini PC can't hold AI (6 GB) beside the rest, however much they want it.
    expect(ai.canInclude).toBeUndefined();
    expect(ai.reason).toMatch(
      /can't be included anyway: .*more memory than this computer has in all \(8 GB\)/,
    );
    expect(includeAnywayEffects(a, eight, {}, [], {}, "want:ai").allowed).toBe(false);
    // Docker-only on a laptop that can't run Docker: not a trade-off, so no override.
    const photos = recommendBuild(answers({ wants: ["watch", "photos"] }), MACHINES[1]![1]);
    expect(req(photos, "want:photos")).toMatchObject({ status: "infeasible" });
    expect(req(photos, "want:photos")!.canInclude).toBeUndefined();
  });

  it("save for later moves a goal to the later group, frees its room, and comes back on undo", () => {
    const roomier = scan({ memoryBytes: 16 * GB, freeMemoryBytes: 9 * GB });
    const a = answers({ wants: ["photos", "ai"], priorities: ["photos", "ai"] });
    const before = recommendBuild(a, roomier);
    expect(req(before, "want:ai")!.status).toBe("deferred");
    const decisions = { "want:photos": { choice: "later" as const, at } };
    const after = recommendBuild(a, roomier, {}, [], decisions);
    expect(groupOf(after, "want:photos")).toEqual(["later"]);
    expect(req(after, "want:photos")!.reason).toMatch(/^You saved this for later/);
    // Its room goes to what was waiting.
    expect(groupOf(after, "want:ai")).toEqual(["included"]);
    expect(comparePlans(before, after)).toEqual([
      expect.stringMatching(/^Now in your plan(, with a trade-off)?: "Try running AI at home"/),
      expect.stringMatching(
        /^Saved for later, as you chose: "Keep my phone's photos safe at home"\.$/,
      ),
    ]);
    expect(recommendBuild(a, roomier, {}, [], {})).toEqual(before);
  });

  it("saving the media server for later takes the download tools with it, and says why", () => {
    const a = answers({ wants: ["watch", "request"] });
    const plan = recommendBuild(a, mini, {}, [], { "want:watch": { choice: "later", at } });
    const starterApps = plan.capabilities
      .filter((c) => c.starter)
      .flatMap((c) => c.apps.map((x) => x.id));
    expect(starterApps).not.toContain("seerr");
    expect(starterApps).not.toContain("qbittorrent");
    expect(plan.capabilities.find((c) => c.id === "request")!.waitReason).toMatch(
      /needs the media server .*which you saved for later\. It comes in with it\./,
    );
    expect(groupOf(plan, "want:request")).toEqual(["notIncluded"]);
  });

  it("a substitute waits for their OK, then counts as included", () => {
    const a = answers({ wants: ["watch"], existingServer: "emby" });
    expect(groupOf(recommendBuild(a, mini), "existing:emby")).toEqual(["notIncluded"]);
    const ok = recommendBuild(a, mini, {}, [], { "existing:emby": { choice: "accept", at } });
    expect(groupOf(ok, "existing:emby")).toEqual(["included"]);
    expect(req(ok, "existing:emby")).toMatchObject({ status: "substituted", decision: "accept" });
  });

  it("keeps what they didn't ask for apart, as suggestions", () => {
    const plan = recommendBuild(answers({ wants: ["watch"], importance: "replaceable" }), mini);
    expect(planGroups(plan).suggestions.map((c) => c.apps[0]!.id)).toEqual(["backups"]);
    expect(plan.requirements.map((r) => r.id)).toEqual(["want:watch"]);
  });

  it("never counts on a daily-use computer's free memory being there all the time", () => {
    // 14 GB free right now on a 16 GB desktop: lucky, not typical.
    const idle = scan({ memoryBytes: 16 * GB, freeMemoryBytes: 14 * GB });
    const shared = recommendBuild(answers({ wants: ["watch"], dedicated: "shared" }), idle);
    // 16 less 1 for the system and 4 for everyday use = 11, less 1.6 spare.
    expect(shared.memoryBudget.gb).toBe(9.4);
    expect(shared.notes[0]).toMatch(
      /14\.0 GB is free right now \(measured\), but .* never counts on more than about 11\.0 GB/,
    );
    const server = recommendBuild(answers({ wants: ["watch"], dedicated: "server" }), idle);
    // Only a server: all of it less the system and Hearth (14.6), less 1.6 spare.
    expect(server.memoryBudget.gb).toBe(13);
  });
});

describe("their own setup and priorities come first: no rule forces a local media server", () => {
  const host = scan();
  const at = "2026-10-16T12:00:00.000Z";
  const appsOf = (plan: BuildPlan) =>
    plan.capabilities.filter((c) => c.starter).flatMap((c) => c.apps);

  it("uses the Plex they already run elsewhere: nothing installed for it, nothing waits on it", () => {
    const a = answers({
      wants: ["watch", "request"],
      existingServer: "plex",
      priorities: ["request", "watch"],
    });
    const plan = recommendBuild(a, host);
    const where = plan.choices.find((c) => c.id === "media-where")!;
    expect(where).toMatchObject({ recommended: "elsewhere" });
    expect(where.question).toBe("Use the Plex you already have, or set one up here?");
    const plex = appsOf(plan).find((x) => x.id === "plex")!;
    expect(plex).toMatchObject({ installed: true, elsewhere: true, cost: "Nothing extra" });
    // Their ranking stands: requests first, since there's no new server to install before it.
    expect(plan.capabilities.map((c) => c.id).slice(0, 2)).toEqual(["request", "watch"]);
    expect(req(plan, "existing:plex")).toMatchObject({ status: "included" });
    expect(req(plan, "existing:plex")!.reason).toMatch(
      /where it already runs: nothing is installed/,
    );
    // Seerr has the media server it needs, so leaving out nothing here breaks it.
    expect(leaveOutEffects(a, host, {}, [], "radarr").breaks).toEqual([
      "Without Radarr, Seerr can take movie requests but nothing fetches them.",
    ]);
    // Saving "watch" for later doesn't hold the download tools back: Plex is still there.
    const later = recommendBuild(a, host, {}, [], { "want:watch": { choice: "later", at } });
    expect(appsOf(later).map((x) => x.id)).toContain("seerr");
  });

  it("sets up a new one here only when they choose it, and then it goes first", () => {
    const a = answers({
      wants: ["watch", "request"],
      existingServer: "plex",
      priorities: ["request", "watch"],
    });
    const here = recommendBuild(a, host, { "media-where": "here" });
    const plex = appsOf(here).find((x) => x.id === "plex")!;
    expect(plex.installed).toBeUndefined();
    expect(here.capabilities.map((c) => c.id).slice(0, 2)).toEqual(["watch", "request"]);
  });

  it("music with a server they already have elsewhere needs nothing new for the music", () => {
    const plan = recommendBuild(answers({ wants: ["music"], existingServer: "jellyfin" }), host);
    const music = plan.capabilities.find((c) => c.id === "music")!;
    expect(music.apps.map((x) => [x.id, !!x.elsewhere])).toEqual([
      ["jellyfin", true],
      ["audiobookshelf", false],
    ]);
  });

  it("keeps no media server rule for wishes that don't need one", () => {
    const plan = recommendBuild(
      answers({ wants: ["photos", "smart-home"], existingServer: "plex" }),
      host,
    );
    expect(plan.choices.map((c) => c.id)).not.toContain("media-where");
    expect(appsOf(plan).map((x) => x.id)).not.toContain("plex");
  });
});

describe("the planning assumptions are labelled as assumptions", () => {
  it("keeps them in one place, marked provisional, and says so on every plan", () => {
    expect(PLANNING_ASSUMPTIONS.status).toBe("provisional");
    for (const [basis, over] of [
      ["dedicated", { dedicated: "server" }],
      ["free-now", { dedicated: "shared" }],
    ] as const) {
      const plan = recommendBuild(answers({ wants: ["watch"], ...over }), scan());
      expect(plan.memoryBudget.basis).toBe(basis);
      expect(plan.notes[0]).toMatch(
        /working assumptions, still being checked on real computers, not guarantees/,
      );
    }
  });
});

describe("the VPN rule: downloading only ever through a VPN that allows P2P", () => {
  const noVpn = answers({ wants: ["watch", "request"], budget: "free", existingVpn: "none" });
  const noScanVpn = scan({ vpns: [] });
  const starter = (plan: BuildPlan) =>
    plan.capabilities.filter((c) => c.starter).flatMap((c) => c.apps.map((x) => x.id));

  it("keep it free, no VPN, wants downloads: the warning is shown and qBittorrent is left out", () => {
    const plan = recommendBuild(noVpn, noScanVpn);
    const c = plan.choices.find((x) => x.id === "vpn-needed")!;
    expect(c.mustPick).toBe(true);
    expect(c.notice!.join(" ")).toMatch(/Free VPNs almost never allow it/);
    expect(c.notice!.join(" ")).toMatch(/Hearth will not set up downloading without a VPN/);
    expect(c.options.map((o) => o.name)).toEqual([
      "I'll get a VPN (about $2 to $5 a month)",
      "Skip automatic downloads for now (just play my own files, free)",
    ]);
    expect(c.recommended).toBe("skip");
    expect(starter(plan)).not.toContain("qbittorrent");
    // Nothing quietly added, nothing quietly dropped: the wish says why it waits.
    expect(req(plan, "want:request")!.reason).toMatch(/never sets them up without one/);
    expect(req(plan, "budget:free")).toMatchObject({ status: "included" });
    // Skipping keeps it free and says what adding it later costs.
    const skip = recommendBuild(noVpn, noScanVpn, { "vpn-needed": "skip" });
    expect(starter(skip)).not.toContain("qbittorrent");
    expect(req(skip, "want:request")!.reason).toMatch(/about \$2 to \$5 a month/);
    // Only choosing to get a VPN brings the download tools, and never a free VPN.
    const get = recommendBuild(noVpn, noScanVpn, { "vpn-needed": "get" });
    expect(starter(get)).toContain("qbittorrent");
    expect(get.choices.find((x) => x.id === "vpn")!.recommended).toBe("proton");
  });

  it("a budget for it still has to choose: getting a VPN is recommended, not assumed", () => {
    const plan = recommendBuild({ ...noVpn, budget: "low" }, noScanVpn);
    expect(plan.choices.find((x) => x.id === "vpn-needed")!.recommended).toBe("get");
    expect(starter(plan)).not.toContain("qbittorrent");
  });

  it("Bob: Plex lifetime, a VPN, keep it free: Plex is recommended and his VPN reused", () => {
    const bob = answers({
      wants: ["watch", "request"],
      budget: "free",
      existingServer: "plex",
      plexPass: "lifetime",
      plexServer: "running",
      existingVpn: "nord",
      downloadSites: "yes",
      media: "external",
      devices: ["smart-tv"],
    });
    const plan = recommendBuild(bob, scan({ vpns: [] }), { "media-where": "here" });
    const media = plan.choices.find((x) => x.id === "media-app")!;
    expect(media.recommended).toBe("plex");
    expect(media.why).toBe(
      "You already pay for Plex Pass, so you get its best features at no extra cost.",
    );
    expect(plan.choices.find((x) => x.id === "vpn-needed")).toBeUndefined();
    expect(plan.choices.find((x) => x.id === "vpn")!.recommended).toBe("have-nord");
    expect(starter(plan)).toEqual(expect.arrayContaining(["plex", "qbittorrent", "prowlarr"]));
    // What he already pays for counts as free.
    expect(req(plan, "budget:free")).toMatchObject({ status: "included" });
    const prowlarr = plan.capabilities.flatMap((c) => c.apps).find((x) => x.id === "prowlarr")!;
    expect(prowlarr.why).toMatch(/Ember helps you add them here later/);
    expect(prowlarr.why).toMatch(/Hearth never names or suggests any/);
    // Away from home with Plex Pass already paid: nothing to buy.
    const away = recommendBuild({ ...bob, away: "away" }, scan({ vpns: [] }));
    expect(req(away, "budget:free")!.reason ?? "").not.toMatch(/Plex Pass/);
  });

  it("a Plex account with no server yet: Plex is set up here with their account", () => {
    const plan = recommendBuild(
      answers({
        wants: ["watch"],
        existingServer: "plex",
        plexServer: "account-only",
        plexPass: "free",
        media: "external",
      }),
      scan(),
    );
    expect(plan.choices.find((x) => x.id === "media-where")).toBeUndefined();
    const plex = plan.capabilities.flatMap((c) => c.apps).find((x) => x.id === "plex")!;
    expect(plex.elsewhere).toBeUndefined();
    expect(plex.why).toMatch(/sets one up here, signed in to your account/);
  });
});
