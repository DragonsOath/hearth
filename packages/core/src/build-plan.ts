/**
 * "Help me build": a first homelab plan for someone starting from nothing (stage 1 of
 * docs/design/BEGINNER_JOURNEY.md). A few human questions give the wishes; a read-only look at
 * the machine gives the reality; plain rules turn both into a plan.
 *
 * The rules, from the owner's brief: capabilities first, apps second, install method third. A
 * modest starter build sized to the memory the machine really has free, with the rest as "later,
 * if you like". Wherever there is a real choice, the options are laid out, explained, and one is
 * recommended; the person decides. Every step that changes the computer or costs money is listed
 * before anything happens. Plain code, so the same answers always give the same plan and it can be
 * tested; the AI explains the plan, it does not decide it. Nothing is installed at this stage.
 */

export type Unsure = "unsure";

export type BuildWant =
  "watch" | "request" | "music" | "books" | "photos" | "files" | "smart-home" | "ai" | "explore";

export type BuildDevice =
  | "smart-tv"
  | "roku"
  | "fire-tv"
  | "google-tv"
  | "apple-tv"
  | "phone"
  | "laptop"
  | "console"
  | "unsure";

export interface BuildAnswers {
  /** What they would love to do (several). */
  wants: BuildWant[];
  experience?: "new" | "some" | "experienced";
  /** Monthly spending they are comfortable with. */
  budget?: "free" | "low" | "medium" | "more" | Unsure;
  /** Where their movies, music, or files are now. */
  media?: "this-computer" | "external" | "several" | "none" | Unsure;
  existingServer?: "plex" | "jellyfin" | "emby" | "none" | Unsure;
  /** With Plex: whether they pay for Plex Pass. What they already pay for counts as free. */
  plexPass?: "free" | "subscription" | "lifetime" | Unsure;
  /** With Plex: a Plex server already running somewhere, or only the account. */
  plexServer?: "running" | "account-only" | Unsure;
  /** Sites they already download from (never named or suggested by Hearth). */
  downloadSites?: "yes" | "no" | Unsure;
  importance?: "replaceable" | "some" | "irreplaceable" | Unsure;
  /** Where they will enjoy it (several). */
  devices: BuildDevice[];
  streams?: "1" | "2-3" | "4+" | Unsure;
  quality?: "hd" | "4k" | Unsure;
  away?: "home" | "away" | Unsure;
  /** "Build it for me and explain as we go", or "teach me each step". */
  pace?: "build" | "teach" | Unsure;
  /** A VPN they already pay for, so the plan reuses it instead of buying another. */
  existingVpn?: VpnProvider | "other" | "none" | Unsure;
  /** Only a server, or also used for other things: how much memory the apps may plan on. */
  dedicated?: "server" | "shared" | Unsure;
  /** Their wishes, most important first. Unranked wishes follow, in the usual order. */
  priorities?: BuildWant[];
}

/** VPN providers the plan knows, all of which allow P2P on their paid plans. */
export type VpnProvider =
  "proton" | "mullvad" | "nord" | "surfshark" | "pia" | "express" | "windscribe" | "airvpn";

/**
 * What the plan says about each VPN: all allow P2P on paid plans; port forwarding makes
 * downloads faster. Prices are rough and change, so setup checks them again before anyone signs
 * up. Hearth's VPN layer (Gluetun) works with all of them.
 */
export const VPN_PROVIDERS: Record<
  VpnProvider,
  { name: string; portForwarding: boolean; cost: string; note: string }
> = {
  proton: {
    name: "Proton VPN",
    portForwarding: true,
    cost: "About $4 to $5 a month on a long plan (P2P needs Plus, not the free plan)",
    note: "Well-known for privacy (Swiss, audited no-logs), easy app, P2P and port forwarding.",
  },
  airvpn: {
    name: "AirVPN",
    portForwarding: true,
    cost: "About $3 to $4 a month on a yearly plan",
    note: "The cheapest of the well-regarded ones, with P2P and port forwarding. More technical.",
  },
  mullvad: {
    name: "Mullvad",
    portForwarding: false,
    cost: "About $5.50 a month (5 euros), one simple price",
    note: "Very private (no email needed). No port forwarding, so downloads can be slower.",
  },
  pia: {
    name: "Private Internet Access",
    portForwarding: true,
    cost: "About $2 to $3 a month on a long plan",
    note: "Cheap on long plans, with P2P and port forwarding.",
  },
  nord: {
    name: "NordVPN",
    portForwarding: false,
    cost: "About $3 to $5 a month on a long plan",
    note: "Allows P2P on its P2P servers; no port forwarding.",
  },
  surfshark: {
    name: "Surfshark",
    portForwarding: false,
    cost: "About $2 to $3 a month on a long plan",
    note: "Allows P2P; no port forwarding.",
  },
  express: {
    name: "ExpressVPN",
    portForwarding: false,
    cost: "About $7 to $10 a month",
    note: "Allows P2P; no port forwarding, and pricier.",
  },
  windscribe: {
    name: "Windscribe",
    portForwarding: true,
    cost: "About $5 to $9 a month (the free plan caps data at about 10 GB)",
    note: "Allows P2P on paid plans; port forwarding on its static IPs.",
  },
};

/** The questions, in order, a few per screen. Every one can be answered "I don't know". */
export const BUILD_QUESTIONS = {
  wants: {
    question: "What would you love to do?",
    help: "Pick everything that sounds fun. You can always add more later.",
    options: [
      ["watch", "Watch my own movies and shows, like my own Netflix"],
      ["request", "Ask for a movie or show and have it turn up on its own"],
      ["music", "Listen to my music or audiobooks"],
      ["books", "Read my ebooks and comics"],
      ["photos", "Keep my phone's photos safe at home"],
      ["files", "Keep my files in one place I can reach"],
      ["smart-home", "Run my smart home"],
      ["ai", "Try running AI at home"],
      ["explore", "I'm not sure yet, show me what's possible"],
    ],
  },
  experience: {
    question: "How new is this to you?",
    options: [
      ["new", "Brand new: I've never set up a server"],
      ["some", "I've tinkered a little"],
      ["experienced", "I've done this before"],
    ],
  },
  budget: {
    question: "Keep it free, or happy to spend a little each month?",
    help: "Some things are free forever; a few work better with a small subscription. You'll always be told before anything costs money.",
    options: [
      ["free", "Keep it free"],
      ["low", "Up to about $5 a month"],
      ["medium", "Up to about $15 a month"],
      ["more", "More is fine if it's worth it"],
      ["unsure", "I'm not sure"],
    ],
  },
  pace: {
    question: "How would you like to build it?",
    options: [
      ["build", "Build it for me and explain as we go"],
      ["teach", "Teach me each step"],
      ["unsure", "Decide for me"],
    ],
  },
  media: {
    question: "Do you already have movies, music, or files?",
    options: [
      ["this-computer", "Yes, on this computer"],
      ["external", "Yes, on an external drive"],
      ["several", "Yes, spread over a few places"],
      ["none", "Not yet"],
      ["unsure", "I'm not sure"],
    ],
  },
  existingServer: {
    question: "Do you already use Plex, Jellyfin, or Emby?",
    options: [
      ["plex", "Plex"],
      ["jellyfin", "Jellyfin"],
      ["emby", "Emby"],
      ["none", "No"],
      ["unsure", "I'm not sure"],
    ],
  },
  plexPass: {
    question: "Do you pay for Plex Pass?",
    help: "Not sure? Sign in at plex.tv and open your account: it says Plex Pass there if you have it.",
    options: [
      ["free", "No, free account"],
      ["subscription", "Yes, monthly or yearly"],
      ["lifetime", "Yes, lifetime"],
      ["unsure", "I'm not sure"],
    ],
  },
  plexServer: {
    question: "Is your Plex server already set up on a computer?",
    help: "Only a Plex account (you watch other people's servers, or never set one up)? Hearth sets one up here with your account.",
    options: [
      ["running", "Yes, it runs on a computer already"],
      ["account-only", "No, I just have the account"],
      ["unsure", "I'm not sure"],
    ],
  },
  downloadSites: {
    question: "Do you already download movies or shows from somewhere?",
    options: [
      ["yes", "Yes, I have sites I use"],
      ["no", "No"],
      ["unsure", "I'm not sure"],
    ],
  },
  importance: {
    question: "How bad would it be to lose these files?",
    options: [
      ["replaceable", "Not bad, I could get them again"],
      ["some", "Some would be hard to replace"],
      ["irreplaceable", "Terrible: photos and things I can never get back"],
      ["unsure", "I'm not sure"],
    ],
  },
  devices: {
    question: "Where will you enjoy it?",
    help: "Pick all that apply.",
    options: [
      ["smart-tv", "A smart TV"],
      ["roku", "Roku"],
      ["fire-tv", "Fire TV"],
      ["google-tv", "Google TV"],
      ["apple-tv", "Apple TV"],
      ["phone", "Phone or tablet"],
      ["laptop", "Laptop or computer"],
      ["console", "Game console"],
      ["unsure", "I'm not sure"],
    ],
  },
  streams: {
    question: "How many people might watch at the same time?",
    options: [
      ["1", "Just me"],
      ["2-3", "Two or three"],
      ["4+", "Four or more"],
      ["unsure", "I'm not sure"],
    ],
  },
  quality: {
    question: "Is regular HD fine, or do you want 4K?",
    options: [
      ["hd", "HD is fine"],
      ["4k", "4K when I can"],
      ["unsure", "I don't know the difference"],
    ],
  },
  dedicated: {
    question: "Will this computer only be your server?",
    help: "A computer you also use every day needs room for your browser and games, so the apps plan on what's free. One that's only a server can give them more.",
    options: [
      ["server", "Yes, it'll only be a server"],
      ["shared", "No, I use it for other things too"],
      ["unsure", "Not sure yet"],
    ],
  },
  existingVpn: {
    question: "Do you already pay for a VPN?",
    help: "Downloads use P2P (peer-to-peer, like torrenting: you download pieces from other people's computers), and not every VPN allows it. If yours does, the plan uses it instead of asking you to buy another.",
    options: [
      ["proton", "Proton VPN"],
      ["nord", "NordVPN"],
      ["surfshark", "Surfshark"],
      ["express", "ExpressVPN"],
      ["pia", "Private Internet Access"],
      ["mullvad", "Mullvad"],
      ["windscribe", "Windscribe"],
      ["airvpn", "AirVPN"],
      ["other", "A different one"],
      ["none", "No"],
      ["unsure", "I'm not sure"],
    ],
  },
  away: {
    question: "Only at home, or away from home too?",
    help: "Away from home means more setup; you'll be asked before anything opens to the internet.",
    options: [
      ["home", "Just at home"],
      ["away", "Away from home too"],
      ["unsure", "Not sure yet"],
    ],
  },
} as const;

