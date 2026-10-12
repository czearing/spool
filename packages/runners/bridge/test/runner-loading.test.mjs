import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("shared runner startup does not load unrelated spelling engines", () => {
  const entry = new URL("../run.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(name, context, next) {
      if (/^(?:typescript|cspell-lib|harper\\.js)(?:\\/|$)/.test(name))
        throw new Error("Unrelated spelling dependency loaded: " + name);
      return next(name, context);
    } });
    await import(${JSON.stringify(entry)});
  `], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
