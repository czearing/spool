import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createPullRequest,
  branchTip,
  defaultBranch,
  getPullRequest,
  listBranchPullRequests,
  patchPullRequest,
  uploadAttachment,
  webUrl,
} from "./ado.ts";
import { CATEGORY_IDS, MAX_TITLE_WORDS, buildTitle, parseTitle, type Category } from "./categories.ts";
import { sendPullRequestLink } from "./discord.ts";
import { runGate, setupBranch, type GateOutcome } from "./gate.ts";
import { callingAgent, shouldNotify } from "./identity.ts";
import { parseDescription, renderDescription } from "./render.ts";
import { validate, type Draft } from "./validate.ts";
import { runOperation, validateOperation } from "./operations.mjs";
import { gitCredentials } from "./git-auth.ts";
import { creationContext, createWithOrigin, preservePrOrigin } from "./pr-origin.mjs";
import { assertActiveUpdate } from "./pr-update-guard.mjs";
import { prepareBundlePublication, finishBundlePublication } from "./bundle-gate.mjs";
import { PREPARATION_BLOCKED } from "./resume-state.mjs";

export type ToolRequest = {
  id?: string | number;
  params?: { name?: string; arguments?: Record<string, unknown> };
};

const sectionField = (what: string, sentences: string) => ({
  type: "string",
  minLength: 1,
  maxLength: 400,
  description: `${what} ${sentences}`,
});

const descriptionFields = {
  category: {
    type: "string",
    enum: CATEGORY_IDS,
    description: "Title prefix, added for you.",
  },
  title: {
    type: "string",
    minLength: 1,
    maxLength: 70,
    description: `Up to ${MAX_TITLE_WORDS} words, fewer is better. No category prefix, no trailing punctuation.`,
  },
  problem: sectionField("State the problem and its impact directly; include only essential information.", "Exactly one sentence."),
  solution: {
    type: "string",
    minLength: 1,
    maxLength: 2000,
    description:
      "Be concise and direct. In one or two sentences, explain what changed and how it fixes the problem. Include only essential reviewer information; omit task history, implementation walkthroughs, and repeated validation. Use a compact table only for relevant measured before/after performance results (required for perf), never for summaries, checklists, or build status. For uiChange, include cropped before/after images; local image paths are uploaded for you.",
  },
  validation: sectionField("State only the relevant checks performed and their outcome; omit logs and checklists.", "Exactly one sentence."),
  uiChange: {
    type: "boolean",
    description: "True when a user sees a difference. Requires images in the solution.",
  },
} as const;

const legacyTools = [
  {
    name: "bohemia_branch_create",
    title: "Create or switch to a Bohemia branch",
    description:
      "Prepare a clean branch for development: fetches the target base branch from origin, creates and checks out the branch in user/calebzearing/<name> format, and optionally runs bohemia setup to warm dependencies and the build.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string", minLength: 1, description: "Azure DevOps repository name (e.g. office-bohemia)." },
        branch: { type: "string", minLength: 1, description: "Branch name or topic (e.g. user/calebzearing/my-feature or my-feature)." },
        baseBranch: {
          type: "string",
          description: "Base branch to branch off of (defaults to master or repository default).",
        },
        runSetup: {
          type: "boolean",
          default: true,
          description: "Whether to run bohemia setup after checkout to warm dependencies.",
        },
      },
      required: ["repository", "branch"],
      additionalProperties: false,
    },
  },
  {
    name: "bohemia_pr_create",
    title: "Create a Bohemia pull request",
    description:
      "Run the repository's required checks on the changed packages, then open a pull request and send Caleb the link on Discord. Refuses to open one if a check fails. Fill one field per section; the title and body are built for you. Plain wording: no file names, paths, line numbers, task ids, dates, em dashes, or hype.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string", minLength: 1, description: "Azure DevOps repository name." },
        sourceBranch: { type: "string", minLength: 1, description: "Branch holding the change." },
        targetBranch: {
          type: "string",
          minLength: 1,
          description: "Defaults to the repository's own default branch.",
        },
        draft: {
          type: "boolean",
          default: false,
          description: "Open as a draft. Use when Caleb reviews before it is published.",
        },
        ...descriptionFields,
      },
      required: [
        "repository",
        "sourceBranch",
        "category",
        "title",
        "problem",
        "solution",
        "validation",
        "uiChange",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "bohemia_pr_update",
    title: "Update a Bohemia pull request",
    description:
      "Run the repository's required checks, then update a pull request's title, sections or target branch. Retargeting validates against the requested target before changing it. Refuses to change anything if a check fails. Omitted sections are read back and revalidated, so the result always conforms.",
    inputSchema: {
      type: "object",
      properties: {
        repository: { type: "string", minLength: 1 },
        pullRequestId: { type: "integer", minimum: 1 },
        targetBranch: {
          type: "string",
          minLength: 1,
          description: "Retarget the existing PR only after required checks pass against this branch.",
        },
        ...descriptionFields,
        notify: {
          type: "boolean",
          default: false,
          description: "Send the link to Caleb on Discord again.",
        },
      },
      required: ["repository", "pullRequestId"],
      additionalProperties: false,
    },
  },
] as const;