/** What the read-only look at the machine found. Measured, except where said. */
export interface HostScan {
  /** The computer's name, so nobody mistakes it for the phone they are reading on. */
  hostname?: string;
  /** "Ubuntu 24.04 LTS", "Windows 11", "macOS 15". */
  os: string;
  platform: "linux" | "win32" | "darwin" | string;
  cpu: string;
  cores: number;
  memoryBytes: number;
  /** Memory free right now, after the system and whatever else is running. */
  freeMemoryBytes?: number;
  gpus: {
    vendor: "nvidia" | "intel" | "amd" | "apple" | "other";
    name: string;
    memoryBytes?: number;
  }[];
  /** Drives with their free space (real ones only), and what media they hold, if counted. */
  disks: {
    name: string;
    totalBytes: number;
    freeBytes: number;
    media?: { videos: number; audio: number; photos: number };
  }[];
  /** Connected by cable, by Wi-Fi, or unknown. */
  network: "wired" | "wifi" | "unknown";
  docker: boolean;
  /** Apps already running here (from discovery, by name). */
  running: string[];
  /** VPN apps found installed on this computer (by name only, nothing is opened). */
  vpns?: VpnProvider[];
}

export type BuildFit = "comfortable" | "slow" | "wait";

export interface BuildApp {
  id: string;
  name: string;
  /** What it does, in one plain sentence. */
  what: string;
  /** Why it was picked for this person. */
  why: string;
  /** What it needs from them (an account, a subscription, a drive). */
  needs: string[];
  /** "Free", or what it costs. */
  cost: string;
  /** Roughly how much memory it uses, in GB (an estimate). */
  memoryGb: number;
  /** How it would be installed on this machine. */
  install: "docker" | "native";
  fit: BuildFit;
  /** Why it isn't "comfortable", when it isn't: the specific constraint. */
  fitReason?: string;
  /** Already running on this machine: reused, not installed again. */
  installed?: boolean;
  /** Theirs already, running somewhere else (another computer, a NAS): used as it is. */
  elsewhere?: boolean;
}

/** A real choice: the options, each explained, with one recommended. The person decides. */
export interface BuildChoice {
  id: string;
  question: string;
  options: { id: string; name: string; summary: string; cost: string }[];
  recommended: string;
  why: string;
  /** Said plainly before they pick (the VPN rule's warning), one paragraph each. */
  notice?: string[];
  /** Nothing is assumed: until they pick, the plan leaves this out. */
  mustPick?: boolean;
}

export interface BuildCapability {
  id: BuildWant | "safety" | "companion";
  /** What they will be able to do ("Watch your movies on your TV"). */
  title: string;
  apps: BuildApp[];
  /** In the starter build, or "later, if you like". */
  starter: boolean;
  /** Why it waits, when it does. */
  waitReason?: string;
}

/**
 * Where a requirement came from: the person's own answer, or something the planner suggested
 * (for someone exploring). Suggestions are never presented as what they asked for.
 */
export type RequirementSource = "customer" | "cove";

/**
 * What became of one thing the person asked for. "substituted": met another way than they said;
 * "deferred": waits for room, a good next step; "infeasible": cannot be done well on this
 * machine as it is; "declined": they chose to leave it out.
 */
export type RequirementStatus =
  "included" | "partial" | "substituted" | "deferred" | "infeasible" | "declined";

/**
 * One goal, traced from the person's answer to the plan. Every goal they state comes back as
 * exactly one of these, whatever the plan does with it, so nothing they asked for can quietly
 * disappear (issue #16).
 */
export interface BuildRequirement {
  /** Stable across plans: "want:ai", "quality:4k", "budget:free". */
  id: string;
  /** Their words: the answer they picked. */
  wording: string;
  source: RequirementSource;
  /** 1 for what matters most, when they ranked it. */
  priority?: number;
  status: RequirementStatus;
  /** Why it has this status, in plain words. */
  reason: string;
  /** The apps in the plan that deliver it (empty when nothing does yet). */
  apps: string[];
  /** Realistic other ways to get it, when it waits or can't be done here. */
  alternatives?: string[];
  /** What they decided about it, if anything. */
  decision?: GoalChoice;
  /**
   * Whether "Include it anyway" is possible: only when it waits for comfortable memory, never
   * past a hard limit (more memory than the computer has, Docker that can't run, a full disk).
   */
  canInclude?: boolean;
}

/**
 * What the person decided about one goal on the plan screen. "include": run it now although it
 * doesn't fit comfortably (an informed override, plan only); "later": keep it on the list, not
 * in the starter; "accept": the substitute offered is fine. Saved with when they decided.
 */
export type GoalChoice = "include" | "later" | "accept";
export type GoalDecisions = Readonly<Record<string, { choice: GoalChoice; at: string }>>;

export interface BuildPlan {
  /** Everything they asked for, and what became of each. */
  requirements: BuildRequirement[];
  capabilities: BuildCapability[];
  choices: BuildChoice[];
  /** Everything that will ask for approval before it happens, in plain words. */
  approvals: string[];
  warnings: string[];
  notes: string[];
  /** How apps would be installed here, and why. */
  installMethod: { method: "docker" | "native"; why: string };
  /**
   * The memory the plan works within, in GB: what it's based on (memory free right now, the
   * whole computer if it's only a server, or their answer), whether that was measured, and the
   * spare kept for busy moments and updates (an estimate).
   */
  memoryBudget: {
    gb: number;
    measured: boolean;
    basis: "free-now" | "dedicated" | "answer";
    spareGb: number;
  };
  /** One line: what the starter build gives them. */
  summary: string;
}

const GB = 1024 ** 3;

/**
 * The planner's working assumptions about memory. They are reasoned, not measured: each is
 * shown to the person as an estimate, and they are checked and tuned on real computers before
 * they are relied on (docs/design/BEGINNER_JOURNEY.md, section 13). Kept in one place so tuning
 * one changes every plan.
 */
export const PLANNING_ASSUMPTIONS = {
  status: "provisional",
  /** What the system itself uses, in GB. */
  systemGb: { linux: 1, windowsOrMac: 3, unknown: 2 },
  /** Everyday use on a computer that's also used for other things, at its busiest. */
  dailyUse: { share: 0.25, minGb: 1 },
  /** Spare kept for busy moments, updates, and growth. */
  spare: { share: 0.1, minGb: 0.5 },
  /** Hearth itself, when it isn't already counted in a measurement. */
  selfGb: 0.4,
  /** Docker's own memory: Docker Desktop on Windows and macOS, the engine on Linux. */
  dockerGb: { windowsOrMac: 2, linux: 0.2 },
  /** Fewer cores than this, and heavy apps are "possible with trade-offs". */
  heavyCores: 4,
} as const;
const A = PLANNING_ASSUMPTIONS;

/** Every app the builder knows. Memory is a working estimate at rest, for planning only. */
const APPS: Record<
  string,
  Omit<BuildApp, "why" | "install" | "fit"> & {
    native: boolean;
    /** Works the processor hard (photo search, AI): slow on fewer than 4 cores. */
    cpuHeavy?: boolean;
    /** Disk it needs for itself (models, caches), in GB, beyond your files. An estimate. */
    diskGb?: number;
  }
