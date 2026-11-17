use super::*;

async fn native_completion(case: &str) -> Result<()> {
    let root =
        std::env::temp_dir().join(format!("spool-native-completion-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("logs"))?;
    let result = async {
        let script = root.join("peer.js");
        fs::write(&script, r#"
const fs = require("node:fs"), path = require("node:path");
const [session, model, mode, root] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify({jsonrpc:"2.0",...value})+"\n");
const update = data => send({method:"session/update",params:{
  sessionId:mode==="foreign" ? "another-session" : session,update:data}});
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if(request.method==="initialize") send({id:request.id,result:{agentCapabilities:{loadSession:true}}});
  else if(request.method==="session/new" || request.method==="session/load") {
    if(mode==="replay") {
      update({sessionUpdate:"tool_call",toolCallId:"done",title:"task_complete",rawInput:{summary:"Old completion"}});
      update({sessionUpdate:"tool_call_update",toolCallId:"done",status:"completed"});
    }
    send({id:request.id,result:{sessionId:session,models:{currentModelId:model}}});
  } else if(request.method==="session/prompt") {
    if(["cancelled","resume","explicit-failure"].includes(mode)) {
      fs.writeFileSync(path.join(root,"operator-request"),mode);
      const wait=new Int32Array(new SharedArrayBuffer(4));
      while(!fs.existsSync(path.join(root,"operator-applied"))) Atomics.wait(wait,0,0,10);
    }
    if(mode!=="replay") {
      update({sessionUpdate:"tool_call",toolCallId:"done",title:mode==="unrelated" ? "shell" : "task_complete",
        rawInput:{summary:"Review finished; findings posted, approval withheld and integration blocked by sign-in"}});
      update({sessionUpdate:"tool_call_update",toolCallId:"done",status:mode==="tool-failed" ? "failed" : "completed"});
      update({sessionUpdate:"tool_call_update",toolCallId:"done",status:"completed"});
    }
    if(mode==="provider-error") send({id:request.id,error:{code:-32000,message:"Turn failed after completion"}});
    else send({id:request.id,result:{stopReason:mode==="cancelled" ? "cancelled" : mode==="aborted" ? "max_tokens" : "end_turn",
      usage:{inputTokens:1,outputTokens:1}}});
  }
});
"#)?;
        let agent = AgentConfig::parse("probe", "Review the PR.", PathBuf::new())?;
        let mut task = Task::new("original", "probe", "Review", "Original assignment");
        task.status = crate::models::TaskStatus::InProgress;
        task.workspace = Some(root.to_string_lossy().into_owned());
        task.runner_metadata = Some(json!({ "runner": "pr-reviewer" }));
        let session = uuid::Uuid::new_v4().to_string();
        if case == "replay" {
            task.session_id = Some(session.clone());
            task.interaction.messages.push(crate::models::task::OperatorMessage {
                id: "followup".into(), text: "Continue the review".into(), status: "queued".into(),
                created_at: chrono::Utc::now(), session_id: None, error: None,
            });
        }
        if case == "contract" { task.acceptance = Some(json!({ "kind": "unsupported" })); }
        if case == "chat" {
            task.interaction.chat_return = Some(crate::models::task::ChatReturn {
                status: crate::models::TaskStatus::Failed, error: Some("Historical failure".into()),
            });
        }
        let paths = crate::queue::fs::QueuePaths::new(root.join("queues"));
        paths.ensure_dirs()?;
        crate::queue::fs::write_task(paths.in_progress.join("original.json"), &task)?;
        let mut child = Command::new("node").arg(&script).arg(&session).arg(&agent.model).arg(case).arg(&root)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true).spawn()?;
        let mut connection = Connection { input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()).lines(),
            log: OpenOptions::new().append(true).create(true).open(root.join("logs/mock.log"))?, next_id: 0 };
        let runner = CopilotRunner::new(root.join("logs"));
        let mut config = SessionConfig::capture(&root, &task, &agent, None)?;
        let operator = if matches!(case, "cancelled" | "resume" | "explicit-failure") {
            let root = root.clone();
            let case = case.to_owned();
            Some(tokio::spawn(async move {
                wait_for(|| Ok(root.join("operator-request").try_exists()?)).await?;
                {
                    let queues = root.join("queues");
                    let _guard = TaskGuard::acquire(&queues, "original")?;
                    let (file, mut task) = locate_task(&queues, "original")?;
                    match case.as_str() {
                        "explicit-failure" => {
                            task.status = crate::models::TaskStatus::Failed;
                            task.error = Some("Explicit validation failure".into());
                        }
                        "cancelled" => task.interaction.status_change = Some(crate::models::task::OperatorStatusChange {
                            request_id: "operator-stop".into(), target: crate::models::TaskStatus::Failed,
                        }),
                        _ => {
                            task.interaction.cancel_requested = true;
                            task.interaction.resume_requested = true;
                        }
                    }
                    crate::queue::fs::save_task_state(&queues, &file, &task)?;
                }
                fs::write(root.join("operator-applied"), "")?;
                Ok::<_, anyhow::Error>(())
            }))
        } else { None };
        let execution = timeout(Duration::from_secs(10),
            run_session(&mut connection, &runner, &root, &root, &task, &agent, &mut config, None)).await?;
        if let Some(operator) = operator { operator.await??; }
        let Connection { input, mut output, .. } = connection;
        drop(input);
        while timeout(Duration::from_secs(5), output.next_line()).await??.is_some() {}
        assert!(timeout(Duration::from_secs(5), child.wait()).await??.success());
        let saved = locate_task(&paths.base, "original")?.1;
        if case == "contract" {
            assert!(execution.err().context("Contract completion unexpectedly succeeded")?
                .to_string().contains("Unsupported task acceptance contract"));
            assert_eq!(saved.status, crate::models::TaskStatus::InProgress);
            assert!(saved.comments.is_empty());
        } else if case == "provider-error" {
            assert!(execution.err().context("Failed provider turn unexpectedly succeeded")?
                .to_string().contains("Turn failed after completion"));
            assert_eq!(saved.status, crate::models::TaskStatus::InProgress);
            assert!(saved.comments.is_empty());
        } else {
            assert_eq!(execution?.exit_code, if case == "aborted" { 1 } else { 0 });
            let expected = match case {
                "success" => crate::models::TaskStatus::Completed,
                "explicit-failure" => crate::models::TaskStatus::Failed,
                _ => crate::models::TaskStatus::InProgress,
            };
            assert_eq!(saved.status, expected, "{case}");
            if case == "success" {
                assert_eq!(saved.comments.len(), 1);
                assert!(saved.comments[0].message.contains("approval withheld"));
                assert_eq!(saved.comments[0].author, "agent:probe");
            } else if case == "explicit-failure" {
                assert_eq!(saved.error.as_deref(), Some("Explicit validation failure"));
            } else {
                assert!(saved.comments.is_empty(), "{case}");
            }
        }
        assert_eq!(saved.session_id.as_deref(), Some(session.as_str()));
        assert_eq!(saved.prompt, task.prompt);
        Ok(())
    }.await;
    fs::remove_dir_all(root)?;
    result
}

