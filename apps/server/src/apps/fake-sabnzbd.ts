import { bodyText, type Fetch } from "./http";

/**
 * A stand-in SABnzbd (port 8080) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install): one download running, one paused, and a history with one failure (and why), answering
 * the same API calls the panel and its controls make: the speed limit, a timed pause, and a job's
 * priority, place and category too, like SABnzbd 5.1. Adding NZBs (links and uploaded files), a
 * job's files, a searched history, and its warnings (one to start with, and clearing them) too.
 */

export interface FakeSabnzbd {
  fetch: Fetch;
  reset(): void;
}

const QUEUE = () => [
  {
    nzo_id: "SABnzbd_nzo_a1",
    filename: "Arrival.2016.1080p.BluRay",
    status: "Downloading",
    percentage: "63",
    mb: "9800.0",
    mbleft: "3626.0",
    timeleft: "0:01:20",
    cat: "movies",
    priority: "Normal",
  },
  {
    nzo_id: "SABnzbd_nzo_b2",
    filename: "Severance.S02E05.1080p.WEB",
    status: "Paused",
    percentage: "0",
    mb: "2100.0",
    mbleft: "2100.0",
    timeleft: "0:00:00",
    cat: "tv",
    priority: "Normal",
  },
  {
    nzo_id: "SABnzbd_nzo_e5",
    filename: "Nosferatu.1922.Restored.1080p",
    status: "Queued",
    percentage: "0",
    mb: "4100.0",
    mbleft: "4100.0",
    timeleft: "0:00:00",
    cat: "movies",
    priority: "Low",
  },
];
const PRIORITY: Record<string, string> = { "2": "Force", "1": "High", "0": "Normal", "-1": "Low" };

const HISTORY = () => [
  {
    nzo_id: "SABnzbd_nzo_c3",
    name: "Dune.Part.Two.2024.2160p",
    status: "Failed",
    fail_message: "Repair failed, not enough repair blocks (412 short)",
    completed: Math.floor(Date.now() / 1000) - 18_000,
    bytes: 53_687_091_200,
    category: "movies",
  },
  {
    nzo_id: "SABnzbd_nzo_d4",
    name: "Paper.Moons.2026.1080p",
    status: "Completed",
    fail_message: "",
    completed: Math.floor(Date.now() / 1000) - 32_400,
    bytes: 8_493_465_600,
    category: "movies",
  },
];

const WARNINGS = () => [
  {
    text: "Server news.example.net will be ignored for 10 minutes (too many connections)",
    type: "WARNING",
    time: Math.floor(Date.now() / 1000) - 600,
  },
];

/** Each job's files, as get_files lists them (a few per job, the rest made up from its size). */
function filesOf(job: { nzo_id: string; filename: string; mb: string; mbleft: string }) {
  const total = Number(job.mb);
  const left = Number(job.mbleft);
  const parts = 4;
  const done = Math.round((1 - left / total) * parts);
  return Array.from({ length: parts }, (_, i) => ({
    filename: `${job.filename}.part0${i + 1}.rar`,
    mb: (total / parts).toFixed(2),
    mbleft: i < done ? "0.00" : (total / parts).toFixed(2),
    status: i < done ? "finished" : i === done ? "active" : "queued",
    age: "2d",
  }));
}

/** The uploaded file's name in a multipart body (field "name", as SABnzbd's addfile takes it). */
function uploadedName(body: unknown) {
  const text = bodyText(body);
  if (!/<nzb[\s>]/i.test(text)) return undefined;
  return /name="name"; filename="([^"]+)"/.exec(text)?.[1];
}

