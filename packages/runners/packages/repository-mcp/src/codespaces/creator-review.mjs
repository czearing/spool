import { createHash } from "node:crypto";
import { readCodespaceConfig, shellQuote, resolveControlWorkspace } from "./config.mjs";
import { CodespaceTransport } from "./transport.mjs";
import { writeReceipt } from "../process.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const remoteFiles = (config, key) => {
  const directory = `${config.remoteTools}/creator-reviews/${digest(key)}`;
  return { contractFile: `${directory}/contract.json`, creatorRoleFile: `${directory}/creator.md`,
    resultFile: `${directory}/result.json` };
};

export async function stageCreatorReview(prepared, contract, role, dependencies = {}) {
  const config = dependencies.config || readCodespaceConfig(prepared.execution.configFile);
  if (config.purpose !== "engineering" || prepared.execution.codespace !== config.codespace ||
      prepared.repoRoot !== config.workspace || resolveControlWorkspace(contract.cwd) !== config.workspace)
    throw new Error("Review artifacts do not belong to this prepared Codespace");
  const files = remoteFiles(config, contract.submissionId);
  const remote = { ...contract, ...files, cwd: config.remoteRoot };
  delete remote.repositoryConfigFile;
  const payload = {
    [files.contractFile]: JSON.stringify(remote, null, 2),
    [files.creatorRoleFile]: role,
  };
  const transport = dependencies.transport || new CodespaceTransport(config);
  try {
    await transport.environment();
    const writer = 'const fs=require("node:fs"),path=require("node:path");let input="";' +
      'process.stdin.on("data",b=>input+=b);process.stdin.on("end",()=>{' +
      'for(const [file,text] of Object.entries(JSON.parse(input))){fs.mkdirSync(path.dirname(file),{recursive:true});' +
      'if(fs.realpathSync(path.dirname(file))!==path.dirname(file)||fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())' +
      'throw Error("Review artifact redirects");fs.writeFileSync(file,text,{mode:0o600});}' +
      'for(const file of Object.keys(JSON.parse(input)))if(!fs.statSync(file).isFile())throw Error("Review artifact missing");});';
    await transport.ssh(`${shellQuote(config.nativeProfile.nodeExecutable)} -e ${shellQuote(writer)}`,
      120, undefined, Buffer.from(JSON.stringify(payload)));
  } finally { await transport.dispose(); }
  return { ...contract, remoteArtifacts: { ...files, configFile: config.file, codespace: config.codespace } };
}

export async function syncCreatorReview(contract, dependencies = {}) {
  if (!contract?.remoteArtifacts) return;
  const config = dependencies.config || readCodespaceConfig(contract.remoteArtifacts.configFile);
  const files = remoteFiles(config, contract.submissionId);
  if (config.codespace !== contract.remoteArtifacts.codespace || resolveControlWorkspace(contract.cwd) !== config.workspace ||
      Object.entries(files).some(([key, value]) => contract.remoteArtifacts[key] !== value))
    throw new Error("Review result transport does not match its assigned Codespace");
  const transport = dependencies.transport || new CodespaceTransport(config);
  try {
    await transport.environment();
    const program = 'const fs=require("node:fs"),file=process.argv[1];' +
      'if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>1048576)throw Error("Invalid review result artifact");' +
      'process.stdout.write(fs.readFileSync(file,"utf8"));';
    const { stdout } = await transport.ssh(`${shellQuote(config.nativeProfile.nodeExecutable)} -e ` +
      `${shellQuote(program)} ${shellQuote(files.resultFile)}`, 60);
    const result = JSON.parse(stdout);
    if (result.submissionId !== contract.submissionId || result.fingerprint !== contract.fingerprint)
      throw new Error("Remote review result names a different submission or feedback generation");
    writeReceipt(contract.resultFile, result);
  } finally { await transport.dispose(); }
}