> = {
  jellyfin: {
    id: "jellyfin",
    name: "Jellyfin",
    what: "Your own Netflix: it organizes your movies and shows and plays them on your TV, phone, and computer.",
    needs: ["Nothing to buy and no account with anyone"],
    cost: "Free",
    memoryGb: 0.6,
    native: true,
  },
  plex: {
    id: "plex",
    name: "Plex",
    what: "Your own Netflix: it organizes your movies and shows and plays them on your TV, phone, and computer.",
    needs: ["A free Plex account"],
    cost: "Free at home; Plex Pass (paid) for watching away from home and smooth 4K",
    memoryGb: 0.6,
    native: true,
  },
  seerr: {
    id: "seerr",
    name: "Seerr",
    what: "Your own Netflix-style browse page: find any movie or show, press Request, and the rest happens on its own. Family can request too.",
    needs: [],
    cost: "Free",
    memoryGb: 0.3,
    native: false,
  },
  radarr: {
    id: "radarr",
    name: "Radarr",
    what: "Finds the movies you ask for, fetches them, and names them neatly.",
    needs: [],
    cost: "Free",
    memoryGb: 0.3,
    native: true,
  },
  sonarr: {
    id: "sonarr",
    name: "Sonarr",
    what: "Does the same for TV shows: new episodes arrive on their own.",
    needs: [],
    cost: "Free",
    memoryGb: 0.3,
    native: true,
  },
  prowlarr: {
    id: "prowlarr",
    name: "Prowlarr",
    what: "Keeps the list of places Radarr and Sonarr search, in one spot.",
    needs: [
      "An indexer or two: a site that lists what's available to download, which Radarr and Sonarr search. You choose and add your own; Hearth never suggests any",
    ],
    cost: "Free",
    memoryGb: 0.2,
    native: true,
  },
  qbittorrent: {
    id: "qbittorrent",
    name: "qBittorrent with a VPN",
    what: "Does the downloading, always through a VPN, so your internet provider only sees encrypted traffic.",
    needs: [
      "A VPN that allows P2P (torrenting). Setup asks you to link yours. Most free VPNs don't allow it, and the few that do cap data at about 10 GB a month (one or two movies); paid ones cost about $2 to $5 a month",
    ],
    cost: "Free app; the VPN is about $2 to $5 a month",
    memoryGb: 0.6,
    native: false,
  },
  audiobookshelf: {
    id: "audiobookshelf",
    name: "Audiobookshelf",
    what: "Plays your audiobooks and podcasts, and remembers where you stopped on every device.",
    needs: [],
    cost: "Free",
    memoryGb: 0.3,
    native: true,
  },
  kavita: {
    id: "kavita",
    name: "Kavita",
    what: "A reading app for your ebooks, comics, and PDFs, on any device.",
    needs: [],
    cost: "Free",
    memoryGb: 0.3,
    native: true,
  },
  immich: {
    id: "immich",
    name: "Immich",
    what: "Backs up every photo and video from your phone automatically, like Google Photos, but kept at home.",
    needs: ["The Immich app on each phone"],
    cost: "Free",
    memoryGb: 2.5,
    native: false,
    cpuHeavy: true,
    diskGb: 5,
  },
  samba: {
    id: "samba",
    name: "A shared folder",
    what: "A folder on this computer that your other computers can open like a drive of their own.",
    needs: [],
    cost: "Free",
    memoryGb: 0.1,
    native: true,
  },
  "home-assistant": {
    id: "home-assistant",
    name: "Home Assistant",
    what: "Runs your smart home: lights, plugs, and sensors from many brands in one app, with routines that work even if the internet is down.",
    needs: ["Your smart devices' own apps or accounts, to link them"],
    cost: "Free",
    memoryGb: 1,
    native: false,
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    what: "Runs AI chat models on this computer, privately, with nothing sent to the cloud.",
    needs: [],
    cost: "Free",
    memoryGb: 6,
    native: true,
    cpuHeavy: true,
    diskGb: 8,
  },
  tailscale: {
    id: "tailscale",
    name: "Tailscale",
    what: "A private, encrypted link to your server from anywhere, with nothing opened on your router.",
    needs: [
      "A free Tailscale account",
      "The Tailscale app on each phone or laptop you use away from home",
    ],
    cost: "Free for personal use",
    memoryGb: 0.1,
    native: true,
  },
  backups: {
    id: "backups",
    name: "Backups",
    what: "A second copy of what matters, on another drive, so one broken drive loses nothing.",
    needs: ["A second drive (an external USB drive works)"],
    cost: "Free (the drive, if you need one, is extra)",
    memoryGb: 0.1,
    native: true,
  },
};

const has = <T extends string>(list: readonly T[], ...v: T[]) => v.some((x) => list.includes(x));
const NOT_APPS = new Set(["backups", "samba"]);

/** The media app choice: both options explained, one recommended for this person. */
function mediaChoice(a: BuildAnswers): BuildChoice {
  const tvApps = has(a.devices, "smart-tv", "roku", "console", "apple-tv");
  let recommended: "plex" | "jellyfin";
  let why: string;
  if (a.existingServer === "plex" && (a.plexPass === "subscription" || a.plexPass === "lifetime")) {
    // What they already pay for counts as free ("Keep it free" means no new spending).
    recommended = "plex";
    why = "You already pay for Plex Pass, so you get its best features at no extra cost.";
  } else if (a.existingServer === "plex" || a.existingServer === "jellyfin") {
    recommended = a.existingServer;
    why = `You already use ${a.existingServer === "plex" ? "Plex" : "Jellyfin"}, so your library and habits carry straight over.`;
  } else if (a.budget === "free" || a.budget === undefined || a.budget === "unsure") {
    recommended = "jellyfin";
    why = `It's completely free, with nothing to subscribe to and no account with anyone.${tvApps ? " Its TV apps are a little less polished than Plex's on some TVs." : ""}`;
  } else if (tvApps || a.experience === "new") {
    recommended = "plex";
    why =
      "It has the most polished apps on TVs, and it's the easiest for a first server. Watching away from home needs Plex Pass, which fits the budget you chose.";
  } else {
    recommended = "jellyfin";
    why = "Free, private, and it covers the devices you picked.";
  }
  return {
    id: "media-app",
    question: "Which app plays your movies and shows?",
    options: [
      {
        id: "jellyfin",
        name: "Jellyfin",
        summary:
          "Free and open source, no account with anyone. Apps for most TVs, phones, and browsers.",
        cost: "Free",
      },
      {
        id: "plex",
        name: "Plex",
        summary:
          "The most polished apps on TVs and the easiest to share. Some features need Plex Pass.",
        cost: "Free at home; Plex Pass (about $5 a month or a one-time fee) for away from home and smooth 4K",
      },
    ],
    recommended,
    why,
  };
}