#[tokio::test]
async fn native_task_completion_finalizes_the_review_without_implying_approval() -> Result<()> {
    native_completion("success").await
}

#[tokio::test]
async fn native_task_completion_preserves_explicit_failure_and_acceptance_checks() -> Result<()> {
    for case in ["explicit-failure", "contract"] {
        native_completion(case).await?;
    }
    Ok(())
}

#[tokio::test]
async fn native_task_completion_ignores_failed_unrelated_replayed_foreign_and_cancelled_calls(
) -> Result<()> {
    for case in [
        "tool-failed",
        "unrelated",
        "replay",
        "foreign",
        "cancelled",
        "resume",
        "chat",
        "provider-error",
        "aborted",
    ] {
        native_completion(case).await?;
    }
    Ok(())
}

#[tokio::test]
async fn setup_deadlines_preserve_provider_errors_and_identify_the_stalled_method() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-acp-deadline-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root)?;
    let result = async {
        let script = root.join("peer.js");
        fs::write(
            &script,
            r#"
const send = value => process.stdout.write(JSON.stringify({jsonrpc:"2.0",...value})+"\n");
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize")
    setTimeout(() => send({id:request.id,result:{agentCapabilities:{loadSession:true}}}), 100);
  else if (request.method === "session/new")
    send({id:request.id,error:{code:-32000,message:"Authentication required"}});
});
"#,
        )?;
        let log = root.join("setup.log");
        let mut child = Command::new("node")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let mut connection = Connection {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()).lines(),
            log: OpenOptions::new().append(true).create(true).open(&log)?,
            next_id: 0,
        };
        let initialized = connection
            .call_with_timeout("initialize", json!({}), false, Duration::from_secs(5))
            .await?;
        assert_eq!(initialized["agentCapabilities"]["loadSession"], true);
        let rejected = connection
            .call("session/new", json!({}), false)
            .await
            .unwrap_err();
        assert!(rejected.to_string().contains("Authentication required"));
        assert!(!format!("{rejected:#}").contains("timed out"));
        let stalled = connection
            .call_with_timeout("session/load", json!({}), true, Duration::from_millis(50))
            .await
            .unwrap_err();
        let error = format!("{stalled:#}");
        assert!(
            error.contains("Copilot ACP setup timed out")
                && error.contains("ACP session/load did not respond")
        );
        drop(connection);
        assert!(timeout(Duration::from_secs(5), child.wait())
            .await??
            .success());
        let events: Vec<Value> = fs::read_to_string(log)?
            .lines()
            .map(serde_json::from_str)
            .collect::<std::result::Result<_, _>>()?;
        let completed: Vec<_> = events
            .iter()
            .filter(|event| event["type"] == "session.setup_complete")
            .map(|event| event["data"]["method"].as_str().unwrap())
            .collect();
        assert_eq!(completed, ["initialize"]);
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"] == "session.setup_start")
                .count(),
            3
        );
        Ok(())
    }
    .await;
    fs::remove_dir_all(root)?;
    result
}

