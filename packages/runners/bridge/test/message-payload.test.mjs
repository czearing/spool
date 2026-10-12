import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { continuationMessage, messageByteLimit } from "../message-payload.mjs";
import { digest } from "../spool-files.mjs";

test("inline continuations preserve text up to the native UTF-8 byte limit", () => {
  const text = "\u00e9".repeat(messageByteLimit / 2);
  assert.equal(continuationMessage({}, text), text);
  assert.throws(() => continuationMessage({}, ""), /nonempty/);
  assert.throws(() => continuationMessage({}, null), /nonempty/);
});

test("oversized continuations retain every byte in immutable, retry-safe instruction files", t => {
  const records = mkdtempSync(path.join(tmpdir(), "spool-message-payload-"));
  t.after(() => rmSync(records, { recursive: true, force: true }));
  const prompt = "# PR update mode\n" + "\u00e9".repeat(messageByteLimit) + "\nFinal finding must not be lost.";
  const message = continuationMessage({ records }, prompt);
  assert.ok(Buffer.byteLength(message) <= messageByteLimit);
  const file = path.join(records, "message-prompts", `${digest(prompt)}.json`);
  assert.ok(message.includes(file));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, sha256: digest(prompt), prompt });
  assert.equal(continuationMessage({ records }, prompt), message);
  assert.equal(readdirSync(path.dirname(file)).length, 1);
  writeFileSync(file, JSON.stringify({ version: 1, sha256: digest(prompt), prompt: "Replaced instructions" }));
  assert.throws(() => continuationMessage({ records }, prompt), /do not match/);
});
