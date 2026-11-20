import { describe, expect, it } from "vitest";
import { buildGettingStarted, type GettingStartedState, type KeyNeed } from "./getting-started";

const nothing: GettingStartedState = {
  adopted: false,
  keys: [],
  notifications: false,
  backupCopy: false,
  voice: false,
  operator: false,
  met: false,
};
const none = { dismissed: [], hidden: false };

describe("getting started", () => {
  it("lists the steps in order, all still to do on a new installation", () => {
    const list = buildGettingStarted(nothing, none, "Ember");
    expect(list.items.map((i) => i.id)).toEqual([
      "plan",
      "adopt",
      "notifications",
      "backup-copy",
      "voice",
      "operator",
      "meet",
    ]);
    expect(list.items.every((i) => !i.done && !i.dismissed)).toBe(true);
    // Voice is optional, so six are left; planning counts while nothing of theirs is adopted.
    expect(list.remaining).toBe(6);
    expect(list.items[0]).toMatchObject({ title: "Plan your homelab", href: "/plan" });
    expect(list.finished).toBe(false);
    expect(list.items.at(-1)).toMatchObject({ title: "Meet Ember", kind: "meet" });
  });

  it("adds one key step per adopted app that needs one, with where the app shows it", () => {
    const list = buildGettingStarted(
      {
        ...nothing,
        adopted: true,
        keys: [
          {
            serviceId: "radarr",
            name: "Radarr",
            kind: "api-key",
            where: "Radarr: Settings > General > Security > API Key",
            state: "missing",
          },
          {
            serviceId: "qbittorrent",
            name: "qBittorrent",
            kind: "login",
            where: "qBittorrent: the Web UI username and password (Tools > Options > Web UI)",
            state: "working",
          },
        ],
      },
      none,
      "Warden",
    );
    const radarr = list.items.find((i) => i.id === "key:radarr")!;
    expect(radarr).toMatchObject({
      title: "Add Radarr's key in Secure Vault",
      detail: "How to get it: Settings > General > Security > API Key",
      href: "/vault",
      done: false,
    });
    expect(list.items.find((i) => i.id === "key:qbittorrent")).toMatchObject({
      title: "Add qBittorrent's login in Secure Vault",
      done: true,
    });
    expect(list.items.find((i) => i.id === "adopt")!.done).toBe(true);
    // The owner's chosen name is used.
    expect(list.items.at(-1)!.title).toBe("Meet Warden");
  });

  it("counts only a key Hearth can use, and says why a saved one does not", () => {
    const need = (serviceId: string, state: KeyNeed["state"]): KeyNeed => ({
      serviceId,
      name: serviceId,
      kind: "api-key",
      where: "Settings > General",
      state,
    });
    const list = buildGettingStarted(
      {
        ...nothing,
        keys: [
          need("a", "unused"),
          need("b", "working"),
          need("c", "failing"),
          need("d", "protected"),
          need("e", "missing"),
        ],
      },
      none,
      "Ember",
    );
    const step = (id: string) => list.items.find((i) => i.id === `key:${id}`)!;
    expect(["a", "b", "c", "d", "e"].map((id) => step(id).done)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(step("c").detail).toContain("c turned down the saved key");
    expect(step("d").detail).toContain("save it as Automation");
    expect(step("e").detail).toBe("How to get it: Settings > General");
  });

  it("ticks each step from its state, and is finished when the rest are done or dismissed", () => {
    const list = buildGettingStarted(
      { ...nothing, adopted: true, notifications: true, operator: true, met: true },
      { dismissed: ["backup-copy"], hidden: false },
      "Ember",
    );
    expect(list.items.find((i) => i.id === "backup-copy")!.dismissed).toBe(true);
    // Voice is optional: not doing it does not keep the list open.
    expect(list.items.find((i) => i.id === "voice")).toMatchObject({ done: false, optional: true });
    expect(list.remaining).toBe(0);
    expect(list.finished).toBe(true);
  });

  it("remembers that the whole list was hidden", () => {
    expect(buildGettingStarted(nothing, { dismissed: [], hidden: true }, "Ember").hidden).toBe(
      true,
    );
  });

  it("offers a plan first to someone with nothing to adopt, and makes it optional otherwise", () => {
    const fresh = buildGettingStarted(nothing, none, "Ember");
    expect(fresh.items[0]).toMatchObject({ id: "plan", optional: false, done: false });
    expect(buildGettingStarted({ ...nothing, planned: true }, none, "Ember").items[0]!.done).toBe(
      true,
    );
    const running = buildGettingStarted({ ...nothing, adopted: true }, none, "Ember");
    expect(running.items[0]).toMatchObject({ id: "plan", optional: true });
  });
});
