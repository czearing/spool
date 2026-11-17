import fs from "node:fs";
import path from "node:path";

export function readReviewerPolicy(file) {
  if (!path.isAbsolute(file)) throw new Error("Reviewer policy requires the registered runner configuration");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const policies = Object.values(config.custom_runners || {}).flatMap(runner => runner.nodes || [])
    .filter(node => node.reviewers).map(node =>
      typeof node.reviewers === "string" ? JSON.parse(node.reviewers) : node.reviewers);
  if (!policies.length || policies.some(policy => JSON.stringify(policy) !== JSON.stringify(policies[0])))
    throw new Error("Registered runners must specify one consistent reviewer policy");
  const reviewers = policies[0];
  if (!Array.isArray(reviewers) || !reviewers.length ||
      reviewers.some(value => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.id || "") ||
        typeof value.name !== "string" || !value.name.trim()) ||
      new Set(reviewers.map(value => value.id.toLowerCase())).size !== reviewers.length)
    throw new Error("Registered reviewer identities are invalid or duplicated");
  const organization = config.ado?.organization === "office" ? "https://dev.azure.com/office"
    : config.ado?.organization?.replace(/\/$/, "");
  if (organization !== "https://dev.azure.com/office" ||
      config.ado?.project !== "Office" || config.ado?.repository !== "1JS")
    throw new Error("Reviewer policy does not belong to the registered 1JS repository");
  return { organization, project: config.ado.project, repository: config.ado.repository, reviewers };
}

export async function verifyReviewerIdentities(organization, reviewers, send) {
  const url = new URL(organization);
  const account = url.hostname === "dev.azure.com" ? url.pathname.split("/").filter(Boolean)[0]
    : url.hostname.split(".")[0];
  const payload = await send(`https://vssps.dev.azure.com/${encodeURIComponent(account)}/_apis/identities?` +
    new URLSearchParams({ identityIds: reviewers.map(value => value.id).join(","),
      queryMembership: "None", "api-version": "7.1" }));
  const identities = reviewers.map(expected => {
    const matches = payload.value?.filter(identity => identity.id === expected.id &&
      identity.isActive === true && identity.isContainer !== true &&
      (identity.customDisplayName || identity.providerDisplayName) === expected.name);
    if (matches?.length !== 1) throw new Error(`Reviewer identity could not be verified: ${expected.name}`);
    return { id: expected.id, name: expected.name, isActive: true };
  });
  return { verifiedAt: new Date().toISOString(), identities };
}

export async function assignRequiredReviewers(pr, reviewers, add, readBack) {
  for (const expected of reviewers) {
    if (pr.reviewers?.some(value => value.id === expected.id)) continue;
    await add(expected);
    pr = await readBack();
  }
  const current = await readBack();
  if (!reviewers.every(expected => current.reviewers?.some(value => value.id === expected.id)))
    throw new Error("Required PR reviewer readback failed");
  return current;
}

export function publicationReviewers(policy, accessToken, request) {
  const base = `${policy.organization}/${encodeURIComponent(policy.project)}/_apis/git/repositories/` +
    encodeURIComponent(policy.repository);
  const send = async (url, options = {}) => {
    request ||= (await import("../../../scanners/lib/ado-transport.mjs")).requestJson;
    return request(url, { ...options, token: await accessToken(), cacheMs: 0 });
  };
  return {
    verify: () => verifyReviewerIdentities(policy.organization, policy.reviewers, send),
    async assign(result, evidence, branch) {
      const prUrl = `${base}/pullrequests/${result.pullRequestId}?api-version=7.1`;
      const verify = async () => {
        const pr = await send(prUrl);
        const refs = await send(`${base}/refs?${new URLSearchParams({
          filter: `heads/${branch}`, "api-version": "7.1",
        })}`);
        if (pr.pullRequestId !== result.pullRequestId || pr.status !== "active" ||
            pr.sourceRefName !== `refs/heads/${branch}` ||
            refs.value?.find(ref => ref.name === pr.sourceRefName)?.objectId !== result.commit)
          throw new Error("Published PR identity or source changed during reviewer setup");
        return pr;
      };
      const pr = await assignRequiredReviewers(await verify(), policy.reviewers, expected =>
        send(`${base}/pullrequests/${result.pullRequestId}/reviewers/${expected.id}?api-version=7.1`,
          { method: "PUT", body: { id: expected.id } }), verify);
      return { ...evidence, ready: true, pullRequestId: result.pullRequestId, commit: result.commit,
        reviewers: policy.reviewers.map(expected => {
          const current = pr.reviewers.find(value => value.id === expected.id);
          return { ...expected, vote: current.vote };
        }) };
    },
  };
}
