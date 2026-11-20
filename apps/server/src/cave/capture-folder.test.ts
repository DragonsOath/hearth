import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureName, cleanFolder, readyFolder, saveCapture } from "./capture-folder";

describe("the screen captures' folder", () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const temp = async () => {
    const d = await mkdtemp(path.join(tmpdir(), "hearth-cap-"));
    made.push(d);
    return d;
  };

  it("takes a whole path on Linux and Windows, and refuses a partial one", () => {
    expect(cleanFolder("  /home/you/Pictures/Hearth/ ", "linux")).toBe(
      "/home/you/Pictures/Hearth/",
    );
    expect(cleanFolder('"D:\\Pictures\\Hearth"', "win32")).toBe("D:\\Pictures\\Hearth");
    expect(() => cleanFolder("Pictures/Hearth", "linux")).toThrow(/starting with \//);
    expect(() => cleanFolder("Pictures\\Hearth", "win32")).toThrow(/drive/);
    expect(() => cleanFolder("", "linux")).toThrow(/Type a folder/);
    expect(() => cleanFolder("/a\u0000b", "linux")).toThrow(/character/);
  });

  it("makes the folder, and refuses a file", async () => {
    const d = await temp();
    await readyFolder(path.join(d, "new", "deeper"));
    const f = path.join(d, "a-file");
    await writeFile(f, "x");
    await expect(readyFolder(f)).rejects.toThrow();
  });

  it("names each capture itself and never writes over one", async () => {
    const d = await temp();
    const at = new Date("2026-11-18T10:44:05Z");
    expect(captureName(at)).toBe("hearth-capture-2026-11-18-10-44-05.png");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const a = await saveCapture(d, png, at);
    const b = await saveCapture(d, Buffer.from([...png, 2]), at);
    expect(path.dirname(a)).toBe(d);
    expect(path.basename(b)).toBe("hearth-capture-2026-11-18-10-44-05-1.png");
    expect((await readdir(d)).sort()).toHaveLength(2);
    expect((await readFile(a)).length).toBe(9);
  });
});
