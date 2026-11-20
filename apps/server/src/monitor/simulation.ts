/**
 * Simulated conditions for sample-data services, so incidents can be seen
 * opening, being repaired, and closing without breaking anything real.
 * In memory only.
 *
 * - "down": fixed by a restart.
 * - "stuck": a restart does not help (practises the failure path).
 * - "slow": answers, slowly.
 * - "cascade": fails only because something it depends on is down; it
 *   recovers by itself once that is fixed, and restarting it does nothing.
 */
export type SimulatedCondition = "down" | "stuck" | "slow" | "cascade";

const conditions = new Map<string, SimulatedCondition>();
/** For "cascade": which dependency is the cause. */
const causes = new Map<string, string>();

export function simulatedCondition(serviceId: string): SimulatedCondition | undefined {
  return conditions.get(serviceId);
}

export function simulate(
  serviceId: string,
  condition: SimulatedCondition | "normal",
  causedBy?: string,
) {
  causes.delete(serviceId);
  if (condition === "normal") conditions.delete(serviceId);
  else conditions.set(serviceId, condition);
  if (condition === "cascade" && causedBy) causes.set(serviceId, causedBy);
}

/** Is a cascading failure still caused? Clears it once the cause is fixed. */
export function cascadeActive(serviceId: string): boolean {
  const cause = causes.get(serviceId);
  const active = cause !== undefined && ["down", "stuck"].includes(conditions.get(cause) ?? "");
  if (!active) simulate(serviceId, "normal");
  return active;
}

/** What a restart does to a sample service: it clears "down" and "slow" only. */
export function simulateRestart(serviceId: string) {
  const c = conditions.get(serviceId);
  if (c === "down" || c === "slow") conditions.delete(serviceId);
}

export function simulatedServices(): string[] {
  return [...conditions.keys()];
}

export function clearSimulations() {
  conditions.clear();
  causes.clear();
}
