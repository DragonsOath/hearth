import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { thisPcName } from "./member";

describe("this PC's name", () => {
  it("uses the name picked when linking, else your main Hearth's own name, else the computer's", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hearth-pcname-"));
    expect(thisPcName(dir)).toBe(hostname());
    mkdirSync(path.join(dir, "pc-icons"));
    writeFileSync(path.join(dir, "pc-icons", "hub.json"), JSON.stringify({ name: "Homeserver" }));
    expect(thisPcName(dir)).toBe("Homeserver");
    writeFileSync(path.join(dir, "this-pc.json"), JSON.stringify({ name: "Desktop-PC" }));
    expect(thisPcName(dir)).toBe("Desktop-PC");
  });
});
