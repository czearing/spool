import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { branchName } from "./checkout.mjs";
import { writeReceipt } from "./process.mjs";
import { stripAiAttribution } from "./commit-attribution.mjs";
import { publicationContext, recordPublication } from "../../bohemia-agent-tooling/src/publications.js";

const imagePattern = /!\[(?<alt>[^\]]*)\]\(\s*(?:<(?<angle>[^>\r\n]+)>|(?<plain>[^\s)]+))(?<caption>\s+"[^"]*")?\s*\)/g;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function publicationImages(markdown) {
  return [...new Set([...markdown.matchAll(imagePattern)]
    .map(match => match.groups.angle || match.groups.plain).filter(file => !/^https:\/\//i.test(file)))];
}

function active(pr, expected = pr) {
  if (!pr || pr.status !== "active") throw new Error("PR is not active; publication refused");
  if (pr.pullRequestId !== expected.pullRequestId || pr.sourceRefName !== expected.sourceRefName || pr.targetRefName !== expected.targetRefName)
    throw new Error("PR identity or branches changed; publication refused");
}

export async function publish({ checkout, host, input, baseBranch, allowsChange, check, policy, notify }) {
  const publisher = publicationContext();
  const existing = input.action === "update" ? await host.get(input.pullRequestId) : null;
  if (existing) active(existing);
  const source = branchName(existing ? existing.sourceRefName?.replace(/^refs\/heads\//, "") : input.sourceBranch, "sourceBranch");
  const target = branchName(input.targetBranch || existing?.targetRefName?.replace(/^refs\/heads\//, "") || baseBranch, "targetBranch");
  if (source === target) throw new Error("Source and target branches must differ");
  const draft = policy.draft(input, existing);
  const rendered = policy.render(draft);
  const localImages = publicationImages(rendered.description);
  for (const image of localImages) {
    if (!path.isAbsolute(image) || !fs.statSync(image).isFile()) throw new Error("PR images must be existing absolute paths or hosted HTTPS URLs");
    fs.accessSync(image, fs.constants.R_OK);
  }
  await checkout.clean();
  if (await checkout.branch() !== source) throw new Error("Checkout branch does not match the PR source");
  let head = await checkout.head();
  let targetHead = await checkout.fetch(target);
  const mergeBase = await checkout.git("merge-base", head, targetHead);
  const files = await checkout.changedFiles(`refs/remotes/origin/${target}`);
  if (!files.length) throw new Error("PR has no changes relative to its target");
  const outside = [];
  for (const file of files) if (!await allowsChange(file, checkout)) outside.push(file);
  if (outside.length) throw new Error(`PR changes paths outside the validated package scope:\n${outside.join("\n")}`);
  let evidence = await policy.validate?.({ checkout, draft, files, head, targetRef: `refs/remotes/origin/${target}` });
  const publishedHead = await host.tip(source);
  if (publishedHead && publishedHead !== head) {
    if (await checkout.fetch(source) !== publishedHead) throw new Error("Remote source changed before attribution verification");
    await checkout.git("merge-base", "--is-ancestor", publishedHead, head);
  }
  // Preserve published history; attribution checks cover every commit this update introduces.
  const messages = await checkout.git("log", "--format=%B", `refs/remotes/origin/${target}..HEAD`,
    ...(publishedHead ? ["--not", publishedHead] : []));
  let attributionCleanup;
  if (stripAiAttribution(messages) !== messages) {
    const beforeCommit = head;
    head = await checkout.cleanCommitAttribution({ head, source, targetRef: `refs/remotes/origin/${target}`, publishedHead,
      verifyRemote: async () => {
        if (await host.tip(source) !== publishedHead) throw new Error("Remote source changed during attribution cleanup");
      } });
    const cleaned = await checkout.git("log", "--format=%B", `refs/remotes/origin/${target}..HEAD`,
      ...(publishedHead ? ["--not", publishedHead] : []));
    if (stripAiAttribution(cleaned) !== cleaned) throw new Error("Automatic commit attribution cleanup did not verify");
    attributionCleanup = { beforeCommit, commit: head };
    evidence = await policy.validate?.({ checkout, draft, files, head, targetRef: `refs/remotes/origin/${target}` });
  }

  const receiptFile = checkout.receiptPath(`publications/${digest({ source, target })}.json`);
  let receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, "utf8")) : null;
  const intent = digest({ source, target, head, ...rendered, draft: Boolean(input.draft) });
  let created = existing;
  if (!existing) {
    const candidates = await host.list(source);
    const matched = receipt && candidates.filter(pr => pr.description?.includes(`<!-- repository-mcp:${receipt.marker} -->`));
    if (matched?.length > 1) throw new Error("Multiple PRs match the publication receipt; manual reconciliation required");
    if (matched?.length === 1) {
      created = await host.get(matched[0].pullRequestId);
      active(created);
      if (created.targetRefName !== `refs/heads/${target}`) throw new Error("Recovered PR targets a different branch");
    } else if (receipt) {
      throw new Error("An earlier PR creation intent has no verified matching PR. Reconcile it before another create; no POST was retried.");
    }
    if (receipt && receipt.intent !== intent) throw new Error("Create retry differs from its recorded intent; use update for an existing PR");
    if (candidates.some(pr => pr.status === "active" && pr.pullRequestId !== created?.pullRequestId && pr.targetRefName === `refs/heads/${target}`))
      throw new Error("An active PR already exists for this branch; use update");
  }

  const checks = await check();
  if (evidence && digest(await policy.validate({ checkout, draft, files, head, targetRef: `refs/remotes/origin/${target}` })) !== digest(evidence))
    throw new Error("Performance evidence changed during validation; publication refused");
  const verify = async () => {
    await checkout.clean();
    if (await checkout.head() !== head || await checkout.branch() !== source) throw new Error("Checkout changed during publication");
    let refreshes = 0;
    while (await host.tip(target) !== targetHead) {
      if (++refreshes > 3) throw new Error("Target branch keeps changing during publication; rerun publication");
      const next = await checkout.fetch(target);
      // Checks remain valid only when the target advances without changing the checked PR delta.
      if (await checkout.git("merge-base", targetHead, next) !== targetHead ||
          await checkout.git("merge-base", head, next) !== mergeBase)
        throw new Error("Target branch changed the validated history; rerun publication");
      const targetChanges = (await checkout.git("diff", "--name-only", "-z", targetHead, next)).split("\0").filter(Boolean);
      if (targetChanges.some(file => files.includes(file)))
        throw new Error("Target branch changed files in the checked PR; rerun publication");
      const refreshedFiles = await checkout.changedFiles(`refs/remotes/origin/${target}`);
      if (digest(refreshedFiles) !== digest(files))
        throw new Error("Target branch changed the validated package scope; rerun publication");
      const refreshedEvidence = await policy.validate?.({
        checkout, draft, files: refreshedFiles, head, targetRef: next,
      });
      if (digest(refreshedEvidence ?? null) !== digest(evidence ?? null))
        throw new Error("Performance evidence changed during validation; publication refused");
      await checkout.clean();
      if (await checkout.head() !== head || await checkout.branch() !== source)
        throw new Error("Checkout changed during publication");
      targetHead = next;
    }
  };
  await verify();
  const remoteHead = await host.tip(source);
  if (remoteHead && remoteHead !== head) {
    const fetched = await checkout.fetch(source);
    if (fetched !== remoteHead) throw new Error("Remote source changed before push");
    await checkout.git("merge-base", "--is-ancestor", remoteHead, head);
  }
  if (remoteHead !== head) await checkout.networkGit("push", "--porcelain", "origin", `${head}:refs/heads/${source}`);
  const verifyRemote = async () => {
    await verify();
    if (await host.tip(source) !== head) throw new Error("Remote source does not match the checked commit");
  };
  await verifyRemote();
  if (!created) {
    receipt = { version: 1, marker: randomUUID(), state: "pending", intent, source, target, head, targetHead, at: new Date().toISOString() };
    writeReceipt(receiptFile, receipt);
    created = await host.create({
      sourceRefName: `refs/heads/${source}`, targetRefName: `refs/heads/${target}`,
      title: rendered.title, description: `${rendered.description}\n<!-- repository-mcp:${receipt.marker} -->`,
      isDraft: Boolean(input.draft),
    });
    if (!Number.isSafeInteger(created.pullRequestId) || created.pullRequestId <= 0) throw new Error("PR creation did not return a valid ID; reconcile the saved intent");
    receipt = { ...receipt, state: "created", pullRequestId: created.pullRequestId };
    writeReceipt(receiptFile, receipt);
  }
  active(created);
  if (created.sourceRefName !== `refs/heads/${source}`) throw new Error("PR source does not match the checked branch");
  const current = await host.get(created.pullRequestId);
  active(current, created);
  await verifyRemote();
  let description = rendered.description;
  for (const image of localImages) {
    await verifyRemote();
    const url = await host.upload(created.pullRequestId, image);
    description = description.replace(imagePattern, (...args) => {
      const { alt, angle, plain, caption = "" } = args.at(-1);
      return (angle || plain) === image ? `![${alt}](${url}${caption})` : args[0];
    });
  }
  const marker = existing?.description?.match(/<!-- repository-mcp:[\w-]+ -->/)?.[0] ||
    (!existing && receipt ? `<!-- repository-mcp:${receipt.marker} -->` : "");
  if (marker) description += `\n${marker}`;
  await verifyRemote();
  active(await host.get(created.pullRequestId), created);
  if (created.targetRefName !== `refs/heads/${target}`) {
    const retargeted = await host.update(created.pullRequestId, { targetRefName: `refs/heads/${target}` });
    if (retargeted.targetRefName !== `refs/heads/${target}`) throw new Error("PR retarget did not retain the checked target");
    created = retargeted;
  }
  await verifyRemote();
  active(await host.get(created.pullRequestId), created);
  await host.update(created.pullRequestId, { title: rendered.title, description,
    ...(input.draft !== undefined ? { isDraft: input.draft } : {}) });
  const published = await host.get(created.pullRequestId);
  active(published, created);
  await verifyRemote();
  if (published.title !== rendered.title || published.description !== description ||
      published.targetRefName !== `refs/heads/${target}`)
    throw new Error("PR readback differs from the checked publication");
  if ((!existing || input.draft !== undefined) && published.isDraft !== Boolean(input.draft))
    throw new Error("PR draft state differs from the publication intent");
  const result = {
    ok: true, ready: true, repoRoot: checkout.root, commit: head, targetCommit: targetHead,
    branch: source, targetBranch: target,
    pullRequestId: published.pullRequestId, url: host.url(published.pullRequestId), title: published.title, checks,
    ...(attributionCleanup ? { attributionCleanup } : {}),
    ...(evidence ? { performanceEvidence: evidence } : {}),
  };
  const publishedReceipt = { ...(receipt || { version: 1, source, target }), state: "published", ...result, at: new Date().toISOString() };
  writeReceipt(existing ? checkout.receiptPath(`publications/pr-${published.pullRequestId}.json`) : receiptFile, publishedReceipt);
  await recordPublication({ context: publisher, result, branch: source, repoRoot: checkout.root });
  if (input.action === "create" || input.notify) result.notification = await notify({ title: result.title, url: result.url, action: existing ? "updated" : "opened" });
  return result;
}
