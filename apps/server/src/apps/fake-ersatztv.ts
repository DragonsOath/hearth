import type { Fetch } from "./http";

/**
 * A stand-in ErsatzTV (port 8409) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install): three channels, one streaming, a guide with what is on now and next (one channel has
 * nothing on), and the reset and stop calls the panel makes.
 */

export interface FakeErsatz {
  fetch: Fetch;
  reset(): void;
}

const t = (minutes: number) => {
  const d = new Date(Date.now() + minutes * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
};

const guide = () => `<?xml version="1.0" encoding="utf-8"?><tv generator-info-name="ersatztv">
<channel id="C1.1.ersatztv.org"><display-name>Dragon&#39;s Vault Network</display-name><display-name>1</display-name></channel>
<channel id="C101.2.ersatztv.org"><display-name>Fantasy</display-name><display-name>101</display-name></channel>
<channel id="C102.3.ersatztv.org"><display-name>Sci-Fi</display-name><display-name>102</display-name></channel>
<programme start="${t(-20)}" stop="${t(25)}" channel="C1.1.ersatztv.org"><title lang="en">The Expanse</title><sub-title lang="en">Dulcinea</sub-title></programme>
<programme start="${t(25)}" stop="${t(70)}" channel="C1.1.ersatztv.org"><title lang="en">Arcane</title></programme>
<programme start="${t(-5)}" stop="${t(100)}" channel="C101.2.ersatztv.org"><title lang="en">The Fellowship of the Ring</title></programme>
</tv>`;

export function fakeErsatz(): FakeErsatz {
  let sessions = [{ channelNumber: "1", state: "Running", clients: [{}] }];
  const resets: string[] = [];
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => String(data),
  });
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? "GET";
    if (p === "/api/version")
      return reply(200, { apiVersion: 3, appVersion: "26.3.0-docker-amd64" });
    if (p === "/api/channels")
      return reply(200, [
        { id: 1, number: "1", name: "Home Network TV", ffmpegProfile: "1920x1080 x264 aac" },
        { id: 2, number: "101", name: "Fantasy", ffmpegProfile: "1920x1080 x264 aac" },
        { id: 3, number: "102", name: "Sci-Fi", ffmpegProfile: "1920x1080 x264 aac" },
      ]);
    if (p === "/api/sessions") return reply(200, sessions);
    if (p === "/iptv/xmltv.xml")
      return { ok: true, status: 200, json: async () => ({}), text: async () => guide() };
    const reset = /^\/api\/channels\/(\w+)\/playout\/reset$/.exec(p);
    if (reset && method === "POST") {
      resets.push(reset[1]!);
      return reply(200, null);
    }
    const stop = /^\/api\/session\/(\w+)$/.exec(p);
    if (stop && method === "DELETE") {
      sessions = sessions.filter((s) => s.channelNumber !== stop[1]);
      return reply(200, null);
    }
    return reply(404, {});
  };
  return {
    fetch: fetchImpl,
    reset: () => (sessions = [{ channelNumber: "1", state: "Running", clients: [{}] }]),
  };
}