/** The recommended plan for these answers on this machine. */
export function recommendBuild(
  a: BuildAnswers,
  scan: HostScan,
  chosen: Record<string, string> = {},
  /** Apps they chose to leave out ("Leave this out"), so their goals say so. */
  removed: readonly string[] = [],
  /** What they decided about goals that don't fit: include anyway, save for later, accept. */
  decisions: GoalDecisions = {},
): BuildPlan {
  const windowsOrMac = scan.platform === "win32" || scan.platform === "darwin";
  // The memory the plan works within: what is free now, measured, or else total minus 2 GB for
  // the system, an estimate. A 4 GB laptop with 1.2 GB free is planned as a 1.2 GB server.
  const measured = scan.freeMemoryBytes !== undefined;
  const totalGb = scan.memoryBytes / GB;
  // What the system itself needs (an estimate): Windows and macOS take more than Linux.
  const osGb =
    scan.platform === "linux"
      ? A.systemGb.linux
      : scan.platform === "unknown"
        ? A.systemGb.unknown
        : A.systemGb.windowsOrMac;
  // Spare room for busy moments, updates, and the system growing: a tenth of the memory, at
  // least half a gigabyte. A stated working margin, not a measurement.
  const spareGb = Math.max(A.spare.minGb, totalGb * A.spare.share);
  const freeNowGb = measured ? scan.freeMemoryBytes! / GB : undefined;
  // Free memory is measured while Hearth and anything already running are running, so
  // they are already counted. A computer that's only a server can plan on everything but the
  // system (or what's free now, if that's more: some systems use less than the estimate).
  const basis: BuildPlan["memoryBudget"]["basis"] =
    a.dedicated === "server" ? "dedicated" : measured ? "free-now" : "answer";
  // A computer used every day: free memory changes as browsers, games, and other programs open
  // and close, so today's reading is never taken as what's always there. The plan counts on
  // whichever is less: what's free now (measured), or the memory left after the system and
  // everyday use at its busiest (a quarter of the memory, at least 1 GB: an estimate).
  const dailyGb = Math.max(A.dailyUse.minGb, totalGb * A.dailyUse.share);
  const baseGb =
    basis === "dedicated"
      ? Math.max(freeNowGb ?? 0, totalGb - osGb - A.selfGb)
      : basis === "free-now"
        ? Math.min(freeNowGb!, totalGb - osGb - dailyGb)
        : // Not looked at: the system, Hearth, and (unless it's only a server) everyday use.
          totalGb - osGb - A.selfGb - (a.dedicated === "server" ? 0 : dailyGb);
  const budgetGb = Math.max(0.5, baseGb - spareGb);
  // Docker Desktop on Windows and macOS wants about 2 GB of its own; on Linux Docker is light.
  const dockerCostGb = windowsOrMac ? A.dockerGb.windowsOrMac : A.dockerGb.linux;
  const dockerFits = budgetGb - dockerCostGb >= 1.5;
  const method: "docker" | "native" = scan.docker || dockerFits ? "docker" : "native";
  const installWhy =
    method === "docker"
      ? scan.docker
        ? "Docker is already here: each app runs in its own sealed box, so apps never clash, updates are one step, and Hearth can look after each one."
        : "Docker would run each app in its own sealed box, so apps never clash and updates are one step. It isn't installed yet; installing it is its own step you approve."
      : `This computer has about ${(freeNowGb ?? budgetGb).toFixed(1)} GB of memory free, and Docker would use about ${dockerCostGb} GB of that by itself, so apps use their own installers instead. It works the same for you; a few apps that only come for Docker wait until there's more room.`;

  const media = mediaChoice(a);
  const pickedMedia = chosen["media-app"];
  const mediaApp: "plex" | "jellyfin" =
    pickedMedia === "plex" || pickedMedia === "jellyfin"
      ? pickedMedia
      : (media.recommended as "plex" | "jellyfin");
  const wants =
    a.wants.length && !a.wants.includes("explore")
      ? a.wants
      : (["watch", ...a.wants.filter((w) => w !== "explore")] as BuildWant[]);
  const exploring = !a.wants.length || a.wants.includes("explore");
  const watching = wants.includes("watch") || wants.includes("request");
  // New movies and shows arriving on their own: part of the media starter for anyone who asked
  // for it or is exploring, and offered (explained, not assumed) to someone watching their own.
  const downloadsChoice: BuildChoice | undefined = watching
    ? {
        id: "downloads",
        question: "Should new movies and shows arrive on their own?",
        options: [
          {
            id: "yes",
            name: "Yes, request it and it turns up",
            summary:
              "Seerr to ask, Radarr for movies, Sonarr for shows, Prowlarr to search, and qBittorrent to download, only ever through a VPN.",
            cost: "The apps are free; a VPN that allows P2P is about $3 to $5 a month",
          },
          {
            id: "no",
            name: "No, I'll add my own files",
            summary: "Just your media server, playing what you put on the drive.",
            cost: "Free",
          },
        ],
        recommended: wants.includes("request") || exploring ? "yes" : "no",
        why:
          wants.includes("request") || exploring
            ? "It's the heart of a home media server for most people: you pick what you want, and it's there when you sit down to watch."
            : "You said you'd watch your own movies, so you don't need it to start. It's easy to add later.",
      }
    : undefined;
  const wantsDownloads = downloadsChoice
    ? (chosen["downloads"] ?? downloadsChoice.recommended) === "yes"
    : false;
  // A VPN they already have (said, or found installed) is reused before anything is bought.
  const have: VpnProvider | undefined =
    a.existingVpn && a.existingVpn in VPN_PROVIDERS
      ? (a.existingVpn as VpnProvider)
      : scan.vpns?.[0];
  // The VPN rule: downloading is never set up without a VPN that allows P2P, whatever the budget.
  // Someone without one is told so plainly and picks: get one, or skip downloads for now. Until
  // they pick, nothing is assumed and nothing costs money.
  const hasVpn = !!have || a.existingVpn === "other";
  const vpnNeededChoice: BuildChoice | undefined =
    wantsDownloads && !hasVpn
      ? {
          id: "vpn-needed",
          question: "Automatic downloads need a VPN",
          notice: [
            "Automatic downloads need a VPN that allows P2P (torrenting). Free VPNs almost never allow it. Hearth is free, but you bring your own VPN, the same way you bring your own AI.",
            "Without a VPN, your internet provider can see your downloads and may warn you, slow you down, or cut off your service.",
            "What you download is your responsibility. Hearth will not set up downloading without a VPN.",
          ],
          mustPick: true,
          options: [
            {
              id: "get",
              name: "I'll get a VPN (about $2 to $5 a month)",
              summary:
                "Hearth sets up downloading only through it, with a kill switch: if the VPN drops, downloading stops.",
              cost: "About $2 to $5 a month for the VPN",
            },
            {
              id: "skip",
              name: "Skip automatic downloads for now (just play my own files, free)",
              summary:
                "Your media server plays what you put on the drive. Add downloads any time later.",
              cost: "Free",
            },
          ],
          recommended: a.budget === "free" ? "skip" : "get",
          why:
            a.budget === "free"
              ? "You asked to keep it free, and a VPN that allows downloading costs money. Adding downloads later costs about $2 to $5 a month for the VPN."
              : "It fits the budget you chose, and it's the only safe way to download.",
        }
      : undefined;
  const vpnPicked = vpnNeededChoice ? chosen["vpn-needed"] : undefined;
  const downloads = wantsDownloads && (hasVpn || vpnPicked === "get");
  const vpnOption = (id: VpnProvider) => ({
    id,
    name: VPN_PROVIDERS[id].name,
    summary: VPN_PROVIDERS[id].note,
    cost: VPN_PROVIDERS[id].cost,
  });
  const vpnChoice: BuildChoice | undefined = downloads
    ? {
        id: "vpn",
        question: "Which VPN keeps your downloads private?",
        options: [
          ...(have
            ? [
                {
                  id: `have-${have}`,
                  name: `The ${VPN_PROVIDERS[have].name} you already have`,
                  summary: `${a.existingVpn === have ? "You said you have it" : "Found on this computer"}. It allows P2P${VPN_PROVIDERS[have].portForwarding ? " and port forwarding" : " (no port forwarding, so downloads can be a little slower)"}, and Hearth's VPN setup works with it.`,
                  cost: "Nothing extra (a free plan won't do: P2P needs a paid one)",
                },
              ]
            : []),
          ...(["proton", "airvpn", "mullvad"] as VpnProvider[])
            .filter((id) => id !== have)
            .map(vpnOption),
        ],
        recommended: have ? `have-${have}` : "proton",
        why: have
          ? `No need to pay twice: ${VPN_PROVIDERS[have].name} already does the job.`
          : `${a.budget === "free" ? "There's no free VPN Hearth will use for this: free ones either don't allow P2P or cap data at about 10 GB a month (one or two movies). " : ""}Proton VPN is the best value overall: a strong privacy reputation, P2P, and port forwarding for faster downloads, for about $4 to $5 a month. AirVPN costs a little less if price matters most. Prices change, so they're checked again before you sign up, and you create the account yourself.`,
      }
    : undefined;

  // The media server they already have and want to keep using where it runs: nothing is
  // installed for it here, and nothing here has to wait for it.
  const existingHere =
    (a.existingServer === "plex" || a.existingServer === "jellyfin") &&
    scan.running.some((r) => r.toLowerCase().includes(a.existingServer!));
  // A Plex account but no Plex server yet: one is set up here, signed in to their account.
  const plexAccountOnly = a.existingServer === "plex" && a.plexServer === "account-only";
  const whereChoice: BuildChoice | undefined =
    (a.existingServer === "plex" || a.existingServer === "jellyfin") &&
    !plexAccountOnly &&
    !existingHere &&
    mediaApp === a.existingServer &&
    (wants.includes("watch") || wants.includes("request") || wants.includes("music"))
      ? {
          id: "media-where",
          question: `Use the ${APPS[mediaApp]!.name} you already have, or set one up here?`,
          options: [
            {
              id: "elsewhere",
              name: `Use the ${APPS[mediaApp]!.name} I already have`,
              summary:
                "It keeps running where it is (another computer, a NAS, or this one if I missed it). Nothing is installed for it; the other apps connect to it over your network.",
              cost: "Nothing extra",
            },
            {
              id: "here",
              name: `Set up ${APPS[mediaApp]!.name} on this computer too`,
              summary: "A new one here, beside the rest. Your existing one isn't touched.",
              cost: APPS[mediaApp]!.cost,
            },
          ],
          recommended: "elsewhere",
          why: "You already have it, so there's no need for a second copy or a second library to look after.",
        }
      : undefined;
  const elsewhere = !!whereChoice && (chosen["media-where"] ?? "elsewhere") === "elsewhere";
  const app = (id: string, why: string): BuildApp => {
    const base = APPS[id]!;
    if (elsewhere && id === mediaApp)
      return {
        id,
        name: base.name,
        what: base.what,
        why: `Your ${base.name} keeps running where it is. Nothing is installed for it here; the other apps connect to it over your network.`,
        needs: [],
        cost: "Nothing extra",
        memoryGb: base.memoryGb,
        install: base.native && method === "native" ? "native" : "docker",
        fit: "comfortable",
        installed: true,
        elsewhere: true,
      };
    const installed = !NOT_APPS.has(id) && scan.running.some((r) => r.toLowerCase().includes(id));
    return {
      id,
      name: base.name,
      what: base.what,
      why,
      needs: base.needs,
      cost: base.cost,
      memoryGb: base.memoryGb,
      install: base.native && method === "native" ? "native" : "docker",
      fit: "comfortable",
      ...(installed ? { installed: true } : {}),
    };
  };

  // Capabilities, in the order the person is likely to care about them.
  const caps: BuildCapability[] = [];
  const addCap = (id: BuildCapability["id"], title: string, apps: BuildApp[]) =>
    caps.push({ id, title, apps, starter: true });
  const mediaWhy =
    media.recommended === mediaApp
      ? plexAccountOnly && mediaApp === "plex"
        ? `${media.why} You have a Plex account but no server yet, so Hearth sets one up here, signed in to your account.`
        : media.why
      : "You chose it.";
  if (watching)
    addCap("watch", "Watch your movies and shows on your TV and phone", [
      app(mediaApp, exploring ? `Most people start here. ${mediaWhy}` : mediaWhy),
    ]);
  // Music plays in the media server; someone who wants music but not films still needs one.
  const musicServer = wants.includes("music") && !watching;
  if (wants.includes("music")) {
    const apps: BuildApp[] = [];
    if (musicServer)
      apps.push(app(mediaApp, "It plays your music on your phone, TV, and computer."));
    apps.push(
      app(
        "audiobookshelf",
        musicServer
          ? "For audiobooks: it remembers where you stopped, on every device."
          : `For audiobooks; your music plays in ${APPS[mediaApp]!.name} too.`,
      ),
    );
    addCap("music", "Listen to your music and audiobooks anywhere", apps);
  }
  if (wants.includes("books"))
    addCap("books", "Read your ebooks and comics on any device", [
      app("kavita", "For your ebooks and comics."),
    ]);
  if (wants.includes("photos"))
    addCap("photos", "Your phone's photos, backed up at home", [
      app("immich", "It backs up your phone on its own and keeps everything at home."),
    ]);
  if (wants.includes("files"))
    addCap("files", "Your files in one place", [
      app("samba", "The simplest way to keep and reach files at home."),
    ]);
  if (wants.includes("smart-home"))
    addCap("smart-home", "Run your smart home from one app", [
      app(
        "home-assistant",
        "It works with most brands and keeps running even when the internet is down.",
      ),
    ]);
  if (wants.includes("ai"))
    addCap("ai", "AI chat on your own computer", [
      app("ollama", "It runs AI models privately on this computer."),
    ]);
  if (downloads) {
    const vpnPick = vpnChoice!.options.find(
      (o) => o.id === (chosen["vpn"] ?? vpnChoice!.recommended),
    );
    const vpn = vpnPick && {
      name: vpnPick.id.startsWith("have-")
        ? VPN_PROVIDERS[vpnPick.id.slice(5) as VpnProvider].name
        : vpnPick.name,
    };
    addCap("request", "Ask for a movie or show and it turns up on its own", [
      app(
        "seerr",
        `Where you and your family ask for things; it works with ${APPS[mediaApp]!.name}.`,
      ),
      app("radarr", "It finds and fetches the movies you request, in the quality you want."),
      app("sonarr", "It does the same for shows, and grabs new episodes as they air."),
      app(
        "prowlarr",
        a.downloadSites === "yes"
          ? "Radarr and Sonarr need somewhere to look. You said you already have sites you use: Ember helps you add them here later. Hearth never names or suggests any."
          : "Radarr and Sonarr need somewhere to look; this keeps that list in one place. You add the sites you choose; Hearth never suggests any.",
      ),
      app(
        "qbittorrent",
        `It does the downloading, only ever through ${vpn?.name ?? "your VPN"}, so your internet provider sees nothing.`,
      ),
    ]);
  }
  if (a.away === "away")
    caps.push({
      id: "safety",
      title: "Reach it safely away from home",
      apps: [
        app("tailscale", "It links your devices privately, with nothing opened on your router."),
      ],
      starter: true,
    });
  const precious =
    a.importance === "irreplaceable" || a.importance === "some" || wants.includes("photos");
  caps.push({
    id: "safety",
    title: "Keep a second copy of what matters",
    apps: [
      app(
        "backups",
        precious
          ? "What you keep would be hard or impossible to replace."
          : "Even replaceable files take time to get back; a second copy is cheap insurance.",
      ),
    ],
    // Backups never crowd out the first wish; they come right after it.
    starter: precious,
  });

  // Their ranking decides what goes first. Asking for films to turn up needs the media server,
  // so the media server is ranked at least as high as that wish. Unranked wishes keep the usual
  // order after the ranked ones; safety (remote access, backups) stays at the end.
  const ranks = a.priorities ?? [];
  const rankOf = (c: BuildCapability) => {
    const ids: BuildWant[] =
      // A new media server ranks as high as the requests that need it; one they already run
      // keeps its own place.
      c.id === "watch"
        ? c.apps[0]!.installed
          ? ["watch"]
          : ["watch", "request"]
        : c.id === "safety" || c.id === "companion"
          ? []
          : [c.id];
    const r = ids.map((w) => ranks.indexOf(w)).filter((i) => i >= 0);
    return r.length ? Math.min(...r) : Infinity;
  };
  const DEFAULT_ORDER = [
    "watch",
    "request",
    "music",
    "books",
    "photos",
    "files",
    "smart-home",
    "ai",
  ];
  const order = (c: BuildCapability) =>
    c.id === "safety"
      ? 1e6 + caps.indexOf(c)
      : Math.min(rankOf(c), 999) * 100 + DEFAULT_ORDER.indexOf(c.id);
  caps.sort((x, y) => order(x) - order(y));
  // A new media server to install here must come before the request apps that need it. One
  // they already run (here or elsewhere) costs nothing, so their ranking stands as it is.
  const newServer = (c?: BuildCapability) => !!c && !c.apps[0]!.installed;
  const wi = caps.findIndex((c) => c.id === "watch");
  const ri = caps.findIndex((c) => c.id === "request");
  if (wi > ri && ri >= 0 && newServer(caps[wi])) caps.splice(ri, 0, caps.splice(wi, 1)[0]!);

  // The starter build: capabilities in that order while they fit the memory budget. Everything
  // else is "later, if you like", with why it waits and what went ahead of it.
  // Docker not yet installed costs its own memory; Hearth is already counted when free
  // memory was measured, and added otherwise.
  let used = method === "docker" && !scan.docker ? dockerCostGb : 0;
  let first = true;
  const ahead: string[] = [];
  const freeDiskGb = Math.max(0, ...scan.disks.map((d) => d.freeBytes / GB));
  // The most the apps could ever have: all the memory less the system. Past this, "include it
  // anyway" is refused: it's a hard limit, not a trade-off.
  const hardGb = Math.max(0.5, totalGb - osGb);
  const canInclude = new Set<BuildCapability>();
  for (const c of caps) {
    const decided = decisions[goalOf(c)]?.choice;
    // The download tools are only any use with the media server: if that waits, they wait too.
    const server = caps.find((x) => x.id === "watch");
    if (c.id === "request" && newServer(server) && !server!.starter) {
      c.starter = false;
      c.waitReason = `It needs the media server (${lowerFirst(server!.title)}), which ${decisions[goalOf(server!)]?.choice === "later" ? "you saved for later" : "isn't in the starter yet"}. It comes in with it.`;
      c.apps.forEach((x) => (x.fit = "wait"));
      continue;
    }
    if (decided === "later") {
      c.starter = false;
      c.waitReason = "You saved this for later. Bring it back whenever you like.";
      c.apps.forEach((x) => (x.fit = "wait"));
      continue;
    }
    if (c.id === "safety" && c.apps[0]!.id === "backups") {
      c.apps[0]!.fit = "comfortable";
      continue;
    }
    const needDocker = c.apps.some((x) => !APPS[x.id]!.native) && method === "native";
    // What they left out, or already run, costs nothing more.
    const need = c.apps
      .filter((x) => !x.installed && !removed.includes(x.id))
      .reduce((n, x) => n + x.memoryGb, 0);
    if (needDocker) {
      c.starter = false;
      c.waitReason = `It only comes for Docker, which needs more free memory than this computer has (about ${budgetGb.toFixed(1)} GB).`;
      c.apps.forEach((x) => (x.fit = "wait"));
    } else if (scan.disks.length && c.apps.some((x) => (APPS[x.id]!.diskGb ?? 0) > freeDiskGb)) {
      const big = c.apps.find((x) => (APPS[x.id]!.diskGb ?? 0) > freeDiskGb)!;
      c.starter = false;
      c.waitReason = `${big.name} needs about ${APPS[big.id]!.diskGb} GB of disk for itself, and the roomiest drive here has about ${Math.round(freeDiskGb)} GB free (measured). Free some space or add a drive, and it fits.`;
      c.apps.forEach((x) => (x.fit = "wait"));
    } else if (used + need > budgetGb && !first && decided === "include" && used + need <= hardGb) {
      // Their informed choice: in the starter although it doesn't fit comfortably. Plan only:
      // every install still asks for approval.
      used += need;
      c.apps.forEach((x) => {
        x.fit = "slow";
        x.fitReason = `Included at your request. The plan now needs about ${used.toFixed(1)} GB of memory, and about ${budgetGb.toFixed(1)} GB is comfortably free here (this computer has ${totalGb.toFixed(0)} GB in all). Expect slowdowns when several apps are busy at once; if it's too much, save it for later again.`;
      });
      ahead.push(lowerFirst(c.title));
    } else if (used + need > budgetGb && !first) {
      c.starter = false;
      if (used + need <= hardGb) canInclude.add(c);
      const left = Math.max(0, budgetGb - used);
      c.waitReason = `It needs about ${need.toFixed(1)} GB of memory, and ${left < 0.1 ? "almost nothing" : `about ${left.toFixed(1)} GB`} is left once ${list(ahead)} ${ahead.length > 1 ? "are" : "is"} running${ranks.length ? ", which come first in your ranking" : ", which come first"}. To fit it: rank it higher, leave out something above it, or add memory.${used + need > hardGb ? ` It can't be included anyway: with the rest of the plan it needs more memory than this computer has in all (${totalGb.toFixed(0)} GB).` : ""} It stays on your list either way.`;
      c.apps.forEach((x) => (x.fit = "wait"));
    } else {
      used += need;
      if (used > budgetGb)
        c.apps.forEach((x) => {
          x.fit = "slow";
          x.fitReason = `Possible with trade-offs: the plan so far needs about ${used.toFixed(1)} GB of memory, and about ${budgetGb.toFixed(1)} GB is comfortably free here. It runs, but things may slow down when several apps are busy at once.`;
        });
      ahead.push(lowerFirst(c.title));
    }
    // Heavy work on a small processor: it runs, but slowly. Measured cores, estimated effect.
    for (const x of c.apps)
      if (x.fit === "comfortable" && APPS[x.id]!.cpuHeavy && scan.cores < A.heavyCores) {
        x.fit = "slow";
        x.fitReason = `Possible with trade-offs: ${x.name} works the processor hard, and this one has ${scan.cores} cores. Expect it to take a while, especially at first.`;
      }
    first = false;
  }

  const ai = caps.flatMap((c) => c.apps).find((x) => x.id === "ollama");
  if (
    ai &&
    ai.fit === "comfortable" &&
    !scan.gpus.some((g) => g.vendor === "nvidia" || g.vendor === "apple")
  ) {
    ai.fit = "slow";
    ai.fitReason =
      "Possible with trade-offs: with no graphics card that runs AI here, answers come from the processor, a few words a second with a small model. An NVIDIA card or an Apple computer makes it quick.";
  }

  // Video conversion: a TV or phone that cannot play a file as it is makes the server convert it.
  const warnings: string[] = [];
  const notes: string[] = [];
  const watchCap = caps.find((c) => c.id === "watch");
  // Graphics that can convert video: NVIDIA, Intel (Quick Sync), AMD Radeon, Apple. Jellyfin uses
  // all of them; Plex needs Plex Pass for it.
  const gpu =
    scan.gpus.find((g) => g.vendor === "nvidia") ??
    scan.gpus.find((g) => g.vendor === "intel" || g.vendor === "amd" || g.vendor === "apple");
  if (watchCap) {
    const heavy = a.quality === "4k" || a.streams === "4+" || a.streams === "2-3";
    if (!gpu && heavy) {
      watchCap.apps[0]!.fit = watchCap.apps[0]!.fit === "wait" ? "wait" : "slow";
      warnings.push(
        `${a.quality === "4k" ? "4K" : "Several people watching at once"} may stutter: this computer has no graphics chip that can convert video, so the processor does it. Most films play fine as they are; it matters when a TV can't play a file directly.`,
      );
    } else if (gpu)
      notes.push(
        `${gpu.vendor === "intel" ? "Intel built-in graphics (Quick Sync)" : gpu.name} can convert video when a TV needs it${mediaApp === "plex" ? " (in Plex, with Plex Pass)" : ""}. Measured: the chip is there; how many streams at once is an estimate.`,
      );
    if (scan.network === "wifi" && heavy)
      warnings.push(
        "This computer is on Wi-Fi. For 4K or several people, a cable to the router helps a lot.",
      );
    const free = scan.disks.reduce((n, d) => n + d.freeBytes, 0) / GB;
    if (free < 200)
      warnings.push(
        `About ${Math.round(free)} GB free. A movie takes 2 to 8 GB in HD (20 to 60 GB in 4K); your existing files stay where they are, so this is only about new ones.`,
      );
    const library = scan.disks.find((d) => d.media && d.media.videos > 0);
    if (library)
      notes.push(
        `Found ${library.media!.videos} videos on ${library.name}. They stay exactly where they are: nothing is copied, moved, or renamed.`,
      );
  }
  if ((a.importance === "irreplaceable" || wants.includes("photos")) && scan.disks.length < 2)
    warnings.push(
      "Only one drive was found: a backup copy needs a second one (an external USB drive works).",
    );

  notes.unshift(
    basis === "dedicated"
      ? `Planned within about ${budgetGb.toFixed(1)} GB of memory: this computer has ${totalGb.toFixed(0)} GB (measured), less about ${osGb} GB for the system itself and ${spareGb.toFixed(1)} GB kept spare for busy moments (both estimates), since it'll only be a server. Each app's memory is an estimate from typical use. These allowances are working assumptions, still being checked on real computers, not guarantees.`
      : basis === "free-now"
        ? `Planned within about ${budgetGb.toFixed(1)} GB of memory. ${freeNowGb!.toFixed(1)} GB is free right now (measured), but on a computer you also use, that changes from hour to hour, so the plan never counts on more than about ${Math.max(0, totalGb - osGb - dailyGb).toFixed(1)} GB (${totalGb.toFixed(0)} GB, less about ${osGb} GB for the system and ${dailyGb.toFixed(1)} GB for everyday use at its busiest), and keeps ${spareGb.toFixed(1)} GB spare on top. Those allowances and each app's memory are estimates: working assumptions, still being checked on real computers, not guarantees. If this computer will only be a server, say so and the plan can use more.`
        : `Planned within about ${budgetGb.toFixed(1)} GB of memory, worked out from your answer, not measured, with allowances that are working assumptions, not guarantees. Let me look at the computer for a better plan.`,
  );

  const choices: BuildChoice[] = [];
  if (watchCap) choices.push(media);
  else if (musicServer) choices.push({ ...media, question: "Which app plays your music?" });
  if (whereChoice) choices.push(whereChoice);
  if (downloadsChoice) choices.push(downloadsChoice);
  if (vpnNeededChoice) choices.push(vpnNeededChoice);
  if (vpnChoice) choices.push(vpnChoice);
  if (windowsOrMac)
    choices.push({
      id: "system",
      question: "Keep this computer's system, or switch it to Linux?",
      options: [
        {
          id: "keep",
          name: scan.platform === "win32" ? "Keep Windows" : "Keep macOS",
          summary:
            "Nothing changes about how you use this computer. Hearth and your apps run in the background.",
          cost: "Free",
        },
        {
          id: "linux",
          name: "Switch to Linux",
          summary:
            "Steadier for a computer that stays on day and night, and leaves more memory for the apps. Means reinstalling the computer: a bigger step for later.",
          cost: "Free",
        },
      ],
      recommended: "keep",
      why: "Start with what you have; switching is a bigger job and can wait until you know you love this.",
    });

  const approvals = [
    ...(method === "docker" && !scan.docker
      ? ["Installing Docker (needs administrator rights once)"]
      : []),
    ...(method === "native"
      ? ["Installing each app with its own installer (may ask for administrator rights)"]
      : []),
    "Creating your accounts in each app (passwords go straight into Secure Vault; you never type them into chat)",
    ...(caps.some((c) => c.id === "request" && c.starter)
      ? ["Linking your VPN before any download starts"]
      : []),
    ...(a.away === "away" ? ["Anything that reaches outside your home network"] : []),
    "Anything that costs money (nothing is ever bought for you)",
  ];

  const starter = caps.filter((c) => c.starter && c.id !== "safety");
  const summary = starter.length
    ? `Your starter build: ${starter.map((c) => lowerFirst(c.title)).join("; ")}. ${caps.some((c) => !c.starter) ? "More is waiting below whenever you like." : ""}`.trim()
    : "Let's start small: this computer is tight on memory, so the first step is the one thing it can do well.";

  const requirements = traceRequirements({
    decisions,
    canInclude: new Set([...canInclude].map(goalOf)),
    a,
    scan,
    caps,
    removed,
    wants,
    exploring,
    mediaApp,
    downloads,
    downloadsAsked: !!downloadsChoice,
    vpnHeld: wantsDownloads && !downloads,
    vpnPicked,
    vpnId: vpnChoice ? (chosen["vpn"] ?? vpnChoice.recommended) : undefined,
    gpu: !!gpu,
    elsewhere,
  });

  return {
    requirements,
    capabilities: caps,
    choices,
    approvals,
    warnings,
    notes,
    installMethod: { method, why: installWhy },
    memoryBudget: {
      gb: Math.round(budgetGb * 10) / 10,
      measured,
      basis,
      spareGb: Math.round(spareGb * 10) / 10,
    },
    summary,
  };
}