#[tokio::test]
async fn provider_requests_with_colliding_ids_do_not_complete_client_requests() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-acp-collision-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("logs"))?;
    let result = async {
        let script = root.join("peer.js");
        fs::write(&script, r#"
const readline = require("node:readline");
let active;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:"2.0",...value})+"\n");
readline.createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize" || request.method === "session/prompt") {
    active = request;
    send({id:request.id,method:"session/request_permission",
      params:{options:[{kind:"allow_once",optionId:"allow"}]}});
  } else if (request.method === "session/new") {
    send({id:request.id,result:{sessionId:"collision-session",models:{currentModelId:process.argv[2]}}});
  } else if (!request.method && request.id === active?.id) {
    if (request.result?.outcome?.optionId !== "allow") throw Error("Permission response missing");
    send({id:active.id,result:active.method==="initialize" ?
      {agentCapabilities:{loadSession:true}} : {stopReason:"end_turn",usage:{inputTokens:1,outputTokens:1}}});
    active = undefined;
  }
});
"#)?;
        let agent = AgentConfig::parse("probe", "Fixture", PathBuf::new())?;
        let mut task = Task::new("original", "probe", "Original", "Fixture assignment");
        task.status = crate::models::TaskStatus::InProgress;
        task.workspace = Some(root.to_string_lossy().into_owned());
        let file = root.join("queues/in_progress/original.json");
        fs::create_dir_all(file.parent().unwrap())?;
        crate::queue::fs::write_task(&file, &task)?;
        let mut child = Command::new("node").arg(&script).arg(&agent.model)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true).spawn()?;
        let mut connection = Connection { input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()).lines(),
            log: OpenOptions::new().append(true).create(true).open(root.join("logs/mock.log"))?, next_id: 0 };
        let runner = CopilotRunner::new(root.join("logs"));
        let mut config = SessionConfig::capture(&root, &task, &agent, None)?;
        let execution = timeout(Duration::from_secs(10),
            run_session(&mut connection, &runner, &root, &root, &task, &agent, &mut config, None)).await??;
        assert_eq!(execution.exit_code, 0);
        assert_eq!(execution.session_id, "collision-session");
        drop(connection);
        assert!(timeout(Duration::from_secs(5), child.wait()).await??.success());
        Ok(())
    }.await;
    fs::remove_dir_all(root)?;
    result
}

