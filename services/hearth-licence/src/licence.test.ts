import { createPrivateKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newSigningKey, readLicense } from "../../../apps/server/src/premium/license";
import { codeHash, handle, memoryStore, ownerMessage, servicePublicKey } from "./licence";

const service = newSigningKey();
const owner = newSigningKey();
const env = { SIGNING_KEY: service.privatePem, OWNER_KEY: owner.publicKey };
const INSTALL = "a1b2c3d4-0000-4000-8000-000000000001";
const OTHER = "a1b2c3d4-0000-4000-8000-000000000002";
const CODE = "HRTH-ABCDE-FGHJK-MNPQR-STVWX";

let now = Date.parse("2026-11-10T00:00:00Z");
const clock = () => now;
let n = 0;

const ownerReq = (body: Record<string, unknown>, key = owner.privatePem) => {
  const text = JSON.stringify({
    at: new Date(now).toISOString(),
    nonce: `nonce-${++n}-x`,
    ...body,
  });
  const sig = sign(null, ownerMessage(text), createPrivateKey(key)).toString("base64url");
  return new Request("https://l.test/v1/owner", {
    method: "POST",
    body: text,
    headers: { "x-hearth-signature": sig },
  });
};
const redeemReq = (code: string, install: string) =>
  new Request("https://l.test/v1/redeem", {
    method: "POST",
    body: JSON.stringify({ code, install }),
  });

async function setup(maxUses = 3) {
  const store = memoryStore();
  const res = await handle(
    ownerReq({
      op: "code",
      code: {
        id: "code-0001",
        hash: await codeHash(CODE),
        features: ["ember_show_and_tell"],
        maxUses,
        days: 30,
        label: "Launch week",
      },
    }),
    env,
    store,
    clock,
  );
  expect(res.status).toBe(200);
  return store;
}

describe("Hearth's licence service", () => {
  it("redeems a code into a licence Hearth accepts, for that installation only", async () => {
    const store = await setup();
    // Typed loosely: lower case and spaces still match.
    const res = await handle(redeemReq("hrth abcde fghjk mnpqr stvwx", INSTALL), env, store, clock);
    expect(res.status).toBe(200);
    const { licence } = (await res.json()) as { licence: string };
    const trusted = { [service.keyId]: await servicePublicKey(service.privatePem) };
    const p = readLicense(licence, trusted);
    expect(p).toMatchObject({
      install: INSTALL,
      features: ["ember_show_and_tell"],
      kind: "complimentary",
      label: "Launch week",
      key: service.keyId,
    });
    expect(Date.parse(p.end!) - Date.parse(p.start)).toBe(30 * 86_400_000);
    // Once per installation.
    const again = await handle(redeemReq(CODE, INSTALL), env, store, clock);
    expect(again.status).toBe(409);
    expect(store.all.codes.get("code-0001")!.uses).toBe(1);
  });

  it("never goes past a code's uses, however many redeem at once", async () => {
    const store = await setup(3);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        handle(redeemReq(CODE, `install-${String(i).padStart(4, "0")}-x`), env, store, clock),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(store.all.codes.get("code-0001")!.uses).toBe(3);
  });

  it("refuses a wrong code, a switched-off code, and too many tries", async () => {
    const store = await setup();
    expect(
      (await handle(redeemReq("HRTH-22222-22222-22222-22222", OTHER), env, store, clock)).status,
    ).toBe(404);
    expect(
      (
        await handle(
          ownerReq({ op: "code-active", id: "code-0001", active: false }),
          env,
          store,
          clock,
        )
      ).status,
    ).toBe(200);
    expect((await handle(redeemReq(CODE, INSTALL), env, store, clock)).status).toBe(409);
    for (let i = 0; i < 4; i++) await handle(redeemReq(CODE, OTHER), env, store, clock);
    expect((await handle(redeemReq(CODE, OTHER), env, store, clock)).status).toBe(429);
  });

  it("takes only owner-signed changes, fresh and once", async () => {
    const store = memoryStore();
    const stranger = newSigningKey();
    const forged = await handle(
      ownerReq({ op: "revoke", ids: ["licence-0001"] }, stranger.privatePem),
      env,
      store,
      clock,
    );
    expect(forged.status).toBe(403);
    const req = ownerReq({ op: "revoke", ids: ["licence-0001"] });
    const replay = req.clone();
    expect((await handle(req, env, store, clock)).status).toBe(200);
    expect((await handle(replay, env, store, clock)).status).toBe(409);
    const old = ownerReq({ op: "unrevoke", id: "licence-0001" });
    now += 10 * 60_000;
    expect((await handle(old, env, store, clock)).status).toBe(409);
    // No owner key set: every owner request is refused.
    const none = await handle(ownerReq({ op: "list" }), { ...env, OWNER_KEY: "" }, store, clock);
    expect(none.status).toBe(403);
  });

  it("counts a code's uses, and takes back every licence made from it", async () => {
    const store = await setup();
    await handle(redeemReq(CODE, INSTALL), env, store, clock);
    await handle(redeemReq(CODE, OTHER), env, store, clock);
    const uses = await handle(new Request("https://l.test/v1/codes/code-0001"), env, store, clock);
    expect(await uses.json()).toEqual({ uses: 2, maxUses: 3, active: true });
    const res = await handle(ownerReq({ op: "revoke-code", id: "code-0001" }), env, store, clock);
    expect(await res.json()).toMatchObject({ revoked: 2 });
    const list = await handle(new Request("https://l.test/v1/revoked"), env, store, clock);
    expect(((await list.json()) as { revoked: string[] }).revoked).toHaveLength(2);
  });

  it("tells every Hearth which licences were taken back", async () => {
    const store = memoryStore();
    await handle(
      ownerReq({ op: "revoke", ids: ["licence-0001", "licence-0002"] }),
      env,
      store,
      clock,
    );
    await handle(ownerReq({ op: "unrevoke", id: "licence-0002" }), env, store, clock);
    const res = await handle(new Request("https://l.test/v1/revoked"), env, store, clock);
    expect(((await res.json()) as { revoked: string[] }).revoked).toEqual(["licence-0001"]);
  });
});
