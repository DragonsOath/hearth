import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { PcLink } from "./hub";

/**
 * The live link to a PC: a forwarded socket's data that arrives after the browser's side closed
 * (or for a socket it never had) is dropped, never sent to nothing. That once took the whole
 * server down.
 */

function link() {
  const ws = Object.assign(new EventEmitter(), { send: () => undefined }) as unknown as WebSocket;
  new PcLink(
    "pc-1",
    ws,
    () => undefined,
    () => undefined,
  );
  return (m: unknown) => ws.emit("message", Buffer.from(JSON.stringify(m)));
}

describe("a PC's live link", () => {
  it("drops data for a forwarded socket it does not have", () => {
    const fromPc = link();
    expect(() => fromPc({ t: "ws-data", sid: 42, d: "late" })).not.toThrow();
    expect(() => fromPc({ t: "ws-data", sid: 42, d: "aGk=", bin: true })).not.toThrow();
    expect(() => fromPc({ t: "ws-close", sid: 42 })).not.toThrow();
  });
});
