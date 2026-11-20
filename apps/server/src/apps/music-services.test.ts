import { describe, expect, it } from "vitest";
import type { MaCall } from "./music-assistant-api";
import { musicServices, serviceStart, serviceStep, serviceSubmit, stepOf } from "./music-services";

// Add a music service (11-05): Music Assistant's services, popular first, its own setup steps
// read as forms, sign-in pages and progress; secrets never sent back into a form.

const MANIFESTS = [
  { type: "music", domain: "builtin", name: "Music Assistant", builtin: true, stage: "stable" },
  { type: "music", domain: "test", name: "Test", stage: "alpha" },
  { type: "player", domain: "chromecast", name: "Chromecast", stage: "stable" },
  { type: "music", domain: "somafm", name: "SomaFM Radio", stage: "stable" },
  {
    type: "music",
    domain: "plex",
    name: "Plex Media Server Library",
    stage: "beta",
    multi_instance: true,
  },
  { type: "music", domain: "spotify", name: "Spotify", stage: "stable", multi_instance: true },
  { type: "music", domain: "ytmusic", name: "YouTube Music", stage: "beta", multi_instance: true },
  { type: "music", domain: "audible", name: "Audible", stage: "stable" },
];

function fakeCall(): { call: MaCall; calls: { command: string; args: Record<string, unknown> }[] } {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const call = (async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "providers/manifests") return MANIFESTS;
    if (command === "config/providers") return [{ domain: "ytmusic", instance_id: "ytmusic--a" }];
    if (command === "config/providers/setup")
      return {
        flow_id: "flow-1",
        step_id: "authenticate",
        type: "external",
        url: "https://accounts.spotify.com/authorize?x=1",
        entries: [],
      };
    if (command === "config/flows/get")
      return { flow_id: "flow-1", step_id: "playback_backend", type: "form", entries: [] };
    if (command === "config/flows/submit")
      return { flow_id: "flow-1", step_id: "done", type: "finish" };
    throw new Error(command);
  }) as MaCall;
  return { call, calls };
}

describe("adding a music service", () => {
  it("lists Music Assistant's music services, popular first, added ones marked", async () => {
    const list = await musicServices(fakeCall().call);
    expect(list.map((s) => s.domain)).toEqual(["spotify", "ytmusic", "plex", "audible", "somafm"]);
    expect(list.find((s) => s.domain === "ytmusic")).toMatchObject({ added: true, more: true });
    expect(list.find((s) => s.domain === "plex")).toMatchObject({
      name: "Plex",
      kind: "library",
      beta: true,
    });
    expect(list.find((s) => s.domain === "somafm")!.kind).toBe("radio");
    expect(list.find((s) => s.domain === "audible")!.kind).toBe("audiobooks");
  });

  it("reads a form: its fields, choices and errors, and never a stored secret", () => {
    const s = stepOf({
      flow_id: "f",
      step_id: "credentials",
      type: "form",
      entries: [
        { key: "username", type: "string", label: "Username", required: true, value: "alex" },
        {
          key: "password",
          type: "secure_string",
          label: "Password",
          required: true,
          value: "kept",
        },
        {
          key: "quality",
          type: "string",
          options: [{ title: "High", value: "high" }],
          default_value: "high",
        },
        { key: "lossless", type: "boolean", label: "Lossless", default_value: false },
        { key: "help", type: "label", label: "Sign in with your account." },
        { key: "internal", type: "string", hidden: true },
      ],
      errors: { base: "invalid_auth" },
    });
    expect(s.fields).toEqual([
      { key: "username", type: "text", label: "Username", required: true, value: "alex" },
      { key: "password", type: "secret", label: "Password", required: true },
      {
        key: "quality",
        type: "choice",
        label: "Quality",
        required: false,
        value: "high",
        options: [{ title: "High", value: "high" }],
      },
      { key: "lossless", type: "boolean", label: "Lossless", required: false, value: false },
      { key: "help", type: "note", label: "Sign in with your account.", required: false },
    ]);
    expect(s.errors).toEqual({ base: "Invalid auth" });
    expect(stepOf({ type: "weird" }).type).toBe("abort");
    expect(stepOf({ type: "external", url: "javascript:alert(1)" }).url).toBeUndefined();
  });

  it("starts a setup, follows it after the sign-in page, and answers its form", async () => {
    const { call, calls } = fakeCall();
    const first = await serviceStart(call, "spotify");
    expect(first).toMatchObject({
      flowId: "flow-1",
      type: "external",
      url: "https://accounts.spotify.com/authorize?x=1",
    });
    expect((await serviceStep(call, "flow-1")).stepId).toBe("playback_backend");
    expect((await serviceSubmit(call, "flow-1", { backend: "librespot" })).type).toBe("finish");
    expect(calls.find((c) => c.command === "config/flows/submit")!.args).toEqual({
      flow_id: "flow-1",
      values: { backend: "librespot" },
    });
    await expect(serviceStart(call, "../etc")).rejects.toThrow(/Not a music service/);
    await expect(serviceStep(call, "bad id!")).rejects.toThrow(/Not a setup/);
  });
});
