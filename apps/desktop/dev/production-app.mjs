import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, preview } from "vite";
import { build as bundle } from "esbuild";
import { routeSource } from "../backend/route-source.ts";

export function enableRunnerFlight(t) {
  const previous = process.env.SPOOL_ENABLE_RUNNERS;
  process.env.SPOOL_ENABLE_RUNNERS = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.SPOOL_ENABLE_RUNNERS;
    else process.env.SPOOL_ENABLE_RUNNERS = previous;
  });
}

export async function startProductionApp(directory, plugins = []) {
  const desktop = resolve(import.meta.dirname, ".."), clientDirectory = join(directory, "client");
  await build({ root: desktop, build: { outDir: clientDirectory, emptyOutDir: true }, plugins, logLevel: "error" });
  let backend, client;
  const close = async () => { await backend?.close(); await client?.close(); };
  try {
    const file = join(directory, "backend.mjs");
    await bundle({
      stdin: { contents: `
        import { dispatch } from "./backend/dispatch.ts";
        import { configureApplication } from "./src/lib/application-paths.ts";
        import { apiMiddleware } from "./dev/http.ts";
        import { closeBoardReadModels } from "./src/lib/board-read-model.ts";
        configureApplication(${JSON.stringify({ data: directory, resources: join(desktop, "src-tauri", "resources") })});
        export const api = apiMiddleware(dispatch, closeBoardReadModels);
      `, resolveDir: desktop, loader: "ts" },
      bundle: true, platform: "node", format: "esm", target: "node24", outfile: file,
      banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
      plugins: [{ name: "production-api-routes", setup(builder) {
        builder.onResolve({ filter: /^desktop:routes$/ }, () => ({ path: "routes", namespace: "desktop" }));
        builder.onLoad({ filter: /.*/, namespace: "desktop" }, async () => ({
          contents: await routeSource(), loader: "ts", resolveDir: desktop,
        }));
      } }],
    });
    backend = (await import(pathToFileURL(file).href)).api;
    client = await preview({ root: desktop, build: { outDir: clientDirectory }, logLevel: "error",
      preview: { host: "127.0.0.1", port: 0 }, plugins: [{
        name: "production-ui-fixture-backend",
        configurePreviewServer(server) {
          server.middlewares.use(backend.handle);
        },
      }] });
    return { url: `http://127.0.0.1:${client.httpServer.address().port}`, close,
      disconnect: () => client.httpServer.closeAllConnections() };
  } catch (error) { await close(); throw error; }
}
