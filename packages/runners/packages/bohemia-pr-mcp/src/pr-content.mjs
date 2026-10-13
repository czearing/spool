import { execFileSync } from "node:child_process";

export function assertSubstantiveChanges(repoRoot, target, head) {
  if (![target, head].every(value => /^[a-f0-9]{40}$/i.test(value || ""))) {
    throw new Error("PR content verification requires exact source and target commits");
  }
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8",
    windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const files = git("diff", "--name-only", "-z", `${target}...${head}`, "--")
    .split("\0").filter(file => file && !file.startsWith("change/"));
  for (const file of files) {
    try { git("diff", "--quiet", "--ignore-cr-at-eol", target, head, "--", file); }
    catch (error) {
      if (error.status === 1) return;
      throw error;
    }
  }
  throw new Error("No substantive changes remain against the target; metadata-only or already-applied fixes cannot create a PR");
}
