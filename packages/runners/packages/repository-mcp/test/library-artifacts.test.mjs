import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { refreshLibraryArtifacts } from "../src/adapters/library-artifacts.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "library-artifacts-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
function fixture() {
  const root = fs.mkdtempSync(path.join(scratch, "case-"));
  const profile = { repoRoot: root, workspaceRoot: path.join(root, "midgard"),
    stateRoot: path.join(root, "state") };
  const cwd = path.join(profile.workspaceRoot, "packages", "dependency");
  fs.mkdirSync(cwd, { recursive: true });
  const blobs = new Map([["a".repeat(40), { "lib/index.js": "before" }]]);
  let plan = [{ id: "dependency#build", cwd, hash: "a".repeat(40), task: "build" }];
  const requests = [];
  const deps = {
    plan: async () => structuredClone(plan),
    execute: async () => ({ stdout: "midgard/packages/dependency/source.ts\0" }),
    cache: async () => ({
      container: { getBlobClient: hash => ({
        getProperties: async () => {
          requests.push(["head", hash]);
          if (!blobs.has(hash)) throw Object.assign(new Error("missing"), { statusCode: 404 });
        },
        download: async () => {
          requests.push(["download", hash]);
          return { readableStreamBody: Readable.from([JSON.stringify(blobs.get(hash))]) };
        },
      }) },
      extract: (stage, { ignore }) => {
        let body = "";
        return new Writable({
          write(chunk, _, callback) { body += chunk; callback(); },
          final(callback) {
            try {
              for (const [file, content] of Object.entries(JSON.parse(body))) {
                const destination = path.join(stage, file);
                if (ignore(destination)) continue;
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                fs.writeFileSync(destination, content);
              }
              callback();
            } catch (error) { callback(error); }
          },
        });
      },
    }),
  };
  return { profile, cwd, blobs, requests, deps, setPlan: value => { plan = value; },
    refresh: () => refreshLibraryArtifacts(profile, deps) };
}

test("restores exact content-addressed artifacts once and reuses verified unchanged prerequisites", async () => {
  const f = fixture();
  f.deps.execute = async (command, args) => {
    expect(command).toBe("git");
    expect(args).toEqual(["ls-files", "-z", "--full-name", "--",
      path.relative(f.profile.repoRoot, f.cwd)]);
    return { stdout: "midgard/packages/dependency/source.ts\0" };
  };
  expect(await f.refresh()).toMatchObject({ ready: true, restored: 1 });
  expect(fs.readFileSync(path.join(f.cwd, "lib", "index.js"), "utf8")).toBe("before");
  expect(await f.refresh()).toMatchObject({ ready: true, restored: 0 });
  expect(f.requests.filter(([kind]) => kind === "download")).toHaveLength(1);
  fs.unlinkSync(path.join(f.cwd, "lib", "index.js"));
  expect((await f.refresh()).restored).toBe(1);
});

test("a source fingerprint change fetches the new artifact and removes only previously managed stale outputs", async () => {
  const f = fixture();
  await f.refresh();
  fs.writeFileSync(path.join(f.cwd, "unrelated.txt"), "preserved");
  f.blobs.set("b".repeat(40), { "lib/replacement.js": "after" });
  f.setPlan([{ id: "dependency#build", cwd: f.cwd, hash: "b".repeat(40), task: "build" }]);
  await f.refresh();
  expect(fs.existsSync(path.join(f.cwd, "lib", "index.js"))).toBe(false);
  expect(fs.readFileSync(path.join(f.cwd, "lib", "replacement.js"), "utf8")).toBe("after");
  expect(fs.readFileSync(path.join(f.cwd, "unrelated.txt"), "utf8")).toBe("preserved");
});

test("a missing CI artifact refuses readiness before changing any prior output", async () => {
  const f = fixture();
  await f.refresh();
  f.setPlan([{ id: "dependency#build", cwd: f.cwd, hash: "b".repeat(40), task: "build" }]);
  await expect(f.refresh()).rejects.toThrow("Matching Linux CI artifact is unavailable");
  expect(fs.readFileSync(path.join(f.cwd, "lib", "index.js"), "utf8")).toBe("before");
  expect(f.requests.filter(([kind]) => kind === "download")).toHaveLength(1);
});

test("cache extraction excludes tracked source, repository metadata, and nested dependency fixtures", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.cwd, "source.ts"), "authored");
  f.blobs.set("a".repeat(40), { "source.ts": "cached", ".git/config": "bad",
    "fixtures/node_modules/module/index.js": "bad", "lib/index.js": "generated" });
  await f.refresh();
  expect(fs.readFileSync(path.join(f.cwd, "source.ts"), "utf8")).toBe("authored");
  expect(fs.existsSync(path.join(f.cwd, ".git"))).toBe(false);
  expect(fs.existsSync(path.join(f.cwd, "fixtures"))).toBe(false);
});

test("an interrupted extraction retains non-ready provenance and is retried, never reused as success", async () => {
  const f = fixture();
  await f.refresh();
  f.blobs.set("b".repeat(40), { "lib/new.js": "new" });
  f.setPlan([{ id: "dependency#build", cwd: f.cwd, hash: "b".repeat(40), task: "build" }]);
  const cache = f.deps.cache;
  f.deps.cache = async () => ({ ...(await cache()), extract: () => { throw new Error("extraction failed"); } });
  await expect(f.refresh()).rejects.toThrow("extraction failed");
  expect(JSON.parse(fs.readFileSync(path.join(f.profile.stateRoot, "ci-artifacts.json"), "utf8")).ready).toBe(false);
  f.deps.cache = cache;
  expect((await f.refresh()).restored).toBe(1);
  expect(fs.existsSync(path.join(f.cwd, "lib", "index.js"))).toBe(false);
});

test("rejects output parents redirected through symlinks and prerequisites outside the workspace", async () => {
  const f = fixture();
  const outside = path.join(f.profile.repoRoot, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.cwd, "lib"), process.platform === "win32" ? "junction" : "dir");
  await expect(f.refresh()).rejects.toThrow("redirects");
  expect(fs.existsSync(path.join(outside, "index.js"))).toBe(false);
  f.setPlan([{ id: "outside#build", cwd: outside, hash: "a".repeat(40), task: "build" }]);
  await expect(f.refresh()).rejects.toThrow("Invalid Library prerequisite");
});
