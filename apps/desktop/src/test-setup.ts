import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureApplication } from "./lib/application-paths";

const data = mkdtempSync(join(tmpdir(), "spool-unit-"));
configureApplication({ data, resources: resolve("src-tauri", "resources") });
afterAll(() => rmSync(data, { recursive: true, force: true }));
