import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const api = fileURLToPath(new URL("../src/app/api/", import.meta.url));
export async function routeSource() {
  const files = (await readdir(api, { recursive: true })).filter(file => file.endsWith("route.ts")).sort();
  return files.map((file, index) => `import * as route${index} from ${JSON.stringify(join(api, file).replaceAll("\\", "/"))};`).join("\n")
    + "\nexport const routes = [\n" + files.map((file, index) =>
      `{ path: ${JSON.stringify("/api/" + file.replaceAll("\\", "/").replace(/\/?route.ts$/, ""))}, handlers: route${index} }`).join(",\n") + "\n];";
}
