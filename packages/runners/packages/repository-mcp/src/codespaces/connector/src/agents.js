#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SSH_ALIAS_PREFIX = "codespace-agents";
const KEY_BASENAME = "codespace-agents";
const BLOCK_BEGIN = "# >>> yarn cs --agents (managed) >>>";
const BLOCK_END = "# <<< yarn cs --agents (managed) <<<";
const DEFAULT_USER = "vscode";

class UsageError extends Error {}

function usage() {
  return `Usage:
  yarn cs [<codespace-name>] --agents [--port <port|auto>] [--user <user>]
  yarn cs --agents --status

Prepare one display-named plain SSH host for the VS Code Agents window.
The bridge stays in the foreground. Keep the terminal open and press Ctrl+C
when the Agents window no longer needs the connection.

Options:
  --agents          Use the VS Code Agents loopback bridge mode
  --port <value>    Fixed local port, or auto/0 for a free port (default: auto)
  --user <name>     Codespace SSH user (default: ${DEFAULT_USER})
  --status          Check whether the configured bridge is reachable
  -h, --help        Show this help`;
}

function parseArgs(argv) {
  let codespace;
  let port;
  let user = DEFAULT_USER;
  let status = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agents") {
      continue;
    }
    if (arg === "--port" || arg === "--agents-port") {
      const value = argv[++i];
      if (value === undefined) {
        throw new UsageError(`${arg} requires a value`);
      }
      if (value === "auto" || value === "0") {
        port = 0;
      } else if (/^[0-9]+$/.test(value)) {
        port = Number(value);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
          throw new UsageError(
            `${arg} must be auto, 0, or a port from 1 to 65535`,
          );
        }
      } else {
        throw new UsageError(
          `${arg} must be auto, 0, or a port from 1 to 65535`,
        );
      }
      continue;
    }
    if (arg === "--user") {
      user = argv[++i];
      if (user === undefined) {
        throw new UsageError("--user requires a value");
      }
      continue;
    }
    if (arg === "--status") {
      status = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new UsageError(`unknown Agents option ${arg}`);
    }
    if (codespace !== undefined) {
      throw new UsageError(`unexpected argument ${arg}`);
    }
    codespace = arg;
  }

  for (const [label, value] of [
    ["codespace name", codespace],
    ["SSH user", user],
  ]) {
    if (value !== undefined && (!value || /[\r\n\u2028\u2029\0]/.test(value))) {
      throw new UsageError(`${label} is invalid`);
    }
  }
  if (codespace && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(codespace)) {
    throw new UsageError("codespace name contains unsupported characters");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user)) {
    throw new UsageError("SSH user contains unsupported characters");
  }
  if (status && port !== undefined) {
    throw new UsageError("--status cannot be combined with --port");
  }

  return { codespace, port, user, status, help };
}

function targetKind({
  platform = process.platform,
  env = process.env,
  procVersion = "",
} = {}) {
  if (platform === "win32") {
    return "windows";
  }
  if (
    platform === "linux" &&
    (Boolean(env.WSL_INTEROP) ||
      Boolean(env.WSL_DISTRO_NAME) ||
      /microsoft|wsl/i.test(procVersion))
  ) {
    return "wsl-windows";
  }
  return "posix";
}

function currentTargetKind() {
  let procVersion = "";
  try {
    procVersion = fs.readFileSync("/proc/version", "utf8");
  } catch {
    // /proc does not exist on macOS or Windows.
  }
  return targetKind({ procVersion });
}

function commandResult(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function commandResultAsync(executable, args, options = {}) {
  const { timeout = 0, ...spawnOptions } = options;
  delete spawnOptions.quiet;
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
    let stdout = "";
    let stderr = "";
    let error;
    let timer;
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (childError) => {
      error = childError;
    });
    child.once("close", (status, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, error });
    });
    if (timeout > 0) {
      timer = setTimeout(() => {
        error = new Error(`command timed out after ${timeout} ms`);
        child.kill("SIGTERM");
      }, timeout);
      timer.unref?.();
    }
  });
}

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function powerShellArgs(script) {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedPowerShell(script),
  ];
}

function nativeWindowsPathSetup(home) {
  return [
    "$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
    "$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$env:Path = $machinePath + ';' + $userPath",
    `$env:USERPROFILE = ${psLiteral(home)}`,
    `$env:HOME = ${psLiteral(home)}`,
  ].join("\n");
}

function windowsInvocationScript(executable, args, home) {
  if (args.some((arg) => arg === "")) {
    throw new Error(
      "Windows PowerShell 5.1 cannot preserve an empty native argument",
    );
  }
  const invocation = [psLiteral(executable), ...args.map(psLiteral)].join(" ");
  return `$ErrorActionPreference = 'Stop'
${nativeWindowsPathSetup(home)}
& ${invocation}
if ($null -eq $LASTEXITCODE) { exit 0 }
exit $LASTEXITCODE`;
}

function findWslPowerShell() {
  const candidates = [
    "powershell.exe",
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  ];
  for (const candidate of candidates) {
    const result = commandResult(candidate, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "exit 0",
    ]);
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  throw new Error(
    "Windows PowerShell is not reachable from WSL. Enable WSL Windows interop, then retry.",
  );
}

