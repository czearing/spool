import test from "node:test";
import assert from "node:assert/strict";
import { verifyEventWorkspace } from "../workflow-workspace.mjs";

const prepared = { ready: true, repoRoot: "C:\\Code\\1js\\software-engineer",
  branch: "user/calebzearing/library-backlog-12284752-12346412", commit: "a".repeat(40) };
const wsl = { kind: "wsl", distribution: "1js-linux", nativeRepoRoot: "/home/dev/1js-library/software-engineer" };
function execute(calls, dirty = false) {
  return async (command, args) => {
    calls.push({ command, args });
    return { stdout: args.includes("rev-parse") ? `${prepared.commit}\n` :
      args.includes("symbolic-ref") ? `${prepared.branch}\n` : dirty ? " M authored.ts\n" : "" };
  };
}
test("native Bohemia checkout verification retains its original Git calls", async () => {
  const calls = [];
  await verifyEventWorkspace(prepared, false, execute(calls));
  assert.ok(calls.every(call => call.command === "git" && call.args[0] === "-C" && call.args[1] === prepared.repoRoot));
  assert.equal(calls.length, 3);
  assert.ok(calls.some(call => call.args.includes("--untracked-files=no")));
});
test("WSL checkout verification runs Git inside the receipt's actual Linux distribution and root", async () => {
  const calls = [];
  await verifyEventWorkspace({ ...prepared, execution: wsl }, false, execute(calls));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.command === "wsl.exe"));
  assert.ok(calls.every(call => JSON.stringify(call.args.slice(0, 6)) ===
    JSON.stringify(["--distribution", "1js-linux", "--exec", "git", "-C", wsl.nativeRepoRoot])));
  assert.ok(calls.some(call => call.args.includes("--untracked-files=normal")));
});
test("WSL handoffs reject dirty work, changed branches, and changed heads", async () => {
  await assert.rejects(verifyEventWorkspace({ ...prepared, execution: wsl }, false, execute([], true)), /changed/);
  await assert.rejects(verifyEventWorkspace({ ...prepared, execution: wsl }, false,
    async () => ({ stdout: "other" })), /changed/);
});
test("creator continuation may retain authored changes but still verifies branch and commit", async () => {
  const calls = [];
  await verifyEventWorkspace({ ...prepared, execution: wsl }, true, execute(calls, true));
  assert.equal(calls.length, 2);
});
test("engineering Codespace handoffs verify the exact commit while allowing authored files", async () => {
  const engineering = { ...prepared, execution: { kind: "codespace", purpose: "engineering" } };
  let verified = false;
  await verifyEventWorkspace(engineering, true, async () => assert.fail("No host Git"), async (value, options) => {
    assert.equal(value, engineering);
    assert.deepEqual(options, { allowDirty: true });
    verified = true;
  });
  assert.equal(verified, true);
});
test("review Codespace handoffs still refuse mutation before invoking the verifier", async () => {
  await assert.rejects(verifyEventWorkspace({ ...prepared, execution: { kind: "codespace" } }, true,
    async () => assert.fail("No host Git"), async () => assert.fail("No mutable review")), /does not support mutation/);
});
for (const execution of [{ ...wsl, distribution: "--other" }, { ...wsl, nativeRepoRoot: "relative" },
  { ...wsl, nativeRepoRoot: "/home/dev\nother" }])
  test(`malformed WSL receipt scope is rejected: ${JSON.stringify(execution)}`, async () => {
    await assert.rejects(verifyEventWorkspace({ ...prepared, execution }, false,
      async () => assert.fail("Must not launch a command")), /Invalid prepared WSL/);
  });
