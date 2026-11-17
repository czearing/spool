#!/usr/bin/env node
/**
 * ado-auth-connect: host-side CLI that connects to an existing GitHub codespace
 * with Azure DevOps auth wired up, so git/ADO works inside the codespace over
 * plain SSH -- no VS Code open, no dependency on the `ado-codespaces-auth`
 * extension (the root cause of IcM 811055869).
 *
 * What it does, all from the developer's machine:
 *   1. Starts the `host-az` token broker in-process on a host Unix socket
 *      (mints ADO tokens from your local `az` login).
 *   2. Installs into the codespace: the git credential helper
 *      (~/.codespaces/git-credential-azure-devops) and `~/ado-auth-helper` —
 *      the exact file the codespace's own az/npm/yarn shims wait for (the one
 *      missing in IcM 811055869), backed by the broker.
 *   3. Opens `gh codespace ssh` with the broker socket REVERSE-forwarded (-R)
 *      and points git at our shim via GIT_CONFIG_*. The codespace's own az/npm/
 *      yarn shims then mint fresh tokens through ~/ado-auth-helper on demand, so
 *      `az`, `yarn`, and `npm` authenticate without the ~3 min stall waiting for
 *      the (absent) ado-codespaces-auth helper.
 *
 * All tokens are minted fresh per request via the broker. The wiring is
 * ephemeral: the broker and forwarded socket disappear when you exit, after
 * which ~/ado-auth-helper simply can't reach the broker (it fails fast rather
 * than hanging). Only the installed shim scripts remain; the codespace's own
 * auth is otherwise left untouched.
 *
 * Usage:
 *   yarn cs [<codespace-name>] [--repo-dir <path>] [--exec "<cmd>"]
 *   yarn cs [<codespace-name>] --agents [--port <port|auto>]
 *   node src/connect.ts [<codespace-name>] [--repo-dir <path>] [--exec "<cmd>"]
 *
 *   <codespace-name>   Name of an existing codespace. If omitted, you get an
 *                      interactive picker listing your codespaces.
 *   --repo-dir <path>  Directory to cd into on connect (default: /workspaces/1JS).
 *   --exec "<cmd>"     Run a single command with auth wired, then exit
 *                      (non-interactive). Omit for an interactive shell.
 *
 * Uses only Node.js built-in modules, so it runs straight from source with no
 * dependency install required.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { main as runAgents } from "./agents.js";
import { sshInvocation } from "../../config.mjs";
import {
  gitEnvironmentCommand,
  installShims,
  type GhRunner,
  REMOTE_SOCKET,
} from "./agentsAuth.ts";
import { startBroker } from "./broker.ts";
import { getToken as hostAz } from "./sources/hostAz.ts";
import { getToken as nativeHelper } from "./sources/nativeHelper.ts";
import {
  ADO_RESOURCE,
  AZ_SPAWN_OPTIONS,
  type TokenSource,
} from "./sources/types.ts";

const DEFAULT_REPO_DIR = "/workspaces/1JS";

/**
 * ADO token source for the broker. Fast path: the Codespaces native auth helper
 * (~125ms); falls back to the host `az` Python CLI (~1s+) when the helper is
 * unavailable (e.g. a local dev machine, not a Codespace) or returns an
 * unusable token. Mirrors the 1JS sandbox broker
 * (packages/sandbox/src/sandbox.ts:540-547).
 */
const adoTokenSource: TokenSource = async () =>
  (await nativeHelper()) ?? (await hostAz());

interface Args {
  codespace?: string;
  sshHost?: string;
  repoDir: string;
  exec?: string;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

function fail(message: string): never {
  console.error(`ado-auth-connect: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  let codespace: string | undefined;
  let sshHost: string | undefined;
  let repoDir = DEFAULT_REPO_DIR;
  let exec: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ssh-host") {
      sshHost = argv[++i] ?? fail("--ssh-host requires a value");
      sshInvocation({ sshHost }, ["true"]);
    } else if (arg === "--repo-dir") {
      repoDir = argv[++i] ?? fail("--repo-dir requires a value");
    } else if (arg === "--exec") {
      exec = argv[++i] ?? fail("--exec requires a value");
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        'usage: ado-auth-connect [<codespace-name>] [--repo-dir <path>] [--exec "<cmd>"]\n' +
          "       ado-auth-connect [<codespace-name>] --agents [--port <port|auto>]\n" +
          "       (omit <codespace-name> to pick one interactively)",
      );
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown option ${arg}`);
    } else if (codespace === undefined) {
      codespace = arg;
    } else {
      fail(`unexpected argument ${arg}`);
    }
  }
  return { codespace, sshHost, repoDir, exec };
}

