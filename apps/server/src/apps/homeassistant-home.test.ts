import { describe, expect, it } from "vitest";
import { fakeHomeAssistant } from "./fake-homeassistant";
import {
  addAppCredentials,
  connectMusicAssistant,
  connectNext,
  connectStart,
  connectTiming,
  deliverSignInCallback,
  homeAct,
  homePicture,
  musicLibrary,
  musicPlay,
  musicSearch,
  NEEDS_PIN,
  readHome,
  sceneDelete,
  sceneRead,
  sceneSave,
} from "./homeassistant-home";

// The home dashboard (11-04) against the stand-in Home Assistant: what a wall tablet shows, each
// kind of tap, what it refuses, and Home Assistant's own setup flows.

const BASE = "http://ha.test:8123";
const TOKEN = "e2e-home";

function setup() {
  const ha = fakeHomeAssistant();
  return {
    ha,
    read: () => readHome(ha.fetch, BASE, TOKEN, ha.socket),
    tap: (entity: string, action: string, extra: Record<string, unknown> = {}) =>
      homeAct(ha.fetch, BASE, TOKEN, { entity, action, ...extra }),
  };
}

describe("the home dashboard", () => {
  it("calls a speaker by its room when all it reports is a model number (11-13)", async () => {
    const { read } = setup();
    const d = await read();
    expect(d.music.find((m) => m.entity === "media_player.sonos_era_100")).toMatchObject({
      name: "Den speaker",
      originalName: "Den speaker",
      // Music Assistant still finds it by what Home Assistant reports.
      systemName: "Sonos Era 100",
    });
    // A real name stays as it is.
    expect(d.music.find((m) => m.entity === "media_player.kitchen_speaker")?.name).toBe(
      "Kitchen speaker",
    );
  });

  it("reads the weather with a forecast, music, the calendar, lists, rooms, cameras and doors", async () => {
    const { read } = setup();
    const d = await read();
    expect(d.weather).toMatchObject({ condition: "partlycloudy", temperature: 18.4, unit: "°C" });
    expect(d.weather!.forecast).toHaveLength(5);
    expect(d.music[0]).toMatchObject({
      name: "Kitchen speaker",
      state: "playing",
      title: "Harbor Song",
      artist: "The Lighthouse Band",
      volume: 40,
      picture: true,
      sources: ["Spotify", "Radio"],
      can: { pause: true, next: true, previous: true, volume: true, source: true, power: true },
    });
    expect(d.events.map((e) => e.title)).toEqual([
      "Dentist",
      "Soccer practice",
      "Grandma's birthday",
    ]);
    expect(d.events[2]!.allDay).toBe(true);
    const groceries = d.lists.find((l) => l.name === "Groceries")!;
    expect(groceries.items.map((i) => [i.summary, i.done])).toEqual([
      ["Milk", false],
      ["Bread", false],
      ["Eggs", true],
    ]);
    // Lights by their room in Home Assistant; the rest under Other.
    expect(d.rooms.map((r) => r.name)).toEqual(["Kitchen", "Living room", "Other"]);
    expect(d.cameras.map((c) => c.name)).toEqual(["Front porch"]);
    expect(d.security.map((s) => [s.kind, s.name, s.state])).toEqual([
      ["lock", "Front door", "locked"],
      ["garage", "Garage door", "closed"],
      ["alarm", "Alarm", "disarmed"],
    ]);
    expect(d.security.find((s) => s.kind === "alarm")!.needsCode).toBe(true);
    // A speaker's artwork address carries a token: it is never sent to the screen.
    expect(JSON.stringify(d)).not.toContain("fake-art-token");
  });

  it("reads the hourly forecast, feels-like, the sun, song progress and the thermostat", async () => {
    const { read } = setup();
    const d = await read();
    expect(d.weather).toMatchObject({ feelsLike: 16.9, windBearing: 270, rainChance: 10 });
    expect(d.weather!.hourly).toHaveLength(8);
    expect(d.sun?.up).toBe(false);
    expect(d.sun?.rising).toBeTruthy();
    expect(d.music[0]).toMatchObject({
      position: 92,
      duration: 238,
      shuffle: false,
      repeat: "off",
      video: false,
      can: { shuffle: true, repeat: true },
    });
    expect(d.climate[0]).toMatchObject({
      name: "Thermostat",
      mode: "heat",
      action: "heating",
      current: 20.5,
      target: 21,
      modes: ["off", "heat", "cool", "auto"],
    });
  });

  it("reads the widget gallery's things: people, travel, the doorbell, plants, sports, bins, energy", async () => {
    const { ha } = setup();
    const d = await readHome(ha.fetch, BASE, TOKEN, ha.socket, {
      watch: ["sensor.living_room_temperature", "input_boolean.guest_mode", "lock.front_door"],
      catalog: true,
    });
    expect(d.people.map((p) => [p.name, p.state, p.picture])).toEqual([
      ["Alex", "home", true],
      ["Sam", "not_home", false],
    ]);
    expect(d.travel).toEqual([
      expect.objectContaining({ name: "Commute to work", minutes: 24, destination: "Office" }),
    ]);
    // The doorbell's camera is the one on the same device.
    expect(d.doorbells[0]).toMatchObject({
      name: "Front door doorbell",
      camera: "camera.front_porch",
    });
    expect(d.doorbells[0]!.last).toBeTruthy();
    expect(d.plants[0]).toMatchObject({ name: "Fern", problem: "moisture low", moisture: 12 });
    expect(d.sports[0]).toMatchObject({ team: "Harbor City", teamScore: "24", state: "POST" });
    expect(d.waste[0]).toMatchObject({ name: "Bin day", days: 2, types: ["Recycling"] });
    // Today's totals from the Energy dashboard's own sources, and the power now.
    expect(d.energy).toMatchObject({ grid: 8.4, solar: 6.1, powerNow: 1430 });
    // A Devices widget gets only what it asked for (a lock is the Security page's, not here).
    expect(d.devices.map((x) => [x.entity, x.state, x.unit, x.toggle])).toEqual([
      ["sensor.living_room_temperature", "21.3", "°C", false],
      ["input_boolean.guest_mode", "off", undefined, true],
    ]);
    expect(d.devices[0]!.room).toBe("Living room");
    // The catalog lists what a Devices widget can add, garage doors left out.
    expect(d.catalog!.map((x) => x.entity)).toContain("switch.server_fan");
    expect(d.catalog!.map((x) => x.entity)).not.toContain("cover.garage_door");
    // Without asking: no devices and no catalog.
    const bare = await readHome(ha.fetch, BASE, TOKEN, ha.socket);
    expect(bare.devices).toEqual([]);
    expect(bare.catalog).toBeUndefined();
  });

  it("flips a helper toggle and shows a person's picture through Home Assistant", async () => {
    const { tap, ha } = setup();
    expect((await tap("input_boolean.guest_mode", "toggle")).state).toBe("on");
    await expect(tap("input_boolean.guest_mode", "turn_off")).rejects.toThrow(/does not do that/);
    expect((await homePicture(ha.fetch, BASE, TOKEN, "person.alex"))?.type).toBe("image/png");
    expect(await homePicture(ha.fetch, BASE, TOKEN, "person.sam")).toBeUndefined();
  });

  it("moves what is playing to another Music Assistant speaker", async () => {
    const { tap, ha, read } = setup();
    ha.home({ musicAssistant: true, livingRoom: true });
    const moved = await tap("media_player.kitchen_speaker_ma", "move", {
      value: "media_player.living_room_ma",
    });
    expect(moved.state).toBe("playing");
    const d = await read();
    expect(d.music.find((m) => m.entity === "media_player.living_room_ma")?.state).toBe("idle");
    await expect(
      tap("media_player.kitchen_speaker_ma", "move", { value: "media_player.kitchen_speaker_ma" }),
    ).rejects.toThrow(/Which speaker/);
    await expect(
      tap("media_player.kitchen_speaker_ma", "move", { value: "light.kitchen" }),
    ).rejects.toThrow(/Which speaker/);
  });

  it("shuffles, repeats and sets the thermostat within its range and modes", async () => {
    const { tap, read } = setup();
    await tap("media_player.kitchen_speaker", "shuffle", { value: true });
    await tap("media_player.kitchen_speaker", "repeat", { value: "all" });
    await expect(tap("media_player.kitchen_speaker", "repeat", { value: "twice" })).rejects.toThrow(
      /off, all or one/,
    );
    await tap("climate.living_room", "temperature", { value: 22.5 });
    await expect(tap("climate.living_room", "temperature", { value: 45 })).rejects.toThrow(
      /from 7 to 30/,
    );
    await tap("climate.living_room", "mode", { value: "cool" });
    await expect(tap("climate.living_room", "mode", { value: "dry" })).rejects.toThrow(
      /no such mode/,
    );
    const d = await read();
    expect(d.music[0]).toMatchObject({ shuffle: true, repeat: "all" });
    expect(d.climate[0]).toMatchObject({ target: 22.5, mode: "cool" });
  });

  it("plays, skips, sets the volume and the source, and toggles a light, then reads back", async () => {
    const { tap } = setup();
    expect((await tap("media_player.kitchen_speaker", "play_pause")).state).toBe("paused");
    expect((await tap("media_player.kitchen_speaker", "play")).state).toBe("playing");
    expect((await tap("media_player.kitchen_speaker", "pause")).state).toBe("paused");
    expect((await tap("media_player.kitchen_speaker", "pause")).state).toBe("paused");
    await tap("media_player.kitchen_speaker", "play");
    expect((await tap("media_player.kitchen_speaker", "next")).state).toBe("playing");
    await tap("media_player.kitchen_speaker", "volume", { value: 70 });
    await tap("media_player.kitchen_speaker", "source", { value: "Radio" });
    await expect(tap("media_player.kitchen_speaker", "source", { value: "Nope" })).rejects.toThrow(
      /no such source/,
    );
    expect((await tap("light.living_room", "toggle")).state).toBe("on");
    await expect(tap("light.kitchen", "brightness", { value: 400 })).rejects.toThrow(/0 to 100/);
  });

  it("adds to a list, ticks an item off and back, and removes it", async () => {
    const { tap, read } = setup();
    await tap("todo.groceries", "add", { value: "Apples" });
    let g = (await read()).lists.find((l) => l.name === "Groceries")!;
    const apples = g.items.find((i) => i.summary === "Apples")!;
    await tap("todo.groceries", "complete", { item: apples.uid });
    g = (await read()).lists.find((l) => l.name === "Groceries")!;
    expect(g.items.find((i) => i.uid === apples.uid)!.done).toBe(true);
    await tap("todo.groceries", "reopen", { item: apples.uid });
    await tap("todo.groceries", "remove", { item: apples.uid });
    g = (await read()).lists.find((l) => l.name === "Groceries")!;
    expect(g.items.some((i) => i.uid === apples.uid)).toBe(false);
    await expect(tap("todo.groceries", "add", { value: " " })).rejects.toThrow(/What to add/);
  });

  it("locks, opens the garage and turns the alarm on and off with its code; refuses anything else", async () => {
    const { tap } = setup();
    expect((await tap("lock.front_door", "unlock")).state).toBe("unlocked");
    expect((await tap("lock.front_door", "lock")).state).toBe("locked");
    expect((await tap("cover.garage_door", "open")).state).toBe("open");
    expect((await tap("cover.garage_door", "close")).state).toBe("closed");
    await expect(
      tap("alarm_control_panel.home_alarm", "arm_away", { code: "0000" }),
    ).rejects.toThrow(/did not do it/);
    expect((await tap("alarm_control_panel.home_alarm", "arm_away", { code: "1234" })).state).toBe(
      "armed_away",
    );
    // Opening the house needs the PIN (checked before this, by the caller).
    expect(NEEDS_PIN.has("lock.unlock")).toBe(true);
    expect(NEEDS_PIN.has("cover.open")).toBe(true);
    expect(NEEDS_PIN.has("alarm_control_panel.disarm")).toBe(true);
    expect(NEEDS_PIN.has("lock.lock")).toBe(false);
    // Nothing outside the list: no automations, no arbitrary services, no other covers.
    await expect(tap("automation.vacation_mode", "turn_off")).rejects.toThrow(/does not do that/);
    await expect(tap("light.kitchen", "delete")).rejects.toThrow(/does not do that/);
    await expect(tap("lock.front_door", "open")).rejects.toThrow(/does not do that/);
    await expect(tap("light.nope", "toggle")).rejects.toThrow(/does not have that/);
  });

  it("serves a speaker's artwork and a camera's picture, only through Home Assistant", async () => {
    const { ha } = setup();
    const art = await homePicture(ha.fetch, BASE, TOKEN, "media_player.kitchen_speaker");
    expect(art?.type).toBe("image/png");
    expect(
      (await homePicture(ha.fetch, BASE, TOKEN, "camera.front_porch"))?.body.length,
    ).toBeGreaterThan(0);
    expect(await homePicture(ha.fetch, BASE, TOKEN, "lock.front_door")).toBeUndefined();
  });

  it("adds Music Assistant: its address, then the owner's Music Assistant sign-in as the code", async () => {
    const { ha, read } = setup();
    const wrong = await connectMusicAssistant(ha.fetch, ha.socket, BASE, TOKEN, {
      address: "http://localhost",
      token: "ma-session",
    });
    expect(wrong).toMatchObject({ type: "form", errors: { base: "cannot_connect" } });
    const done = await connectMusicAssistant(ha.fetch, ha.socket, BASE, TOKEN, {
      address: "http://192.168.1.50:8095",
      token: "ma-session",
    });
    expect(done).toMatchObject({ type: "done", title: "Music Assistant" });
    expect((await read()).music.map((m) => m.name)).toContain("Kitchen speaker");
  });

  it("the music library: shelves, search, play and start a mix on a Music Assistant speaker", async () => {
    const { ha, read } = setup();
    await expect(musicLibrary(ha.fetch, BASE, TOKEN, "playlist")).rejects.toThrow(
      /isn't in Home Assistant yet/,
    );
    await connectMusicAssistant(ha.fetch, ha.socket, BASE, TOKEN, {
      address: "http://192.168.1.50:8095",
      token: "ma-session",
    });
    const speaker = (await read()).music.find(
      (m) => m.entity === "media_player.kitchen_speaker_ma",
    );
    expect(speaker?.musicAssistant).toBe(true);
    expect(
      (await read()).music.find((m) => m.entity === "media_player.kitchen_speaker")?.musicAssistant,
    ).toBeUndefined();

    const lists = await musicLibrary(ha.fetch, BASE, TOKEN, "playlist");
    expect(lists.map((l) => l.name)).toEqual(["Road Trip", "Late Night"]);
    const found = await musicSearch(ha.fetch, BASE, TOKEN, "sadness");
    expect(found.tracks).toEqual([
      expect.objectContaining({
        name: "Summertime Sadness",
        by: "Lana Del Rey",
        kind: "track",
        uri: "ytmusic://track/t1",
      }),
    ]);
    expect(
      await musicPlay(ha.fetch, BASE, TOKEN, {
        entity: "media_player.kitchen_speaker_ma",
        uri: "ytmusic://track/t1",
        kind: "track",
        how: "mix",
      }),
    ).toEqual({ done: "Mix started" });
    expect(
      (await read()).music.find((m) => m.entity === "media_player.kitchen_speaker_ma"),
    ).toMatchObject({ state: "playing", title: "Summertime Sadness" });
    await expect(
      musicPlay(ha.fetch, BASE, TOKEN, {
        entity: "media_player.kitchen_speaker_ma",
        uri: "javascript:alert(1)",
        kind: "track",
        how: "play",
      }),
    ).rejects.toThrow(/can play/);
  });

  it("a sign-in thrown away: Connect reloads Google to ask afresh, and never says Connected while it isn't (11-18)", async () => {
    connectTiming.verifyTries = 2;
    connectTiming.verifyGapMs = 1;
    const { ha, read } = setup();
    ha.home({ googleSignInLost: true });
    const before = await read();
    expect(before.calendarsDown).toBe(1);
    expect(before.signInAgain).toBeUndefined();
    expect(before.calendarsDownFor).toEqual([
      { handler: "google", label: "Google Calendar", for: "calendar" },
    ]);
    expect(before.homeAddress).toBe(BASE.replace(/\/+$/, ""));
    // Finishing a setup that is gone does not read as done while the calendar is still down.
    const gone = await connectNext(ha.fetch, ha.socket, BASE, TOKEN, "google", "goneflow0001", {});
    expect(gone.type).toBe("stopped");
    expect(gone.reason).toContain("didn't take");
    // Connect: Home Assistant asks again (as its own Reload does), straight to Google's page.
    const step = await connectStart(ha.fetch, ha.socket, BASE, TOKEN, "google");
    expect(step).toMatchObject({ type: "external", renewing: true, flowId: "reauth00000002" });
    expect(step.homeAddress).toBe(BASE.replace(/\/+$/, ""));
    const done = await connectNext(ha.fetch, ha.socket, BASE, TOKEN, "google", step.flowId!, {
      code: "x",
    });
    expect(done.type).toBe("done");
    expect((await read()).calendarsDown).toBeUndefined();
  });

  it("says when Google needs a sign-in again, and Connect renews it instead of starting over (11-18)", async () => {
    const { ha, read } = setup();
    ha.home({ googleSignInAgain: true });
    const before = await read();
    expect(before.calendars).toEqual([]);
    expect(before.calendarsDown).toBe(1);
    expect(before.signInAgain).toEqual([
      { handler: "google", label: "Google Calendar", for: "calendar" },
    ]);
    // Connect goes on with Home Assistant's own waiting setup: straight to Google's sign-in page.
    const step = await connectStart(ha.fetch, ha.socket, BASE, TOKEN, "google");
    expect(step).toMatchObject({ type: "external", renewing: true, flowId: "reauth00000001" });
    expect(step.url).toContain("accounts.google.com");
    const done = await connectNext(ha.fetch, ha.socket, BASE, TOKEN, "google", step.flowId!, {
      code: "x",
    });
    expect(done.type).toBe("done");
    const after = await read();
    expect(after.calendars.map((c) => c.entity)).toEqual(["calendar.family"]);
    expect(after.signInAgain).toBeUndefined();
    expect(after.calendarsDown).toBeUndefined();
    // A setup Home Assistant already finished on its own reads as done, not "Invalid flow".
    expect(
      (await connectNext(ha.fetch, ha.socket, BASE, TOKEN, "google", "goneflow0001", {})).type,
    ).toBe("done");
  });

  it("connects a list, CalDAV (saying when the password is wrong) and Spotify (an app first)", async () => {
    const { ha, read } = setup();
    const list = await connectStart(ha.fetch, ha.socket, BASE, TOKEN, "local_todo");
    expect(list.fields).toEqual([
      expect.objectContaining({ name: "todo_list_name", required: true }),
    ]);
    const made = await connectNext(ha.fetch, ha.socket, BASE, TOKEN, "local_todo", list.flowId!, {
      todo_list_name: "Hardware store",
    });
    expect(made).toMatchObject({ type: "done", title: "Hardware store" });
    expect((await read()).lists.map((l) => l.name)).toContain("Hardware store");

    const cal = await connectStart(ha.fetch, ha.socket, BASE, TOKEN, "caldav");
    expect(cal.fields!.find((f) => f.name === "password")!.secret).toBe(true);
    const wrong = await connectNext(ha.fetch, ha.socket, BASE, TOKEN, "caldav", cal.flowId!, {
      url: "https://caldav.icloud.com",
      username: "me@example.com",
      password: "wrong",
    });
    expect(wrong.errors).toEqual({ base: "invalid_auth" });
    expect(
      await connectNext(ha.fetch, ha.socket, BASE, TOKEN, "caldav", cal.flowId!, {
        url: "https://caldav.icloud.com",
        username: "me@example.com",
        password: "app-specific-pass",
      }),
    ).toMatchObject({ type: "done" });

    const first = await connectStart(ha.fetch, ha.socket, BASE, TOKEN, "spotify");
    expect(first).toMatchObject({ type: "stopped", reason: "missing_credentials" });
    await addAppCredentials(ha.socket, BASE, TOKEN, "spotify", "client-id", "client-secret");
    const signIn = await connectStart(ha.fetch, ha.socket, BASE, TOKEN, "spotify");
    expect(signIn).toMatchObject({ type: "external", url: expect.stringContaining("spotify.com") });
    expect(
      await connectNext(ha.fetch, ha.socket, BASE, TOKEN, "spotify", signIn.flowId!, {}),
    ).toMatchObject({
      type: "done",
    });
    expect((await read()).music.map((m) => m.name)).toContain("Spotify Alex");

    await expect(connectStart(ha.fetch, ha.socket, BASE, TOKEN, "zwave_js")).rejects.toThrow(
      /does not connect that/,
    );
    await expect(addAppCredentials(ha.socket, BASE, TOKEN, "caldav", "a", "b")).rejects.toThrow(
      /does not need an app/,
    );
  });
});