function wslPath(nativePath) {
  const result = commandResult("wslpath", ["-u", nativePath]);
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error(
      `could not map Windows path ${nativePath} into WSL: ${result.stderr.trim() || result.error?.message || "unknown error"}`,
    );
  }
  return result.stdout.trim().replace(/\r/g, "");
}

function discoverWslWindows(powershell) {
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = $machinePath + ';' + $userPath
function Find-Application([string] $name) {
  $command = Get-Command $name -CommandType Application -ErrorAction Stop | Select-Object -First 1
  return $command.Source
}
[PSCustomObject]@{
  home = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  gh = Find-Application 'gh.exe'
  ssh = Find-Application 'ssh.exe'
  sshKeygen = Find-Application 'ssh-keygen.exe'
  path = $env:Path
  pathExt = $env:PATHEXT
  appData = $env:APPDATA
  localAppData = $env:LOCALAPPDATA
  systemRoot = $env:SystemRoot
  temp = $env:TEMP
} | ConvertTo-Json -Compress`;
  const result = commandResult(powershell, powerShellArgs(script));
  if (result.error || result.status !== 0) {
    throw new Error(
      "Windows gh.exe and OpenSSH are required because the VS Code Agents window runs on Windows. " +
        "Install GitHub CLI and the Windows OpenSSH client, then run this command again.\n" +
        (result.stderr.trim() || result.error?.message || ""),
    );
  }
  try {
    return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
  } catch {
    throw new Error(
      "could not read the Windows tool locations returned by PowerShell",
    );
  }
}

function createPosixTarget() {
  const home = os.homedir();
  const sshDir = path.join(home, ".ssh");
  return {
    kind: "posix",
    label: process.platform === "darwin" ? "macOS" : "native Linux",
    isWindows: false,
    homeNative: home,
    homeFs: home,
    configNative: path.join(sshDir, "config"),
    configFs: path.join(sshDir, "config"),
    keyNative: path.join(sshDir, KEY_BASENAME),
    keyFs: path.join(sshDir, KEY_BASENAME),
    publicKeyFs: path.join(sshDir, `${KEY_BASENAME}.pub`),
    nullDevice: "/dev/null",
    commands: { gh: "gh", ssh: "ssh", keygen: "ssh-keygen" },
    run(tool, args, options = {}) {
      return commandResult(this.commands[tool], args, options);
    },
    runAsync(tool, args, options = {}) {
      return commandResultAsync(this.commands[tool], args, options);
    },
    spawn(tool, args, options = {}) {
      return spawn(this.commands[tool], args, options);
    },
  };
}

function createNativeWindowsTarget() {
  const home = process.env.USERPROFILE || os.homedir();
  const sshDir = path.win32.join(home, ".ssh");
  return {
    kind: "windows",
    label: "Windows",
    isWindows: true,
    homeNative: home,
    homeFs: home,
    configNative: path.win32.join(sshDir, "config"),
    configFs: path.win32.join(sshDir, "config"),
    keyNative: path.win32.join(sshDir, KEY_BASENAME),
    keyFs: path.win32.join(sshDir, KEY_BASENAME),
    publicKeyFs: path.win32.join(sshDir, `${KEY_BASENAME}.pub`),
    nullDevice: "NUL",
    commands: { gh: "gh.exe", ssh: "ssh.exe", keygen: "ssh-keygen.exe" },
    run(tool, args, options = {}) {
      return commandResult(this.commands[tool], args, options);
    },
    runAsync(tool, args, options = {}) {
      return commandResultAsync(this.commands[tool], args, options);
    },
    spawn(tool, args, options = {}) {
      return spawn(this.commands[tool], args, {
        windowsHide: false,
        ...options,
      });
    },
  };
}

function windowsInteropEnvironment(base, info) {
  const env = {
    ...base,
    HOME: info.home,
    USERPROFILE: info.home,
    PATH: info.path,
    PATHEXT: info.pathExt,
    APPDATA: info.appData,
    LOCALAPPDATA: info.localAppData,
    SystemRoot: info.systemRoot,
    TEMP: info.temp,
    TMP: info.temp,
  };
  // A WSL-specific config path would make native gh.exe read the wrong OS's
  // files. GH_TOKEN itself is safe to retain when callers intentionally share it.
  delete env.GH_CONFIG_DIR;
  delete env.XDG_CONFIG_HOME;

  // WSL exports only variables named in WSLENV to a directly launched Win32
  // process. These values already use Windows syntax, so /w selects the
  // WSL-to-Windows direction without applying path translation.
  const nativeNames = [
    "HOME",
    "USERPROFILE",
    "PATH",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "TEMP",
    "TMP",
  ].filter((name) => env[name] !== undefined);
  const replaced = new Set([
    ...nativeNames.map((name) => name.toUpperCase()),
    "GH_CONFIG_DIR",
    "XDG_CONFIG_HOME",
  ]);
  const retained = String(base.WSLENV || "")
    .split(":")
    .filter(Boolean)
    .filter((entry) => !replaced.has(entry.split("/", 1)[0].toUpperCase()));
  env.WSLENV = [...retained, ...nativeNames.map((name) => `${name}/w`)].join(
    ":",
  );

  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined),
  );
}

function createWslWindowsTarget() {
  const powershell = findWslPowerShell();
  const info = discoverWslWindows(powershell);
  const sshDirNative = path.win32.join(info.home, ".ssh");
  const commands = { gh: info.gh, ssh: info.ssh, keygen: info.sshKeygen };
  // Windows PowerShell 5.1 drops empty native arguments. ssh-keygen needs an
  // actual empty argument for -N/-P, so launch that Windows executable through
  // WSL interop directly. execve-style argv preserves the empty value.
  const keygenInteropPath = wslPath(info.sshKeygen);
  const ghInteropPath = wslPath(info.gh);
  const interopEnvironment = windowsInteropEnvironment(process.env, info);
  const runWindows = (tool, args, options = {}) => {
    if (tool === "keygen") {
      return commandResult(keygenInteropPath, args, {
        ...options,
        env: interopEnvironment,
      });
    }
    return commandResult(
      powershell,
      powerShellArgs(windowsInvocationScript(commands[tool], args, info.home)),
      options,
    );
  };
  const runWindowsAsync = (tool, args, options = {}) => {
    if (tool === "keygen") {
      return commandResultAsync(keygenInteropPath, args, {
        ...options,
        env: interopEnvironment,
      });
    }
    return commandResultAsync(
      powershell,
      powerShellArgs(windowsInvocationScript(commands[tool], args, info.home)),
      options,
    );
  };
  return {
    kind: "wsl-windows",
    label: "Windows (from WSL)",
    isWindows: true,
    homeNative: info.home,
    homeFs: wslPath(info.home),
    configNative: path.win32.join(sshDirNative, "config"),
    configFs: wslPath(path.win32.join(sshDirNative, "config")),
    keyNative: path.win32.join(sshDirNative, KEY_BASENAME),
    keyFs: wslPath(path.win32.join(sshDirNative, KEY_BASENAME)),
    publicKeyFs: wslPath(path.win32.join(sshDirNative, `${KEY_BASENAME}.pub`)),
    nullDevice: "NUL",
    commands,
    run: runWindows,
    runAsync: runWindowsAsync,
    spawn(tool, args, options = {}) {
      if (tool !== "gh") {
        throw new Error(`unsupported long-lived Windows tool ${tool}`);
      }
      // Keep gh.exe as the direct child. Killing a PowerShell wrapper does not
      // cascade to native descendants and could orphan gh's loopback listener.
      return spawn(ghInteropPath, args, {
        ...options,
        env: interopEnvironment,
      });
    },
  };
}

function createTarget(kind = currentTargetKind()) {
  if (kind === "windows") {
    return createNativeWindowsTarget();
  }
  if (kind === "wsl-windows") {
    return createWslWindowsTarget();
  }
  return createPosixTarget();
}

function resultFailure(result) {
  return (
    result.stderr.trim() ||
    result.stdout.trim() ||
    result.error?.message ||
    "command failed"
  );
}

function assertTool(target, tool, args, description) {
  const result = target.run(tool, args);
  if (result.error || result.status === null) {
    throw new Error(
      `${description} was not found on ${target.label}: ${resultFailure(result)}`,
    );
  }
  return result;
}

function preflight(target) {
  const ghVersion = assertTool(target, "gh", ["--version"], "GitHub CLI");
  if (ghVersion.status !== 0) {
    throw new Error(
      `GitHub CLI failed on ${target.label}: ${resultFailure(ghVersion)}`,
    );
  }
  assertTool(target, "ssh", ["-V"], "OpenSSH client");
  assertTool(target, "keygen", ["-?"], "ssh-keygen");

  const help = target.run("gh", ["codespace", "ssh", "--help"]);
  if (
    help.status !== 0 ||
    !`${help.stdout}\n${help.stderr}`.includes("--server-port")
  ) {
    throw new Error(
      `GitHub CLI on ${target.label} does not support the Codespaces loopback bridge. Upgrade gh and retry.`,
    );
  }
}

function fileKind(filename) {
  try {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

function normalizePublicKey(value) {
  const line = value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("#"));
  if (!line) {
    throw new Error("SSH public key is empty");
  }
  const [type, body] = line.split(/\s+/);
  if (
    !/^ssh-|^ecdsa-/.test(type || "") ||
    !/^[A-Za-z0-9+/=]+$/.test(body || "")
  ) {
    throw new Error("SSH public key has an unsupported format");
  }
  return `${type} ${body}`;
}

function atomicWrite(filename, content, mode = 0o600) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.codespace-agents.${process.pid}.${Date.now()}`,
  );
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode });
    fs.renameSync(temporary, filename);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best effort after a successful rename or a failed write.
    }
  }
}