interface CodespaceInfo {
  name: string;
  displayName: string;
  repository: string;
  state: string;
  lastUsedAt: string;
}

/** List the user's codespaces via `gh` (returns [] only on empty account). */
function listCodespaces(
  ghRunner: GhRunner = (args, options) => run("gh", args, options),
): CodespaceInfo[] {
  const res = ghRunner(
    [
      "codespace",
      "list",
      "--json",
      "name,displayName,repository,state,lastUsedAt",
    ],
    { quiet: true },
  );
  if (res.status !== 0) {
    fail(
      "could not list codespaces. Is `gh` logged in with the `codespace` scope?\n" +
        "Run `gh auth refresh -h github.com -s codespace`.\n" +
        res.stderr.trim(),
    );
  }
  try {
    const parsed = JSON.parse(res.stdout) as CodespaceInfo[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    fail("could not parse `gh codespace list` output.");
  }
}

/**
 * Interactive picker shown when no <codespace-name> is given. Lists the user's
 * codespaces (running ones first, then most-recently-used) and reads a choice
 * from stdin. Uses only node:readline/promises so no deps are required.
 */
async function pickCodespace(ghRunner?: GhRunner): Promise<string> {
  const all = listCodespaces(ghRunner);
  if (all.length === 0) {
    fail("no codespaces found. Create one with `gh codespace create`.");
  }
  const sorted = [...all].sort((a, b) => {
    const ra = a.state === "Available" ? 0 : 1;
    const rb = b.state === "Available" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "");
  });

  const lines = sorted.map((c, i) => {
    const marker = c.state === "Available" ? "●" : "○";
    return `  ${String(i + 1).padStart(2)}. ${marker} ${c.displayName}  [${c.state}]  ${c.repository}`;
  });

  if (!process.stdin.isTTY) {
    fail(
      "no <codespace-name> given and stdin is not a TTY for interactive selection.\n" +
        `Your codespaces:\n${lines.join("\n")}`,
    );
  }

  console.error("Select a codespace to connect to (● running, ○ stopped):\n");
  console.error(lines.join("\n"));
  console.error("");

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = (
        await rl.question(`Enter a number [1-${sorted.length}] (default 1): `)
      ).trim();
      const choice = answer === "" ? 1 : Number(answer);
      if (Number.isInteger(choice) && choice >= 1 && choice <= sorted.length) {
        const picked = sorted[choice - 1];
        console.error(
          `\nado-auth-connect: selected ${picked.displayName} (${picked.name})\n`,
        );
        return picked.name;
      }
      console.error(`Invalid selection: ${answer || "(empty)"}`);
    }
  } finally {
    rl.close();
  }
}

