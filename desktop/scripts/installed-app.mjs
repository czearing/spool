import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { chromium, expect } from "@playwright/test";

export function installedApp({ fixture, registry, projectId, projectName }) {
  const executable = process.env.SPOOL_TEST_APP;
  if (process.platform !== "win32" || !executable || !isAbsolute(executable))
    throw new Error("Set SPOOL_TEST_APP to the installed Windows spool-desktop.exe and quit Spool first.");
  let app, browser, page;
  return {
    async start() {
      const server = createServer();
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const port = server.address().port;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      app = spawn(executable, [], { windowsHide: false, stdio: "ignore", env: {
        ...process.env, SPOOL_PROJECTS_FILE: registry, SPOOL_DATA_DIR: fixture,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
      } });
      let launchError;
      app.once("error", error => { launchError = error; });
      const endpoint = `http://127.0.0.1:${port}`, deadline = Date.now() + 30000;
      while (true) {
        if (launchError) throw launchError;
        if (app.exitCode !== null) throw new Error(`Spool exited ${app.exitCode}. Quit any existing tray instance before testing.`);
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; }
        catch (error) { if (!(error instanceof TypeError)) throw error; }
        if (Date.now() > deadline) throw new Error("Installed Spool did not expose its temporary WebView test endpoint.");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      browser = await chromium.connectOverCDP(endpoint);
      await expect.poll(() => browser.contexts()[0]?.pages().length ?? 0).toBeGreaterThan(0);
      page = browser.contexts()[0].pages()[0];
      page.setDefaultTimeout(30000);
      await page.waitForURL("http://tauri.localhost/**");
      await page.goto(`http://tauri.localhost/#/${projectId}`);
      await expect(page.getByRole("button", { name: `Switch project, ${projectName}`, exact: true })).toBeVisible();
      await page.bringToFront();
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$shell = New-Object -ComObject WScript.Shell; if (-not $shell.AppActivate(${app.pid})) { throw 'Cannot focus installed Spool for UI testing.' }`],
      { windowsHide: true });
      return page;
    },
    async stop() {
      await browser?.close(); browser = undefined;
      if (app && app.exitCode === null) {
        const exited = once(app, "exit");
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          `Stop-Process -Id ${app.pid} -ErrorAction Stop`], { windowsHide: true });
        await exited;
      }
      app = undefined;
    },
    async screenshot(name) {
      if (process.env.SPOOL_TEST_ARTIFACTS && page && !page.isClosed()) {
        await mkdir(process.env.SPOOL_TEST_ARTIFACTS, { recursive: true });
        await page.screenshot({ path: join(process.env.SPOOL_TEST_ARTIFACTS, `${name}.png`) });
      }
    },
  };
}