async fn wait_for(mut ready: impl FnMut() -> Result<bool>) -> Result<()> {
    timeout(Duration::from_secs(10), async {
        while !ready()? {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<(), anyhow::Error>(())
    })
    .await
    .context("Timed out waiting for session state")?
}

fn queue_message(root: &Path, text: &str) -> Result<()> {
    mutate(root, "original", |task| {
        task.interaction
            .messages
            .push(crate::models::task::OperatorMessage {
                id: text.into(),
                text: text.into(),
                status: "queued".into(),
                created_at: chrono::Utc::now(),
                session_id: None,
                error: None,
            });
        task.interaction.paused = false;
        if task.interaction.cancel_requested {
            task.interaction.resume_requested = true;
        }
        Ok(())
    })?;
    Ok(())
}

async fn release_completed_turn_with_messages(explicit_stop: bool) -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-interrupt-acp-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("logs"))?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let history_dir = crate::usage::session_root()?.join(&session_id);
    fs::create_dir_all(&history_dir)?;
    let result = async {
        let script = root.join("mock-provider.js");
        fs::write(&script, r#"
const fs = require("node:fs");
const capture = process.argv[4], release = process.argv[5];
let active, turns = 0;
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result}) + "\n");
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(capture, line + "\n");
  if (request.method === "initialize") reply(request.id, {agentCapabilities:{loadSession:true}});
  else if (request.method === "session/new") reply(request.id,
    {sessionId:process.argv[2],models:{currentModelId:process.argv[3]}});
  else if (request.method === "session/prompt") {
    if (++turns === 1) {
      active = request.id;
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{
        sessionId:process.argv[2],update:{sessionUpdate:"tool_call",toolCallId:"busy",title:"Busy tool"}
      }}) + "\n");
    } else reply(request.id, {stopReason:"end_turn",usage:{inputTokens:1,outputTokens:1}});
  } else if (request.method === "session/cancel") {
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:900,method:"session/request_permission",
      params:{options:[{kind:"allow_once",optionId:"allow"}]}}) + "\n");
  } else if (request.id === 900) {
    const timer = setInterval(() => {
      if (!fs.existsSync(release)) return;
      clearInterval(timer);
      reply(active, {stopReason:"cancelled",usage:{inputTokens:1,outputTokens:1}});
    }, 10);
  }
});
"#)?;
        let capture = root.join("requests.jsonl");
        let release = root.join("release");
        let agent = AgentConfig::parse("probe", "Fixture instructions", PathBuf::new())?;
        let mut task = Task::new("original", "probe", "Original", "Original assignment");
        task.status = crate::models::TaskStatus::InProgress;
        task.workspace = Some(root.to_string_lossy().into_owned());
        let file = root.join("queues/in_progress/original.json");
        fs::create_dir_all(file.parent().unwrap())?;
        crate::queue::fs::write_task(&file, &task)?;
        let mut child = Command::new("node").arg(&script).arg(&session_id).arg(&agent.model)
            .arg(&capture).arg(&release).stdin(Stdio::piped()).stdout(Stdio::piped())
            .kill_on_drop(true).spawn()?;
        let mut connection = Connection { input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()).lines(),
            log: OpenOptions::new().append(true).create(true).open(root.join("logs/mock.log"))?, next_id: 0 };
        let runner = CopilotRunner::new(root.join("logs"));
        let mut config = SessionConfig { model: agent.model.clone(), reasoning_effort: None,
            workspace: task.workspace.clone().unwrap(), agent: task.agent.clone(), mcp: None, autopilot: false, provider: None };
        let operator = async {
            wait_for(|| Ok(capture.exists() && fs::read_to_string(&capture)?.contains("session/prompt"))).await?;
            queue_message(&root, "First follow-up")?;
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert!(!fs::read_to_string(&capture)?.contains("session/cancel"),
                "Queued input must not interrupt an unfinished turn");
            let events = [
                ("assistant.turn_start", json!({ "turnId": "first" })),
                ("assistant.message", json!({ "turnId": "first", "phase": "final_answer", "toolRequests": [] })),
                ("assistant.turn_end", json!({ "turnId": "first" })),
            ].map(|(kind, data)| format!("{}\n", json!({
                "type": kind, "data": data, "timestamp": chrono::Utc::now(),
            }))).concat();
            fs::write(history_dir.join("events.jsonl"), events)?;
            wait_for(|| Ok(fs::read_to_string(&capture)?.contains("session/cancel"))).await?;
            queue_message(&root, "Second follow-up")?;
            if explicit_stop {
                mutate(&root, "original", |task| {
                    task.interaction.paused = true;
                    task.interaction.cancel_requested = true;
                    task.interaction.resume_requested = false;
                    Ok(())
                })?;
            }
            fs::write(&release, "")?;
            if explicit_stop {
                wait_for(|| Ok(crate::queue::fs::read_task(&file)?.interaction.phase == "paused")).await?;
                let requests = fs::read_to_string(&capture)?;
                assert_eq!(requests.matches("session/prompt").count(), 1, "Explicit stop must win over queued messages");
                queue_message(&root, "Resume after stop")?;
            }
            Ok::<(), anyhow::Error>(())
        };
        let execution = run_session(&mut connection, &runner, &root, &root, &task, &agent, &mut config, None);
        let (execution, operator) = timeout(Duration::from_secs(15), async {
            tokio::join!(execution, operator)
        }).await.context("Completed turn did not release queued input")?;
        operator?;
        let execution = execution?;
        assert_eq!(execution.session_id, session_id);
        assert_eq!(execution.usage.turns, 2);
        connection.input.shutdown().await?;
        drop(connection.input);
        assert!(child.wait().await?.success());
        let requests: Vec<Value> = fs::read_to_string(&capture)?.lines()
            .map(serde_json::from_str).collect::<std::result::Result<_, _>>()?;
        assert_eq!(requests.iter().filter(|request| request["method"] == "session/new").count(), 1);
        assert_eq!(requests.iter().filter(|request| request["method"] == "session/cancel").count(), 1);
        let permission = requests.iter().find(|request| request["id"] == 900).unwrap();
        assert_eq!(permission["result"]["outcome"]["outcome"], "cancelled");
        let prompts: Vec<_> = requests.iter().filter(|request| request["method"] == "session/prompt").collect();
        assert_eq!(prompts.len(), 2);
        assert_eq!(prompts[0]["params"]["sessionId"], session_id);
        assert_eq!(prompts[1]["params"]["sessionId"], session_id);
        let texts: Vec<_> = prompts[1]["params"]["prompt"].as_array().unwrap().iter()
            .map(|message| message["text"].as_str().unwrap()).collect();
        assert_eq!(texts, if explicit_stop {
            vec!["First follow-up", "Second follow-up", "Resume after stop"]
        } else { vec!["First follow-up", "Second follow-up"] });
        let saved = crate::queue::fs::read_task(&file)?;
        assert!(!saved.interaction.paused && !saved.interaction.cancel_requested);
        assert!(saved.interaction.messages.iter().all(|message|
            message.status == "delivered" && message.session_id.as_deref() == Some(session_id.as_str())));
        assert_eq!(saved.workspace, task.workspace);
        assert_eq!(saved.prompt, task.prompt);
        Ok::<(), anyhow::Error>(())
    }.await;
    fs::remove_dir_all(root)?;
    fs::remove_dir_all(history_dir)?;
    result
}

