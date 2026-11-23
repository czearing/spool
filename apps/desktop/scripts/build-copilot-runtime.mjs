import { createRequire } from "node:module";
import { cp, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { copilotRuntimePlatform } from "../src/lib/copilot-runtime.ts";

export async function buildCopilotRuntime(resources) {
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve("@github/copilot-sdk"));
  const platform = copilotRuntimePlatform();
  const packageName = `@github/copilot-sdk-${platform}`;
  const source = dirname(sdkRequire.resolve(`${packageName}/package.json`));
  const sdk = JSON.parse(await readFile(new URL("../package.json", import.meta.resolve("@github/copilot-sdk")), "utf8"));
  const runtime = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (sdk.optionalDependencies[packageName] !== runtime.version) {
    throw new Error("The Copilot runtime must match the installed SDK's pinned platform package.");
  }
  const binaries = join("prebuilds", platform);
  for (const name of ["runtime.node", `copilot-runtime${process.platform === "win32" ? ".exe" : ""}`]) {
    if (!(await stat(join(source, binaries, name))).size) throw new Error(`Copilot runtime is empty: ${name}`);
  }
  await mkdir(resources, { recursive: true });
  await cp(source, join(resources, "copilot"), { recursive: true, dereference: true });
  console.log(`Packaged SDK-matched Copilot runtime ${runtime.version} for ${platform}.`);
}
