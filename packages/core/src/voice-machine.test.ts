import { describe, expect, it } from "vitest";
import { voiceLevel } from "./voice-machine";
import { ARCHETYPES, DEFAULT_VOICE_PROFILES } from "./voice";

const GB = 1024 ** 3;

describe("which machines can run the voices", () => {
  it("places a machine in one level, with what holds it back in plain words", () => {
    const base = { arch: "x64", cores: 8, memoryBytes: 16 * GB, freeDiskBytes: 200 * GB };
    expect(voiceLevel({ ...base, nvidiaMemoryBytes: 10 * GB }).level).toBe("best");
    const full = voiceLevel(base);
    expect(full.level).toBe("full");
    expect(full.short).toEqual(["no NVIDIA graphics card (it would make listening instant)"]);
    expect(full.found).toEqual(["8 processor cores", "16 GB of memory", "200 GB of free disk"]);

    // A small machine still speaks; it just cannot listen well.
    const small = voiceLevel({ ...base, cores: 2, memoryBytes: 4 * GB });
    expect(small.level).toBe("speak");
    expect(small.short).toEqual([
      "it has 2 processor cores (listening needs 4)",
      "it has 4 GB of memory (listening needs 8 GB)",
    ]);
    expect(small.summary).toBe("Speaking only: Ember can speak, and you type to it.");
    expect(voiceLevel({ ...base, freeDiskBytes: 1 * GB }).level).toBe("speak");

    expect(voiceLevel({ ...base, memoryBytes: 2 * GB }, "Ember")).toMatchObject({
      level: "none",
      summary: "No voice on this machine: Ember is typing only.",
    });
    expect(voiceLevel({ ...base, arch: "ia32" }).level).toBe("none");
  });

  it("counts an 8 GB machine as 8 GB, though it reports a little less", () => {
    expect(voiceLevel({ arch: "arm64", cores: 4, memoryBytes: 7.7 * GB }).level).toBe("full");
  });

  it("does not hold an unknown disk against the machine", () => {
    expect(voiceLevel({ arch: "x64", cores: 4, memoryBytes: 8 * GB }).level).toBe("full");
  });
});

describe("built-in voices and looks", () => {
  it("every built-in voice has a gender and a look of its own", () => {
    for (const p of DEFAULT_VOICE_PROFILES) {
      expect(p.gender, p.id).toBeTruthy();
      expect(p.avatar, p.id).toBeTruthy();
    }
    for (const a of ARCHETYPES) expect(a.looks).toHaveLength(5);
  });
});
