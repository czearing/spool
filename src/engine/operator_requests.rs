use super::*;

pub fn process_requests(root: &Path, active: &HashSet<String>) -> Result<()> {
    let incoming = root.join("controls").join("requests");
    let results = root.join("controls").join("results");
    let history = root.join("controls").join("history");
    for directory in [&incoming, &results, &history] { std::fs::create_dir_all(directory)?; }
    let capability = root.join("controls").join("capabilities.json");
    let fresh = match std::fs::metadata(&capability) {
        Ok(metadata) => metadata.modified()?.elapsed()?.as_secs() < 2,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if !fresh {
        write_json(&capability, &json!({ "version": 1, "usageAccountingVersion": 2, "usageUsdVersion": 2, "projectModelVersion": 1, "taskModelVersion": 1, "bundleAcceptanceVersion": 2, "parallelTaskExecutionVersion": 1, "statusControl": true, "taskControl": true,
            "deferredPrOwnersVersion": 1, "agentSettingsVersion": 1, "agentWorkspaceVersion": 1, "sharedPromptsVersion": 1, "interactive": crate::copilot::process::interactive_enabled(), "messageContinuationVersion": 1, "preparedMessageVersion": 1,
            "pid": std::process::id(), "updatedAt": chrono::Utc::now() }))?;
    }
    let mut requests = Vec::new();
    for entry in std::fs::read_dir(&incoming)? {
        let file = entry?.path();
        if file.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let id = file.file_stem().and_then(|s| s.to_str()).context("Invalid request filename")?.to_owned();
        validate_id(&id)?;
        let request = std::fs::read(&file).map_err(anyhow::Error::from)
            .and_then(|bytes| serde_json::from_slice::<OperatorRequest>(&bytes).map_err(Into::into));
        requests.push((file, id, request));
    }
    requests.sort_by_key(|(_, _, request)| request.as_ref().map(|r| r.created_at).unwrap_or_default());
    for (file, id, parsed) in requests {
        let result_file = results.join(format!("{id}.json"));
        if !result_file.exists() {
            let outcome = parsed.and_then(|request| {
                anyhow::ensure!(request.id == id, "Request identity does not match file");
                apply_request(root, &request, active)
            });
            let result = match outcome {
                Ok(value) => value,
                Err(error) => json!({ "status": "failed", "error": format!("{error:#}") }),
            };
            if result["status"] == "pending" { continue; }
            write_json(&result_file, &json!({ "id": id, "processedAt": chrono::Utc::now(), "result": result }))?;
        }
        std::fs::rename(file, history.join(format!("{id}.json")))?;
    }
    Ok(())
}
