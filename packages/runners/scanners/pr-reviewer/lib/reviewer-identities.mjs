import { getJson } from "../../lib/ado-transport.mjs";

export function readReviewerJson(url, options, cacheMs, metric) {
  return (options.getJson || getJson)(url.href, options.token, options.fetchImpl, options.refresh, {
    cacheMs: options.fresh ? 0 : cacheMs, metric,
  });
}

function identityUrl(organization, parameters) {
  const url = new URL(organization);
  const account = url.hostname === "dev.azure.com" && url.pathname.split("/").filter(Boolean).length === 1
    ? url.pathname.split("/").filter(Boolean)[0] : url.hostname.match(/^([^.]+)\.visualstudio\.com$/)?.[1];
  if (!account) throw new Error(`Unsupported Azure DevOps organization for reviewer identity lookup: ${url.origin}`);
  const endpoint = new URL(`https://vssps.dev.azure.com/${account}/_apis/identities`);
  endpoint.search = new URLSearchParams({ ...parameters, "api-version": "7.1" });
  return endpoint;
}

export async function resolveReviewer(scope, email, options) {
  const payload = await readReviewerJson(identityUrl(scope.organization, {
    searchFilter: "General", filterValue: email, queryMembership: "Expanded",
  }), options, 300_000, "reviewer.identities");
  if (!Array.isArray(payload.value)) throw new Error("Azure DevOps returned invalid reviewer identities");
  const matches = payload.value.filter(identity => identity.id && identity.isActive !== false
    && identity.isContainer !== true && ["Account", "Mail"].some(property =>
      String(identity.properties?.[property]?.$value || "").toLowerCase() === email.toLowerCase()));
  if (matches.length !== 1) {
    throw new Error(`Azure DevOps reviewer identity must resolve uniquely for ${email}; found ${matches.length}`);
  }
  if (!Array.isArray(matches[0].memberOf) || matches[0].memberOf.some(group => typeof group !== "string" || !group)) {
    throw new Error("Azure DevOps returned incomplete expanded reviewer memberships");
  }
  return { id: matches[0].id, memberships: new Set(matches[0].memberOf) };
}

export async function resolveReviewerGroups(scope, pullRequests, reviewer, options) {
  const ids = new Set();
  for (const pr of pullRequests) {
    if (!Array.isArray(pr.reviewers)) throw new Error("Azure DevOps returned incomplete pull request reviewers");
    for (const identity of pr.reviewers) if (identity.isContainer === true) {
      if (typeof identity.id !== "string" || !identity.id) throw new Error("Azure DevOps returned an invalid reviewer group");
      ids.add(identity.id);
    }
  }
  const groups = new Map(), requested = [...ids].sort();
  if (!reviewer.memberships.size) return groups;
  for (let offset = 0; offset < requested.length; offset += 40) {
    const batch = requested.slice(offset, offset + 40);
    const payload = await readReviewerJson(identityUrl(scope.organization, {
      identityIds: batch.join(","), queryMembership: "None",
    }), options, 300_000, "reviewer.groups");
    if (!Array.isArray(payload.value)) throw new Error("Azure DevOps returned invalid reviewer group identities");
    for (const id of batch) {
      const matches = payload.value.filter(group => group.id === id);
      if (matches.length !== 1 || typeof matches[0].descriptor !== "string" || matches[0].isContainer !== true) {
        throw new Error("Azure DevOps reviewer groups did not resolve completely");
      }
      const group = matches[0];
      if (group.isActive !== false && reviewer.memberships.has(group.descriptor)) {
        groups.set(id, { id, name: group.providerDisplayName || id });
      }
    }
  }
  return groups;
}
