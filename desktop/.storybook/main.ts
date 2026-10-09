import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "node:url";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  staticDirs: ["../public"],
  framework: "@storybook/react-vite",
  core: { disableTelemetry: true },
  viteFinal: async (config) => {
    const workflow = fileURLToPath(new URL("../../packages/workflow/", import.meta.url));
    const aliases = config.resolve?.alias;
    config.resolve = { ...config.resolve, alias: [{ find: "@spool/workflow", replacement: `${workflow}index.mjs` },
      ...(Array.isArray(aliases) ? aliases : Object.entries(aliases || {}).map(([find, replacement]) => ({ find, replacement })))] };
    config.optimizeDeps = { ...config.optimizeDeps, exclude: [...(config.optimizeDeps?.exclude || []), "@spool/workflow"] };
    config.server = { ...config.server, fs: { ...config.server?.fs,
      allow: [...(config.server?.fs?.allow || [fileURLToPath(new URL("..", import.meta.url))]), workflow] },
      proxy: { ...config.server?.proxy,
      "/api/file-picker": { target: "http://127.0.0.1:3000", changeOrigin: false },
    } };
    return config;
  },
};

export default config;
