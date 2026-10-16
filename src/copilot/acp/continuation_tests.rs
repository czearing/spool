use super::*;
use crate::models::task::OperatorMessage;

#[tokio::test]
async fn recorded_final_answers_release_repeated_queued_turns_only_after_provider_cancel_ack() -> Result<()> {
    fixture(false).await
}
#[tokio::test]
async fn missing_cancel_ack_fails_explicitly_without_sending_or_replaying_queued_input() -> Result<()> {
    fixture(true).await
}
async fn fixture(ignore_cancel: bool) -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-queued-acp-{}", uuid::Uuid::new_v4()));
    let session = uuid::Uuid::new_v4().to_string();
    let history_dir = crate::usage::session_root()?.join(&session);
    fs::create_dir_all(&history_dir)?;
    fs::create_dir_all(root.join("logs"))?;
    fs::create_dir_all(root.join(".runner-receipts/native-creators"))?;
    let result = async {
        let script = root.join("provider.js");
        fs::write(&script, r#"
const fs=require("node:fs");
const [session,model,capture,history,gate,ignoreCancel]=process.argv.slice(2);
let turn=0, pending;
const emit=value=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",...value})+"\n");
const record=value=>fs.appendFileSync(capture,JSON.stringify(value)+"\n");
function final() {
  emit({method:"session/update",params:{sessionId:session,update:{
    sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Finished answer"}
  }}});
  for(const [type,data] of [
    ["assistant.turn_start",{turnId:String(turn)}],
    ["assistant.message",{turnId:String(turn),phase:"final_answer",toolRequests:[]}],
    ["assistant.turn_end",{turnId:String(turn)}]]) {
    fs.appendFileSync(history,JSON.stringify({type,data,timestamp:new Date().toISOString()})+"\n");
  }
}
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
  const r=JSON.parse(line); record(r);
  if(r.method==="session/cancel") {
    if(ignoreCancel==="true") return;
    const id=pending;
    setTimeout(()=>{record({method:"cancel_ack",turn});
      emit({id,result:{stopReason:"cancelled",usage:{inputTokens:1,outputTokens:1}}});},200);
  } else if(r.method==="session/prompt") {
    turn++; pending=r.id;
    if(turn===1) {
      const timer=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(timer);final();}},10);
    } else if(turn===2) final();
    else emit({id:r.id,result:{stopReason:"end_turn",usage:{inputTokens:1,outputTokens:1}}});
  } else emit({id:r.id,result:r.method==="initialize"?{agentCapabilities:{loadSession:true}}:
    {sessionId:session,models:{currentModelId:model}}});
});
"#)?;
        let capture = root.join("requests.jsonl");
        let gate = root.join("finish-first");
        let agent = AgentConfig::parse("probe", "Keep the original assignment.", PathBuf::new())?;
        let mut task = Task::new("original", "probe", "Original task", "Original assignment");
        task.status = crate::models::TaskStatus::InProgress;
        task.workspace = Some(root.to_string_lossy().into_owned());
        let file = root.join("queues/in_progress/original.json");
        fs::create_dir_all(file.parent().unwrap())?;
        crate::queue::fs::write_task(&file, &task)?;
        let mut child = Command::new("node").arg(&script).arg(&session).arg(&agent.model)
            .arg(&capture).arg(history_dir.join("events.jsonl")).arg(&gate)
            .arg(ignore_cancel.to_string())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true).spawn()?;
        let mut connection = Connection { input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()).lines(),
            log: OpenOptions::new().append(true).create(true).open(root.join("logs/mock.log"))?, next_id: 0 };
        let runner = CopilotRunner::new(root.join("logs"));
        let mut config = SessionConfig { model: agent.model.clone(), reasoning_effort: None,
            workspace: task.workspace.clone().unwrap(), agent: task.agent.clone(), mcp: None };
        let drive = async {
            for index in 1..=if ignore_cancel { 1 } else { 2 } {
                timeout(Duration::from_secs(5), async {
                    loop {
                        if capture.exists() && fs::read_to_string(&capture)?.lines()
                            .filter(|line| line.contains("\"session/prompt\"")).count() >= index { break; }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    Ok::<(), anyhow::Error>(())
                }).await??;
                if index == 2 {
                    tokio::time::sleep(Duration::from_millis(1200)).await;
                    assert_eq!(fs::read_to_string(&capture)?.lines().filter(|line| line.contains("\"session/cancel\"")).count(), 1,
                        "A final answer without queued input must not trigger cancellation");
                }
                mutate(&root, "original", |task| {
                    task.interaction.messages.push(OperatorMessage {
                        id: format!("followup-{index}"), text: format!("New input {index}"), status: "queued".into(),
                        created_at: chrono::Utc::now(), session_id: None, error: None,
                    });
                    Ok(())
                })?;
                if index == 1 {
                    tokio::time::sleep(Duration::from_millis(1200)).await;
                    assert!(!fs::read_to_string(&capture)?.contains("session/cancel"),
                        "Queued input must not interrupt an unfinished answer");
                    fs::write(&gate, "finish")?;
                }
            }
            Ok::<(), anyhow::Error>(())
        };
        let (execution, driven) = tokio::join!(
            timeout(Duration::from_secs(if ignore_cancel { 36 } else { 20 }),
                run_session(&mut connection, &runner, &root, &root, &task, &agent, &mut config, None)), drive);
        driven?;
        let execution = execution.context("Queued continuation stayed blocked")?;
        connection.input.shutdown().await?;
        drop(connection.input);
        assert!(child.wait().await?.success());
        let saved = crate::queue::fs::read_task(&file)?;
        if ignore_cancel {
            assert!(execution.err().context("Unacknowledged cancellation must fail")?.to_string().contains("30 seconds"));
            assert_eq!(saved.interaction.messages.len(), 1);
            assert_eq!(saved.interaction.messages[0].status, "queued");
            assert_eq!(fs::read_to_string(&capture)?.lines().filter(|line| line.contains("\"session/prompt\"")).count(), 1);
            return Ok(());
        }
        let execution = execution?;
        assert_eq!(execution.session_id, session);
        assert_eq!(execution.usage.turns, 3);
        assert!(!saved.interaction.paused && !saved.interaction.cancel_requested && !saved.interaction.resume_requested);
        assert!(saved.interaction.messages.iter().all(|message| message.status == "delivered"));
        let requests: Vec<Value> = fs::read_to_string(&capture)?.lines().map(serde_json::from_str)
            .collect::<std::result::Result<_, _>>()?;
        let prompts: Vec<_> = requests.iter().filter(|r| r["method"] == "session/prompt").collect();
        assert_eq!(prompts.len(), 3);
        assert!(prompts[0]["params"]["prompt"][0]["text"].as_str().unwrap().contains("Original assignment"));
        for index in 1..=2 {
            assert_eq!(prompts[index]["params"]["sessionId"], session);
            assert_eq!(prompts[index]["params"]["prompt"], json!([{"type":"text","text":format!("New input {index}")}]));
            let ack = requests.iter().position(|r| r["method"] == "cancel_ack" && r["turn"] == index).unwrap();
            let next = requests.iter().position(|r| r == prompts[index]).unwrap();
            assert!(ack < next, "Never send a continuation before cancellation is acknowledged");
        }
        Ok::<(), anyhow::Error>(())
    }.await;
    if result.is_err() {
        eprintln!("Mock protocol: {:?}", fs::read_to_string(root.join("requests.jsonl")));
        eprintln!("Mock history: {:?}", fs::read_to_string(history_dir.join("events.jsonl")));
        eprintln!("Native events: {:?}", fs::read_to_string(root.join("logs/mock.log")));
    }
    fs::remove_dir_all(root)?;
    fs::remove_dir_all(history_dir)?;
    result
}
