import { describe, expect, it } from "vitest";
import { newSigningKey } from "../../../apps/server/src/premium/license";
import { handle, memoryStore, type Picture, type SendResult } from "./licence";

const START = Date.parse("2026-12-01T18:00:00Z");
const service = newSigningKey();
const env = {
  SIGNING_KEY: service.privatePem,
  OWNER_KEY: "",
  GITHUB_CLIENT_ID: "c",
  GITHUB_CLIENT_SECRET: "s",
  OWNER_GITHUB_ID: "1",
  SESSION_KEY: "k",
  SITE_ORIGIN: "https://site.test",
};
const PIC: Picture = { type: "image/webp", data: new Uint8Array([1, 2, 3]).buffer };

async function signedIn() {
  const { createHmac } = await import("node:crypto");
  const exp = String(START + 3_600_000);
  const sig = createHmac("sha256", "k").update(`1.${exp}`).digest("base64url");
  return `__Host-hearth-owner=1.${exp}.${sig}`;
}

describe("Send with Ember on the owner's code page", () => {
  it("DMs a code just made, with Premium Ember, and says plainly when it couldn't", async () => {
    const store = memoryStore();
    const asked: { to: string; code: string; months: number | null; picture?: Picture | null }[] =
      [];
    let answer: SendResult = { status: "sent", name: "Sam" };
    const ember = {
      async sendFounderCode() {
        return { sent: true };
      },
      async sendCode(a: {
        to: string;
        code: string;
        months: number | null;
        picture?: Picture | null;
      }) {
        asked.push(a);
        return answer;
      },
    };
    const cookie = await signedIn();
    const call = (path: string, body: unknown) =>
      handle(
        new Request(`https://site.test/codes/api/${path}`, {
          method: "POST",
          headers: { cookie, "x-hearth-owner": "1", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        store,
        () => START,
        fetch,
        { ember, premiumEmber: async () => PIC },
      );
    const camp = (await (
      await call("campaign", { name: "Gifts", months: 3, cap: null })
    ).json()) as {
      id: string;
    };
    const made = (await (await call("give", { campaignId: camp.id, note: "" })).json()) as {
      code: string;
    };

    const ok = await call("send", { code: made.code, to: "@sam" });
    expect(await ok.json()).toEqual({ status: "sent", name: "Sam" });
    expect(asked[0]).toMatchObject({ to: "@sam", code: made.code, months: 3 });
    expect(asked[0]!.picture).toBe(PIC);
    // The code now says who it went to.
    expect((await store.codes())[0]!.note).toBe("Discord Sam");

    answer = { status: "dm-closed", name: "Sam" };
    expect(await (await call("send", { code: made.code, to: "sam" })).json()).toEqual(answer);
    answer = { status: "ambiguous", names: ["Sam (@sam1)", "Sam (@sam2)"] };
    expect(
      ((await (await call("send", { code: made.code, to: "sam" })).json()) as SendResult).status,
    ).toBe("ambiguous");

    // Only a real, unused code; and a name is needed.
    expect((await call("send", { code: "HRTH-AAAAA-BBBBB-CCCCC", to: "sam" })).status).toBe(409);
    expect((await call("send", { code: made.code, to: " " })).status).toBe(400);
  });

  it("says Ember Bot couldn't be reached, and sends nothing, when the binding fails", async () => {
    const store = memoryStore();
    const ember = {
      async sendFounderCode() {
        return { sent: true };
      },
      async sendCode(): Promise<SendResult> {
        throw new Error("down");
      },
    };
    const cookie = await signedIn();
    const call = (path: string, body: unknown) =>
      handle(
        new Request(`https://site.test/codes/api/${path}`, {
          method: "POST",
          headers: { cookie, "x-hearth-owner": "1", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        store,
        () => START,
        fetch,
        { ember },
      );
    const camp = (await (
      await call("campaign", { name: "Gifts", months: null, cap: null })
    ).json()) as {
      id: string;
    };
    const made = (await (await call("give", { campaignId: camp.id })).json()) as { code: string };
    const r = await call("send", { code: made.code, to: "sam" });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toContain("Nothing was sent");
  });
});
