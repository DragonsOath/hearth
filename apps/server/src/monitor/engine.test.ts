import { describe, expect, it } from "vitest";
import { checkService, evaluate, type CheckOutcome, type PriorState } from "./engine";
import { parseContainer } from "./probes";

const ok: CheckOutcome = { status: "ok", detail: "is responding" };
const fail: CheckOutcome = {
  status: "failing",
  detail: "stopped responding",
  problem: "stopped responding",
};
const slow: CheckOutcome = { status: "slow", detail: "is answering slowly" };

/** Feeds a sequence of outcomes through evaluate and returns the transitions. */
function run(outcomes: CheckOutcome[], threshold = 2) {
  let prior: PriorState | undefined;
  return outcomes.map((o) => {
    const { next, transition } = evaluate(prior, o, threshold);
    prior = next;
    return transition;
  });
}

describe("evaluate (debouncing)", () => {
  it("ignores a single blip", () => {
    expect(run([ok, fail, ok])).toEqual(["steady", "first-failure", "blip-cleared"]);
  });

  it("confirms on the threshold, then keeps failing quietly, then recovers", () => {
    expect(run([fail, fail, fail, fail, ok, ok])).toEqual([
      "first-failure",
      "confirmed",
      "still-failing",
      "still-failing",
      "recovered",
      "steady",
    ]);
  });

  it("respects other thresholds, including 1 (alert immediately)", () => {
    expect(run([fail, fail, fail], 3)).toEqual(["first-failure", "still-unconfirmed", "confirmed"]);
    expect(run([fail, ok], 1)).toEqual(["confirmed", "recovered"]);
  });

  it("treats slow as not failing", () => {
    expect(run([fail, slow, fail, fail])).toEqual([
      "first-failure",
      "blip-cleared",
      "first-failure",
      "confirmed",
    ]);
  });

  it("counts consecutive failures correctly", () => {
    let prior: PriorState | undefined;
    for (let i = 1; i <= 5; i++) prior = evaluate(prior, fail, 2).next;
    expect(prior).toEqual({ status: "failing", consecutiveFailures: 5 });
    expect(evaluate(prior, ok, 2).next).toEqual({ status: "ok", consecutiveFailures: 0 });
  });
});

describe("parseContainer", () => {
  it("reads Docker's status line", () => {
    expect(parseContainer({ State: "running", Status: "Up 2 weeks (healthy)" })).toEqual({
      state: "running",
      health: "healthy",
    });
    expect(parseContainer({ State: "running", Status: "Up 3 minutes (unhealthy)" })).toEqual({
      state: "running",
      health: "unhealthy",
    });
    expect(parseContainer({ State: "running", Status: "Up 5 seconds (health: starting)" })).toEqual(
      { state: "running", health: "starting" },
    );
    expect(parseContainer({ State: "exited", Status: "Exited (143) 4 weeks ago" })).toEqual({
      state: "stopped",
      health: undefined,
      exitCode: 143,
    });
  });
});

describe("a stopped container", () => {
  const service = {
    id: "kometa",
    name: "Kometa",
    checkTarget: "container:kometa",
    localUrl: null,
  } as unknown as Parameters<typeof checkService>[0];
  const probes = {} as Parameters<typeof checkService>[1];
  const stopped = (exitCode: number) =>
    new Map([["kometa", { state: "stopped" as const, exitCode }]]);

  it("that shut down cleanly is a question, not a failure to repair", async () => {
    for (const code of [0, 143]) {
      expect(await checkService(service, probes, stopped(code))).toMatchObject({
        status: "failing",
        code: "stopped-on-purpose",
        problem: "was stopped (not a crash)",
      });
    }
  });

  it("that crashed or was killed is still a failure", async () => {
    for (const code of [1, 137, 139]) {
      expect(await checkService(service, probes, stopped(code))).toMatchObject({
        code: "not-running",
      });
    }
  });
});
