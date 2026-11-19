use super::*;
use crate::models::{task::{ChatReturn, OperatorMessage}, TaskStatus};

#[test]
fn archived_contenders_are_benign_but_invalid_records_still_release_idle_ownership() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-idle-contender-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root)?;
    let file = root.join("request.json");
    fs::write(&file, r#"{"status":"waiting"}"#)?;
    assert_eq!(read_contender::<Value>(&file)?.unwrap()["status"], "waiting");
    fs::remove_file(&file)?;
    assert!(read_contender::<Value>(&file)?.is_none());
    fs::write(&file, "{")?;
    assert!(read_contender::<Value>(&file).is_err());
    assert!(read_contender::<Value>(&root).is_err());
    fs::remove_dir_all(root)?;
    Ok(())
}

async fn wait_for(mut condition: impl FnMut() -> Result<bool>) -> Result<()> {
    timeout(Duration::from_secs(8), async {
        while !condition()? { tokio::time::sleep(Duration::from_millis(5)).await; }
        Ok::<_, anyhow::Error>(())
    }).await?
}

async fn warm_conversation(case: &str, previous: TaskStatus) -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-warm-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("logs"))?;
    fs::create_dir_all(root.join("agents"))?;
    fs::write(root.join("agents/probe.md"), "Diagnostic role")?;
    let workspace = if matches!(case, "migrated-repository" | "shared-workspace") {
        root.join("registered-workspace")
    } else { root.clone() };
    fs::create_dir_all(&workspace)?;
    fs::write(root.join("profile.json"), json!({ "purpose":"engineering","sshHost":"fixture",
        "workspace":workspace }).to_string())?;
    fs::write(root.join("spool.json"), json!({ "version": 1, "defaultModel": "gpt-5.4",
        "keepChatWarm": case == "persistent",
        "warmChatSeconds": if matches!(case, "expiry" | "persistent") { 1 } else { 30 } }).to_string())?;
    let result = async {
        let paths = crate::queue::fs::QueuePaths::new(root.join("queues"));
        paths.ensure_dirs()?;
        let agent = AgentConfig::parse("probe", "Diagnostic role", PathBuf::new())?;
        let mut task = Task::new("original", "probe", "Original work", "NEVER REPLAY THIS ASSIGNMENT");
        task.status = TaskStatus::InProgress;
        task.workspace = Some(root.to_string_lossy().into_owned());
        task.session_id = Some(uuid::Uuid::new_v4().to_string());
        task.provider = Some(ProviderLease { token: "original-provider".into(), pid: Some(std::process::id()) });
        task.interaction.chat_return = Some(ChatReturn {
            status: previous, error: (previous == TaskStatus::Failed).then(|| "Historical failure".into()),
        });
        task.interaction.messages.push(OperatorMessage {
            id: "first".into(), text: "First diagnostic".into(), status: "queued".into(),
            created_at: chrono::Utc::now(), session_id: None, error: None,
        });
        let mut config = SessionConfig::capture(&root, &task, &agent, None)?;
        config.provider = Some(crate::copilot::provider::Provider {
            command: std::env::current_exe()?,
            args: vec!["--config".into(), root.join("profile.json").to_string_lossy().into_owned()],
            working_directory: "/workspaces/1JS".into(),
        });
        task.session_config = Some(config.clone());
        crate::queue::fs::write_task(paths.in_progress.join("original.json"), &task)?;
        let peer = root.join("peer.js");
        fs::write(&peer, r#"
const fs=require("node:fs"),path=require("node:path");
const [root,session,model,mode]=process.argv.slice(2);
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",...value})+"\n");
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
 const request=JSON.parse(line);
 fs.appendFileSync(path.join(root,"requests.jsonl"),line+"\n");
 if(request.method==="initialize")send({id:request.id,result:{agentCapabilities:{loadSession:true}}});
 else if(request.method==="session/load")send({id:request.id,result:{sessionId:session,models:{currentModelId:model}}});
 else if(request.method==="session/prompt"){
  send({method:"session/update",params:{sessionId:session,update:{sessionUpdate:"user_message_chunk",
   content:{type:"text",text:request.params.prompt[0].text}}}});
  send({id:request.id,result:{stopReason:"end_turn",usage:{inputTokens:1,outputTokens:1}}});
  if(mode==="disconnect")setTimeout(()=>process.exit(0),25);
 }
});
"#)?;
        let mut child = Command::new("node").arg(peer).arg(&root).arg(task.session_id.as_ref().unwrap())
            .arg(&agent.model).arg(case).stdin(Stdio::piped()).stdout(Stdio::piped())
            .kill_on_drop(true).spawn()?;
        let mut connection = Connection { input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()).lines(),
            log: OpenOptions::new().append(true).create(true).open(root.join("logs/test.log"))?, next_id: 0 };
        let operator = if matches!(case, "followup" | "persistent" | "contender" | "repository" | "migrated-repository" | "shared-workspace") {
            let root = root.clone();
            let workspace = workspace.clone();
            let case = case.to_owned();
            Some(tokio::spawn(async move {
                wait_for(|| Ok(locate_task(&root.join("queues"), "original")?.1.interaction.phase == "idle")).await?;
                let idle = locate_task(&root.join("queues"), "original")?.1;
                assert_eq!(idle.status, previous);
                assert_eq!(idle.provider.as_ref().unwrap().token, "original-provider");
                if matches!(case.as_str(), "followup" | "persistent") {
                    if case == "persistent" { tokio::time::sleep(Duration::from_millis(1250)).await; }
                    mutate(&root, "original", |task| {
                        task.interaction.chat_return = Some(ChatReturn {
                            status: task.status, error: task.error.clone(),
                        });
                        task.interaction.messages.push(OperatorMessage {
                            id: "second".into(), text: "Second diagnostic".into(), status: "queued".into(),
                            created_at: chrono::Utc::now(), session_id: None, error: None,
                        });
                        Ok(())
                    })?;
                    wait_for(|| {
                        let task = locate_task(&root.join("queues"), "original")?.1;
                        Ok(task.interaction.phase == "idle" &&
                            task.interaction.messages.iter().any(|message| message.id == "second" && message.status == "delivered"))
                    }).await?;
                }
                if matches!(case.as_str(), "repository" | "migrated-repository") {
                    fs::write(workspace.join("repository-mcp.lock"), "{}")?;
                } else {
                    let directory = root.join("controls/manual");
                    fs::create_dir_all(&directory)?;
                    fs::write(directory.join("contender.json"), json!({ "status":"waiting",
                        "request": { "id":"contender","agent":if case == "shared-workspace" { "another-agent" } else { "probe" },
                            "workspace":workspace,"taskId":"another-task" } }).to_string())?;
                }
                Ok::<_, anyhow::Error>(())
            }))
        } else { None };
        let runner = CopilotRunner::new(root.join("logs"));
        let execution = timeout(Duration::from_secs(10),
            super::super::session::run_session(&mut connection, &runner, &root, &root,
                &task, &agent, &mut config, None)).await??;
        if let Some(operator) = operator { operator.await??; }
        drop(connection);
        assert!(timeout(Duration::from_secs(5), child.wait()).await??.success());
        assert_eq!(execution.exit_code, 0);
        let saved = locate_task(&paths.base, "original")?.1;
        assert_eq!(saved.status, previous);
        assert_eq!(saved.error.as_deref(), (previous == TaskStatus::Failed).then_some("Historical failure"));
        assert_eq!(saved.session_id, task.session_id);
        assert!(saved.interaction.messages.iter().all(|message| message.status == "delivered"));
        let requests: Vec<Value> = fs::read_to_string(root.join("requests.jsonl"))?.lines()
            .map(serde_json::from_str).collect::<std::result::Result<_, _>>()?;
        assert_eq!(requests.iter().filter(|request| request["method"] == "initialize").count(), 1);
        assert_eq!(requests.iter().filter(|request| request["method"] == "session/load").count(), 1);
        let prompts: Vec<_> = requests.iter().filter(|request| request["method"] == "session/prompt").collect();
        assert_eq!(prompts.len(), if matches!(case, "followup" | "persistent") { 2 } else { 1 });
        assert!(prompts.iter().all(|prompt| !prompt.to_string().contains("NEVER REPLAY")));
        Ok(())
    }.await;
    fs::remove_dir_all(root)?;
    result
}

#[tokio::test]
async fn warm_followups_reuse_one_session_and_keep_completed_and_failed_outcomes() -> Result<()> {
    for previous in [TaskStatus::Completed, TaskStatus::Failed] {
        warm_conversation("followup", previous).await?;
    }
    Ok(())
}

#[tokio::test]
async fn warm_sessions_yield_for_new_assignments_and_repository_operations() -> Result<()> {
    for case in ["contender", "repository", "migrated-repository", "shared-workspace"] {
        warm_conversation(case, TaskStatus::Completed).await?;
    }
    Ok(())
}

#[tokio::test]
async fn persistent_sessions_accept_followups_after_the_configured_idle_timeout() -> Result<()> {
    warm_conversation("persistent", TaskStatus::Completed).await
}

#[tokio::test]
async fn idle_expiry_and_disconnect_do_not_fail_completed_work() -> Result<()> {
    for case in ["expiry", "disconnect"] { warm_conversation(case, TaskStatus::Completed).await?; }
    Ok(())
}