function ensureKeyPair(target) {
  fs.mkdirSync(path.dirname(target.keyFs), { recursive: true, mode: 0o700 });
  const privateKind = fileKind(target.keyFs);
  const publicKind = fileKind(target.publicKeyFs);

  if (privateKind !== "missing" && privateKind !== "file") {
    throw new Error(
      `refusing to use non-regular SSH private key ${target.keyFs}`,
    );
  }
  if (publicKind !== "missing" && publicKind !== "file") {
    throw new Error(
      `refusing to use non-regular SSH public key ${target.publicKeyFs}`,
    );
  }
  if (privateKind === "missing" && publicKind !== "missing") {
    throw new Error(
      `SSH public key ${target.publicKeyFs} exists without its private key; refusing to replace it`,
    );
  }

  let created = false;
  if (privateKind === "missing") {
    // Generate beside the final path, then hard-link into place. The link is an
    // atomic create-if-absent operation, so concurrent invocations never
    // overwrite a key and ssh-keygen never waits at an overwrite prompt.
    const suffix = `.creating-${process.pid}-${randomUUID()}`;
    const temporaryNative = `${target.keyNative}${suffix}`;
    const temporaryFs = `${target.keyFs}${suffix}`;
    const temporaryPublicFs = `${temporaryFs}.pub`;
    try {
      const generated = target.run("keygen", [
        "-q",
        "-t",
        "ed25519",
        "-f",
        temporaryNative,
        "-N",
        "",
        "-C",
        "yarn-cs-agents",
      ]);
      if (generated.error || generated.status !== 0) {
        throw new Error(
          `could not create SSH key ${target.keyFs}: ${resultFailure(generated)}`,
        );
      }
      if (
        fileKind(temporaryFs) !== "file" ||
        fileKind(temporaryPublicFs) !== "file"
      ) {
        throw new Error(
          `ssh-keygen did not create a complete key pair for ${target.keyFs}`,
        );
      }
      try {
        fs.linkSync(temporaryFs, target.keyFs);
        created = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      if (created && fileKind(target.publicKeyFs) === "missing") {
        try {
          fs.linkSync(temporaryPublicFs, target.publicKeyFs);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
    } finally {
      fs.rmSync(temporaryFs, { force: true });
      fs.rmSync(temporaryPublicFs, { force: true });
    }
  }

  if (fileKind(target.keyFs) !== "file") {
    throw new Error(`ssh-keygen did not create ${target.keyFs}`);
  }

  // -P with an empty old passphrase makes an unexpected encrypted replacement
  // fail immediately instead of opening an interactive prompt.
  const derived = target.run("keygen", [
    "-y",
    "-P",
    "",
    "-f",
    target.keyNative,
  ]);
  if (derived.error || derived.status !== 0) {
    throw new Error(
      `could not read SSH private key ${target.keyFs}: ${resultFailure(derived)}`,
    );
  }
  const derivedKey = normalizePublicKey(derived.stdout);

  if (fileKind(target.publicKeyFs) === "missing") {
    atomicWrite(target.publicKeyFs, `${derivedKey} yarn-cs-agents\n`, 0o644);
  } else {
    const publicKey = normalizePublicKey(
      fs.readFileSync(target.publicKeyFs, "utf8"),
    );
    if (publicKey !== derivedKey) {
      throw new Error(
        `SSH key files ${target.keyFs} and ${target.publicKeyFs} do not match; refusing to overwrite either file`,
      );
    }
  }

  if (!target.isWindows) {
    fs.chmodSync(path.dirname(target.keyFs), 0o700);
    fs.chmodSync(target.keyFs, 0o600);
    fs.chmodSync(target.publicKeyFs, 0o644);
  }
  return { created };
}

function quoteSshValue(value) {
  const normalized = String(value).replaceAll("\\", "/").replaceAll("%", "%%");
  return `"${normalized.replaceAll('"', '\\"')}"`;
}

function sshAliasForDisplayName(displayName) {
  if (
    typeof displayName !== "string" ||
    !displayName.trim() ||
    /[\r\n\u2028\u2029\0]/.test(displayName)
  ) {
    throw new Error("Codespace display name is invalid");
  }
  const normalized = displayName.normalize("NFKD");
  const readable = normalized
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  const digest = createHash("sha256")
    .update(displayName, "utf8")
    .digest("hex")
    .slice(0, 32);
  const alias = `${SSH_ALIAS_PREFIX}-${readable || "codespace"}-${digest}`;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(alias)) {
    throw new Error("Codespace display name did not produce an SSH-safe host");
  }
  return alias;
}

function getCodespaceIdentity(codespace, runGh) {
  const result = runGh(
    ["codespace", "view", "-c", codespace, "--json", "name,displayName"],
    { quiet: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not read the display name for Codespace '${codespace}': ${resultFailure(result)}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `could not parse the display name for Codespace '${codespace}'`,
    );
  }
  if (
    parsed?.name !== codespace ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(parsed.name) ||
    typeof parsed.displayName !== "string" ||
    !parsed.displayName.trim() ||
    /[\r\n\u2028\u2029\0]/.test(parsed.displayName)
  ) {
    throw new Error(
      `GitHub CLI returned an invalid display name for Codespace '${codespace}'`,
    );
  }
  return {
    name: parsed.name,
    displayName: parsed.displayName,
    alias: sshAliasForDisplayName(parsed.displayName),
  };
}

function buildManagedBlock({ codespace, displayName, port, user, target }) {
  const alias = sshAliasForDisplayName(displayName);
  return [
    BLOCK_BEGIN,
    `# Codespace: ${codespace}`,
    `# Codespace display name: ${JSON.stringify(displayName)}`,
    `# SSH host: ${alias}`,
    `# Local port: ${port}`,
    `# SSH user: ${user}`,
    `# Native target: ${target.label}`,
    `Host ${alias}`,
    "  HostName 127.0.0.1",
    `  Port ${port}`,
    `  User ${user}`,
    `  IdentityFile ${quoteSshValue(target.keyNative)}`,
    "  IdentitiesOnly yes",
    "  PreferredAuthentications publickey",
    "  PasswordAuthentication no",
    "  RequestTTY no",
    "  ProxyCommand none",
    "  ProxyJump none",
    "  StrictHostKeyChecking no",
    `  UserKnownHostsFile ${target.nullDevice}`,
    "  ConnectTimeout 10",
    "  ServerAliveInterval 30",
    "  ServerAliveCountMax 3",
    // Reset the Host scope before the original config. Without this line, a
    // prepended managed block would make leading Include/default directives
    // conditional on this alias and silently break existing SSH hosts.
    "Host *",
    BLOCK_END,
  ].join("\n");
}

function splitManagedBlocks(content) {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? content.slice(1) : content;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.match(/[^\r\n]*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
  const kept = [];
  const blocks = [];
  let current;

  for (const token of lines) {
    const line = token.replace(/\r?\n$/, "");
    if (line === BLOCK_BEGIN) {
      if (current)
        throw new Error("nested yarn cs --agents SSH config markers");
      current = [line];
    } else if (line === BLOCK_END) {
      if (!current)
        throw new Error("unmatched yarn cs --agents SSH config end marker");
      current.push(line);
      blocks.push(current.join("\n"));
      current = undefined;
    } else if (current) {
      current.push(line);
    } else {
      kept.push(token);
    }
  }
  if (current)
    throw new Error("unterminated yarn cs --agents SSH config block");
  return { bom, eol, rest: kept.join(""), blocks };
}

function parseManagedBlock(block) {
  const codespace = block.match(/^# Codespace: (.+)$/m)?.[1];
  const displayNameJson = block.match(/^# Codespace display name: (.+)$/m)?.[1];
  const recordedAlias = block.match(/^# SSH host: (.+)$/m)?.[1];
  const alias = block.match(/^Host[ \t]+([^ \t\r\n]+)[ \t]*$/im)?.[1];
  const port = Number(block.match(/^# Local port: ([0-9]+)$/m)?.[1]);
  const user = block.match(/^# SSH user: (.+)$/m)?.[1] || DEFAULT_USER;
  let displayName;
  let derivedAlias;
  try {
    displayName =
      displayNameJson === undefined ? undefined : JSON.parse(displayNameJson);
    derivedAlias =
      displayName === undefined
        ? undefined
        : sshAliasForDisplayName(displayName);
  } catch {
    return undefined;
  }
  if (
    !codespace ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(codespace) ||
    !alias ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(alias) ||
    (displayName !== undefined &&
      (typeof displayName !== "string" ||
        recordedAlias?.toLowerCase() !== alias.toLowerCase() ||
        derivedAlias !== alias.toLowerCase())) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return undefined;
  }
  return { alias, codespace, displayName, port, user };
}

function parseManagedMetadataList(content) {
  return splitManagedBlocks(content)
    .blocks.map(parseManagedBlock)
    .filter(Boolean);
}

function parseManagedMetadata(content) {
  return parseManagedMetadataList(content).at(-1);
}

function hasExactHost(lines, alias) {
  const expected = alias.toLowerCase();
  return lines.some((line) => {
    const match = line.match(/^\s*Host\s+(.+)$/i);
    return (
      match &&
      match[1]
        .trim()
        .split(/\s+/)
        .some((value) => value.toLowerCase() === expected)
    );
  });
}

function updateSshConfig(content, block) {
  const { bom, eol, rest, blocks } = splitManagedBlocks(content);
  const nextMetadata = parseManagedBlock(block);
  if (!nextMetadata) {
    throw new Error("could not read the generated yarn cs --agents SSH block");
  }
  if (hasExactHost(rest.split(/\r?\n/), nextMetadata.alias)) {
    throw new Error(
      `SSH config already has an unmanaged Host ${nextMetadata.alias} entry; rename or remove it before retrying`,
    );
  }

  let replaced = false;
  const nextBlocks = [];
  for (const existing of blocks) {
    const existingMetadata = parseManagedBlock(existing);
    if (!existingMetadata) {
      throw new Error("could not read an existing yarn cs --agents SSH block");
    }
    if (
      existingMetadata.alias.toLowerCase() ===
        nextMetadata.alias.toLowerCase() &&
      existingMetadata.codespace !== nextMetadata.codespace
    ) {
      throw new Error(
        `managed Host ${nextMetadata.alias} already belongs to Codespace ${existingMetadata.codespace}`,
      );
    }
    if (
      existingMetadata.alias.toLowerCase() ===
        nextMetadata.alias.toLowerCase() ||
      existingMetadata.codespace === nextMetadata.codespace
    ) {
      if (!replaced) {
        nextBlocks.push(block);
        replaced = true;
      }
    } else {
      nextBlocks.push(existing);
    }
  }
  if (!replaced) nextBlocks.unshift(block);

  const normalizedBlocks = nextBlocks
    .map((value) => value.replaceAll("\n", eol))
    .join(eol);
  if (!rest) return `${bom}${normalizedBlocks}${eol}`;
  if (blocks.length > 0 && rest.startsWith(eol)) {
    return `${bom}${normalizedBlocks}${eol}${rest}`;
  }
  return `${bom}${normalizedBlocks}${eol}${eol}${rest}`;
}

function readConfig(target) {
  try {
    return fs.readFileSync(target.configFs, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function writeConfig(target, content) {
  const kind = fileKind(target.configFs);
  if (kind !== "missing" && kind !== "file" && kind !== "symlink") {
    throw new Error(
      `refusing to replace non-regular SSH config ${target.configFs}`,
    );
  }
  let writePath = target.configFs;
  if (kind === "symlink") {
    writePath = fs.realpathSync(target.configFs);
    if (fileKind(writePath) !== "file") {
      throw new Error(
        `SSH config symlink does not point to a regular file: ${target.configFs}`,
      );
    }
  }
  atomicWrite(writePath, content, 0o600);
  if (!target.isWindows) fs.chmodSync(writePath, 0o600);
}

async function withConfigLock(target, action) {
  const lockPath = `${target.configFs}.codespace-agents.lock`;
  const timeoutMs = target.configLockTimeoutMs ?? 30000;
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `could not acquire SSH config lock ${lockPath} within ${timeoutMs}ms`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(50, remaining)),
      );
    }
  }
  try {
    return await action();
  } finally {
    fs.rmdirSync(lockPath);
  }
}

async function installManagedBlock(target, block, validateCurrent) {
  return withConfigLock(target, async () => {
    // The lock serializes bridge writers. Keep the optimistic re-read too, so
    // an editor that does not honor the lock cannot be overwritten unnoticed.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = readConfig(target);
      if (validateCurrent) await validateCurrent(current);
      const next = updateSshConfig(current, block);
      if (next === current) return;
      if (readConfig(target) !== current) continue;
      writeConfig(target, next);
      return;
    }
    throw new Error(
      `SSH config ${target.configFs} kept changing; no update was written`,
    );
  });
}

function buildBridgeArgs({ codespace, port, target, sshArgs = [] }) {
  return [
    "codespace",
    "ssh",
    "-c",
    codespace,
    "--server-port",
    String(port),
    "--",
    "-i",
    target.keyNative,
    ...sshArgs,
    "-N",
    "-T",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    `UserKnownHostsFile=${target.nullDevice}`,
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
  ];
}

async function bridgeStatus(target, metadata) {
  if (!metadata || fileKind(target.keyFs) !== "file") {
    return {
      active: false,
      detail: "the managed SSH host or key is not configured",
    };
  }
  const remoteCheck =
    `test "$(cat "$HOME/.codespaces/agents-codespace" 2>/dev/null)" = "${metadata.codespace}" && ` +
    `test "\${GIT_CONFIG_COUNT:-}" = 4 && ` +
    `test -n "$("$HOME/ado-auth-helper" get-access-token)"`;
  const runAsync = target.runAsync
    ? target.runAsync.bind(target)
    : async (tool, args, options) => target.run(tool, args, options);
  // Bypass user config and prove the exact key, Codespace identity, and live
  // ADO broker before reusing or publishing the Agents alias.
  const result = await runAsync(
    "ssh",
    [
      "-F",
      target.nullDevice,
      "-T",
      "-i",
      target.keyNative,
      "-p",
      String(metadata.port),
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "PreferredAuthentications=publickey",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "ProxyCommand=none",
      "-o",
      "ProxyJump=none",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      `UserKnownHostsFile=${target.nullDevice}`,
      "-o",
      "ConnectTimeout=3",
      "-o",
      "ConnectionAttempts=1",
      `${metadata.user}@127.0.0.1`,
      remoteCheck,
    ],
    { timeout: 15000 },
  );
  if (result.status === 0) {
    return {
      active: true,
      detail: "authenticated to the expected Codespace with live ADO auth",
    };
  }
  return { active: false, detail: resultFailure(result) };
}

function pause(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

async function runBridge(target, args, probeMetadata, onReady) {
  // Capture and tee gh output so readiness is tied to this exact child. gh
  // prints Connection Details only after its own ListenTCP call succeeds.
  const child = target.spawn("gh", args, {
    stdio: ["inherit", "pipe", "pipe"],
  });
  let stopping = false;
  let closed;
  let ownListenerReady = false;
  let listenerPort;
  let signalListenerReady;
  const listenerReady = new Promise((resolve) => {
    signalListenerReady = resolve;
  });
  let recentOutput = "";
  const watchedStreams = [];
  const watch = (stream, destination) => {
    if (!stream?.on) return;
    const onData = (chunk) => {
      destination.write(chunk);
      recentOutput = `${recentOutput}${chunk.toString("utf8")}`.slice(-8192);
      const details = recentOutput.match(
        /Connection Details:[^\r\n]*-p ([0-9]+)/,
      );
      if (!ownListenerReady && details) {
        listenerPort = Number(details[1]);
        ownListenerReady = true;
        signalListenerReady();
      }
    };
    stream.on("data", onData);
    watchedStreams.push([stream, onData]);
  };
  watch(child.stdout, process.stdout);
  watch(child.stderr, process.stderr);

  const forward = (signal) => {
    stopping = true;
    try {
      child.kill(signal);
    } catch {
      // The terminal may already have delivered the signal to the child.
    }
  };
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  const completion = new Promise((resolve) => {
    child.once("error", (error) => {
      closed = { code: 1, signal: undefined, stopping, error, ready: false };
      resolve(closed);
    });
    child.once("close", (code, signal) => {
      if (!closed) {
        closed = {
          code: code ?? (signal ? 1 : 0),
          signal,
          stopping,
          ready: false,
        };
      }
      resolve(closed);
    });
  });

  const cleanup = () => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    for (const [stream, onData] of watchedStreams) stream.off("data", onData);
  };
  const terminate = async () => {
    if (closed) return;
    forward("SIGTERM");
    const ended = await Promise.race([
      completion.then(() => true),
      pause(3000).then(() => false),
    ]);
    if (!ended) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process exited between the timeout and kill.
      }
      await completion;
    }
  };

  try {
    const readyTimeoutMs = target.readyTimeoutMs ?? 180000;
    const deadline = Date.now() + readyTimeoutMs;
    let lastDetail = "waiting for this gh process to bind the loopback port";
    while (!closed && Date.now() < deadline) {
      if (ownListenerReady) {
        const status = await bridgeStatus(target, {
          ...probeMetadata,
          port: listenerPort,
        });
        if (status.active) {
          await onReady(listenerPort);
          const result = await completion;
          return { ...result, ready: true };
        }
        lastDetail = status.detail;
      }
      const remaining = Math.max(1, Math.min(350, deadline - Date.now()));
      const wake = [completion, pause(remaining)];
      if (!ownListenerReady) wake.push(listenerReady);
      await Promise.race(wake);
    }
    if (closed) return closed;
    await terminate();
    throw new Error(
      `Codespaces bridge did not accept the managed SSH key within ${Math.ceil(readyTimeoutMs / 1000)} seconds (${lastDetail})`,
    );
  } catch (error) {
    await terminate();
    throw error;
  } finally {
    cleanup();
  }
}

function printActive(metadata, target) {
  const display = metadata.displayName
    ? `${metadata.displayName} (${metadata.codespace})`
    : metadata.codespace;
  console.error(
    `codespace-agents: ${metadata.alias} is active on ${target.label} ` +
      `(127.0.0.1:${metadata.port}, ${display}).`,
  );
  console.error(
    `codespace-agents: select SSH host "${metadata.alias}" in the VS Code Agents window, then open /workspaces/1JS.`,
  );
}

async function reuseActiveBridge(
  target,
  args,
  metadata,
  codespace,
  reuseMessage,
) {
  const status = await bridgeStatus(target, metadata);
  if (!status.active) return false;

  const sameCodespace = !codespace || codespace === metadata.codespace;
  const samePort =
    args.port === undefined || args.port === 0 || args.port === metadata.port;
  const sameUser = args.user === metadata.user;
  if (sameCodespace && samePort && sameUser) {
    printActive(metadata, target);
    console.error(reuseMessage);
    return true;
  }
  throw new Error(
    `${metadata.alias} already reaches ${metadata.codespace} on port ${metadata.port}. ` +
      "Press Ctrl+C in the terminal that owns that bridge, then retry.",
  );
}

async function main(argv = process.argv.slice(2), injectedTarget, hooks = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const target = injectedTarget ?? createTarget();
  const runGh = (ghArgs, options = { quiet: true }) =>
    target.run("gh", ghArgs, options);
  const oldContent = readConfig(target);
  const allMetadata = parseManagedMetadataList(oldContent);

  if (args.status) {
    const selected = args.codespace
      ? allMetadata.filter((value) => value.codespace === args.codespace)
      : allMetadata;
    let hasInactive = selected.length === 0;
    if (hasInactive) {
      console.error(
        `codespace-agents: no matching managed SSH host is configured on ${target.label}.`,
      );
    }
    for (const metadata of selected) {
      const status = await bridgeStatus(target, metadata);
      if (status.active) {
        printActive(metadata, target);
      } else {
        hasInactive = true;
        console.error(
          `codespace-agents: ${metadata.alias} is not active on ${target.label} (${status.detail}).`,
        );
      }
    }
    if (hasInactive) {
      console.error(
        "codespace-agents: start a bridge with `yarn cs <codespace-name> --agents`.",
      );
    }
    return 0;
  }

  preflight(target);

  const existing = args.codespace
    ? allMetadata.find((value) => value.codespace === args.codespace)
    : allMetadata.length === 1
      ? allMetadata[0]
      : undefined;
  if (
    existing &&
    (await reuseActiveBridge(
      target,
      args,
      existing,
      args.codespace,
      "codespace-agents: the existing foreground bridge can be reused; no changes were made.",
    ))
  ) {
    return 0;
  }

  if (!args.codespace && !hooks.pickCodespace) {
    throw new Error("a codespace name or picker hook is required");
  }
  const requestedCodespace =
    args.codespace ?? (await hooks.pickCodespace({ runGh }));
  const identity = getCodespaceIdentity(requestedCodespace, runGh);
  const codespace = identity.name;
  const displayName = identity.displayName;
  const alias = identity.alias;
  const key = ensureKeyPair(target);
  const requestedPort = args.port ?? 0;

  // Selection and key setup can take time. Re-read now so any SSH config edit
  // made during that work is preserved, and notice a matching bridge that a
  // parallel invocation started in the meantime.
  const freshContent = readConfig(target);
  const freshMetadata = parseManagedMetadataList(freshContent).find(
    (value) =>
      value.alias.toLowerCase() === alias || value.codespace === codespace,
  );
  if (
    freshMetadata &&
    (await reuseActiveBridge(
      target,
      args,
      freshMetadata,
      codespace,
      "codespace-agents: a parallel invocation started the bridge; no changes were made.",
    ))
  ) {
    return 0;
  }

  let prepared;
  if (hooks.prepare) {
    prepared = await hooks.prepare({
      codespace,
      targetKind: target.kind,
      runGh,
    });
  }
  console.error(
    `codespace-agents: ${key.created ? "created" : "reusing"} SSH key ${target.keyNative}`,
  );
  console.error(
    requestedPort > 0
      ? `codespace-agents: starting the loopback bridge for ${displayName} (${codespace}) on ${target.label} at 127.0.0.1:${requestedPort}.`
      : `codespace-agents: starting the loopback bridge for ${displayName} (${codespace}) on ${target.label} with an automatic free port.`,
  );
  console.error(
    `codespace-agents: waiting for the bridge to accept the managed key…`,
  );

  let result;
  try {
    result = await runBridge(
      target,
      buildBridgeArgs({
        codespace,
        port: requestedPort,
        target,
        sshArgs: prepared?.sshArgs,
      }),
      { codespace, user: args.user },
      async (port) => {
        const block = buildManagedBlock({
          codespace,
          displayName,
          port,
          user: args.user,
          target,
        });
        // Publish the alias only after gh owns the port and the exact key works.
        // Serialize this final conflict check and merge so simultaneous bridges
        // for different display names cannot overwrite each other's entries.
        await installManagedBlock(target, block, async (latestContent) => {
          const latestMetadata = parseManagedMetadataList(latestContent).find(
            (value) =>
              value.alias.toLowerCase() === alias ||
              value.codespace === codespace,
          );
          if (
            latestMetadata &&
            (latestMetadata.codespace !== codespace ||
              latestMetadata.port !== port)
          ) {
            const latestStatus = await bridgeStatus(target, latestMetadata);
            if (latestStatus.active) {
              throw new Error(
                `${latestMetadata.alias} was activated by another process for ${latestMetadata.codespace} ` +
                  `on port ${latestMetadata.port}; the new bridge was stopped without changing SSH config`,
              );
            }
          }
        });
        console.error(
          `codespace-agents: verified and configured host "${alias}" in ${target.configNative}.`,
        );
        console.error(
          `codespace-agents: select SSH host "${alias}" in the VS Code Agents window, ` +
            "then open /workspaces/1JS.",
        );
        console.error(
          `codespace-agents: keep this terminal open; press Ctrl+C to stop it when finished.`,
        );
        console.error(
          `codespace-agents: the bridge keeps the Codespace active while it runs.`,
        );
        console.error(
          `codespace-agents: from another terminal, check it with \`yarn cs --agents --status\`.\n`,
        );
      },
    );
  } finally {
    prepared?.cleanup();
  }

  if (result.stopping || result.signal === "SIGINT" || result.code === 130) {
    console.error("\ncodespace-agents: bridge stopped.");
    return 0;
  }
  if (result.error) {
    throw new Error(
      `failed to start GitHub CLI bridge: ${result.error.message}`,
    );
  }
  if (!result.ready) {
    throw new Error(
      `GitHub CLI bridge exited with code ${result.code} before it accepted the managed key. ` +
        "SSH config was not changed; rerun after fixing the reported error.",
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `GitHub CLI bridge exited with code ${result.code}. ` +
        "The verified SSH entry remains configured; rerun after fixing the reported error.",
    );
  }
  console.error("codespace-agents: bridge stopped.");
  return 0;
}

export {
  BLOCK_BEGIN,
  BLOCK_END,
  DEFAULT_USER,
  KEY_BASENAME,
  SSH_ALIAS_PREFIX,
  UsageError,
  atomicWrite,
  bridgeStatus,
  buildBridgeArgs,
  buildManagedBlock,
  encodedPowerShell,
  ensureKeyPair,
  installManagedBlock,
  main,
  normalizePublicKey,
  parseArgs,
  parseManagedMetadata,
  parseManagedMetadataList,
  psLiteral,
  runBridge,
  sshAliasForDisplayName,
  splitManagedBlocks,
  targetKind,
  updateSshConfig,
  usage,
  windowsInteropEnvironment,
  windowsInvocationScript,
};
