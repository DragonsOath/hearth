import { describe, expect, it } from "vitest";
import { parseRemoteId, remoteId, routeToPc } from "./pcs";

describe("systems on another PC", () => {
  it("carry ids that name their PC", () => {
    const id = remoteId("0123abcdef", "svc-sonarr");
    expect(id).toBe("pc~0123abcdef~svc-sonarr");
    expect(parseRemoteId(id)).toEqual({ pc: "0123abcdef", id: "svc-sonarr" });
    expect(parseRemoteId("svc-sonarr")).toBeNull();
  });

  it("send their API calls to that PC through your Hearth", () => {
    expect(routeToPc("/api/services/pc~0123abcdef~svc-sonarr/dashboard?x=1")).toBe(
      "/api/on/0123abcdef/services/svc-sonarr/dashboard?x=1",
    );
    expect(routeToPc("/api/credentials/pc~0123abcdef~svc-a/import")).toBe(
      "/api/on/0123abcdef/credentials/svc-a/import",
    );
    expect(routeToPc("/api/services/svc-sonarr")).toBe("/api/services/svc-sonarr");
    expect(routeToPc("/api/on/0123abcdef/engine/state")).toBe("/api/on/0123abcdef/engine/state");
  });
});
