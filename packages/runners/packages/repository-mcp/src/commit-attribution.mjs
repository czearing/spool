import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeReceipt } from "./process.mjs";

export function stripAiAttribution(message) {
  return message.replace(/^(?:Co-authored-by:[^\r\n]*(?:copilot|claude|chatgpt|cursor|\bai\b)[^\r\n]*|Copilot-Session:[^\r\n]*)(?:\r?\n[ \t]+[^\r\n]*)*(?:\r?\n|$)/gim, "");
}

function commitDetails(raw) {
  const boundary = raw.indexOf("\n\n");
  if (boundary < 0) throw new Error("Cannot safely read commit attribution");
  const headers = raw.slice(0, boundary);
  const identity = role => {
    const match = headers.match(new RegExp(`^${role} (.*) <([^<>]*)> (\\d+ [+-]\\d{4})$`, "m"));
    if (!match) throw new Error(`Cannot safely preserve commit ${role}`);
    return match.slice(1);
  };
  if (/^(?:encoding (?!UTF-8$)|mergetag )/im.test(headers))
    throw new Error("Cannot safely rewrite this commit's encoding or signed merge tag");
  return {
    tree: headers.match(/^tree ([a-f0-9]+)$/m)?.[1],
    parents: [...headers.matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => match[1]),
    author: identity("author"), committer: identity("committer"),
    signed: /^gpgsig(?:-sha256)? /m.test(headers),
    message: raw.slice(boundary + 2),
  };
}

export async function cleanCommitAttribution(checkout, gitInput, { head, source, targetRef, publishedHead, verifyRemote }) {
  await checkout.clean();
  if (await checkout.head() !== head || await checkout.branch() !== source)
    throw new Error("Checkout changed before attribution cleanup");
  const ids = (await checkout.git("rev-list", "--reverse", "--topo-order", `${targetRef}..${head}`,
    ...(publishedHead ? ["--not", publishedHead] : []))).split(/\r?\n/).filter(Boolean);
  const commits = [];
  for (const id of ids) commits.push({ id, ...commitDetails(await gitInput(["cat-file", "commit", id])) });
  if (!commits.some(commit => stripAiAttribution(commit.message) !== commit.message)) return head;
  const sign = await checkout.git("config", "--type=bool", "--default=false", "--get", "commit.gpgSign") === "true";
  const directory = checkout.receiptPath(`attribution/${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true });
  const messageFile = path.join(directory, "message");
  const rewritten = new Map();
  try {
    await checkout.git("hook", "run", "--ignore-missing", "pre-commit");
    for (const commit of commits) {
      const parents = commit.parents.map(parent => rewritten.get(parent) ?? parent);
      const message = stripAiAttribution(commit.message);
      if (message === commit.message && parents.every((parent, index) => parent === commit.parents[index])) continue;
      fs.writeFileSync(messageFile, message);
      await checkout.git("hook", "run", "--ignore-missing", "prepare-commit-msg", "--", messageFile, "commit", commit.id);
      fs.writeFileSync(messageFile, stripAiAttribution(fs.readFileSync(messageFile, "utf8")));
      await checkout.git("hook", "run", "--ignore-missing", "commit-msg", "--", messageFile);
      const checkedMessage = stripAiAttribution(fs.readFileSync(messageFile, "utf8"));
      if (checkedMessage !== message) throw new Error("Commit hook changed more than AI attribution; cleanup refused");
      fs.writeFileSync(messageFile, checkedMessage);
      const [authorName, authorEmail, authorDate] = commit.author;
      const [committerName, committerEmail, committerDate] = commit.committer;
      const next = (await gitInput(["commit-tree", commit.tree, ...parents.flatMap(parent => ["-p", parent]),
        ...(sign || commit.signed ? ["-S"] : []), "-F", messageFile], { env: {
        GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_AUTHOR_DATE: authorDate,
        GIT_COMMITTER_NAME: committerName, GIT_COMMITTER_EMAIL: committerEmail, GIT_COMMITTER_DATE: committerDate,
      } })).trim();
      const verified = commitDetails(await gitInput(["cat-file", "commit", next]));
      if (verified.tree !== commit.tree || JSON.stringify(verified.parents) !== JSON.stringify(parents) ||
          JSON.stringify(verified.author) !== JSON.stringify(commit.author) ||
          JSON.stringify(verified.committer) !== JSON.stringify(commit.committer) || verified.message !== checkedMessage ||
          (sign || commit.signed) && !verified.signed)
        throw new Error("Attribution cleanup changed commit content or authorship");
      rewritten.set(commit.id, next);
    }
    const next = rewritten.get(head);
    if (!next) throw new Error("Attribution cleanup did not retain the branch tip");
    await checkout.clean();
    if (await checkout.head() !== head || await checkout.branch() !== source)
      throw new Error("Checkout changed during attribution cleanup");
    await verifyRemote();
    // Only the private suffix moves; trees, merge parents and published ancestors are retained.
    await checkout.git("update-ref", "-m", "repository-mcp: remove AI attribution", `refs/heads/${source}`, next, head);
    writeReceipt(path.join(directory, "rewritten.json"), { before: head, after: next, commits: [...rewritten] });
    await gitInput(["hook", "run", "--ignore-missing", "post-rewrite", "--", rewritten.size === 1 ? "amend" : "rebase"],
      { input: [...rewritten].map(([before, after]) => `${before} ${after}\n`).join("") });
    await checkout.clean();
    if (await checkout.head() !== next || await checkout.branch() !== source)
      throw new Error("Checkout changed after attribution cleanup");
    return next;
  } finally {
    fs.rmSync(messageFile, { force: true });
  }
}
