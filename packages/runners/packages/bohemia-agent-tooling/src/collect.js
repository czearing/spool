/**
 * Collection interface. A tool supplies the collectors. The shared core never knows what is measured.
 *
 * A collector is { name, collect } where collect returns one observation or an array of them.
 * An observation must carry the five values a task issue is allowed to say and nothing else.
 */

const REQUIRED_STRINGS = ["metric", "unit", "reproduction"];

export function assertObservation(observation) {
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("observation must be an object");
  }
  for (const key of REQUIRED_STRINGS) {
    if (typeof observation[key] !== "string" || observation[key].trim() === "") {
      throw new Error(`observation.${key} must be a non empty string`);
    }
  }
  for (const key of ["current", "target", "acceptance"]) {
    if (typeof observation[key] !== "number" || !Number.isFinite(observation[key])) {
      throw new Error(`observation.${key} must be a finite number`);
    }
  }
  return observation;
}

export function defineCollector({ name, collect }) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("collector requires a name");
  }
  if (typeof collect !== "function") {
    throw new Error(`collector "${name}" requires a collect function`);
  }
  return { name, collect };
}

/**
 * Runs every collector. A collector that throws is reported as a failure and never becomes a task,
 * because a task without a current number is never written.
 */
export async function runCollection(collectors, context = {}) {
  if (!Array.isArray(collectors) || collectors.length === 0) {
    throw new Error("collection requires at least one collector");
  }

  const observations = [];
  const failures = [];

  for (const collector of collectors) {
    try {
      const produced = await collector.collect(context);
      const list = Array.isArray(produced) ? produced : [produced];
      for (const observation of list) {
        observations.push(assertObservation({ ...observation, collector: collector.name }));
      }
    } catch (error) {
      failures.push({ collector: collector.name, error: error.message });
    }
  }

  return { observations, failures };
}
