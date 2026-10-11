import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

type Scope = "bohemia" | "other" | "unknown";
const literal = (value: string) => value.length > 0 && !/[$`]|%[^%]+%/.test(value);
function git(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", windowsHide: true, timeout: 1500, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return undefined; }
}
function destination(cwd: string, remote?: string): Scope {
  if (!remote) {
    const branch = git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD");
    remote = (branch && git(cwd, "config", "--get", `branch.${branch}.pushRemote`))
      || git(cwd, "config", "--get", "remote.pushDefault")
      || (branch && git(cwd, "config", "--get", `branch.${branch}.remote`)) || "origin";
  }
  if (!literal(remote)) return "unknown";
  let urls = git(cwd, "remote", "get-url", "--push", "--all", remote);
  if (urls === undefined && /^(?:[a-z][\w+.-]*:\/\/|[^@\s]+@[^:\s]+:)/i.test(remote)) {
    // Let Git apply pushInsteadOf without writing any repository configuration.
    const name = `bohemia-scope-${randomUUID()}`;
    urls = git(cwd, "-c", `remote.${name}.url=${remote}`, "remote", "-v")?.split(/\r?\n/)
      .filter(line => line.startsWith(`${name}\t`) && line.endsWith(" (push)"))
      .map(line => line.slice(name.length + 1, -7)).join("\n");
  }
  if (!urls) return "unknown";
  let unknown = false;
  for (const url of urls.split(/\r?\n/)) {
    let repository: string;
    try { repository = decodeURIComponent(url.replace(/[?#].*$/, "").replace(/\/+$/, "").split(/[/:]/).at(-1) ?? ""); }
    catch { return "unknown"; }
    if (repository.replace(/\.git$/i, "").toLowerCase() === "office-bohemia") return "bohemia";
    if (!/^(?:https?:\/\/|ssh:\/\/|[^@\s]+@[^:\s]+:)/i.test(url)
      || /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(repository)) unknown = true;
  }
  return unknown ? "unknown" : "other";
}

export function pushScopes(command: string, initialCwd: string): Scope[] {
  const raw = command.match(/"(?:[^"`]|`.)*"|'(?:[^']|'')*'|&&|\|\||[;|\r\n&]|[^\s;|&]+/g) ?? [];
  const statements: string[][] = [[]];
  for (const token of raw) {
    if (/^(?:&&|\|\||[;|\r\n&])$/.test(token)) statements.push([]);
    else statements.at(-1)!.push(/^["']/.test(token) ? token.slice(1, -1) : token);
  }
  let cwd: string | undefined = initialCwd;
  const directories: (string | undefined)[] = [], scopes: Scope[] = [];
  for (const [program, ...args] of statements) {
    if (!program) continue;
    if (/^(?:cd|chdir|set-location|pushd|push-location)$/i.test(program)) {
      if (/^push/i.test(program)) directories.push(cwd);
      const target = args.filter(value => !/^(?:-LiteralPath|-Path|\/d)$/i.test(value))[0];
      cwd = cwd && target && literal(target) ? resolve(cwd, target) : undefined;
      continue;
    }
    if (/^(?:popd|pop-location)$/i.test(program)) { cwd = directories.pop(); continue; }
    if (!/(?:^|[\\/])git(?:\.exe)?$/i.test(program)) continue;
    let root = cwd, unsupported = false;
    while (args[0]?.startsWith("-")) {
      const option = args.shift();
      if (option === "-C") {
        const target = args.shift();
        root = root && target && literal(target) ? resolve(root, target) : undefined;
      } else if (option === "-c" || option === "--git-dir" || option === "--work-tree") {
        args.shift(); unsupported = true;
      } else if (!["--no-pager", "--no-optional-locks"].includes(option!)) unsupported = true;
    }
    if (args.shift() !== "push") continue;
    if (!root || unsupported) { scopes.push("unknown"); continue; }
    let remote: string | undefined;
    while (args.length) {
      const option = args.shift()!;
      if (option === "--repo") { remote = args.shift(); break; }
      if (option.startsWith("--repo=")) { remote = option.slice(7); break; }
      if (["-o", "--push-option", "--receive-pack", "--exec"].includes(option)) { args.shift(); continue; }
      if (option === "--") { remote = args.shift(); break; }
      if (!option.startsWith("-")) { remote = option; break; }
    }
    scopes.push(destination(root, remote));
  }
  if (!scopes.length && /\bgit(?:\.exe)?\s+push\b/i.test(command)) scopes.push("unknown");
  return scopes;
}
