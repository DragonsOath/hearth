import { createPrivateKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newSigningKey, readLicense } from "../../../apps/server/src/premium/license";
import { codeHash, handle, memoryStore, ownerMessage, servicePublicKey } from "./licence";

const service = newSigningKey();
const owner = newSigningKey();
const env = { SIGNING_KEY: service.privatePem, OWNER_KEY: owner.publicKey };
const OLD = "a1b2c3d4-0000-4000-8000-000000000001";
const NEW = "a1b2c3d4-0000-4000-8000-000000000002";
const THIRD = "a1b2c3d4-0000-4000-8000-000000000003";
const CODE = "HRTH-ABCDE-FGHJK-MNPQR-STVWX";

let now = Date.parse("2026-11-23T00:00:00Z");
const clock = () => now;
let n = 0;

const ownerReq = (body: Record<string, unknown>) => {
  const text = JSON.stringify({
    at: new Date(now).toISOString(),
    nonce: `nonce-${++n}-x`,
    ...body,
  });
  const sig = sign(null, ownerMessage(text), createPrivateKey(owner.privatePem)).toString(
    "base64url",
  );
  return new Request("https://l.test/v1/owner", {
    method: "POST",
    body: text,
    headers: { "x-hearth-signature": sig },
  });
};
const post = (path: string, body: unknown) =>
  new Request(`https://l.test${path}`, { method: "POST", body: JSON.stringify(body) });
const move = async (store: ReturnType<typeof memoryStore>, licence: string, install: string) => {
  const res = await handle(post("/v1/move", { licence, install }), env, store, clock);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const revoked = async (store: ReturnType<typeof memoryStore>) =>
  (
    (await (await handle(new Request("https://l.test/v1/revoked"), env, store, clock)).json()) as {
      revoked: string[];
    }
  ).revoked;

/** A code redeemed on the old Hearth: its licence, as the old Hearth's blueprint holds it. */
async function redeemed(days?: number) {
  now += 86_400_000;
  const store = memoryStore();
  await handle(
    ownerReq({
      op: "code",
      code: {
        id: "code-0001",
        hash: await codeHash(CODE),
        features: ["ember_show_and_tell", "panel_builder"],
        maxUses: 1,
        ...(days ? { days } : {}),
        label: "Founder",
      },
    }),
    env,
    store,
    clock,
  );
  const res = await handle(post("/v1/redeem", { code: CODE, install: OLD }), env, store, clock);
  const { licence, licenceId } = (await res.json()) as { licence: string; licenceId: string };
  return { store, licence, licenceId };
}

describe("Premium moving to a new Hearth", () => {
  it("gives the new Hearth the same Premium and takes it back from the old one", async () => {
    const { store, licence, licenceId } = await redeemed(365);
    const r = await move(store, licence, NEW);
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(true);
    const trusted = { [service.keyId]: await servicePublicKey(service.privatePem) };
    const before = readLicense(licence, trusted);
    const after = readLicense(r.body.licence as string, trusted);
    expect(after).toMatchObject({
      install: NEW,
      features: before.features,
      start: before.start,
      end: before.end,
      label: "Founder",
    });
    expect(after.id).not.toBe(licenceId);
    expect(await revoked(store)).toEqual([licenceId]);
  });

  it("answers the same when asked again, and follows an older blueprint to where Premium went", async () => {
    const { store, licence } = await redeemed();
    const first = await move(store, licence, NEW);
    const again = await move(store, licence, NEW);
    expect(again.body.licence).toBe(first.body.licence);
    // A blueprint written before the move, restored on a third Hearth: Premium follows.
    const third = await move(store, licence, THIRD);
    expect(third.status).toBe(200);
    const live = await revoked(store);
    expect(live).toContain(first.body.licenceId);
    expect(live).not.toContain(third.body.licenceId);
  });

  it("leaves a licence already for this Hearth as it is", async () => {
    const { store, licence } = await redeemed();
    const r = await move(store, licence, OLD);
    expect(r.body).toMatchObject({ moved: false, licence });
    expect(await revoked(store)).toEqual([]);
  });

  it("moves at most three times a year", async () => {
    const { store, licence } = await redeemed();
    let held = licence;
    for (const [i, to] of [NEW, THIRD, OLD].entries()) {
      const r = await move(store, held, to);
      expect(r.status, `move ${i + 1}`).toBe(200);
      held = r.body.licence as string;
    }
    const fourth = await move(store, held, "a1b2c3d4-0000-4000-8000-000000000004");
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toMatch(/3 times this year/);
    now += 366 * 86_400_000;
    expect((await move(store, held, "a1b2c3d4-0000-4000-8000-000000000004")).status).toBe(200);
  });

  it("refuses a forged, ended or taken-back licence", async () => {
    const { store, licence, licenceId } = await redeemed(30);
    const stranger = newSigningKey();
    const forged = licence.split(".");
    forged[2] = sign(
      null,
      Buffer.from(`${forged[0]}.${forged[1]}`),
      createPrivateKey(stranger.privatePem),
    ).toString("base64url");
    expect((await move(store, forged.join("."), NEW)).status).toBe(403);
    await handle(ownerReq({ op: "revoke", ids: [licenceId] }), env, store, clock);
    expect((await move(store, licence, NEW)).body.error).toMatch(/taken back/);
    const ended = await redeemed(30);
    now += 31 * 86_400_000;
    expect((await move(ended.store, ended.licence, NEW)).body.error).toMatch(/ended/);
  });

  it("taking a code's Premium back reaches the Hearth it moved to; giving it back, only that one", async () => {
    const { store, licence, licenceId } = await redeemed();
    const moved = await move(store, licence, NEW);
    await handle(ownerReq({ op: "revoke-code", id: "code-0001" }), env, store, clock);
    expect((await revoked(store)).sort()).toEqual([licenceId, moved.body.licenceId].sort());
    await handle(ownerReq({ op: "unrevoke", id: licenceId }), env, store, clock);
    expect(await revoked(store)).toEqual([licenceId]);
  });
});
