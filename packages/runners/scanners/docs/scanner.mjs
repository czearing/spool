import { buildCycleConfig } from "./config.js";
import { runDocsCycle } from "./cycle.js";
import { runTodoCycle } from "../lib/todo-cycle.mjs";

export function runScanner(options) {
  return runTodoCycle({ ...options, buildCycleConfig, runCycle: runDocsCycle });
}
