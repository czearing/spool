/**
 * Run a child process and never lose the reason it failed.
 *
 * spawnSync reports two completely different outcomes through the same object, and the
 * difference decides what a caller should do:
 *
 *   - `result.error` set means the process returned NO verdict. It timed out, or it could not
 *     be spawned at all. `status` is null, `stderr` is usually empty, and nothing has been
 *     learned about the work. Asking again is the only way to learn anything.
 *   - a non-zero `result.status` IS a verdict. The command ran and rejected the request.
 *     Repeating it prints the same rejection again and buries the real message.
 *
 * Every call site here originally tested `status !== 0` alone. That single mistake produced a
 * live evaluation failure reading `git fetch origin master --quiet failed in <path>: ` with
 * nothing after the colon: a stall set `error` and left `status` null and `stderr` empty, so
 * the guard fired with no reason to report. Two hundred lines of careful evidence gathering
 * are worthless when the one message an unattended operator sees is blank.
 *
 * Retries are opt in. A `git fetch` or a token request is cheap and idempotent and worth three
 * attempts; a 45 minute install is not something to start again blindly.
 *
 * No regular expressions are used anywhere in this package.
 */
import { spawnSync } from "node:child_process";

/** Block between attempts; every command here is run synchronously. */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Execute `command`, returning the successful spawnSync result.
 *
 * `describe` names the command in errors so a failure is readable without the caller having to
 * rebuild the string. `attempts` above one retries ONLY a no-verdict failure.
 */
export function runCommand(command, args, options = {}) {
  const {
    run = spawnSync,
    attempts = 1,
    wait = sleepSync,
    backoffMs = 5_000,
    describe = `${command} ${(args || []).join(" ")}`.trim(),
    ...spawnOptions
  } = options;

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = run(command, args, { encoding: "utf8", windowsHide: true, ...spawnOptions });
    if (result.error) {
      lastError = result.error;
      if (attempt < attempts) wait(attempt * backoffMs);
      continue;
    }
    if (result.status !== 0) {
      const said = (result.stderr || result.stdout || "").trim();
      throw new Error(`${describe} exited ${result.status}${said.length > 0 ? `: ${said}` : " with no output"}`);
    }
    return result;
  }
  // The reason is always named. A stall that reports nothing is indistinguishable from a bug.
  throw new Error(
    `${describe} did not complete after ${attempts} attempt(s): ${(lastError && lastError.message) || "unknown"}`
  );
}
