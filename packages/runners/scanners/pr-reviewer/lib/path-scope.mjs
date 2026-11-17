const sha = /^[a-f0-9]{40}$/i;

export function pathScopeCache(repository, saved) {
  if (!repository || typeof repository !== "string") throw new Error("Repository identity is required");
  if (saved && (saved.version !== 1 || saved.repository !== repository ||
      !saved.bases || !saved.trees)) throw new Error("Path scope cache does not match the repository");
  return saved || { version: 1, repository, bases: {}, trees: {} };
}

export function mergeBaseProgram(root) {
  return `
    const {execFile}=require("node:child_process"),{promisify}=require("node:util"),fs=require("node:fs");
    const git=promisify(execFile);
    const pairs=JSON.parse(fs.readFileSync(0,"utf8")),sha=/^[a-f0-9]{40}$/i;
    if(!Array.isArray(pairs)||pairs.some(p=>!sha.test(p.sourceCommit)||!sha.test(p.targetCommit)))
      throw Error("Invalid pinned review identities");
    const results=new Array(pairs.length);let cursor=0;
    const worker=async()=>{while(cursor<pairs.length){
      const index=cursor++,p=pairs[index];
      try{
        const {stdout}=await git("git",["merge-base","--all",p.sourceCommit,p.targetCommit],{
          cwd:${JSON.stringify(root)},encoding:"utf8",timeout:30000,stdio:["ignore","pipe","pipe"],
          env:{...process.env,GIT_OPTIONAL_LOCKS:"0",GIT_NO_LAZY_FETCH:"1"}
        });
        const bases=stdout.trim().split("\\n");
        results[index]={...p,commonCommit:bases.length===1&&sha.test(bases[0])?bases[0]:null};
      }catch{results[index]={...p,commonCommit:null};}
    }};
    Promise.all(Array.from({length:Math.min(4,pairs.length)},worker))
      .then(()=>process.stdout.write(JSON.stringify(results)))
      .catch(error=>{console.error(error.message);process.exitCode=1});
  `;
}

function validateDirectories(directories) {
  if (!Array.isArray(directories) || !directories.length ||
      new Set(directories).size !== directories.length || directories.some(directory =>
      typeof directory !== "string" || !/^\/[^/]+(?:\/[^/]+)*$/.test(directory) || /[\\*?\0\r\n]/.test(directory) ||
      directory.split("/").some(part => part === "." || part === "..")))
    throw new Error("Scope requires explicit repository-relative directories, not globs or repository root");
}

export async function scopeByDirectoryGroups(pullRequests, { scopes, ...options }) {
  if (!Array.isArray(scopes) || !scopes.length || scopes.some(scope =>
      !scope || typeof scope.id !== "string" || !scope.id.trim()) ||
      new Set(scopes.map(scope => scope.id)).size !== scopes.length)
    throw new Error("Directory scopes require unique nonempty identities");
  for (const scope of scopes) validateDirectories(scope.directories);
  const directories = [...new Set(scopes.flatMap(scope => scope.directories))];
  // Every package shares the same full inventory; pruning must not use a package-filtered subset.
  const matches = await scopeByDirectoryTrees(pullRequests, { ...options, directories });
  return scopes.map(scope => ({
    id: scope.id,
    pullRequests: matches.flatMap(pr => {
      const changedDirectories = pr.changedDirectories.filter(directory => scope.directories.includes(directory));
      return changedDirectories.length ? [{ ...pr, changedDirectories }] : [];
    }),
  }));
}