const WANT_APPS: Record<Exclude<BuildWant, "explore" | "watch" | "request">, string[]> = {
  music: ["audiobookshelf"],
  books: ["kavita"],
  photos: ["immich"],
  files: ["samba"],
  "smart-home": ["home-assistant"],
  ai: ["ollama"],
};
const REQUEST_APPS = ["seerr", "radarr", "sonarr", "prowlarr", "qbittorrent"];
const wantWords = (w: BuildWant) =>
  BUILD_QUESTIONS.wants.options.find(([id]) => id === w)![1] as string;
const answerWords = <K extends keyof typeof BUILD_QUESTIONS>(q: K, v: string) =>
  (BUILD_QUESTIONS[q].options as readonly (readonly [string, string])[]).find(
    ([id]) => id === v,
  )?.[1] ?? v;
const nameOf = (id: string) => APPS[id]?.name ?? id;
/** "Watch your movies" to "watch your movies", leaving "AI chat" as it is. */
const lowerFirst = (t: string) =>
  /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
const list = (names: string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * Traces every goal in the answers to the plan: what delivers it, or why nothing does yet.
 * Read only from what recommendBuild decided; it never changes the plan.
 */
function traceRequirements(p: {
  decisions: GoalDecisions;
  canInclude: Set<string>;
  a: BuildAnswers;
  scan: HostScan;
  caps: BuildCapability[];
  removed: readonly string[];
  wants: BuildWant[];
  exploring: boolean;
  mediaApp: "plex" | "jellyfin";
  downloads: boolean;
  downloadsAsked: boolean;
  /** Downloads wanted, but held: no VPN that allows P2P (yet). */
  vpnHeld?: boolean;
  vpnPicked?: string;
  vpnId?: string;
  gpu: boolean;
  elsewhere: boolean;
}): BuildRequirement[] {
  const { a, caps, removed, mediaApp } = p;
  const out: BuildRequirement[] = [];
  const capOf = (app: string) => caps.find((c) => c.apps.some((x) => x.id === app));

  /** The status that follows from where its apps landed in the plan. */
  const fromApps = (
    base: Omit<BuildRequirement, "status" | "reason">,
    included: string,
  ): BuildRequirement => {
    const inPlan = base.apps.filter((id) => capOf(id));
    const left = inPlan.filter((id) => removed.includes(id));
    if (!inPlan.length)
      return { ...base, status: "infeasible", reason: "Nothing in this plan delivers it yet." };
    if (left.length === inPlan.length)
      return {
        ...base,
        status: "declined",
        reason: `You chose to leave out ${list(left.map(nameOf))}. It stays saved here if you change your mind.`,
      };
    const waiting = inPlan.map(capOf).find((c) => c && !c.starter);
    if (waiting) {
      const docker = /only comes for Docker/.test(waiting.waitReason ?? "");
      return {
        ...base,
        status: docker ? "infeasible" : "deferred",
        reason: `${waiting.waitReason ?? "It waits until the starter is running."}${docker ? " With more memory, or on another computer, it becomes possible." : /[Ss]aved/.test(waiting.waitReason ?? "") ? "" : " It's saved, and comes back when there's room."}`,
      };
    }
    if (left.length) {
      const live = caps
        .filter((c) => c.starter)
        .flatMap((c) => c.apps.map((x) => x.id))
        .filter((id) => !removed.includes(id));
      const broken = brokenBy(live, removed).filter((b) => base.apps.includes(b.app));
      return {
        ...base,
        status: "partial",
        reason: `You left out ${list(left.map(nameOf))}${broken.length ? `. ${[...new Set(broken.map((b) => b.without))].join(" ")}` : ", so this only works in part."}`,
      };
    }
    const slow = inPlan
      .map((id) => caps.flatMap((c) => c.apps).find((x) => x.id === id)!)
      .find((x) => x.fit === "slow" && x.fitReason);
    if (slow) return { ...base, status: "partial", reason: `${included} ${slow.fitReason}` };
    return { ...base, status: "included", reason: included };
  };

  // What they want to do, each wish on its own.
  const watching = p.wants.includes("watch") || p.wants.includes("request");
  if (a.wants.includes("watch"))
    out.push(
      fromApps(
        { id: "want:watch", wording: wantWords("watch"), source: "customer", apps: [mediaApp] },
        `${nameOf(mediaApp)} plays your movies and shows on your TV, phone, and computer.`,
      ),
    );
  else if (watching && !a.wants.includes("request"))
    out.push(
      fromApps(
        {
          id: "want:watch",
          wording: "Watch movies and shows at home (suggested, since you're exploring)",
          source: "cove",
          apps: [mediaApp],
        },
        `Most people start with ${nameOf(mediaApp)}. It's a suggestion: leave it out if it isn't for you.`,
      ),
    );
  if (a.wants.includes("request") || (p.exploring && p.downloadsAsked)) {
    const base = {
      id: "want:request",
      wording: a.wants.includes("request")
        ? wantWords("request")
        : "Ask for a movie or show and have it turn up (suggested, since you're exploring)",
      source: (a.wants.includes("request") ? "customer" : "cove") as RequirementSource,
      apps: [...REQUEST_APPS, mediaApp],
    };
    out.push(
      p.downloads
        ? fromApps(
            base,
            `Seerr to ask, Radarr and Sonarr to find, Prowlarr to search, and qBittorrent to download through your VPN, into ${nameOf(mediaApp)}.`,
          )
        : p.vpnHeld
          ? {
              ...base,
              apps: [],
              status: p.vpnPicked === "skip" ? "declined" : "substituted",
              reason:
                p.vpnPicked === "skip"
                  ? `You chose to skip automatic downloads for now: Hearth never sets up downloading without a VPN that allows P2P. Adding them later needs one, about $2 to $5 a month.${a.budget === "free" ? " That keeps everything free." : ""}`
                  : "Automatic downloads need a VPN that allows P2P, and Hearth never sets them up without one. Pick below: get a VPN (about $2 to $5 a month), or skip downloads for now.",
            }
          : {
              ...base,
              apps: [],
              status: "declined",
              reason:
                "You chose to add your own files instead, so the download tools aren't in the plan. Switch it back any time.",
            },
    );
  }
  for (const w of Object.keys(WANT_APPS) as (keyof typeof WANT_APPS)[]) {
    if (!a.wants.includes(w)) continue;
    const apps = w === "music" && !watching ? [mediaApp, ...WANT_APPS[w]] : WANT_APPS[w];
    const included: Record<keyof typeof WANT_APPS, string> = {
      music: `${nameOf(mediaApp)} plays your music, and Audiobookshelf your audiobooks.`,
      books: "Kavita keeps your ebooks and comics, and you read them in any browser.",
      photos: "Immich backs up your phone's photos on its own and keeps them at home.",
      files: "A shared folder on this computer that your other devices can open.",
      "smart-home":
        "Home Assistant runs your devices from one app, even when the internet is down.",
      ai: "Ollama runs AI models privately on this computer.",
    };
    out.push(
      fromApps({ id: `want:${w}`, wording: wantWords(w), source: "customer", apps }, included[w]),
    );
  }

  // How they want it to work.
  if (a.away === "away")
    out.push(
      fromApps(
        {
          id: "away",
          wording: answerWords("away", "away"),
          source: "customer",
          apps: ["tailscale"],
        },
        "Tailscale links your devices privately, with nothing opened on your router.",
      ),
    );
  if (a.importance === "irreplaceable" || a.importance === "some") {
    const r = fromApps(
      {
        id: "importance",
        wording: answerWords("importance", a.importance),
        source: "customer",
        apps: ["backups"],
      },
      "A second copy of what matters, made on a schedule.",
    );
    if (r.status === "included" && p.scan.disks.length < 2) {
      r.status = "partial";
      r.reason =
        "Backups are in the plan, but only one drive was found. A copy on the same drive won't survive that drive failing: a second drive (an external USB one works) makes it real.";
    }
    out.push(r);
  }
  if (watching) {
    const heavy = (id: string, wording: string, what: string) => {
      const r = fromApps(
        { id, wording, source: "customer", apps: [mediaApp] },
        p.gpu
          ? `This computer's graphics can convert video when a TV needs it, so ${what.toLowerCase()} should play smoothly. How many at once is an estimate, not measured.`
          : `${what} plays as it is on TVs that can play the file directly.`,
      );
      if (r.status === "included" && !p.gpu) {
        r.status = "partial";
        r.reason = `${what} plays fine on TVs that can play the file as it is. When a TV can't, the processor has to convert it with no graphics chip to help, and it may stutter. A computer with Intel, AMD, NVIDIA, or Apple graphics fixes that.`;
      }
      return r;
    };
    if (a.quality === "4k") out.push(heavy("quality:4k", answerWords("quality", "4k"), "4K"));
    if (a.streams === "2-3" || a.streams === "4+")
      out.push(
        heavy(
          `streams:${a.streams}`,
          `${answerWords("streams", a.streams)} watching at the same time`,
          "Several people watching at once",
        ),
      );
  }

  // What they already have.
  const media = watching || p.wants.includes("music");
  if (a.existingServer && a.existingServer !== "none" && a.existingServer !== "unsure") {
    const wording = `I already use ${answerWords("existingServer", a.existingServer)}`;
    if (a.existingServer === "emby")
      out.push({
        id: "existing:emby",
        wording,
        source: "customer",
        status: "substituted",
        apps: media ? [mediaApp] : [],
        reason: `Hearth can't set up Emby yet${media ? `, so the plan uses ${nameOf(mediaApp)}${mediaApp === "jellyfin" ? " (it began as the free version of Emby, so it will feel familiar)" : ""}` : ""}. Your Emby stays as it is: if it's running here, Hearth can look after it too.`,
      });
    else if (media)
      out.push(
        a.existingServer === mediaApp
          ? fromApps(
              { id: `existing:${a.existingServer}`, wording, source: "customer", apps: [mediaApp] },
              p.elsewhere
                ? `The plan uses your ${nameOf(mediaApp)} where it already runs: nothing is installed for it, and your library and habits carry straight over.`
                : `The plan keeps ${nameOf(mediaApp)}, so your library and habits carry straight over.`,
            )
          : {
              id: `existing:${a.existingServer}`,
              wording,
              source: "customer",
              status: "declined",
              apps: [],
              reason: `You chose ${nameOf(mediaApp)} instead. Your ${nameOf(a.existingServer)} isn't touched.`,
            },
      );
    else
      out.push({
        id: `existing:${a.existingServer}`,
        wording,
        source: "customer",
        status: "included",
        apps: [],
        reason: `Nothing in this plan replaces your ${nameOf(a.existingServer)}; it stays as it is.`,
      });
  }
  if (p.downloads && a.existingVpn && a.existingVpn !== "none" && a.existingVpn !== "unsure") {
    const wording = `I already pay for ${answerWords("existingVpn", a.existingVpn)}`;
    if (a.existingVpn === "other")
      out.push({
        id: "existing:vpn",
        wording,
        source: "customer",
        status: "partial",
        apps: ["qbittorrent"],
        reason:
          "Downloads need a VPN that allows P2P. Yours may well do: tell Ember which one it is and it checks, so you don't pay for a second one. Until then the plan shows the usual recommendation.",
      });
    else
      out.push(
        p.vpnId === `have-${a.existingVpn}`
          ? fromApps(
              { id: "existing:vpn", wording, source: "customer", apps: ["qbittorrent"] },
              `Downloads go through your ${VPN_PROVIDERS[a.existingVpn].name}: nothing new to buy.`,
            )
          : {
              id: "existing:vpn",
              wording,
              source: "customer",
              status: "declined",
              apps: [],
              reason: `You picked a different VPN for downloads. Your ${VPN_PROVIDERS[a.existingVpn].name} isn't touched.`,
            },
      );
  }
  if (a.budget === "free") {
    const pays: string[] = [];
    if (p.downloads && !removed.includes("qbittorrent") && !p.vpnId?.startsWith("have-"))
      pays.push("a VPN that allows P2P (about $3 to $5 a month)");
    if (
      mediaApp === "plex" &&
      a.away === "away" &&
      !removed.includes("plex") &&
      a.plexPass !== "subscription" &&
      a.plexPass !== "lifetime"
    )
      pays.push("Plex Pass, which Plex needs for watching away from home");
    out.push({
      id: "budget:free",
      wording: answerWords("budget", "free"),
      source: "customer",
      status: pays.length ? "partial" : "included",
      apps: [],
      reason: pays.length
        ? `Everything is free except ${list(pays)}: there's no good free option for that. Leave those out and it's free.`
        : "Everything in this plan is free.",
    });
  }
  // Their decisions, and where "include it anyway" is possible.
  for (const r of out) {
    const d = p.decisions[r.id]?.choice;
    if (d) r.decision = d;
    if (r.status === "deferred" && p.canInclude.has(r.id)) r.canInclude = true;
    if (d === "later" && r.status === "deferred")
      r.reason =
        "You saved this for later. It stays on your list, and comes back whenever you like.";
  }

  // Other realistic ways to get what waits, so "not now" comes with a way forward.
  for (const r of out)
    if (r.status === "deferred" || r.status === "infeasible") {
      const w = r.id.startsWith("want:") ? r.id.slice(5) : "";
      if (ALTERNATIVES[w]) r.alternatives = ALTERNATIVES[w];
    }

  // What matters most to them, where they said.
  const ranks = a.priorities ?? [];
  for (const r of out) {
    const w = r.id.startsWith("want:") ? (r.id.slice(5) as BuildWant) : undefined;
    const i = w ? ranks.indexOf(w) : -1;
    if (i >= 0) r.priority = i + 1;
  }
  return out;
}

/**
 * What changed for each goal between two plans (a new ranking, a decision, an app left out, a new
 * look at the computer), in plain words, split into what they gain and what they give up.
 */
export function planChanges(
  before: BuildPlan,
  after: BuildPlan,
): { gained: string[]; lost: string[] } {
  const inPlan = (s: RequirementStatus) => s === "included" || s === "partial";
  const was = new Map(before.requirements.map((r) => [r.id, r]));
  const gained: string[] = [];
  const lost: string[] = [];
  for (const r of after.requirements) {
    const old = was.get(r.id);
    if (!old || old.status === r.status) continue;
    const q = `"${r.wording}"`;
    if (r.status === "included")
      gained.push(
        old.status === "partial" ? `Now fully in your plan: ${q}.` : `Now in your plan: ${q}.`,
      );
    else if (r.status === "partial" && !inPlan(old.status))
      gained.push(`Now in your plan, with a trade-off: ${q}. ${r.reason}`);
    else if (r.status === "partial") lost.push(`Now only partly met: ${q}. ${r.reason}`);
    else if (r.status === "substituted")
      (inPlan(old.status) ? lost : gained).push(`Now met another way: ${q}. ${r.reason}`);
    else if (r.status === "deferred")
      lost.push(
        r.decision === "later"
          ? `Saved for later, as you chose: ${q}.`
          : `Now waiting for room: ${q}. ${r.reason}`,
      );
    else if (r.status === "infeasible")
      lost.push(`Now not possible on this computer: ${q}. ${r.reason}`);
    else lost.push(`Left out, as you chose: ${q}.`);
  }
  return { gained, lost };
}

/** planChanges as one list: what they gain first, then what it costs. */
export function comparePlans(before: BuildPlan, after: BuildPlan): string[] {
  const c = planChanges(before, after);
  return [...c.gained, ...c.lost];
}

/**
 * What each app needs from another to do its job, and what happens without it. Leaving out
 * the one on the right breaks the one on the left (issue #16, step 3).
 */
const NEEDS: Record<string, { app: string[]; without: string; severity?: "harder" }[]> = {
  seerr: [
    {
      app: ["radarr"],
      without: "Without Radarr, Seerr can take movie requests but nothing fetches them.",
    },
    {
      app: ["sonarr"],
      without: "Without Sonarr, Seerr can take show requests but nothing fetches them.",
    },
    {
      app: ["jellyfin", "plex"],
      without: "Without a media server, Seerr can't see what you already have or play anything.",
    },
  ],
  radarr: [
    {
      app: ["prowlarr"],
      severity: "harder",
      without:
        "Without Prowlarr, Radarr still works, but you add its download sources (indexers) to it yourself and keep them up to date.",
    },
    {
      app: ["qbittorrent"],
      without:
        "Without qBittorrent, Radarr finds movies but has nothing to download them with, unless you add a different download app yourself.",
    },
  ],
  sonarr: [
    {
      app: ["prowlarr"],
      severity: "harder",
      without:
        "Without Prowlarr, Sonarr still works, but you add its download sources (indexers) to it yourself and keep them up to date.",
    },
    {
      app: ["qbittorrent"],
      without:
        "Without qBittorrent, Sonarr finds episodes but has nothing to download them with, unless you add a different download app yourself.",
    },
  ],
  prowlarr: [
    {
      app: ["radarr", "sonarr"],
      without: "Without Radarr or Sonarr, Prowlarr has nobody to search for, so it does nothing.",
    },
  ],
  qbittorrent: [
    {
      app: ["radarr", "sonarr"],
      without: "Without Radarr or Sonarr, qBittorrent only downloads what you add to it by hand.",
    },
  ],
};

/** Apps still in the plan that lose something they need, once these are left out. */
function brokenBy(live: string[], removed: readonly string[]) {
  const out: { app: string; needs: string; without: string; harder: boolean }[] = [];
  for (const app of live)
    for (const n of NEEDS[app] ?? [])
      if (n.app.some((d) => removed.includes(d)) && !n.app.some((d) => live.includes(d)))
        out.push({ app, needs: n.app[0]!, without: n.without, harder: n.severity === "harder" });
  return out;
}

/**
 * Realistic other ways to get a wish that waits: lighter, or elsewhere. Each is something that
 * really works, not a heavier swap.
 */
const ALTERNATIVES: Record<string, string[]> = {
  ai: [
    "A smaller AI model, about 2 to 3 GB of memory instead of 6: quicker, though less clever.",
    "Run the AI on another computer with more memory or an NVIDIA card, and use it from here.",
  ],
  photos: [
    "Have your phone copy its photos to a shared folder here: far lighter, but without Immich's search, faces, and timeline.",
  ],
  "smart-home": [
    "Home Assistant on a small box of its own (a Raspberry Pi or a Home Assistant Green), leaving this computer's memory for the rest.",
  ],
  request: ["Add films yourself for now: the media server plays whatever you put on the drive."],
};

/** What leaving one app out would do, said before it happens. */
export interface LeaveOutEffect {
  app: string;
  name: string;
  /** Other apps that stop working, and how. */
  breaks: string[];
  /** Other apps that still work, but with more to do by hand. */
  harder: string[];
  /** Goals that get worse, and goals that get better (room freed), from comparePlans. */
  lost: string[];
  gained: string[];
  /** Memory it frees, in GB (an estimate; 0 if it waits or already runs). */
  freesGb: number;
  /** One plain paragraph saying all of that. */
  summary: string;
}

/**
 * What leaving `app` out of this plan would break, lose, and free, checked by planning again
 * without it (so a freed gigabyte is only promised when something waiting really fits in it).
 */
export function leaveOutEffects(
  a: BuildAnswers,
  scan: HostScan,
  chosen: Record<string, string>,
  removed: readonly string[],
  app: string,
  decisions: GoalDecisions = {},
): LeaveOutEffect {
  const before = recommendBuild(a, scan, chosen, removed, decisions);
  const after = recommendBuild(a, scan, chosen, [...removed, app], decisions);
  const entry = before.capabilities
    .flatMap((c) => c.apps.map((x) => ({ x, c })))
    .find(({ x }) => x.id === app);
  const live = before.capabilities
    .filter((c) => c.starter)
    .flatMap((c) => c.apps.map((x) => x.id))
    .filter((id) => !removed.includes(id) && id !== app);
  // Only what this would newly break: what's already broken by earlier choices isn't news.
  const already = new Set(brokenBy([...live, app], removed).map((b) => b.without));
  const fresh = brokenBy(live, [...removed, app]).filter((b) => !already.has(b.without));
  const breaks = [...new Set(fresh.filter((b) => !b.harder).map((b) => b.without))];
  const harder = [...new Set(fresh.filter((b) => b.harder).map((b) => b.without))];
  const { lost, gained } = planChanges(before, after);
  const freesGb = entry && entry.c.starter && !entry.x.installed ? entry.x.memoryGb : 0;
  const name = nameOf(app);
  const waiting = before.capabilities.some((c) => !c.starter);
  const parts = [
    breaks.length ? breaks.join(" ") : "",
    harder.length ? harder.join(" ") : "",
    freesGb
      ? gained.length
        ? `It frees about ${freesGb} GB of memory (an estimate), enough for something that was waiting.`
        : waiting
          ? `It frees about ${freesGb} GB of memory (an estimate), but nothing that's waiting fits in that yet.`
          : `It frees about ${freesGb} GB of memory (an estimate).`
      : "",
  ].filter(Boolean);
  return {
    app,
    name,
    breaks,
    harder,
    lost,
    gained,
    freesGb,
    summary: parts.length
      ? `Leaving out ${name}: ${parts.join(" ")}`
      : `Leaving out ${name} doesn't affect anything else in the plan.`,
  };
}

/** The goal a capability delivers: "want:photos", "away", or "importance". */
function goalOf(c: BuildCapability): string {
  if (c.id === "safety") return c.apps[0]!.id === "tailscale" ? "away" : "importance";
  return `want:${c.id}`;
}

/**
 * The plan in the three groups the person sees (issue #16, step 4). Every goal they stated is
 * in exactly one group; suggestions they didn't ask for are kept apart, so a suggestion is never
 * shown as a request and a request is never lost among suggestions.
 */
export interface PlanGroups {
  /** In the starter: fully, partly, or with trade-offs (each says which). */
  included: BuildRequirement[];
  /** Asked for, not in the starter, waiting on their decision: why, and what they can do. */
  notIncluded: BuildRequirement[];
  /** Kept for later: saved by them, left out by them, or Ember's suggestions that wait. */
  later: BuildRequirement[];
  /** Capabilities nobody asked for that wait ("later, if you like"). */
  suggestions: BuildCapability[];
}

export function planGroups(plan: BuildPlan): PlanGroups {
  const g: PlanGroups = { included: [], notIncluded: [], later: [], suggestions: [] };
  for (const r of plan.requirements) {
    if (r.status === "included" || r.status === "partial") g.included.push(r);
    else if (r.status === "substituted")
      (r.decision === "accept" ? g.included : g.notIncluded).push(r);
    else if (r.status === "declined" || r.decision === "later" || r.source === "cove")
      g.later.push(r);
    else g.notIncluded.push(r);
  }
  const served = new Set(plan.requirements.flatMap((r) => r.apps));
  g.suggestions = plan.capabilities.filter(
    (c) => !c.starter && !c.apps.some((x) => served.has(x.id)),
  );
  return g;
}

/** What "include it anyway" would do, said before they confirm it. */
export interface IncludeEffect {
  goal: string;
  wording: string;
  /** Whether it can be included at all, and if not, the hard limit that stops it. */
  allowed: boolean;
  /** The risks, specific to this computer and this plan. */
  risks: string[];
  /** Goals that would get worse or better, from comparePlans. */
  lost: string[];
  gained: string[];
}

/**
 * What including a waiting goal anyway would do: planned again with it in, so the memory and
 * the trade-offs are the real ones. Changes nothing until they confirm, and even then only the
 * plan: installs, accounts, and network changes keep their own approvals.
 */
export function includeAnywayEffects(
  a: BuildAnswers,
  scan: HostScan,
  chosen: Record<string, string>,
  removed: readonly string[],
  decisions: GoalDecisions,
  goal: string,
): IncludeEffect {
  const before = recommendBuild(a, scan, chosen, removed, decisions);
  const r = before.requirements.find((x) => x.id === goal);
  const wording = r?.wording ?? goal;
  if (!r || !r.canInclude)
    return {
      goal,
      wording,
      allowed: false,
      risks: [r?.reason ?? "That goal isn't waiting on memory, so there's nothing to override."],
      lost: [],
      gained: [],
    };
  const after = recommendBuild(a, scan, chosen, removed, {
    ...decisions,
    [goal]: { choice: "include", at: "" },
  });
  // The goal itself is the point of the choice; what else changes is what they need to know.
  const other = (l: string) => !l.includes(`"${wording}"`);
  const changes = planChanges(before, after);
  const apps = after.capabilities.flatMap((c) => c.apps).filter((x) => r.apps.includes(x.id));
  const others = after.capabilities
    .filter((c) => c.starter)
    .flatMap((c) => c.apps)
    // Backups run now and then, not all the time, so they don't count as sharing memory.
    .filter((x) => !r.apps.includes(x.id) && !removed.includes(x.id) && x.id !== "backups")
    .map((x) => x.name);
  const risks = [
    apps.find((x) => x.fitReason)?.fitReason ?? "",
    others.length
      ? `It shares this computer's memory with ${list(others)}, so when they're busy together everything can slow down, and the computer may fall back on its disk, which is much slower.`
      : "",
    "This changes your plan only. Nothing is installed yet, and each install, account, and network change still asks for your approval.",
  ].filter(Boolean);
  return {
    goal,
    wording,
    allowed: true,
    risks,
    lost: changes.lost.filter(other),
    gained: changes.gained.filter(other),
  };
}

/** Where each VPN shows the login its VPN connections use (not the account sign-in). */
export const VPN_LOGIN_PAGES: Partial<Record<VpnProvider, { url: string; where: string }>> = {
  proton: {
    url: "https://account.proton.me/vpn/OpenVpnIKEv2",
    where: 'the "OpenVPN / IKEv2 username" and "OpenVPN / IKEv2 password" on that page (OpenVPN, in the left menu of your Proton account)',
  },
  nord: {
    url: "https://my.nordaccount.com/dashboard/nordvpn/manual-configuration/",
    where: "the service credentials (username and password) on that page",
  },
  surfshark: {
    url: "https://my.surfshark.com/vpn/manual-setup/main/openvpn",
    where: "the service credentials (username and password) on that page",
  },
  pia: {
    url: "https://www.privateinternetaccess.com/account/client-control-panel",
    where: "your PIA username (it starts with p) and its password",
  },
};