#[tokio::test]
async fn completed_turn_release_batches_followups_in_the_same_session() -> Result<()> {
    release_completed_turn_with_messages(false).await
}

#[tokio::test]
async fn explicit_stop_during_message_interruption_waits_for_another_message() -> Result<()> {
    release_completed_turn_with_messages(true).await
}

async fn deferred_owner_cold_start(autopilot: bool, confirmation: &str) -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-deferred-acp-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("logs"))?;
    let result = async {
        let script = root.join("mock-provider.js");
        fs::write(&script, r#"
const fs = require("node:fs");
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.argv[4], line + "\n");
  if (request.method === "session/prompt" && process.argv[5] === "rejected") {
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{
      sessionId:process.argv[2],update:{sessionUpdate:"agent_message_chunk",
        content:{type:"text",text:"Failed to run /autopilot: Autopilot objective storage is not available"}}
    }}) + "\n");
  } else if (request.method === "session/prompt" && process.argv[5] !== "unsupported" && request.params.prompt[0]?.text.startsWith("/autopilot ")) {
    if (request.params.prompt.length !== 1) throw Error("Slash commands require exactly one text block");
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{
      sessionId:process.argv[2],update:{sessionUpdate:"current_mode_update",
        currentModeId:"https://agentclientprotocol.com/protocol/session-modes#autopilot"}
    }}) + "\n");
  }
  const model = {models:{currentModelId:process.argv[3]},...(process.argv[5] === "rejected" ?
    {modes:{currentModeId:"https://agentclientprotocol.com/protocol/session-modes#autopilot"}} : {})};
  const result = request.method === "initialize" ? {agentCapabilities:{loadSession:true}} :
    request.method === "session/new" ? {sessionId:process.argv[2],...model} :
    request.method === "session/load" ? {sessionId:request.params.sessionId,...model} :
    request.method === "session/prompt" ? {stopReason:"end_turn",usage:{inputTokens:1,outputTokens:1}} : {};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result}) + "\n");
});
"#)?;
        let capture = root.join("requests.jsonl");
        let session_id = uuid::Uuid::new_v4().to_string();
        let agent = AgentConfig::parse("probe", "Fix safe prose.", PathBuf::new())?;
        let mut task = Task::new("original", "probe", "Automation", "Automated creation already finished.");
        task.status = crate::models::TaskStatus::InProgress;
        task.deferred_session = true;
        task.workspace = Some(root.to_string_lossy().into_owned());
        task.runner_metadata = Some(json!({ "runner":"pr-updater",
            "preparation": { "ready":true,"repoRoot":root,"branch":"fixture" } }));
        task.interaction.messages.push(crate::models::task::OperatorMessage {
            id: "feedback".into(), text: "Only verified PR feedback".into(), status: "queued".into(),
            created_at: chrono::Utc::now(), session_id: None, error: None,
        });
        let file = root.join("queues/in_progress/original.json");
        fs::create_dir_all(file.parent().unwrap())?;
        crate::queue::fs::write_task(&file, &task)?;
        let runner = CopilotRunner::new(root.join("logs"));
        let mut config = SessionConfig { model: agent.model.clone(), reasoning_effort: None,
            workspace: task.workspace.clone().unwrap(), agent: task.agent.clone(), mcp: None, autopilot, provider: None };
        for turn in 0..2 {
            let mut child = Command::new("node").arg(&script).arg(&session_id).arg(&agent.model).arg(&capture)
                .arg(confirmation)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
            let mut connection = Connection { input: child.stdin.take().unwrap(),
                output: BufReader::new(child.stdout.take().unwrap()).lines(),
                log: OpenOptions::new().append(true).create(true).open(root.join("logs/mock.log"))?, next_id: 0 };
            let execution = run_session(&mut connection, &runner, &root, &root, &task, &agent, &mut config, None).await;
            connection.input.shutdown().await?;
            drop(connection.input);
            assert!(child.wait().await?.success());
            if confirmation != "confirmed" {
                let expected = if confirmation == "rejected" { "objective storage is not available" } else { "did not activate" };
                assert!(execution.err().context("Unsupported Autopilot unexpectedly succeeded")?.to_string().contains(expected));
                return Ok(());
            }
            let execution = execution?;
            assert_eq!(execution.session_id, session_id);
            assert_eq!(execution.usage.turns, 1);
            let context_file = root.join("controls/executions/original.json");
            assert_eq!(serde_json::from_slice::<Value>(&fs::read(context_file)?)?["sessionId"], session_id);
            assert!(!root.join(".runner-receipts/native-creators").exists());
            task = crate::queue::fs::read_task(&file)?;
            assert_eq!(task.interaction.messages.last().unwrap().status, "delivered");
            if turn == 0 {
                task.interaction.messages.push(crate::models::task::OperatorMessage {
                    id: "second".into(), text: "Only subsequent feedback".into(), status: "queued".into(),
                    created_at: chrono::Utc::now(), session_id: None, error: None,
                });
                crate::queue::fs::write_task(&file, &task)?;
            }
        }
        let requests: Vec<Value> = fs::read_to_string(capture)?.lines()
            .map(serde_json::from_str).collect::<std::result::Result<_, _>>()?;
        assert_eq!(requests.iter().filter(|r| r["method"] == "session/new").count(), 1);
        assert_eq!(requests.iter().filter(|r| r["method"] == "session/load").count(), 1);
        let prompts: Vec<_> = requests.iter().filter(|r| r["method"] == "session/prompt").collect();
        assert_eq!(prompts.len(), 2);
        if autopilot {
            assert_eq!(prompts[0]["params"]["prompt"].as_array().unwrap().len(), 1);
            assert_eq!(prompts[0]["params"]["prompt"][0]["text"],
                "/autopilot Only verified PR feedback");
            assert!(!fs::read_to_string(&root.join("requests.jsonl"))?.contains(&agent.system_prompt));
            assert_eq!(prompts[1]["params"]["prompt"][0]["text"], "/autopilot Only subsequent feedback");
        } else {
            assert_eq!(prompts[0]["params"]["prompt"][1]["text"], "Only verified PR feedback");
            assert_eq!(prompts[1]["params"]["prompt"][0]["text"], "Only subsequent feedback");
        }
        assert_eq!(prompts[1]["params"]["prompt"].as_array().unwrap().len(), 1);
        Ok::<(), anyhow::Error>(())
    }.await;
    fs::remove_dir_all(root)?;
    result
}

