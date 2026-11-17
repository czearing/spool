import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REMOTE_SOCKET = "/tmp/codespaces.sock";
const REMOTE_SHIM_DIR = "$HOME/.codespaces";
export const REMOTE_SHIM_PATH = `${REMOTE_SHIM_DIR}/git-credential-azure-devops`;
const REMOTE_HELPER_PATH = "$HOME/ado-auth-helper";
const REMOTE_AGENTS_ENV_PATH = `${REMOTE_SHIM_DIR}/agents-env.sh`;
const REMOTE_AGENTS_ID_PATH = `${REMOTE_SHIM_DIR}/agents-codespace`;
const REMOTE_AGENTS_SOURCE_LINE = `. "${REMOTE_AGENTS_ENV_PATH}" # yarn-cs-agents`;

export interface GhCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type GhRunner = (
  args: string[],
  options?: { quiet?: boolean },
) => GhCommandResult;

const GIT_ENVIRONMENT = [
  ["GIT_CONFIG_COUNT", "4"],
  ["GIT_CONFIG_KEY_0", "credential.helper"],
  ["GIT_CONFIG_VALUE_0", ""],
  ["GIT_CONFIG_KEY_1", "credential.helper"],
  ["GIT_CONFIG_VALUE_1", "cache --timeout=240"],
  ["GIT_CONFIG_KEY_2", "credential.helper"],
  ["GIT_CONFIG_VALUE_2", `!bash ${REMOTE_SHIM_PATH} ${REMOTE_SOCKET}`],
  ["GIT_CONFIG_KEY_3", "credential.useHttpPath"],
  ["GIT_CONFIG_VALUE_3", "true"],
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function gitEnvironmentCommand(): string {
  return GIT_ENVIRONMENT.map(
    ([name, value]) => `${name}=${shellQuote(value)}`,
  ).join(" ");
}

export function agentsEnvironmentScript(): string {
  return [
    `if ! python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(0.2); s.connect(sys.argv[1]); s.close()' ${REMOTE_SOCKET} >/dev/null 2>&1; then`,
    "  return 0",
    "fi",
    ...GIT_ENVIRONMENT.map(
      ([name, value]) => `export ${name}=${shellQuote(value)}`,
    ),
    "",
  ].join("\n");
}

function readShimB64(name: string): string {
  const script = readFileSync(
    fileURLToPath(new URL(`../shims/${name}`, import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
  return Buffer.from(script, "utf8").toString("base64");
}

export function installShims(
  codespace: string,
  installAgentsEnvironment: boolean,
  ghRunner: GhRunner,
  runRemote?: (command: string) => GhCommandResult,
): void {
  const gitShimB64 = readShimB64("git-credential-azure-devops");
  const helperB64 = readShimB64("ado-auth-helper");
  const agentsEnvB64 = Buffer.from(agentsEnvironmentScript(), "utf8").toString(
    "base64",
  );
  const sourceLineB64 = Buffer.from(REMOTE_AGENTS_SOURCE_LINE, "utf8").toString(
    "base64",
  );
  const codespaceB64 = Buffer.from(codespace, "utf8").toString("base64");
  const agentsSetup = installAgentsEnvironment
    ? `printf %s '${agentsEnvB64}' | base64 -d > ${REMOTE_AGENTS_ENV_PATH} && ` +
      `chmod 600 ${REMOTE_AGENTS_ENV_PATH} && ` +
      `printf %s '${codespaceB64}' | base64 -d > ${REMOTE_AGENTS_ID_PATH} && ` +
      `chmod 600 ${REMOTE_AGENTS_ID_PATH} && ` +
      `touch "$HOME/.bashrc" && ` +
      `bashrc=$(readlink -f "$HOME/.bashrc") && ` +
      `source_line=$(printf %s '${sourceLineB64}' | base64 -d) && ` +
      `tmp=$(mktemp "\${bashrc}.agents.XXXXXX") && ` +
      `printf '%s\n' "$source_line" > "$tmp" && ` +
      `{ grep -Fvx "$source_line" "$bashrc" || true; } >> "$tmp" && ` +
      `chmod --reference="$bashrc" "$tmp" && ` +
      `mv "$tmp" "$bashrc" && `
    : "";
  const installCmd =
    `rm -f ${REMOTE_SOCKET} && ` +
    `mkdir -p ${REMOTE_SHIM_DIR} && ` +
    `printf %s '${gitShimB64}' | base64 -d > ${REMOTE_SHIM_PATH} && ` +
    `printf %s '${helperB64}' | base64 -d > ${REMOTE_HELPER_PATH} && ` +
    `chmod +x ${REMOTE_SHIM_PATH} ${REMOTE_HELPER_PATH} && ` +
    agentsSetup +
    `echo ado-auth-connect:shim-installed`;
  const result = runRemote ? runRemote(installCmd) : ghRunner(
    ["codespace", "ssh", "-c", codespace, "--", installCmd],
    { quiet: true },
  );
  if (
    result.status !== 0 ||
    !result.stdout.includes("ado-auth-connect:shim-installed")
  ) {
    throw new Error(
      `failed to install auth shims in codespace.\n${result.stderr.trim()}`,
    );
  }
}
