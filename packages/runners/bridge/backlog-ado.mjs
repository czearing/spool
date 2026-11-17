import { requestJson } from "../scanners/lib/ado-transport.mjs";
import { listOwnPullRequests } from "../scanners/pr-updater/lib/azure-devops.mjs";
import { verifyReviewerIdentities, assignRequiredReviewers } from "../packages/repository-mcp/src/reviewers.mjs";

const api = "api-version=7.1";
const fields = ["System.Id", "System.TeamProject", "System.Title", "System.WorkItemType", "System.State",
  "System.AssignedTo", "System.CreatedDate", "Microsoft.VSTS.Common.Priority"];
export const sameArtifact = (a, b) => decodeURIComponent(a).toLowerCase() === decodeURIComponent(b).toLowerCase();
export const prArtifacts = item => item.relations.filter(link =>
  link.rel === "ArtifactLink" && link.url?.startsWith("vstfs:///Git/PullRequestId/"));

export function workItem(raw, parentId) {
  const f = raw?.fields;
  if (!Number.isSafeInteger(raw?.id) || !Number.isSafeInteger(raw.rev) || !f ||
      !fields.slice(1, 5).every(field => typeof f[field] === "string") ||
      !Number.isFinite(Date.parse(f["System.CreatedDate"])))
    throw new Error("Invalid backlog work-item response");
  const priority = f["Microsoft.VSTS.Common.Priority"];
  if (priority !== undefined && (!Number.isSafeInteger(priority) || priority < 1))
    throw new Error(`Invalid priority for work item ${raw.id}`);
  const relations = raw.relations || [];
  const parents = relations.filter(link => link.rel === "System.LinkTypes.Hierarchy-Reverse");
  return { id: raw.id, rev: raw.rev, title: f["System.Title"], type: f["System.WorkItemType"],
    state: f["System.State"], project: f["System.TeamProject"],
    resolvedReason: f["Microsoft.VSTS.Common.ResolvedReason"],
    assignedTo: f["System.AssignedTo"]?.uniqueName || "", priority: priority ?? null,
    createdAt: f["System.CreatedDate"], relations,
    parentId: parentId ?? (parents.length === 1 ? Number(parents[0].url.split("/").at(-1)) : null) };
}
export const orderWorkItems = items => [...items].sort((a, b) =>
  (a.priority ?? Infinity) - (b.priority ?? Infinity) ||
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
export const assignedChild = (config, item) => item.parentId === config.parentWorkItem &&
  item.project.toLowerCase() === config.workItemProject.toLowerCase() &&
  item.assignedTo.toLowerCase() === config.ado.authorAccount.toLowerCase();

export function createBacklogClient(config, { request = requestJson, credential = null } = {}) {
  const organization = config.ado.organization.replace(/\/$/, "");
  const work = `${organization}/${encodeURIComponent(config.workItemProject)}/_apis/wit`;
  const git = `${organization}/${encodeURIComponent(config.ado.project)}/_apis/git/repositories/${encodeURIComponent(config.ado.repository)}`;
  const auth = async () => credential ? { token: await credential.token() } : {};
  async function send(url, options = {}) {
    try { return await request(url, { ...options, ...await auth() }); }
    catch (error) { if (error.tokenRejected) credential?.clear(); throw error; }
  }
  const getItem = async id => workItem(await send(`${work}/workitems/${id}?$expand=relations&${api}`));
  const states = async type => {
    const result = await send(`${work}/workitemtypes/${encodeURIComponent(type)}/states?${api}`);
    if (!Array.isArray(result?.value) || !result.value.length) throw new Error(`Missing state definitions for ${type}`);
    return result.value;
  };
  const category = async item => {
    const state = (await states(item.type)).find(state => state.name === item.state);
    if (!state?.category) throw new Error(`Unknown ${item.type} state: ${item.state}`);
    return state.category;
  };
  const isOpen = async item => !["Completed", "Removed"].includes(await category(item));
  const getPr = id => send(`${git}/pullrequests/${id}?${api}`);
  async function patchItem(item, changes) {
    await send(`${work}/workitems/${item.id}?${api}`, { method: "PATCH",
      contentType: "application/json-patch+json", body: [{ op: "test", path: "/rev", value: item.rev }, ...changes] });
    return getItem(item.id);
  }
  return {
    item: getItem, isOpen, isCompleted: async item => await category(item) === "Completed", getPr,
    async activate(item) {
      if (!assignedChild(config, item)) throw new Error(`Work item ${item.id} assignment changed before activation`);
      const workflow = await states(item.type);
      const active = workflow.find(state => state.name === "Active" && state.category === "InProgress");
      if (!active) throw new Error(`Missing Active workflow state for ${item.type}`);
      if (item.state === active.name) return item;
      if (workflow.find(state => state.name === item.state)?.category !== "Proposed")
        throw new Error(`Work item ${item.id} is no longer awaiting activation`);
      const updated = await patchItem(item, [{ op: "add", path: "/fields/System.State", value: active.name }]);
      if (updated.state !== active.name || !assignedChild(config, updated))
        throw new Error("Work-item activation readback failed");
      return updated;
    },
    async list() {
      const parent = await send(`${work}/workitems/${config.parentWorkItem}?$expand=relations&${api}`);
      if (parent.id !== config.parentWorkItem || parent.fields?.["System.TeamProject"] !== config.workItemProject)
        throw new Error("Backlog parent identity/project changed");
      const ids = (parent.relations || []).filter(link => link.rel === "System.LinkTypes.Hierarchy-Forward")
        .map(link => Number(link.url.split("/").at(-1)));
      if (ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length)
        throw new Error("Invalid backlog child identities");
      const items = [];
      for (let offset = 0; offset < ids.length; offset += 200) {
        const chunk = ids.slice(offset, offset + 200);
        const result = await send(`${work}/workitemsbatch?${api}`, { method: "POST", body: { ids: chunk, fields } });
        if (!Array.isArray(result?.value) || result.value.length !== chunk.length ||
            new Set(result.value.map(item => item.id)).size !== chunk.length ||
            result.value.some(item => !chunk.includes(item.id))) throw new Error("Incomplete backlog batch response");
        for (const raw of result.value) {
          const item = workItem(raw, config.parentWorkItem);
          if (assignedChild(config, item) && await isOpen(item)) items.push(item);
        }
      }
      return orderWorkItems(items);
    },
    async verifyReviewers() {
      return verifyReviewerIdentities(organization, config.reviewers, send);
    },
    async listPullRequests(ado, options) {
      try { return await listOwnPullRequests(ado, { ...options, ...await auth() }); }
      catch (error) { if (error.tokenRejected) credential?.clear(); throw error; }
    },
    async findPr(branch) {
      const query = new URLSearchParams({ "searchCriteria.status": "all", "searchCriteria.creatorId": config.ado.creatorId,
        "searchCriteria.sourceRefName": `refs/heads/${branch}`, "$top": "2", "api-version": "7.1" });
      const result = await send(`${git}/pullrequests?${query}`);
      if (!Array.isArray(result?.value) || result.value.length > 1) throw new Error("Ambiguous backlog branch PR association");
      return result.value[0] || null;
    },
    async repository() {
      const repo = await send(`${git}?${api}`);
      if (!repo.id || repo.project?.id !== config.ado.projectId || repo.name !== config.ado.repository ||
          repo.defaultBranch !== `refs/heads/${config.baseBranch}`) throw new Error("Backlog repository scope/base changed");
      return repo;
    },
    artifact: (repo, pr) => `vstfs:///Git/PullRequestId/${repo.project.id}%2F${repo.id}%2F${pr.pullRequestId}`,
    async link(item, artifact) {
      const linked = await patchItem(item, [{ op: "add", path: "/relations/-",
        value: { rel: "ArtifactLink", url: artifact, attributes: { name: "Pull Request" } } }]);
      if (!prArtifacts(linked).some(link => sameArtifact(link.url, artifact))) throw new Error("PR artifact readback failed");
      return linked;
    },
    async reviewers(pr) {
      return assignRequiredReviewers(pr, config.reviewers, expected =>
        send(`${git}/pullrequests/${pr.pullRequestId}/reviewers/${expected.id}?${api}`,
          { method: "PUT", body: { id: expected.id } }), () => getPr(pr.pullRequestId));
    },
    async close(item) {
      const completed = (await states(item.type)).filter(state => state.category === "Completed");
      if (completed.length !== 1) throw new Error(`Ambiguous completion state for ${item.type}`);
      const changes = [{ op: "add", path: "/fields/System.State", value: completed[0].name }];
      if (item.type === "Bug" && !item.resolvedReason) {
        const definition = await send(`${work}/workitemtypes/Bug/fields?$expand=all&${api}`);
        if (!Array.isArray(definition?.value)) throw new Error("Missing Bug field definitions");
        const reason = definition.value.find(field => field.referenceName === "Microsoft.VSTS.Common.ResolvedReason");
        if (reason) {
          if (!reason.allowedValues?.includes("Fixed")) throw new Error("Bug workflow has no verified Fixed resolution");
          changes.unshift({ op: "add", path: "/fields/Microsoft.VSTS.Common.ResolvedReason", value: "Fixed" });
        }
      }
      const closed = await patchItem(item, changes);
      if (closed.state !== completed[0].name ||
          changes.length > 1 && closed.resolvedReason !== "Fixed") throw new Error("Work-item closure readback failed");
      return closed;
    },
    itemUrl(id) {
      const url = new URL(organization);
      const origin = url.hostname === "dev.azure.com" ? `https://${url.pathname.split("/").filter(Boolean)[0]}.visualstudio.com` : url.origin;
      return `${origin}/${encodeURIComponent(config.workItemProject)}/_workitems/edit/${id}`;
    },
  };
}