const workspaceFields = {
  repoRoot: { type: "string", description: "Absolute path to this task's checkout; never another active agent's workspace." },
  baseBranch: { type: "string", default: "master" },
  packages: { type: "array", items: { type: "string" }, description: "Optional package names for the repository build." },
};

export const tools = [
  {
    name: "bohemia_prepare",
    description: "Prepare an explicit checkout using shared Bohemia setup. branch positions a branch; master only refreshes origin/master without touching the current branch; setup installs and warms the existing checkout. Never reset another active agent's workspace. Reviewer calls use an exact sourceCommit and never merge master.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["repoRoot", "operation"],
      properties: {
        ...workspaceFields,
        operation: { type: "string", enum: ["branch", "master", "setup"] },
        mode: { type: "string", enum: ["create", "checkout", "resume"], default: "checkout" },
        branch: { type: "string" },
        sourceCommit: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
        expectedHead: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
        seedRoot: { type: "string", description: "Existing local repository used to provision a missing independent checkout." },
        minimumFreeGiB: { type: "number", exclusiveMinimum: 0, description: "Minimum available disk space before provisioning and preparation stages." },
        reset: { type: "boolean", default: false, description: "Explicitly discard tracked and untracked changes in an idle, owned checkout. Never valid for resume." },
        mergeMaster: { type: "boolean", default: false },
        allowConflicts: { type: "boolean", default: false, description: "Leave merge conflicts for a conflict-repair agent." },
        runSetup: { type: "boolean", default: true },
        runBuild: { type: "boolean", default: true, description: "Warm the repository build. Set false for build/conflict repair admission; dependency install still must pass." },
      },
    },
  },
  ...(["build", "check"] as const).map(action => ({
    name: `bohemia_${action}`,
    description: action === "build" ? "Run the existing Bohemia dependency build in an explicit checkout." : "Run the repository's existing required validation gates. Does not reset, switch, or publish.",
    inputSchema: { type: "object", additionalProperties: false, required: ["repoRoot"],
      properties: action === "build"
        ? { repoRoot: workspaceFields.repoRoot, packages: workspaceFields.packages,
          prepareTests: { type: "boolean", default: false,
            description: "After the dependency build, execute selected packages' declared test setup prefixes and verify their Jest configuration loads. Requires explicit packages." },
          productionArtifacts: { type: "boolean", default: false,
            description: "Build release bundles and repository-owned Brotli sidecars for explicitly selected packages, without deployment or upload." } }
        : { repoRoot: workspaceFields.repoRoot, baseBranch: workspaceFields.baseBranch } },
  })),
  {
    name: "bohemia_pr",
    description: "Create or update a PR through the existing required checks, title/description rules, image upload, and notification policy. action=create requires sourceBranch and all description fields. action=update requires pullRequestId, reads omitted sections, and permits retargeting with targetBranch after validating against the new target. Omit sourceBranch and draft for updates. Never posts PR comments.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        ...legacyTools[1].inputSchema.properties, ...legacyTools[2].inputSchema.properties,
        sourceBranch: { ...legacyTools[1].inputSchema.properties.sourceBranch, description: "Create only. Omit for update; the existing PR supplies its source branch." },
        targetBranch: { ...legacyTools[1].inputSchema.properties.targetBranch, description: "For create, defaults to the repository default. For update, omit to preserve the target or specify a branch to retarget after its required checks pass." },
        draft: { ...legacyTools[1].inputSchema.properties.draft, description: "Create only. Omit for update." },
        pullRequestId: { ...legacyTools[2].inputSchema.properties.pullRequestId, description: "Update only. The existing PR to update." },
        notify: { ...legacyTools[2].inputSchema.properties.notify, description: "Update only. Send the PR link on Discord again." },
        action: { type: "string", enum: ["create", "update"] },
      },
      required: ["action", "repository"],
      oneOf: [
        { properties: { action: { const: "create" }, pullRequestId: false, notify: false }, required: legacyTools[1].inputSchema.required },
        { properties: { action: { const: "update" }, sourceBranch: false, draft: false }, required: legacyTools[2].inputSchema.required },
      ],
    },
  },
];

