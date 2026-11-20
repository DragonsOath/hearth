import { describe, expect, it } from "vitest";
import { matchSites, parseCaddyfile } from "./proxy-addresses";

const caddyfile = `{
	email me@example.com
}

(login) {
	forward_auth 127.0.0.1:3011 {
		uri /api/auth/caddy
	}
}

radarr.example.com {
	import login
	reverse_proxy 192.168.1.10:7878 {
		header_up Host {host}
	}
}

sab.example.com {
	import login
	reverse_proxy 192.168.1.10:8085
}

overseerr.example.com,
requests.example.com {
	reverse_proxy 192.168.1.10:5055 {
	}
}

dnd.example.com {
	root * /srv/dnd
	file_server
}

home.example.com {
	reverse_proxy localhost:8123
}
`;

describe("your reverse proxy's addresses", () => {
  it("reads each site and where it forwards, skipping snippets and static sites", () => {
    expect(parseCaddyfile(caddyfile)).toEqual([
      { site: "radarr.example.com", upstream: "192.168.1.10:7878" },
      { site: "sab.example.com", upstream: "192.168.1.10:8085" },
      { site: "overseerr.example.com", upstream: "192.168.1.10:5055" },
      { site: "home.example.com", upstream: "localhost:8123" },
    ]);
  });

  it("matches a site to the system at the same address, or the same port on this machine", () => {
    const m = matchSites(
      parseCaddyfile(caddyfile),
      [
        { id: "radarr", localUrl: "http://192.168.1.10:7878" },
        { id: "ha", localUrl: "http://192.168.1.10:8123" },
        { id: "sonarr", localUrl: "http://192.168.1.10:8989" },
        { id: "db", localUrl: null },
      ],
      ["192.168.1.10"],
    );
    expect(Object.fromEntries(m)).toEqual({
      radarr: "radarr.example.com",
      ha: "home.example.com",
    });
  });
});
