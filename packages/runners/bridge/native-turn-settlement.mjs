import path from "node:path";
import { publicationForTask } from "./publications.mjs";
import { digest, readJson, samePath, verifiedWorkspaceMigration, writeJson } from "./spool-store.mjs";
import { readCodespaceConfig, shellQuote } from "../packages/repository-mcp/src/codespaces/config.mjs";
import { CodespaceTransport } from "../packages/repository-mcp/src/codespaces/transport.mjs";
import { createMonitorControls } from "./monitor-controls.mjs";

export function finishedTurnObservation(config, sessionId) {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error("Invalid native session");
  return `import datetime,fcntl,json,os,pathlib,time
root=${JSON.stringify(config.remoteRoot)}
tools=${JSON.stringify(config.remoteTools)}
session=${JSON.stringify(sessionId)}
home=pathlib.Path.home()/'.copilot/session-state'/session
lease=open(tools+'.lease','r')
try:
 fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
 raise RuntimeError('Native workspace lease is no longer held')
except BlockingIOError:pass
owner=json.loads(pathlib.Path(tools+'.owner.json').read_text())
if owner['token'].encode() not in pathlib.Path('/proc',str(owner['pid']),'cmdline').read_bytes():
 raise RuntimeError('Native workspace owner changed')
matches=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  args=(p/'cmdline').read_bytes().split(b'\\0')
  if b'--acp' not in args or b'--stdio' not in args:continue
  if os.readlink(p/'cwd')!=root:continue
  hold=str(home/('inuse.'+p.name+'.hold'))
  if any(os.readlink(fd)==hold for fd in (p/'fd').iterdir()):matches.append(p)
 except (FileNotFoundError,PermissionError,ProcessLookupError):continue
if len(matches)!=1:raise RuntimeError('Native session process ownership is not unique')
final=None
checkpoint=None
pending=set()
hooks=set()
latest=0
for line in (home/'events.jsonl').open():
 e=json.loads(line)
 if e.get('agentId'):continue
 kind=e.get('type')
 data=e.get('data',{})
 stamp=datetime.datetime.fromisoformat(e['timestamp'].replace('Z','+00:00')).timestamp()
 if kind=='user.message':pending.clear();hooks.clear();final=None;checkpoint=None
 if kind=='tool.execution_start':pending.add(data['toolCallId'])
 if kind=='tool.execution_complete':pending.discard(data['toolCallId'])
 if kind=='hook.start':hooks.add(data['hookInvocationId'])
 if kind=='hook.end':hooks.discard(data['hookInvocationId'])
 if kind in ('assistant.turn_start','tool.execution_start'):final=None;checkpoint=None
 if kind=='assistant.message' and not data.get('toolRequests'):final=stamp
 if kind=='session.usage_checkpoint':checkpoint=stamp
 if kind!='session.compaction_complete':latest=max(latest,stamp)
if not final or not checkpoint or checkpoint<final or pending or hooks or time.time()-latest<30:
 print(json.dumps({'idle':False,'holding':'Native turn is not yet confirmed idle'}))
else:
 print(json.dumps({'idle':True,'sessionId':session}))
`;
}

export async function settleCompletedNativeTurn({ store, config, task, workspace, controls,
  observe = async (profile, sessionId) => {
    const transport = new CodespaceTransport(profile);
    try {
      await transport.environment();
      const program = Buffer.from(finishedTurnObservation(profile, sessionId)).toString("base64");
      const { stdout } = await transport.ssh(`printf %s ${shellQuote(program)} | base64 -d | python3`, 30);
      return JSON.parse(stdout);
    } finally { await transport.dispose(); }
  } }) {
  if (config.repositoryProfile !== "1js" || task?.status !== "completed" || task.error || task.acceptance ||
      task.agent !== config.agentId ||
      !task.provider?.pid || task.interaction?.phase !== "running" || task.interaction.paused ||
      task.interaction.status_change || task.interaction.handoff ||
      task.interaction.messages?.some(message => message.status !== "delivered") ||
      store.isPaused(task.agent)) return null;
  const file = path.join(store.records, "native-turn-settlement", `${digest(`${task.id}:${task.provider.token}`)}.json`);
  const metadata = store.metadata(task.id);
  if (!metadata?.runner || !["backlog", "perf"].includes(metadata.source || metadata.runner)) return null;
  if (!samePath(task.workspace, workspace) && !verifiedWorkspaceMigration(metadata, workspace, task.workspace)) return null;
  const provider = readJson(path.join(store.root, "spool.json"))?.copilotProviders?.[task.agent];
  const args = provider?.args, index = Array.isArray(args) ? args.indexOf("--config") : -1;
  if (JSON.stringify(task.session_config?.provider) !== JSON.stringify(provider) ||
      provider?.workingDirectory !== "/workspaces/1JS" || index < 0 ||
      !path.isAbsolute(args[index + 1] || "") ||
      !args.some(arg => /(?:^|[\\/])codespaces[\\/]copilot\.mjs$/.test(arg)))
    throw new Error("Completed native session ownership changed");
  const publication = publicationForTask(store, task.id, { branch: metadata.preparation?.branch });
  if (publication?.verified !== true || !["spool", "mcp"].includes(publication.originKind) ||
      publication.taskId !== task.id || publication.agent !== task.agent ||
      publication.sessionId !== task.session_id || !samePath(publication.workspace, task.workspace) &&
      !verifiedWorkspaceMigration(metadata, publication.workspace, task.workspace))
    return null;
  const holding = "Waiting for completed native session to release its workspace";
  if (readJson(file)?.controlId) return { dispatched: 0, taskId: task.id, holding };
  const profile = readCodespaceConfig(args[index + 1]);
  if (profile.purpose !== "engineering" || profile.remoteRoot !== provider.workingDirectory)
    throw new Error("Completed native session profile changed");
  const current = store.task(task.id);
  if (JSON.stringify(current) !== JSON.stringify(task)) return { dispatched: 0, taskId: task.id, holding };
  const result = await observe(profile, task.session_id);
  if (result.idle === true) {
    if (result.sessionId !== task.session_id) throw new Error("Native settlement session changed");
    const controlId = digest(`${task.id}:${task.provider.token}:finished-turn`).slice(0, 32)
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    // Preserve the agent's recorded completion, using normal graceful status control.
    // Contract-bearing work must retain the daemon's independent completion verification.
    (controls || createMonitorControls(store)).submit({ id: controlId, kind: "status",
      taskId: task.id, status: "completed", expectedStatus: task.status });
    writeJson(file, { taskId: task.id, sessionId: task.session_id, provider: task.provider, controlId,
      completedAt: task.updated_at, requestedAt: new Date().toISOString() });
  }
  return { dispatched: 0, taskId: task.id, holding: result.holding || holding };
}