export function fakeSabnzbd(): FakeSabnzbd {
  let queue = QUEUE();
  let history = HISTORY();
  let warnings = WARNINGS();
  let added = 0;
  const priorityOf = (p: string | null) =>
    p === "-2" ? undefined : (PRIORITY[p ?? ""] ?? "Normal");
  const add = (name: string, q: URLSearchParams) => {
    added += 1;
    const id = `SABnzbd_nzo_new${added}`;
    queue.push({
      nzo_id: id,
      filename: q.get("nzbname") || name,
      status: q.get("priority") === "-2" ? "Paused" : "Queued",
      percentage: "0",
      mb: "1500.0",
      mbleft: "1500.0",
      timeleft: "0:00:00",
      cat: q.get("cat") ?? "*",
      priority: priorityOf(q.get("priority")) ?? "Normal",
    });
    return id;
  };
  let paused = false;
  let speedlimit = 100;
  let pauseMinutes = 0;
  const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const q = u.searchParams;
    if (!q.get("apikey")?.startsWith("e2e-"))
      return ok({ status: false, error: "API Key Incorrect" });
    const value = q.get("value") ?? "";
    switch (q.get("mode")) {
      case "version":
        return ok({ version: "5.1.3" });
      case "get_cats":
        return ok({ categories: ["*", "movies", "tv", "audio", "software"] });
      case "config": {
        if (q.get("name") === "speedlimit") speedlimit = Number(value) || 100;
        if (q.get("name") === "set_pause") {
          pauseMinutes = Number(value);
          paused = true;
        }
        return ok({ status: true });
      }
      case "switch": {
        const at = queue.findIndex((j) => j.nzo_id === value);
        if (at < 0) return ok({ status: false, error: "Not found" });
        const [job] = queue.splice(at, 1);
        queue.splice(Number(q.get("value2") ?? 0), 0, job!);
        return ok({ result: { position: Number(q.get("value2")), priority: 0 } });
      }
      case "change_cat":
        for (const j of queue) if (j.nzo_id === value) j.cat = q.get("value2") ?? "*";
        return ok({ status: true });
      case "warnings":
        if (q.get("name") === "clear") {
          warnings = [];
          return ok({ status: true });
        }
        return ok({ warnings });
      case "addurl": {
        const link = q.get("name") ?? "";
        if (!/^https?:\/\//.test(link))
          return ok({ status: false, error: "expects one parameter" });
        const name = decodeURIComponent(
          new URL(link).pathname.split("/").pop() || "download",
        ).replace(/\.nzb$/i, "");
        return ok({ status: true, nzo_ids: [add(name, q)] });
      }
      case "addfile": {
        const file = uploadedName(init?.body);
        if (!file) return ok({ status: false, error: "No file given" });
        return ok({ status: true, nzo_ids: [add(file.replace(/\.nzb$/i, ""), q)] });
      }
      case "get_files": {
        const job = queue.find((j) => j.nzo_id === value);
        return ok({ files: job ? filesOf(job) : [] });
      }
      case "pause":
        paused = true;
        return ok({ status: true });
      case "resume":
        paused = false;
        pauseMinutes = 0;
        return ok({ status: true });
      case "retry": {
        const job = history.find((h) => h.nzo_id === value);
        if (!job) return ok({ status: false, error: "Not found" });
        history = history.filter((h) => h !== job);
        queue.push({
          nzo_id: job.nzo_id,
          filename: job.name,
          status: "Queued",
          percentage: "0",
          mb: String(job.bytes / 1024 / 1024),
          mbleft: String(job.bytes / 1024 / 1024),
          timeleft: "0:00:00",
          cat: job.category,
          priority: "Normal",
        });
        return ok({ status: true });
      }
      case "queue": {
        const name = q.get("name");
        if (name === "pause" || name === "resume") {
          for (const j of queue)
            if (j.nzo_id === value) j.status = name === "pause" ? "Paused" : "Queued";
          return ok({ status: true });
        }
        if (name === "delete") {
          queue = queue.filter((j) => j.nzo_id !== value);
          return ok({ status: true });
        }
        if (name === "priority") {
          for (const j of queue)
            if (j.nzo_id === value) j.priority = PRIORITY[q.get("value2") ?? "0"] ?? "Normal";
          return ok({ position: 0 });
        }
        const only = q.get("nzo_ids")?.split(",");
        if (only) return ok({ queue: { slots: queue.filter((j) => only.includes(j.nzo_id)) } });
        const mbleft = queue.reduce((n, j) => n + Number(j.mbleft), 0);
        const running = !paused && queue.some((j) => j.status === "Downloading");
        return ok({
          queue: {
            status: paused ? "Paused" : running ? "Downloading" : "Idle",
            paused,
            kbpersec: running ? "48200.5" : "0.0",
            sizeleft: `${(mbleft / 1024).toFixed(1)} GB`,
            timeleft: running ? "0:02:11" : "0:00:00",
            diskspace1: "812.40",
            diskspacetotal1: "3726.00",
            speedlimit: String(speedlimit),
            speedlimit_abs:
              speedlimit < 100 ? String(Math.round(62_500_000 * (speedlimit / 100))) : "0",
            pause_int: paused && pauseMinutes ? `${pauseMinutes}:00` : "0",
            slots: queue,
          },
        });
      }
      case "history":
        if (q.get("name") === "delete") {
          history = history.filter((h) => h.nzo_id !== value);
          return ok({ status: true });
        }
        {
          const only = q.get("nzo_ids")?.split(",");
          const search = (q.get("search") ?? "").toLowerCase();
          const cat = q.get("category");
          const hits = history
            .filter((h) => !only || only.includes(h.nzo_id))
            .filter((h) => !search || h.name.toLowerCase().includes(search))
            .filter((h) => q.get("failed_only") !== "1" || h.status === "Failed")
            .filter((h) => !cat || h.category === cat);
          const start = Number(q.get("start") ?? 0);
          const limit = Number(q.get("limit") ?? 50);
          return ok({
            history: { noofslots: hits.length, slots: hits.slice(start, start + limit) },
          });
        }
      default:
        return ok({ status: false, error: "not implemented" });
    }
  };
  return {
    fetch: fetchImpl,
    reset: () => {
      queue = QUEUE();
      history = HISTORY();
      warnings = WARNINGS();
      added = 0;
      paused = false;
      speedlimit = 100;
      pauseMinutes = 0;
    },
  };
}
