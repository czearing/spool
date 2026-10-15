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
  let app, browser, page, suspended = false;
  function suspendBackend(suspend) {
    if (!app || app.exitCode !== null) throw new Error("No owned installed app is running.");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop';
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TestProcess {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
 [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
}
'@
$items=@(Get-CimInstance Win32_Process -Filter "Name='spool-runtime.exe'" | Where-Object { $_.ParentProcessId -eq ${app.pid} });
if($items.Count -ne 1) { throw 'Ambiguous fixture backend' };
$handle=[TestProcess]::OpenProcess(0x0800,$false,$items[0].ProcessId);
if($handle -eq [IntPtr]::Zero) { throw 'Cannot access fixture backend' };
try { $result=[TestProcess]::${suspend ? "NtSuspendProcess" : "NtResumeProcess"}($handle);
 if($result -ne 0) { throw "Process control failed: $result" }
} finally { [void][TestProcess]::CloseHandle($handle) }`], { windowsHide: true });
    suspended = suspend;
  }
  return {
    get pid() { return app?.pid; },
    suspendBackend,
    async verifyImmediateSendScroll(trigger) {
      const viewport = page.getByRole("region", { name: "Task conversation", exact: true });
      const list = page.getByRole("list", { name: "Conversation messages", exact: true });
      await viewport.evaluate(element => { element.scrollTop = 0; });
      await expect.poll(() => viewport.evaluate(element =>
        element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(400);
      const count = await list.getAttribute("data-message-count");
      suspendBackend(true);
      try {
        await page.getByRole("button", { name: "Send message", exact: true }).evaluate(button => {
          const form = button.closest("form"), viewport = document.querySelector('section[aria-label="Task conversation"]');
          if (!form || !viewport) throw new Error("Send-scroll measurement target is missing.");
          viewport.removeAttribute("data-send-scroll");
          const measure = event => {
            if (event.type === "keydown" ? event.key !== "Enter" || event.shiftKey
              : !(event.target instanceof Element) || event.target.closest("button") !== button) return;
            form.removeEventListener("click", measure, true); form.removeEventListener("keydown", measure, true);
            const start = performance.now();
            requestAnimationFrame(() => requestAnimationFrame(() => viewport.setAttribute("data-send-scroll", JSON.stringify({
              gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop, elapsed: performance.now() - start,
            }))));
          };
          form.addEventListener("click", measure, true); form.addEventListener("keydown", measure, true);
        });
        await trigger();
        await expect.poll(() => viewport.getAttribute("data-send-scroll")).not.toBeNull();
        const position = JSON.parse(await viewport.getAttribute("data-send-scroll"));
        expect(position.gap).toBeLessThanOrEqual(2);
        expect(position.elapsed).toBeLessThan(250);
        expect(await list.getAttribute("data-message-count")).toBe(count);
        await expect(page.getByRole("button", { name: "Sending message", exact: true })).toBeDisabled();
      } finally { suspendBackend(false); }
      console.log("PASS: sending from older history reaches bottom within two frames while the real backend is suspended, before acceptance or transcript updates.");
    },
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
      if (suspended) suspendBackend(false);
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
