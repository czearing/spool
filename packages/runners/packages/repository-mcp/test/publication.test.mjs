import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publish } from "../src/publication.mjs";
import { pullRequestDraft, prFields, renderPullRequest } from "../src/adapters/1js-pr-policy.mjs";
import { HEADINGS, renderDescription } from "../../bohemia-pr-mcp/src/render.ts";
import { descriptionFields } from "../../bohemia-pr-mcp/src/tools.ts";
import { publicationChangeAllowed } from "../src/adapters/1js-packages.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "repository-publication-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const good = {
  action: "create", sourceBranch: "user/test/library", category: "fix", title: "Keep Library navigation stable",
  problem: "Library navigation reset the selected item.",
  solution: "Navigation now retains the selected item.",
  validation: "The Library checks passed.",
  uiChange: false,
};
function storedPr(draft = good, screenshots = "See the solution above.") {
  return renderPullRequest(pullRequestDraft({ ...draft,
    solution: `${draft.solution}\n\n${screenshots}`, uiChange: /!\[/.test(screenshots) || draft.uiChange }));
}
function fixture(input = {}) {
  const directory = fs.mkdtempSync(path.join(scratch, "publication-"));
  const initialHead = "a".repeat(40);
  let currentHead = initialHead;
  let targetHead = "b".repeat(40);
  let mergeBase = "e".repeat(40);
  let remoteHead;
  const events = [];
  const prs = new Map();
  const checkout = {
    root: directory,
    clean: async () => {},
    branch: async () => "user/test/library",
    head: async () => currentHead,
    fetch: async branch => branch === "master" || branch === "release" ? targetHead : remoteHead,
    changedFiles: async () => ["midgard/packages/m365-copilot-app-library/src/a.ts"],
    git: async (...args) => {
      if (args[0] === "merge-base" && args[1] !== "--is-ancestor")
        return args[1] === initialHead ? mergeBase : args[1];
      events.push(["git", ...args]);
      return "Fix navigation";
    },
    networkGit: async (...args) => { events.push(["push", ...args]); remoteHead = currentHead; },
    receiptPath: file => path.join(directory, file),
  };
  const host = {
    tip: async branch => branch === "master" || branch === "release" ? targetHead : remoteHead,
    list: async () => [...prs.values()].map(pr => structuredClone(pr)),
    get: async id => structuredClone(prs.get(id)),
    create: async fields => {
      events.push(["create"]);
      const pr = { ...fields, pullRequestId: prs.size + 1, status: "active" };
      prs.set(pr.pullRequestId, pr);
      return structuredClone(pr);
    },
    update: async (id, fields) => {
      events.push(["update", fields]);
      const pr = { ...prs.get(id), ...fields };
      prs.set(id, pr);
      return structuredClone(pr);
    },
    upload: async () => { events.push(["upload"]); return "https://example.invalid/attachment.png"; },
    url: id => `https://example.invalid/pullrequest/${id}`,
  };
  const options = {
    checkout, host, input: { ...good, ...input }, baseBranch: "master",
    allowsChange: (file, selected) => publicationChangeAllowed(file, selected,
      [{ name: "@1js/m365-copilot-app-library", directory: "midgard/packages/m365-copilot-app-library" }]),
    check: async () => { events.push(["check"]); return ["build", "lint", "typecheck", "test"]; },
    policy: { draft: pullRequestDraft, render: renderPullRequest },
    notify: async () => { events.push(["notify"]); return "sent"; },
  };
  return {
    options, host, checkout, events, prs, directory,
    setHead: value => { currentHead = value; },
    setTarget: value => { targetHead = value; },
    setMergeBase: value => { mergeBase = value; },
    setRemote: value => { remoteHead = value; },
  };
}

describe("1JS PR policy", () => {
  test("uses Bohemia's exact fields, required description inputs, renderer and wording rules", () => {
    const draft = pullRequestDraft(good);
    const rendered = renderPullRequest(draft);
    expect(rendered.title).toBe("\uD83D\uDC1B Fix - Keep Library navigation stable");
    expect(rendered.description).toBe(renderDescription(draft));
    expect(rendered.description.match(/^# .+$/gm)).toEqual(Object.values(HEADINGS));
    for (const [key, field] of Object.entries(descriptionFields)) expect(prFields[key]).toBe(field);
    expect(() => pullRequestDraft({ ...good, title: "This title has far too many words" })).toThrow("at most 6");
    expect(() => pullRequestDraft({ ...good, problem: "Navigation.tsx resets the selection." })).toThrow("source file");
    expect(() => pullRequestDraft({ ...good, problem: "Navigation is slow \u2014 very slow." })).toThrow("em or en dash");
  });
  test("updates preserve omitted sections, measured tables and images", () => {
    const solution = "Navigation now retains the selected item.\n\n| Before | After |\n| --- | --- |\n| 100 ms | 50 ms |\n\n![Before](https://example.invalid/before.png)\n![After](https://example.invalid/after.png)";
    const rendered = renderPullRequest(pullRequestDraft({ ...good, solution, uiChange: true }));
    const draft = pullRequestDraft({ action: "update", problem: "Library navigation lost the current selection." }, rendered);
    expect(draft.solution).toBe(solution);
    expect(draft.validation).toBe(good.validation);
    expect(draft.uiChange).toBe(true);
  });
  test("does not advertise retired Library-only metadata", () => {
    for (const key of ["rollback", "accessibility", "documentation", "performanceBoundary", "performanceEvidence"])
      expect(prFields[key]).toBeUndefined();
  });
  test("retains template-injection protection and the shared UI-image requirement", () => {
    expect(() => pullRequestDraft({ ...good, problem: "## Inject another section" })).toThrow("inject");
    expect(() => pullRequestDraft({ ...good, uiChange: true })).toThrow("before and after images");
    const combined = { ...good, uiChange: true,
      solution: "Navigation retains selection.\n![Before and after](https://example.invalid/comparison.png)" };
    expect(renderPullRequest(pullRequestDraft(combined)).description).toBe(renderDescription(combined));
  });
  test("current shared descriptions retain screenshot evidence on update", () => {
    const images = "![Before](https://example.invalid/before.png)\n![After](https://example.invalid/after.png)";
    const draft = pullRequestDraft({ action: "update" }, storedPr(good, images));
    const rendered = renderPullRequest(draft);
    expect(draft.problem).toBe(good.problem);
    expect(draft.validation).toBe(good.validation);
    expect(draft.uiChange).toBe(true);
    expect(rendered.description).toContain(images);
    expect(rendered.description.match(/^# .+$/gm)).toEqual(Object.values(HEADINGS));
    expect(rendered.description).not.toContain("How to turn off");
  });
  test("performance descriptions use the same measured-table policy as Bohemia", () => {
    const perf = { ...good, category: "perf",
      solution: "Query records are merged before caching.\n\n| Before | After |\n| --- | --- |\n| 100 bytes | 70 bytes |" };
    expect(() => pullRequestDraft({ ...perf, solution: good.solution })).toThrow();
    const rendered = renderPullRequest(pullRequestDraft(perf));
    expect(rendered.description).toBe(renderDescription(perf));
    expect(rendered.description.match(/^# .+$/gm)).toEqual(Object.values(HEADINGS));
    const updated = pullRequestDraft({ action: "update" }, rendered);
    expect(updated.validation).toBe(good.validation);
    expect(renderPullRequest(updated).description).toBe(rendered.description);
  });
});

describe("checked publication", () => {
  test("an explicit draft update becomes reviewable only after checks and verified readback", async () => {
    const f = fixture({ draft: true });
    await publish(f.options);
    f.options.input = { action: "update", pullRequestId: 1, draft: false };
    f.events.length = 0;
    await publish(f.options);
    expect(f.prs.get(1).isDraft).toBe(false);
    expect(f.events.findIndex(event => event[0] === "check")).toBeLessThan(
      f.events.findIndex(event => event[0] === "update"));
  });
  test("omitted draft state is preserved and an ignored explicit draft update fails readback", async () => {
    const f = fixture({ draft: true });
    await publish(f.options);
    f.options.input = { action: "update", pullRequestId: 1 };
    await publish(f.options);
    expect(f.prs.get(1).isDraft).toBe(true);
    const update = f.host.update;
    f.host.update = async (id, { isDraft, ...fields }) => update(id, fields);
    f.options.input.draft = false;
    await expect(publish(f.options)).rejects.toThrow("draft state differs");
  });
  test("create gates, non-force pushes, publishes, reads back and saves evidence in order", async () => {
    const f = fixture();
    const result = await publish(f.options);
    expect(result.ok).toBe(true);
    expect(result.commit).toBe("a".repeat(40));
    expect(f.events.map(event => event[0])).toEqual(["git", "check", "push", "create", "update", "notify"]);
    expect(f.events.find(event => event[0] === "push")).toEqual([
      "push", "push", "--porcelain", "origin", `${"a".repeat(40)}:refs/heads/user/test/library`,
    ]);
    expect([...f.prs.values()][0].description).toContain("<!-- repository-mcp:");
    expect(fs.readdirSync(path.join(f.directory, "publications"))).toHaveLength(1);
  });
  test("a failed check cannot push, create, upload or update", async () => {
    const f = fixture();
    f.options.check = async () => { throw new Error("lint failed"); };
    await expect(publish(f.options)).rejects.toThrow("lint failed");
    expect(f.events.some(event => ["push", "create", "upload", "update"].includes(event[0]))).toBe(false);
  });
  test("rejected performance provenance cannot reach checks or publication", async () => {
    const f = fixture();
    f.options.policy.validate = async () => { throw new Error("invalid performance baseline"); };
    await expect(publish(f.options)).rejects.toThrow("invalid performance baseline");
    expect(f.events).toHaveLength(0);
  });
  test("changed evidence after the required checks cannot reach a push or PR write", async () => {
    const f = fixture();
    let reads = 0;
    f.options.policy.validate = async () => ({ evidenceSha256: String(++reads) });
    await expect(publish(f.options)).rejects.toThrow("Performance evidence changed");
    expect(f.events.some(event => ["push", "create", "upload", "update"].includes(event[0]))).toBe(false);
  });
  test("verified performance provenance is retained in publication readback and receipt", async () => {
    const f = fixture();
    const evidence = { boundary: "data-layer", evidenceSha256: "fixture" };
    f.options.policy.validate = async () => evidence;
    const result = await publish(f.options);
    expect(result.performanceEvidence).toEqual(evidence);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.directory, "publications",
      fs.readdirSync(path.join(f.directory, "publications"))[0]), "utf8"));
    expect(receipt.performanceEvidence).toEqual(evidence);
  });
  test("paths outside Library and its changefiles are refused before checks", async () => {
    const f = fixture();
    f.checkout.changedFiles = async () => ["midgard/packages/other/src/a.ts"];
    await expect(publish(f.options)).rejects.toThrow("outside the validated package");
    expect(f.events).toHaveLength(0);
  });
  test("dirty checkout cannot publish", async () => {
    const f = fixture();
    f.checkout.clean = async () => { throw new Error("dirty"); };
    await expect(publish(f.options)).rejects.toThrow("dirty");
    expect(f.events).toHaveLength(0);
  });
  test("a changed source during checks cannot publish", async () => {
    const f = fixture();
    f.options.check = async () => {
      f.setHead("c".repeat(40));
      return [];
    };
    await expect(publish(f.options)).rejects.toThrow("changed during");
    expect(f.events.some(event => ["push", "create", "update"].includes(event[0]))).toBe(false);
  });
  test("target advances preserve checks when the validated merge-base and package scope are unchanged", async () => {
    const f = fixture();
    const check = f.options.check;
    f.options.check = async () => {
      const result = await check();
      f.setTarget("c".repeat(40));
      return result;
    };
    const result = await publish(f.options);
    expect(result.targetCommit).toBe("c".repeat(40));
    expect(f.events.filter(event => event[0] === "check")).toHaveLength(1);
    expect(result.checks).toEqual(["build", "lint", "typecheck", "test"]);
  });
  test("a changed merge-base during checks cannot publish", async () => {
    const f = fixture();
    f.options.check = async () => {
      f.setTarget("c".repeat(40));
      f.setMergeBase("f".repeat(40));
      return [];
    };
    await expect(publish(f.options)).rejects.toThrow("validated history");
    expect(f.events.some(event => ["push", "create", "update"].includes(event[0]))).toBe(false);
  });
  test("a rewritten target cannot publish even with the same source merge-base", async () => {
    const f = fixture();
    const git = f.checkout.git;
    f.checkout.git = async (...args) => args[0] === "merge-base" && args[1] === "b".repeat(40)
      ? "d".repeat(40) : git(...args);
    f.options.check = async () => { f.setTarget("c".repeat(40)); return []; };
    await expect(publish(f.options)).rejects.toThrow("validated history");
    expect(f.events.some(event => ["push", "create", "update"].includes(event[0]))).toBe(false);
  });
  test("a changed package scope after target refresh cannot publish", async () => {
    const f = fixture();
    f.options.check = async () => {
      f.setTarget("c".repeat(40));
      f.checkout.changedFiles = async () => ["midgard/packages/other/src/a.ts"];
      return [];
    };
    await expect(publish(f.options)).rejects.toThrow("validated package scope");
    expect(f.events.some(event => ["push", "create", "update"].includes(event[0]))).toBe(false);
  });
  test("target changes to a checked PR file cannot publish", async () => {
    const f = fixture();
    const git = f.checkout.git;
    f.checkout.git = async (...args) => args[0] === "diff"
      ? "midgard/packages/m365-copilot-app-library/src/a.ts\0" : git(...args);
    f.options.check = async () => { f.setTarget("c".repeat(40)); return []; };
    await expect(publish(f.options)).rejects.toThrow("files in the checked PR");
    expect(f.events.some(event => ["push", "create", "update"].includes(event[0]))).toBe(false);
  });
  test("target refresh revalidates performance provenance against the fetched commit", async () => {
    const f = fixture();
    f.options.policy.validate = async ({ targetRef }) => ({
      baseline: targetRef === "c".repeat(40) ? "changed" : "original",
    });
    f.options.check = async () => { f.setTarget("c".repeat(40)); return []; };
    await expect(publish(f.options)).rejects.toThrow("Performance evidence changed");
    expect(f.events.some(event => ["push", "create", "update"].includes(event[0]))).toBe(false);
  });
  test("target refresh refuses a checkout changed while fetching", async () => {
    const f = fixture();
    const fetch = f.checkout.fetch;
    let calls = 0;
    f.checkout.fetch = async branch => {
      const result = await fetch(branch);
      if (++calls === 2) f.setHead("d".repeat(40));
      return result;
    };
    f.options.check = async () => { f.setTarget("c".repeat(40)); return []; };
    await expect(publish(f.options)).rejects.toThrow("Checkout changed");
    expect(f.events.some(event => ["push", "create", "update"].includes(event[0]))).toBe(false);
  });
  test("continuously moving targets fail within a bounded refresh budget", async () => {
    const f = fixture();
    const fetch = f.checkout.fetch;
    let calls = 0;
    f.checkout.fetch = async branch => {
      const result = await fetch(branch);
      f.setTarget(String(++calls).padStart(40, "0"));
      return result;
    };
    await expect(publish(f.options)).rejects.toThrow("keeps changing");
    expect(calls).toBe(4);
    expect(f.events.some(event => ["push", "create", "update"].includes(event[0]))).toBe(false);
  });
  test("legacy PR migration tolerates target advances during checks and readback while preserving images", async () => {
    const f = fixture();
    await publish(f.options);
    const marker = f.prs.get(1).description.match(/<!-- repository-mcp:[\w-]+ -->/)[0];
    const images = "![Before](https://example.invalid/before.png)\n![After](https://example.invalid/after.png)";
    f.prs.get(1).description = `${storedPr(good, images).description}\n${marker}`;
    f.options.input = { action: "update", pullRequestId: 1 };
    f.events.length = 0;
    const check = f.options.check;
    f.options.check = async () => {
      const result = await check();
      f.setTarget("c".repeat(40));
      return result;
    };
    const update = f.host.update;
    f.host.update = async (...args) => {
      const result = await update(...args);
      f.setTarget("d".repeat(40));
      return result;
    };
    const result = await publish(f.options);
    expect(result.targetCommit).toBe("d".repeat(40));
    expect(f.events.filter(event => event[0] !== "git" || event[1] !== "diff").map(event => event[0]))
      .toEqual(["git", "check", "update"]);
    expect(f.prs.get(1).description).toContain(images);
    expect(f.prs.get(1).description).toContain(marker);
    expect(f.prs.get(1).description.match(/^# .+$/gm)).toEqual(Object.values(HEADINGS));
    const receipt = JSON.parse(fs.readFileSync(path.join(f.directory, "publications/pr-1.json"), "utf8"));
    expect(receipt.targetCommit).toBe(result.targetCommit);
  });
  test("diverged source cannot be force-pushed", async () => {
    const f = fixture();
    f.setRemote("d".repeat(40));
    const git = f.checkout.git;
    f.checkout.git = async (...args) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") throw new Error("not an ancestor");
      return git(...args);
    };
    await expect(publish(f.options)).rejects.toThrow("not an ancestor");
    expect(f.events.some(event => event[0] === "push")).toBe(false);
  });
  test("AI attribution blocks publication before checks", async () => {
    const f = fixture();
    f.checkout.git = async () => "Fix selection\n\nCo-authored-by: Copilot <x@example.invalid>";
    await expect(publish(f.options)).rejects.toThrow("AI attribution");
    expect(f.events).toHaveLength(0);
  });
  test("visible changes upload both images after checks and preserve uploaded links", async () => {
    const before = path.join(scratch, "before image.png"), after = path.join(scratch, "after image.png");
    fs.writeFileSync(before, "before");
    fs.writeFileSync(after, "after");
    const f = fixture({ uiChange: true, solution: `Navigation retains the selection.\n![Before](<${before}>)\n![After](<${after}>)` });
    await publish(f.options);
    const order = f.events.map(event => event[0]);
    expect(order.filter(event => event === "upload")).toHaveLength(2);
    expect(order.indexOf("check")).toBeLessThan(order.indexOf("upload"));
    expect([...f.prs.values()][0].description).not.toContain(before);
    expect([...f.prs.values()][0].description).toContain("https://example.invalid/attachment.png");
  });
  test("lost create acknowledgement reconciles the saved marker without a second POST", async () => {
    const f = fixture();
    const create = f.host.create;
    f.host.create = async fields => { await create(fields); throw new Error("lost response"); };
    await expect(publish(f.options)).rejects.toThrow("lost response");
    f.host.create = create;
    const result = await publish(f.options);
    expect(result.pullRequestId).toBe(1);
    expect(f.events.filter(event => event[0] === "create")).toHaveLength(1);
  });
  test("uncertain create with no readback never retries POST", async () => {
    const f = fixture();
    let attempts = 0;
    f.host.create = async () => { attempts++; throw new Error("lost response"); };
    await expect(publish(f.options)).rejects.toThrow("lost response");
    await expect(publish(f.options)).rejects.toThrow("no verified matching PR");
    expect(attempts).toBe(1);
  });
  test("an unrelated active PR requires update rather than a second create", async () => {
    const f = fixture();
    f.prs.set(5, { pullRequestId: 5, status: "active", sourceRefName: "refs/heads/user/test/library", targetRefName: "refs/heads/master" });
    await expect(publish(f.options)).rejects.toThrow("already exists");
    expect(f.events.some(event => event[0] === "create")).toBe(false);
  });
  test("update reruns the same checks and preserves omitted description fields", async () => {
    const f = fixture();
    await publish(f.options);
    const prior = f.prs.get(1).description;
    f.events.length = 0;
    f.options.input = { action: "update", pullRequestId: 1, problem: "Library navigation lost the current selection." };
    await publish(f.options);
    expect(f.events.map(event => event[0])).toEqual(["git", "check", "update"]);
    const updated = f.prs.get(1).description;
    expect(updated).toContain("Library navigation lost the current selection.");
    expect(updated).toContain(good.solution);
    expect(updated.match(/<!-- repository-mcp:[\w-]+ -->/)[0]).toBe(prior.match(/<!-- repository-mcp:[\w-]+ -->/)[0]);
  });
  test("updating a legacy PR migrates the remote description only after checks and retains its marker and images", async () => {
    const f = fixture();
    await publish(f.options);
    const marker = f.prs.get(1).description.match(/<!-- repository-mcp:[\w-]+ -->/)[0];
    const images = "![Before](https://example.invalid/before.png)\n![After](https://example.invalid/after.png)";
    f.prs.get(1).description = `${storedPr(good, images).description}\n${marker}`;
    f.events.length = 0;
    f.options.input = { action: "update", pullRequestId: 1 };
    await publish(f.options);
    expect(f.events.map(event => event[0])).toEqual(["git", "check", "update"]);
    const description = f.prs.get(1).description;
    expect(description.match(/^# .+$/gm)).toEqual(Object.values(HEADINGS));
    expect(description).toContain(images);
    expect(description).toContain(marker);
    expect(description).not.toContain("How to turn off");
  });
  test("retargeting validates the new target and writes it separately from wording", async () => {
    const f = fixture();
    await publish(f.options);
    f.events.length = 0;
    f.options.input = { action: "update", pullRequestId: 1, targetBranch: "release" };
    f.checkout.fetch = async () => "b".repeat(40);
    const result = await publish(f.options);
    expect(result.pullRequestId).toBe(1);
    expect(f.events.filter(event => event[0] === "update").map(event => Object.keys(event[1]))).toEqual([["targetRefName"], ["title", "description"]]);
  });
  test("inactive PR updates fail before any check or write", async () => {
    const f = fixture();
    await publish(f.options);
    f.prs.get(1).status = "completed";
    f.events.length = 0;
    f.options.input = { action: "update", pullRequestId: 1 };
    await expect(publish(f.options)).rejects.toThrow("not active");
    expect(f.events).toHaveLength(0);
  });
});