export async function scopeByDirectoryTrees(pullRequests, {
  repository, directories, cache = pathScopeCache(repository), mergeBases, requestItems,
  batchSize = 200, checkpoint = () => {}, onDeferred,
}) {
  pathScopeCache(repository, cache);
  validateDirectories(directories);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("Invalid scope metadata batch size");
  const pairs = new Map();
  for (const pr of pullRequests) {
    if (!sha.test(pr.sourceCommit || "") || !sha.test(pr.targetCommit || ""))
      throw new Error(`PR ${pr.id} has no pinned comparison identities`);
    const key = `${pr.sourceCommit}:${pr.targetCommit}`;
    pairs.set(key, { sourceCommit: pr.sourceCommit, targetCommit: pr.targetCommit });
  }
  const pending = [...pairs].filter(([key]) => !Object.hasOwn(cache.bases, key))
    .sort(([a], [b]) => (cache.baseChecks?.[a] || 0) - (cache.baseChecks?.[b] || 0));
  const deferred = new Set();
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const results = await mergeBases(batch.map(([, pair]) => pair));
    if (!Array.isArray(results) || results.length !== batch.length)
      throw new Error("Incomplete pinned merge-base inventory");
    for (let index = 0; index < batch.length; index++) {
      const [key, expected] = batch[index], actual = results[index];
      if (actual.sourceCommit !== expected.sourceCommit || actual.targetCommit !== expected.targetCommit)
        throw new Error("Merge-base inventory changed source identity");
      if (actual.commonCommit === null && onDeferred) {
        deferred.add(key);
        for (const pr of pullRequests.filter(pr => `${pr.sourceCommit}:${pr.targetCommit}` === key)) onDeferred(pr);
        continue;
      }
      if (!sha.test(actual.commonCommit || "")) throw new Error("Merge-base inventory changed source identity");
      cache.bases[key] = actual.commonCommit;
    }
    await checkpoint(cache);
  }
  const descriptors = new Map();
  for (const [key, pair] of pairs) {
    if (deferred.has(key)) continue;
    const common = cache.bases[key];
    if (!sha.test(common || "")) throw new Error("Invalid cached merge base");
    for (const version of [pair.sourceCommit, common]) for (const directory of directories) {
      const treeKey = `${version}:${directory}`;
      if (!Object.hasOwn(cache.trees, treeKey)) descriptors.set(treeKey, {
        path: directory, version, versionType: "commit", recursionLevel: "none",
      });
    }
  }
  const trees = [...descriptors];
  for (let offset = 0; offset < trees.length; offset += batchSize) {
    const batch = trees.slice(offset, offset + batchSize);
    const response = await requestItems({
      itemDescriptors: batch.map(([, descriptor]) => descriptor),
      includeContentMetadata: false, includeLinks: false, latestProcessedChange: false,
    });
    if (!Array.isArray(response?.value) || response.value.length !== batch.length)
      throw new Error("Incomplete directory tree metadata; no complete count is available");
    for (let index = 0; index < batch.length; index++) {
      const [key, descriptor] = batch[index], items = response.value[index];
      if (!Array.isArray(items) || items.length > 1)
        throw new Error("Directory lookup returned unexpected descendants");
      if (!items.length) { cache.trees[key] = null; continue; }
      const item = items[0];
      if (item.path !== descriptor.path || item.commitId !== descriptor.version ||
          item.isFolder !== true || item.gitObjectType !== "tree" || !sha.test(item.objectId || ""))
        throw new Error("Directory metadata does not match its pinned path and revision");
      cache.trees[key] = item.objectId;
    }
    await checkpoint(cache);
  }
  const result = pullRequests.flatMap(pr => {
    if (deferred.has(`${pr.sourceCommit}:${pr.targetCommit}`)) return [];
    const commonCommit = cache.bases[`${pr.sourceCommit}:${pr.targetCommit}`];
    const changedDirectories = directories.filter(directory => {
      const source = cache.trees[`${pr.sourceCommit}:${directory}`];
      const base = cache.trees[`${commonCommit}:${directory}`];
      if (![source, base].every(value => value === null || sha.test(value || "")))
        throw new Error("Invalid cached directory tree identity");
      return source !== base;
    });
    return changedDirectories.length ? [{ ...pr, commonCommit, changedDirectories }] : [];
  });
  const retainedCommits = new Set();
  for (const [key, pair] of pairs) {
    if (deferred.has(key)) continue;
    for (const version of [pair.sourceCommit, cache.bases[key]]) retainedCommits.add(version);
  }
  for (const key of Object.keys(cache.bases)) if (!pairs.has(key)) delete cache.bases[key];
  for (const key of Object.keys(cache.baseChecks || {})) if (!pairs.has(key)) delete cache.baseChecks[key];
  for (const key of Object.keys(cache.trees)) if (!retainedCommits.has(key.slice(0, 40))) delete cache.trees[key];
  await checkpoint(cache);
  return result;
}