#[tokio::test]
async fn deferred_owner_cold_start_includes_feedback_then_restores_only_the_same_session(
) -> Result<()> {
    deferred_owner_cold_start(false, "confirmed").await
}

#[tokio::test]
async fn autopilot_objectives_exclude_roles_and_restore_only_new_feedback() -> Result<()> {
    deferred_owner_cold_start(true, "confirmed").await
}

#[tokio::test]
async fn autopilot_requires_provider_mode_confirmation() -> Result<()> {
    deferred_owner_cold_start(true, "unsupported").await
}

#[tokio::test]
async fn autopilot_rejects_failed_objectives_even_when_mode_is_already_active() -> Result<()> {
    deferred_owner_cold_start(true, "rejected").await
}

#[tokio::test]
#[ignore = "Live Codespace integration; requires SPOOL_REMOTE_ACP_CODESPACE and SPOOL_REMOTE_ACP_PROOF"]
async fn live_remote_copilot_preserves_spool_task_and_session() -> Result<()> {
    let codespace = std::env::var("SPOOL_REMOTE_ACP_CODESPACE")?;
    anyhow::ensure!(
        !codespace.is_empty()
            && codespace
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-'),
        "Invalid Codespace name"
    );
    let proof = PathBuf::from(std::env::var("SPOOL_REMOTE_ACP_PROOF")?);
    anyhow::ensure!(
        proof.is_absolute() && !proof.exists(),
        "Proof directory must be new and absolute"
    );
    fs::create_dir_all(proof.join("logs"))?;
    let token =
        std::env::var("COPILOT_GITHUB_TOKEN").context("Remote Copilot token is required")?;
    anyhow::ensure!(!token.contains(['\r', '\n']), "Invalid token");
    let agent = AgentConfig::parse("remote-proof",
        "---\nmodel: gpt-6.1-sol\n---\nUse native tools only. This is a read-only connection test. Do not modify files, branches, settings, dependencies or pull requests.",
        PathBuf::new())?;
    let mut task = Task::new("remote-proof", "remote-proof", "Native remote Spool proof",
        "Use your native file-reading tool to read midgard/packages/m365-copilot-app-library/package.json. Report its actual name. Do not use run.mjs, SSH commands, repository MCP or delegation; you are already inside the Codespace.");
    task.status = crate::models::TaskStatus::InProgress;
    task.workspace = Some(proof.to_string_lossy().into_owned());
    let file = proof.join("queues/in_progress/remote-proof.json");
    fs::create_dir_all(file.parent().unwrap())?;
    crate::queue::fs::write_task(&file, &task)?;
    let runner = CopilotRunner::new(proof.join("logs"));
    let mut config = SessionConfig {
        model: agent.model.clone(),
        reasoning_effort: None,
        workspace: task.workspace.clone().unwrap(),
        agent: task.agent.clone(),
        mcp: None,
        autopilot: false,
        provider: None,
    };
    let mut original_session = None;
    for turn in 0..2 {
        let remote = "IFS= read -r COPILOT_GITHUB_TOKEN && export COPILOT_GITHUB_TOKEN; cd /workspaces/1JS && exec copilot --acp --stdio --model gpt-6.1-sol";
        let mut child = Command::new("gh")
            .args([
                "codespace",
                "ssh",
                "-c",
                &codespace,
                "--",
                "-4",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                remote,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let mut input = child.stdin.take().context("Remote stdin missing")?;
        input.write_all(format!("{token}\n").as_bytes()).await?;
        let mut connection = Connection {
            input,
            output: BufReader::new(child.stdout.take().context("Remote stdout missing")?).lines(),
            log: OpenOptions::new()
                .append(true)
                .create(true)
                .open(proof.join("logs/provider.jsonl"))?,
            next_id: 0,
        };
        let result = run_session(
            &mut connection,
            &runner,
            &proof,
            Path::new("/workspaces/1JS"),
            &task,
            &agent,
            &mut config,
            None,
        )
        .await;
        connection.input.shutdown().await?;
        drop(connection.input);
        anyhow::ensure!(
            child.wait().await?.success(),
            "Remote Copilot did not close normally"
        );
        let execution = result?;
        anyhow::ensure!(execution.exit_code == 0, "Remote agent turn failed");
        if let Some(expected) = &original_session {
            anyhow::ensure!(expected == &execution.session_id, "Remote session changed");
        } else {
            original_session = Some(execution.session_id.clone());
        }
        task = crate::queue::fs::read_task(&file)?;
        anyhow::ensure!(
            task.session_id.as_deref() == Some(&execution.session_id),
            "Spool session not persisted"
        );
        println!(
            "Remote Spool turn {} completed in session {}",
            turn + 1,
            execution.session_id
        );
        if turn == 0 {
            task.interaction.messages.push(crate::models::task::OperatorMessage {
                id: "remote-follow-up".into(),
                text: "This is the follow-up on the same Spool task. Use your native shell tool to run pwd and git branch --show-current. Confirm the working directory, current branch and previously read Library package name. Do not change anything.".into(),
                status: "queued".into(), created_at: chrono::Utc::now(), session_id: None, error: None,
            });
            crate::queue::fs::write_task(&file, &task)?;
        }
    }
    anyhow::ensure!(
        task.interaction
            .messages
            .iter()
            .all(|message| message.status == "delivered"),
        "Spool did not acknowledge the follow-up"
    );
    let events = fs::read_to_string(proof.join("logs/provider.jsonl"))?;
    anyhow::ensure!(
        events.contains("tool.execution_complete")
            && events.contains("@1js/m365-copilot-app-library"),
        "Native tool execution or Library file contents were not recorded"
    );
    write_json(
        &proof.join("verified.json"),
        &json!({
            "ready": true, "sessionId": original_session, "taskId": task.id,
            "codespace": codespace, "remoteRoot": "/workspaces/1JS",
            "nativeTools": true, "turns": 2, "sameSessionRestored": true, "followUpDelivered": true,
            "productModified": false, "productionProviderEnabled": false,
        }),
    )?;
    Ok(())
}
