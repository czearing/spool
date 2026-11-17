import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function nativeControlTestBinary({ env = process.env, moduleUrl = import.meta.url } = {}) {
  if (env.SPOOL_CONTROL_TEST_BINARY) return env.SPOOL_CONTROL_TEST_BINARY;
  for (const directory of [
    env.CARGO_TARGET_DIR && path.join(env.CARGO_TARGET_DIR, "debug", "deps"),
    fileURLToPath(new URL("../../../spool-desktop/target/debug/deps/", moduleUrl)),
    fileURLToPath(new URL("../../../../target/debug/deps/", moduleUrl)),
  ]) {
    if (!directory || !existsSync(directory)) continue;
    const candidates = readdirSync(directory).filter(name =>
      process.platform === "win32" ? /^spool-[a-f0-9]+\.exe$/.test(name) : /^spool-[a-f0-9]+$/.test(name))
      .map(name => path.join(directory, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  }
  throw new Error("Build native Spool tests with cargo test --no-run, or set SPOOL_CONTROL_TEST_BINARY");
}

let binary;
function execute(root) {
  binary ||= nativeControlTestBinary();
  const result = spawnSync(binary, ["engine::prepared_message::tests::process_fixture_requests",
    "--ignored", "--exact", "--nocapture"], {
    env: { ...process.env, SPOOL_CONTROL_FIXTURE_ROOT: root, SPOOL_INTERACTIVE_ACP: "1" },
    windowsHide: true, encoding: "utf8", timeout: 15000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.includes("1 passed")) {
    throw new Error(`Native control fixture failed: ${result.stdout}\n${result.stderr}`);
  }
  const capabilityFile = path.join(root, "controls", "capabilities.json");
  const capability = JSON.parse(readFileSync(capabilityFile, "utf8"));
  writeFileSync(capabilityFile, JSON.stringify({ ...capability, updatedAt: new Date().toISOString() }));
}

export function nativeControls(t, root) {
  writeFileSync(path.join(root, "native-control-fixture"), "Isolated test; never launch providers");
  rmSync(path.join(root, "controls", "capabilities.json"), { force: true });
  execute(root);
  let failure;
  const clock = setInterval(() => {
    if (failure || !readdirSync(path.join(root, "controls", "requests")).some(name => name.endsWith(".json"))) return;
    try { execute(root); } catch (error) { failure = error; }
  }, 20);
  t.after(() => { clearInterval(clock); if (failure) throw failure; });
  return () => execute(root);
}
