import type { Plugin } from "vite";
import { applicationData, configureBackend } from "../backend/configuration.ts";
import { routeSource } from "../backend/route-source.ts";
import { apiMiddleware, type Dispatch } from "./http.ts";

const virtual = "\0desktop:routes";
export function apiPlugin(): Plugin {
  let close: (() => void) | undefined;
  return {
    name: "spool-api",
    apply: "serve",
    resolveId(id) { if (id === "desktop:routes") return virtual; },
    load(id) { if (id === virtual) return routeSource(); },
    async configureServer(server) {
      await configureBackend(applicationData());
      const api = apiMiddleware(async request => {
        const dispatch: Dispatch = (await server.ssrLoadModule("/backend/dispatch.ts")).dispatch;
        return dispatch(request);
      });
      server.middlewares.use(api.handle);
      const routesChanged = (file: string) => {
        if (!/[\\/]src[\\/]app[\\/]api[\\/].*[\\/]route\.ts$/.test(file)) return;
        const module = server.moduleGraph.getModuleById(virtual);
        if (module) server.moduleGraph.invalidateModule(module);
      };
      server.watcher.on("add", routesChanged).on("unlink", routesChanged);
      close = () => {
        api.close();
        server.watcher.off("add", routesChanged).off("unlink", routesChanged);
      };
    },
    closeBundle() { close?.(); },
  };
}
