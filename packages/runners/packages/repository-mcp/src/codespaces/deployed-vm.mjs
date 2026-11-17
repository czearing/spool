import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { deployedPreview, verifiedPreviewState } from "./deployed-browser.mjs";
import { privateDirectory, privateJson } from "./application-browser.mjs";

function capture(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
    const output = [];
    let diagnostic = "";
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => { if (diagnostic.length < 8192) diagnostic += chunk.toString("utf8"); });
    child.stdin.on("error", () => {});
    child.once("error", () => reject(new Error("The VM sign-in runtime is unavailable; rerun app sign-in setup")));
    child.once("close", code => {
      if (code !== 0) {
        const reason = /^VM_APP_SIGN_IN_FAILED ([a-z-]+)$/m.exec(diagnostic)?.[1] || "runtime-unavailable";
        reject(new Error(reason === "deployment-unavailable"
          ? "The deployed preview is unavailable; restore its deployment before testing app sign-in"
          : `VM app sign-in failed (${reason}). Complete normal sign-in/MFA on the VM and retry`));
      }
      else {
        try { resolve(JSON.parse(Buffer.concat(output).toString("utf8"))); }
        catch { reject(new Error("The VM sign-in runtime returned an invalid response")); }
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function refreshVmPreview(configuration, target, {
  execute = capture, interactive = false,
} = {}) {
  const { version, directory, executable, account } = configuration || {};
  if (version !== 1 || !/^\/mnt\/[a-z]\/Users\/[^/]+\/AppData\/Local\/Spool\/browser-auth\/[a-z0-9-]+$/.test(directory || "") ||
      executable !== `${directory}/node.exe` || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account || ""))
    throw new Error("The VM app sign-in configuration did not verify");
  const verified = deployedPreview(target.prId, target.sourceCommit);
  const windowsDirectory = `${directory[5].toUpperCase()}:\\${directory.slice(7).replaceAll("/", "\\")}`;
  const worker = `${windowsDirectory}\\packages\\repository-mcp\\src\\codespaces\\deployed-sign-in.mjs`;
  const captured = await execute(executable, [worker], {
    directory: windowsDirectory, prId: verified.prId, sourceCommit: verified.sourceCommit, account, interactive,
  }, interactive ? 1020000 : 210000);
  return verifiedPreviewState(captured.state, verified, account, captured.watermark);
}

export async function renewVmPreview(directory, target, options) {
  privateDirectory(directory);
  const file = path.join(directory, "vm-auth.json"), stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw new Error("VM sign-in configuration is not private and owned");
  const captured = await refreshVmPreview(JSON.parse(fs.readFileSync(file, "utf8")), target, options);
  const preview = `${directory}/previews/${target.prId}-${target.sourceCommit}`;
  privateDirectory(path.dirname(preview));
  privateDirectory(preview);
  privateJson(path.join(preview, "browser-state.json"), captured.state);
  privateJson(path.join(preview, "authentication.json"), captured.authentication);
  fs.rmSync(path.join(preview, "refresh-request.json"), { force: true });
  return { ...captured, stateDirectory: preview };
}
