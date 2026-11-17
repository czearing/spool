import { expect, test } from "bun:test";
import path from "node:path";
import { execFileSync } from "node:child_process";

const native = process.env.REPOSITORY_MCP_NATIVE_TEST === "1" ? test : test.skip;
native("native stock cache planning and authenticated artifact restoration work without touching the checkout", () => {
  const directory = path.resolve(import.meta.dirname, "..", "src", "adapters");
  if (!/^[a-z]:\\/i.test(directory)) throw new Error("Native smoke test requires a local Windows server path");
  const modules = `/mnt/${directory[0].toLowerCase()}/${directory.slice(3).replaceAll("\\", "/")}`;
  const script = `
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import {libraryProfile,libraryEnvironment} from ${JSON.stringify(modules + "/library-profile.mjs")};
    import {libraryArtifactPlan,refreshLibraryArtifacts} from ${JSON.stringify(modules + "/library-artifacts.mjs")};
    const config=JSON.parse(fs.readFileSync(path.join(os.homedir(),".config/1js/repository-mcp.json"),"utf8"));
    const profile=libraryProfile(config.library);
    Object.assign(process.env,libraryEnvironment(profile));
    const plan=await libraryArtifactPlan(profile);
    const selected=plan.find(target=>target.id==="@1js/chat-ssr-config#build");
    if(!selected) throw new Error("Library graph lacks chat-ssr-config");
    const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"library-cache-smoke-"));
    try {
      const workspaceRoot=path.join(scratch,"midgard");
      const cwd=path.join(workspaceRoot,"packages","chat-ssr-config");
      fs.mkdirSync(cwd,{recursive:true});
      const probe={...profile,repoRoot:scratch,workspaceRoot,stateRoot:path.join(scratch,"state")};
      const result=await refreshLibraryArtifacts(probe,{
        plan:async()=>[{...selected,cwd}],
        execute:async()=>({stdout:""}),
      });
      const reused=await refreshLibraryArtifacts(probe,{
        plan:async()=>[{...selected,cwd}],
        execute:async()=>({stdout:""}),
      });
      console.log(JSON.stringify({targets:plan.length,hash:selected.hash,restored:result.restored,
        reused:reused.restored,js:fs.existsSync(path.join(cwd,"lib/index.js")),
        declarations:fs.existsSync(path.join(cwd,"lib/index.d.ts"))}));
    } finally { fs.rmSync(scratch,{recursive:true,force:true}); }
  `;
  const output = execFileSync("wsl.exe", ["--distribution", "1js-linux", "--exec", "bash", "-lc",
    'exec "$@"', "repository-cache-test", "/opt/node-v22.23.0/bin/node", "--input-type=module", "-e", script], {
    encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 180_000,
  });
  const result = JSON.parse(output.trim());
  expect(result.targets).toBeGreaterThan(1000);
  expect(result.hash).toMatch(/^[a-f0-9]{40}$/);
  expect(result).toMatchObject({ restored: 1, reused: 0, js: true, declarations: true });
}, 190_000);