/** Run a command, returning its exit status; throws nothing. */
function run(
  command: string,
  args: string[],
  opts: { input?: string; quiet?: boolean; shell?: boolean } = {},
): CommandResult {
  const res = spawnSync(command, args, {
    encoding: "utf8",
    input: opts.input,
    shell: opts.shell ?? false,
    stdio: opts.quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function preflightAz(): void {
  if (
    run("az", ["--version"], { quiet: true, ...AZ_SPAWN_OPTIONS }).status !== 0
  ) {
    fail("`az` CLI not found on PATH. Install Azure CLI and `az login`.");
  }
  // Prove the host can mint an ADO token now, so failures surface here (not as
  // a confusing git error inside the codespace). Token value is never printed.
  const token = run(
    "az",
    [
      "account",
      "get-access-token",
      "--resource",
      ADO_RESOURCE,
      "--query",
      "accessToken",
      "-o",
      "tsv",
    ],
    { quiet: true, ...AZ_SPAWN_OPTIONS },
  );
  if (token.status !== 0 || !token.stdout.trim()) {
    fail(
      "host `az` could not mint an ADO token. Run `az login` (and ensure access " +
        `to Azure DevOps).\n${token.stderr.trim()}`,
    );
  }
}

function validateCodespace(codespace: string, ghRunner: GhRunner): void {
  const view = ghRunner(["codespace", "view", "-c", codespace], {
    quiet: true,
  });
  if (view.status !== 0) {
    fail(
      `codespace '${codespace}' not found or unavailable.\n${view.stderr.trim()}`,
    );
  }
}

function preflight(codespace: string, sshHost?: string): void {
  if (sshHost) {
    if (run("ssh", ["-V"], { quiet: true }).status !== 0)
      fail("`ssh` CLI not found on PATH. Install OpenSSH.");
    preflightAz();
    return;
  }
  if (run("gh", ["--version"], { quiet: true }).status !== 0) {
    fail("`gh` CLI not found on PATH. Install GitHub CLI and `gh auth login`.");
  }
  preflightAz();
  validateCodespace(codespace, (args, options) => run("gh", args, options));
}

/**
 * Build the remote command that wires git auth for the session, then either
 * runs a one-off command or an interactive login shell.
 *
 * Only git needs explicit wiring: `GIT_CONFIG_*` chains two credential helpers
 * with a leading empty value that resets any helper from system/global config
 * (notably the codespace's `external-git ado-helper`). The chain is:
 *   1. `cache --timeout=240` — an in-container credential cache, so gvfs-helper's
 *      frequent per-request auth challenges are served locally instead of
 *      round-tripping to the forwarded broker on every request. The timeout
 *      stays below the broker's 5-minute freshness floor so a cached token is
 *      never served past expiry.
 *   2. our shim — backed by the forwarded broker (fresh token per request) —
 *      which answers for ADO hosts on a cache miss.
 *
 * `az`, `npm`, and `yarn` need no env here: the codespace's own shims for those
 * tools call `~/ado-auth-helper` (installed above) on demand, which mints a
 * fresh token from the broker and overrides the placeholder `randomstr` token
 * the codespace's bashrc exports.
 */
function remoteCommand(repoDir: string, exec: string | undefined): string {
  const gitEnv = `export ${gitEnvironmentCommand()}`;
  const cd = `cd ${repoDir} 2>/dev/null || true`;
  const tail = exec ? exec : "exec bash -l";
  return `${gitEnv}; ${cd}; ${tail}`;
}

/** Pick a free loopback port by binding port 0 and reading back the assignment. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        if (port) {
          resolve(port);
        } else {
          reject(new Error("could not allocate a loopback port"));
        }
      });
    });
  });
}

interface AuthBridge {
  sshArgs: string[];
  cleanup(): void;
}

async function startAuthBridge(useLoopback: boolean): Promise<AuthBridge> {
  const workDir = mkdtempSync(join(tmpdir(), "adoauth-"));
  const hostSocket = join(workDir, "h.sock");
  const hostPort = useLoopback ? await findFreePort() : 0;
  console.error("ado-auth-connect: starting host-az broker…");
  const stopBroker = startBroker({
    socketPath: useLoopback ? { port: hostPort } : hostSocket,
    source: adoTokenSource,
    unref: true,
  });
  return {
    sshArgs: [
      "-o",
      "StreamLocalBindUnlink=yes",
      "-R",
      useLoopback
        ? `${REMOTE_SOCKET}:127.0.0.1:${hostPort}`
        : `${REMOTE_SOCKET}:${hostSocket}`,
    ],
    cleanup() {
      try {
        stopBroker();
      } catch {
        // Best effort when the ssh process and broker close together.
      }
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--agents")) {
    const code = await runAgents(argv, undefined, {
      pickCodespace: ({ runGh }) => pickCodespace(runGh),
      async prepare({ codespace, targetKind, runGh }) {
        preflightAz();
        console.error(
          `ado-auth-connect: installing auth shims in ${codespace}…`,
        );
        installShims(codespace, true, runGh);
        const authBridge = await startAuthBridge(targetKind !== "posix");
        return authBridge;
      },
    });
    if (code !== 0) process.exit(code);
    return;
  }

  const args = parseArgs(argv);
  const codespace = args.codespace ?? (await pickCodespace());
  preflight(codespace, args.sshHost);

  console.error(`ado-auth-connect: installing auth shims in ${codespace}…`);
  installShims(codespace, false, (ghArgs, options) =>
    run("gh", ghArgs, options),
    args.sshHost ? command => {
      const connection = sshInvocation(args, ["-T", "-o", "BatchMode=yes", command]);
      return run(connection.command, connection.args, { quiet: true });
    } : undefined,
  );

  // Windows cannot forward a local AF_UNIX socket, so use TCP loopback there.
  const authBridge = await startAuthBridge(process.platform === "win32");
  const sshFlags = [...authBridge.sshArgs];
  if (!args.exec) {
    sshFlags.push("-t"); // force a PTY for the interactive shell
  }
  const connection = sshInvocation({ codespace, sshHost: args.sshHost }, [
    ...sshFlags,
    remoteCommand(args.repoDir, args.exec),
  ]);

  console.error(
    args.exec
      ? `ado-auth-connect: running command in ${codespace} with ADO auth wired…`
      : `ado-auth-connect: connecting to ${codespace} (ADO auth wired; exit the shell to tear down)…`,
  );

  const child = spawn(connection.command, connection.args, { stdio: "inherit" });

  const onSignal = (): void => {
    child.kill("SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  child.on("close", (code) => {
    authBridge.cleanup();
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    authBridge.cleanup();
    fail(`failed to launch gh codespace ssh: ${err.message}`);
  });
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
