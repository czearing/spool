import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isAncestor, preparationBlocked } from "./resume-state.mjs";

export function recoverPreparedMerge({ previous, root, base, git, gitPath, command, stage }) {
  const refuse = reason => { throw preparationBlocked(`Prepared merge recovery refused: ${reason}; checkout preserved`); };
  const branch = git("branch", "--show-current"), head = git("rev-parse", "HEAD");
  const target = fs.readFileSync(gitPath("MERGE_HEAD"), "utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(target)) refuse("not a single-parent merge");
  if (["MERGE_AUTOSTASH", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"]
    .some(name => fs.existsSync(gitPath(name)))) refuse("another Git operation contains work");
  const auto = command("git", ["rev-parse", "--verify", "AUTO_MERGE"], root, true);
  if (auto.code !== 0) refuse("Git's original merge snapshot is missing");
  const tree = (auto.stdout ?? auto.output).trim();
  const id = createHash("sha256").update(JSON.stringify([branch, head, target, tree])).digest("hex");
  const archive = gitPath(`bohemia-prepared-merges/${id}.json`);
  const saved = fs.existsSync(archive) ? JSON.parse(fs.readFileSync(archive, "utf8")) : null;
  const evidence = saved?.preparation ?? previous;
  const sameRoot = value => typeof value === "string" &&
    (process.platform === "win32" ? path.resolve(value).toLowerCase() === root.toLowerCase() : path.resolve(value) === root);
  if (!evidence?.ready || evidence.state !== "completed" || !sameRoot(evidence.repoRoot) ||
      evidence.branch !== branch || evidence.commit !== head || !evidence.merge?.merged ||
      !evidence.merge.conflicted || !Array.isArray(evidence.merge.files)) refuse("no matching canonical preparation receipt");
  if (git("rev-parse", "ORIG_HEAD") !== head ||
      evidence.merge.targetCommit && evidence.merge.targetCommit !== target ||
      !isAncestor(target, `origin/${base}`, command)) refuse("merge identity changed");
  const mergeBase = git("merge-base", "--all", head, target);
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) refuse("ambiguous merge base");
  const unmerged = git("ls-files", "--unmerged", "-z").split("\0").filter(Boolean);
  const files = [...new Set(unmerged.map(entry => entry.slice(entry.indexOf("\t") + 1)))].sort();
  if (!files.length || JSON.stringify(files) !== JSON.stringify([...evidence.merge.files].sort()) ||
      unmerged.length !== files.length * 3) refuse("conflict stages changed");
  for (const entry of unmerged) {
    const tab = entry.indexOf("\t"), file = entry.slice(tab + 1);
    const [mode, object, index] = entry.slice(0, tab).split(" ");
    const ref = { 1: mergeBase, 2: head, 3: target }[index];
    if (!ref || git("--literal-pathspecs", "ls-tree", ref, "--", file).split("\t")[0] !== `${mode} blob ${object}`) {
      refuse("conflict index contains authored changes");
    }
  }
  const unchanged = () => {
    if (git("rev-parse", "HEAD") !== head || git("rev-parse", "MERGE_HEAD") !== target ||
        git("rev-parse", "AUTO_MERGE") !== tree ||
        git("diff", "--no-ext-diff", "--no-textconv", "AUTO_MERGE", "--name-only") ||
        git("diff", "--no-ext-diff", "--no-textconv", "--cached", "AUTO_MERGE", "--name-only", "--diff-filter=ACDMRT") ||
        git("ls-files", "--others", "--exclude-standard") ||
        git("ls-files", "--unmerged", "-z").split("\0").filter(Boolean).join("\0") !== unmerged.join("\0")) {
      refuse("authored or untracked changes exist");
    }
  };
  unchanged();
  if (!saved) {
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, JSON.stringify({ branch, head, target, tree, preparation: evidence,
      index: fs.readFileSync(gitPath("index")).toString("base64"),
      mergeMessage: fs.readFileSync(gitPath("MERGE_MSG"), "utf8"), at: new Date().toISOString() }), { flag: "wx" });
  }
  return stage("recover-prepared-merge", () => {
    for (const [name, object] of Object.entries({ head, target, tree })) {
      const ref = `refs/bohemia/prepared-merges/${id}/${name}`;
      const created = command("git", ["update-ref", ref, object, "0".repeat(40)], root, true);
      if (created.code !== 0 && git("rev-parse", ref) !== object) refuse("recovery reference changed");
    }
    unchanged();
    git("merge", "--abort");
    if (git("status", "--porcelain") || git("rev-parse", "HEAD") !== head) {
      throw preparationBlocked(`Merge recovery did not restore a clean original checkout; evidence retained at ${archive}`);
    }
    return { archive, branch, head, target, tree };
  });
}
