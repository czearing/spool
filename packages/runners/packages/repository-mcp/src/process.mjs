import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function execute(command, args, { cwd, env = process.env, logFile, redactions = [], input } = {}) {
  return new Promise((resolve, reject) => {
    const log = logFile ? fs.createWriteStream(logFile, { flags: "wx" }) : null;
    const executable = process.platform === "win32" && command.toLowerCase() === "cmd.exe"
      ? process.env.ComSpec || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe")
      : command;
    const child = spawn(executable, args, { cwd, env, windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let output = "";
    let stdout = "";
    let failure;
    const redact = text => redactions.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
    const capture = (data, isStdout) => {
      const text = redact(data.toString());
      output = (output + text).slice(-64_000);
      if (isStdout) stdout += text;
      if (stdout.length > 16 * 1024 * 1024) {
        failure ||= new Error("Command stdout exceeded 16 MiB; result cannot be verified");
        stdout = stdout.slice(-64_000);
      }
      log?.write(text);
    };
    child.stdout.on("data", data => capture(data, true));
    child.stderr.on("data", data => capture(data, false));
    child.on("error", error => { failure = error; });
    if (input !== undefined) {
      child.stdin.on("error", error => { failure = error; });
      child.stdin.end(input);
    }
    log?.on("error", error => { failure = error; });
    child.on("close", async code => {
      if (log) await new Promise(done => log.end(done));
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(
        `${path.basename(command)} ${args.join(" ")} failed (${code})${logFile ? `; log: ${logFile}` : ""}\n${redact(output.slice(-16_000))}`,
      ));
      resolve({ stdout: redact(stdout), output: redact(output), logFile });
    });
  });
}

export async function withWorkspaceLock(gitDirectory, operation) {
  const lockPath = path.join(gitDirectory, "repository-mcp.lock");
  const stat = process.platform === "linux" ? fs.readFileSync("/proc/self/stat", "utf8") : null;
  const processGroup = stat ? Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) : undefined;
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString(),
    ...(Number.isSafeInteger(processGroup) && processGroup > 0 ? { processGroup } : {}) });
  let handle;
  try { handle = fs.openSync(lockPath, "wx"); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Workspace is locked: ${lockPath}. Do not remove it while its operation or children are running.`);
  }
  try {
    fs.writeFileSync(handle, owner);
    return await operation();
  } finally {
    fs.closeSync(handle);
    if (fs.readFileSync(lockPath, "utf8") !== owner) throw new Error("Workspace lock ownership changed");
    fs.unlinkSync(lockPath);
  }
}

export { writeRunnerJson as writeReceipt } from "../../bohemia-agent-tooling/src/runner-files.js";