describe("the Scenes widget's editor", () => {
  it("opens a script as devices, keeps the steps it doesn't edit, saves, adds and deletes", async () => {
    const { ha, read } = setup();
    const at = [ha.fetch, ha.socket, BASE, TOKEN] as const;

    const night = await sceneRead(...at, "script.goodnight");
    expect(night).toMatchObject({ name: "Goodnight", type: "script", editable: true });
    expect(night.items).toEqual([
      { kind: "device", ref: "0", entity: "light.living_room", on: false },
      {
        kind: "device",
        ref: "1",
        entity: "light.kitchen",
        on: true,
        brightness: 50,
        color: [255, 0, 0],
      },
    ]);
    expect(night.choices.map((c) => c.entity)).toEqual(
      expect.arrayContaining(["light.kitchen", "switch.server_fan"]),
    );

    // A step it doesn't edit is shown and kept as it was.
    const leaving = await sceneRead(...at, "script.leaving_home");
    expect(leaving.items[1]).toMatchObject({ kind: "other", ref: "1" });
    await sceneSave(...at, {
      entity: "script.leaving_home",
      name: "Leaving",
      items: [
        { ref: "1", keep: true },
        { entity: "light.kitchen", on: true, brightness: 30 },
      ],
    });
    const cfg = (await (
      await ha.fetch(`${BASE}/api/config/script/config/leaving_home`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(5000),
      })
    ).json()) as { alias: string; sequence: unknown[] };
    expect(cfg.alias).toBe("Leaving");
    expect(cfg.sequence).toEqual([
      { action: "lock.lock", target: { entity_id: "lock.front_door" } },
      {
        action: "light.turn_on",
        target: { entity_id: "light.kitchen" },
        data: { brightness_pct: 30 },
      },
    ]);

    // An unchanged device step is kept exactly; a changed one is rewritten.
    await sceneSave(...at, {
      entity: "script.goodnight",
      name: "Goodnight",
      items: [
        { ref: "0", entity: "light.living_room", on: true, brightness: 20 },
        { ref: "1", entity: "light.kitchen", on: true, brightness: 50, color: [255, 0, 0] },
      ],
    });
    const again = await sceneRead(...at, "script.goodnight");
    expect(again.items[0]).toMatchObject({ entity: "light.living_room", on: true, brightness: 20 });
    expect(again.items[1]).toMatchObject({ brightness: 50, color: [255, 0, 0] });

    // A new one is a script, then it can be deleted.
    const added = await sceneSave(...at, {
      name: "Reading time",
      items: [{ entity: "light.living_room", on: true, brightness: 80, color: [255, 200, 150] }],
    });
    expect(added).toEqual({ done: "Added", entity: "script.reading_time" });
    expect((await read()).scenes.map((x) => x.name)).toContain("Reading time");
    await sceneDelete(...at, "script.reading_time");
    expect((await read()).scenes.map((x) => x.name)).not.toContain("Reading time");

    // A Home Assistant scene: device states, the rest kept.
    const morning = await sceneRead(...at, "scene.good_morning");
    expect(morning.items).toEqual([
      { kind: "device", ref: "light.kitchen", entity: "light.kitchen", on: true, brightness: 100 },
      { kind: "other", ref: "cover.blinds", summary: "cover.blinds: open" },
    ]);

    // Refused: an unknown device, no name, nothing in it.
    await expect(
      sceneSave(...at, { name: "X", items: [{ entity: "lock.front_door", on: true }] }),
    ).rejects.toThrow(/no device/);
    await expect(
      sceneSave(...at, { name: " ", items: [{ entity: "light.kitchen", on: true }] }),
    ).rejects.toThrow(/name/);
    await expect(sceneSave(...at, { name: "X", items: [] })).rejects.toThrow(/at least one/);
  });
});

describe("a sign-in that ended on a page that can't be reached", () => {
  it("passes the code and check from the pasted address to Home Assistant, and refuses others", async () => {
    const { ha } = setup();
    await deliverSignInCallback(
      ha.fetch,
      BASE,
      "http://homeassistant.local:8123/auth/external/callback?code=abc123&state=eyJ0.x.y",
    );
    await expect(
      deliverSignInCallback(ha.fetch, BASE, "https://example.com/other?code=a&state=b"),
    ).rejects.toThrow(/auth\/external\/callback/);
    await expect(deliverSignInCallback(ha.fetch, BASE, "not an address")).rejects.toThrow(
      /isn't a web address/,
    );
    await expect(
      deliverSignInCallback(
        ha.fetch,
        BASE,
        "http://homeassistant.local:8123/auth/external/callback?error=access_denied&state=s",
      ),
    ).rejects.toThrow(/turned down/);
    await expect(
      deliverSignInCallback(
        ha.fetch,
        BASE,
        "http://homeassistant.local:8123/auth/external/callback?code=a&state=bad",
      ),
    ).rejects.toThrow(/didn't take it \(400\)/);
  });
});
