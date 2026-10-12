use super::*;

#[tokio::test]
async fn deferred_owner_cold_start_includes_feedback_then_restores_only_the_same_session() -> Result<()> {
    let root = std::env::temp_dir().join(format!("spool-deferred-acp-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("logs"))?;
    fs::create_dir_all(root.join(".runner-receipts/creator-contexts"))?;
    fs::create_dir_all(root.join(".runner-receipts/native-creators"))?;
    let result = async {
        let script = root.join("mock-provider.js");
        fs::write(&script, r#"
const fs = require("node:fs");
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.argv[4], line + "\n");
  const model = {models:{currentModelId:process.argv[3]}};
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
        task.deferred_pr_owner = true;
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
        let owner_file = root.join(".runner-receipts/native-creators/original.json");
        write_json(&owner_file, &json!({ "originKind":"spool_automation","verified":true,"deferred":true,
            "taskId":task.id,"agent":task.agent,"sessionId":null }))?;
        let runner = CopilotRunner::new(root.join("logs"));
        let mut config = SessionConfig { model: agent.model.clone(), reasoning_effort: None,
            workspace: task.workspace.clone().unwrap(), agent: task.agent.clone(), mcp: None };
        for turn in 0..2 {
            let mut child = Command::new("node").arg(&script).arg(&session_id).arg(&agent.model).arg(&capture)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
            let mut connection = Connection { input: child.stdin.take().unwrap(),
                output: BufReader::new(child.stdout.take().unwrap()).lines(),
                log: OpenOptions::new().append(true).create(true).open(root.join("logs/mock.log"))?, next_id: 0 };
            let execution = run_session(&mut connection, &runner, &root, &root, &task, &agent, &mut config, None).await?;
            assert_eq!(execution.session_id, session_id);
            assert_eq!(execution.usage.turns, 1);
            connection.input.shutdown().await?;
            drop(connection.input);
            assert!(child.wait().await?.success());
            assert_eq!(serde_json::from_slice::<Value>(&fs::read(&owner_file)?)?["sessionId"], session_id);
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
        assert_eq!(prompts[0]["params"]["prompt"][1]["text"], "Only verified PR feedback");
        assert_eq!(prompts[1]["params"]["prompt"].as_array().unwrap().len(), 1);
        assert_eq!(prompts[1]["params"]["prompt"][0]["text"], "Only subsequent feedback");
        Ok::<(), anyhow::Error>(())
    }.await;
    fs::remove_dir_all(root)?;
    result
}