export const response = (id: ToolRequest["id"], result: object) => ({ jsonrpc: "2.0", id, result });

export const failure = (id: ToolRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

const toolResult = (id: ToolRequest["id"], text: string, isError: boolean) =>
  response(id, { content: [{ type: "text", text }], isError });

const rejection = (violations: string[]) =>
  [
    "Rejected. The description was not published. Fix every point and call the tool again.",
    ...violations.map((violation) => `- ${violation}`),
  ].join("\n");

const checksRejection = (gate: GateOutcome) =>
  [
    `Rejected. The required checks failed${gate.seconds ? ` after ${gate.seconds}s` : ""}, so no pull request was opened. Fix these, then call the tool again.`,
    ...gate.reasons.map((reason) => `  ${reason}`),
  ].join("\n");

function draftFrom(args: Record<string, any>): Draft {
  return {
    category: args.category as Category,
    title: String(args.title ?? ""),
    problem: String(args.problem ?? ""),
    solution: String(args.solution ?? ""),
    validation: String(args.validation ?? ""),
    uiChange: Boolean(args.uiChange),
  };
}

const IMAGE_MARKDOWN = /!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(\s+"[^"]*")?\s*\)/g;

/// Uploads only images the agent gave as local paths. Images already hosted, such as
/// those carried over from the stored description, are left alone so editing one
/// sentence does not orphan a fresh copy of every attachment.
async function uploadLocalImages(
  repository: string,
  pullRequestId: number,
  markdown: string,
): Promise<string> {
  const targets = [...markdown.matchAll(IMAGE_MARKDOWN)]
    .map((match) => match[2])
    .filter((target) => !/^https?:\/\//i.test(target));
  const uploaded = new Map<string, string>();
  for (const target of new Set(targets)) {
    uploaded.set(target, await uploadAttachment(repository, pullRequestId, target));
  }
  return markdown.replace(IMAGE_MARKDOWN, (whole, alt, target) =>
    uploaded.has(target) ? `![${alt}](${uploaded.get(target)})` : whole,
  );
}

async function create(id: ToolRequest["id"], args: Record<string, any>) {
  const draft = draftFrom(args);
  const violations = validate(draft);
  if (violations.length) return toolResult(id, rejection(violations), true);

  const repository = String(args.repository);
  const agent = callingAgent();
  const title = buildTitle(draft.category, draft.title);
  const sourceBranch = String(args.sourceBranch);
  const targetBranch = String(args.targetBranch ?? (await defaultBranch(repository)));
  const context = creationContext();

  // The checks run before anything reaches Azure DevOps, so a failing branch leaves no pull
  // request behind to abandon. They are the repository's own gate, scoped by merge base exactly
  // as CI scopes itself, rather than a second definition of what "valid" means.
  const gate = await runGate({
    repository,
    sourceBranch,
    targetBranch,
    repoRoot: context?.workspace || undefined,
    headCommit: await branchTip(repository, sourceBranch),
  });
  if (!gate.ok) return toolResult(id, checksRejection(gate), true);

  if (!gate.repoRoot || !gate.headCommit) throw new Error("Publication gate did not return a checked checkout and commit");
  const bundle = await prepareBundlePublication({
    repoRoot: gate.repoRoot, branch: sourceBranch, headCommit: gate.headCommit, context,
  });
  const remoteHead = await branchTip(repository, sourceBranch);
  if (remoteHead !== gate.headCommit) {
    const { pushPublicationBranch } = await import("./gate.ts");
    await pushPublicationBranch(gate.repoRoot, sourceBranch, targetBranch, gate.headCommit);
  }
  if (await branchTip(repository, sourceBranch) !== gate.headCommit) {
    throw new Error("Azure DevOps source branch does not match the checked commit; PR creation refused");
  }

  // Attachments are addressed by pull request, so the description is written twice:
  // once to open it, once with the host's own image URLs embedded.
  const created = await createWithOrigin({
    context, repoRoot: gate.repoRoot,
    input: { repository, sourceBranch, targetBranch, title,
      description: renderDescription(draft), draft: Boolean(args.draft) },
    api: { create: createPullRequest, get: getPullRequest, list: listBranchPullRequests, url: webUrl },
  });
  const solution = await uploadLocalImages(repository, created.pullRequestId, draft.solution);
  if (solution !== draft.solution) {
    await patchPullRequest(repository, created.pullRequestId, {
      description: preservePrOrigin(created.description, renderDescription({ ...draft, solution })),
    });
  }
  if (bundle) await finishBundlePublication(bundle, await getPullRequest(repository, created.pullRequestId));

  const url = webUrl(repository, created.pullRequestId);
  const state = args.draft ? "Draft" : "Published";
  const discord = shouldNotify()
    ? `Discord as ${agent}: ${await sendPullRequestLink({ agent, title, url, action: "opened" })}`
    : "Discord skipped: you are the caller, not an agent";
  return toolResult(
    id,
    `${state} ${title}\n${url}\nChecks passed in ${gate.seconds}s\n${discord}\n${retestLine(draft)}`,
    false,
  );
}

/// The retest obligation, stated at the moment it applies and only for what this pull request
/// actually contains. As standing prompt text it had to enumerate every case to every agent on
/// every turn; here the tool already knows which case this is, so the agent is told one thing.
export function retestLine(draft: Draft): string {
  const parts: string[] = [];
  if (draft.category === "perf") parts.push("the benchmarks rerun and the table refreshed");
  if (draft.uiChange) parts.push("the screenshots retaken");
  if (!parts.length) parts.push("its tests rerun");
  return `Any further change here needs ${parts.join(", ")}.`;
}

async function update(id: ToolRequest["id"], args: Record<string, any>) {
  const requestedTargetBranch = typeof args.targetBranch === "string"
    ? args.targetBranch.trim().replace(/^refs\/heads\//, "").replace(/^origin\//, "")
    : undefined;
  if (args.targetBranch !== undefined && !requestedTargetBranch) {
    throw new Error("targetBranch must be a nonempty branch name");
  }
  const repository = String(args.repository);
  const pullRequestId = Number(args.pullRequestId);
  const existing = await getPullRequest(repository, pullRequestId);
  assertActiveUpdate(existing);
  const stored = parseTitle(existing.title ?? "");
  const sections = parseDescription(existing.description ?? "");

  const draft: Draft = {
    category: (args.category as Category) ?? stored.category,
    title: args.title !== undefined ? String(args.title) : stored.title,
    problem: args.problem !== undefined ? String(args.problem) : sections.problem,
    // The stored solution is kept verbatim, tables and images included, so revising
    // one sentence cannot silently drop the evidence beneath it.
    solution: args.solution !== undefined ? String(args.solution) : sections.solution,
    validation: args.validation !== undefined ? String(args.validation) : sections.validation,
    uiChange:
      args.uiChange !== undefined
        ? Boolean(args.uiChange)
        : /!\[[^\]]*\]\(/.test(
            args.solution !== undefined ? String(args.solution) : sections.solution,
          ),
  };

  if (!draft.category) {
    return toolResult(
      id,
      rejection(["the stored title has no recognised category prefix, so category must be supplied"]),
      true,
    );
  }
  const violations = validate(draft);
  if (violations.length) return toolResult(id, rejection(violations), true);

  // The same checks create runs, for the same reason. An update is not a wording edit: the tool
  // exists so that revising a pull request means revising the change behind it, and a gate that
  // guards one write path and exempts the other is not a gate, it is the route people take.
  // Cheap when nothing moved, because lage replays the cached result for an unchanged tree.
  const sourceBranch = (existing.sourceRefName ?? "").replace(/^refs\/heads\//, "");
  const targetBranch = requestedTargetBranch ?? (existing.targetRefName ?? "").replace(/^refs\/heads\//, "");
  if (!sourceBranch) {
    return toolResult(
      id,
      rejection([
        `pull request ${pullRequestId} reports no source branch, so its checks cannot be run`,
      ]),
      true,
    );
  }
  const gate = await runGate({
    repository,
    sourceBranch,
    targetBranch: targetBranch || undefined,
    headCommit: await branchTip(repository, sourceBranch),
  });
  if (!gate.ok) return toolResult(id, checksRejection(gate), true);

  if (!gate.repoRoot || !gate.headCommit) throw new Error("Publication gate did not return a checked checkout and commit");
  const bundle = await prepareBundlePublication({
    repoRoot: gate.repoRoot, branch: sourceBranch, headCommit: gate.headCommit,
  });
  assertActiveUpdate(await getPullRequest(repository, pullRequestId), existing);
  if (await branchTip(repository, sourceBranch) !== gate.headCommit) {
    const { pushPublicationBranch } = await import("./gate.ts");
    await pushPublicationBranch(gate.repoRoot, sourceBranch, targetBranch, gate.headCommit);
  }
  if (await branchTip(repository, sourceBranch) !== gate.headCommit) {
    throw new Error("Azure DevOps source branch does not match the checked commit; PR update refused");
  }
  const solution = await uploadLocalImages(repository, pullRequestId, draft.solution);
  const title = buildTitle(draft.category, draft.title);
  assertActiveUpdate(await getPullRequest(repository, pullRequestId), existing);
  if (requestedTargetBranch && existing.targetRefName !== `refs/heads/${targetBranch}`) {
    // Azure DevOps ignores wording changes sent in the same request as a retarget.
    const retargeted = await patchPullRequest(repository, pullRequestId, {
      targetRefName: `refs/heads/${targetBranch}`,
    });
    if (retargeted.targetRefName !== `refs/heads/${targetBranch}`) {
      throw new Error(`Pull request ${pullRequestId} did not retain the checked target ${targetBranch}`);
    }
  }
  await patchPullRequest(repository, pullRequestId, {
    title,
    description: preservePrOrigin(existing.description, renderDescription({ ...draft, solution })),
  });
  if (bundle) await finishBundlePublication(bundle, await getPullRequest(repository, pullRequestId));

  const url = webUrl(repository, pullRequestId);
  let notified = "not requested";
  if (args.notify && shouldNotify()) {
    notified = await sendPullRequestLink({
      agent: callingAgent(),
      title,
      url,
      action: "updated",
    });
  } else if (args.notify) {
    notified = "skipped: you are the caller, not an agent";
  }
  return toolResult(
    id,
    `Updated ${title}\n${url}\nChecks passed in ${gate.seconds}s\nDiscord: ${notified}\n${retestLine(draft)}`,
    false,
  );
}

async function branch(id: ToolRequest["id"], args: Record<string, any>) {
  const repository = typeof args.repository === "string" ? args.repository.trim() : "";
  const branchName =
    typeof args.branch === "string"
      ? args.branch.trim()
      : typeof args.branchName === "string"
        ? args.branchName.trim()
        : "";
  const baseBranch = typeof args.baseBranch === "string" ? args.baseBranch.trim() : undefined;
  const runSetup = args.runSetup !== false;

  if (!repository) return toolResult(id, "repository is required", true);
  if (!branchName) return toolResult(id, "branch is required", true);

  const res = await setupBranch({ repository, branch: branchName, baseBranch, runSetup });
  if (!res.ok) {
    return toolResult(id, `Branch setup failed:\n${res.reasons.join("\n")}`, true);
  }

  return toolResult(
    id,
    `Branch ready: ${res.branchName}\nClone: ${res.repoRoot}\nBase: ${baseBranch || "master"}${runSetup ? `\nbohemia setup completed in ${res.seconds}s` : ""}`,
    false,
  );
}

function appendMcpLog(record: Record<string, unknown>) {
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
    if (!home) return;
    const dir = join(home, ".bohemia-gate");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "mcp-runs.jsonl"), `${JSON.stringify(record)}\n`);
  } catch {}
}

export async function callTool(request: ToolRequest) {
  const name = request.params?.name;
  const args = (request.params?.arguments ?? {}) as Record<string, any>;
  const startedAt = new Date().toISOString();
  const startMs = performance.now();

  try {
    let result: any;
    if (name === "bohemia_prepare" || name === "bohemia_build" || name === "bohemia_check") {
      const action = name.slice("bohemia_".length);
      const schema = tools.find(tool => tool.name === name)!.inputSchema;
      for (const field of schema.required) if (args[field] === undefined) throw new Error(`${field} is required`);
      for (const field of Object.keys(args)) if (!(field in schema.properties)) throw new Error(`Unknown argument: ${field}`);
      validateOperation(action, args);
      const credentials = await gitCredentials(args.seedRoot && !existsSync(args.repoRoot) ? args.seedRoot : args.repoRoot);
      const prepared = runOperation(action, args, credentials);
      result = response(request.id, { content: [{ type: "text", text: JSON.stringify(prepared) }], structuredContent: prepared, isError: false });
    } else if (name === "bohemia_pr") {
      if (args.action !== "create" && args.action !== "update") throw new Error("action must be create or update");
      const schema = legacyTools[args.action === "create" ? 1 : 2].inputSchema;
      for (const field of schema.required) if (args[field] === undefined) throw new Error(`${field} is required for PR ${args.action}`);
      const allowed = new Set(["action", ...Object.keys(schema.properties)]);
      for (const field of Object.keys(args)) if (!allowed.has(field)) throw new Error(`${field} is not valid for PR ${args.action}`);
      result = args.action === "create" ? await create(request.id, args) : await update(request.id, args);
    } else if (name === "bohemia_branch_create" || name === "bohemia_branch_setup") {
      result = await branch(request.id, args);
    } else if (name === "bohemia_pr_create") {
      result = await create(request.id, args);
    } else if (name === "bohemia_pr_update") {
      result = await update(request.id, args);
    } else {
      return failure(request.id, -32601, `unknown tool: ${name}`);
    }

    const completedAt = new Date().toISOString();
    const durationMs = performance.now() - startMs;
    const durationSeconds = Math.round(durationMs / 1000);
    const text = result?.result?.content?.[0]?.text || "";
    const isError = Boolean(result?.result?.isError);
    const prIdMatch = text.match(/pullrequest\/(\d+)/i) || (args.pullRequestId ? [null, String(args.pullRequestId)] : null);
    const prId = prIdMatch ? Number(prIdMatch[1]) : undefined;
    const prUrl = prId ? `https://office.visualstudio.com/OC/_git/${args.repository || "office-bohemia"}/pullrequest/${prId}` : undefined;

    appendMcpLog({
      sessionId: process.env.COPILOT_SESSION_ID || "unknown",
      toolName: name,
      startedAt,
      completedAt,
      durationMs,
      durationSeconds,
      success: !isError,
      prId,
      prUrl,
      title: args.title ? `${args.category ? args.category + ': ' : ''}${args.title}` : undefined,
      category: args.category || "",
      args,
      result: text,
    });

    return result;
  } catch (caught) {
    const completedAt = new Date().toISOString();
    const durationMs = performance.now() - startMs;
    const errText = `FAILED: ${caught instanceof Error ? caught.message : caught}`;
    appendMcpLog({
      sessionId: process.env.COPILOT_SESSION_ID || "unknown",
      toolName: name,
      startedAt,
      completedAt,
      durationMs,
      durationSeconds: Math.round(durationMs / 1000),
      success: false,
      args,
      result: errText,
    });
    if (caught instanceof Error && "code" in caught && caught.code === PREPARATION_BLOCKED) {
      return response(request.id, { content: [{ type: "text", text: errText }], isError: true,
        structuredContent: { ok: false, ready: false, code: PREPARATION_BLOCKED, reason: caught.message,
          ...("reasonCode" in caught && typeof caught.reasonCode === "string" ? { reasonCode: caught.reasonCode } : {}) } });
    }
    return toolResult(request.id, errText, true);
  }
}
