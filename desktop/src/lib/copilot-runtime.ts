import { join } from "node:path";
import { applicationPaths } from "./application-paths.ts";

export function copilotRuntimePlatform() {
  const platform = process.platform === "linux"
    && !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime
    ? "linuxmusl" : process.platform;
  return `${platform}-${process.arch}`;
}

export function copilotRuntimePath() {
  return join(applicationPaths().resources, "copilot", "prebuilds", copilotRuntimePlatform(),
    `copilot-runtime${process.platform === "win32" ? ".exe" : ""}`);
}
