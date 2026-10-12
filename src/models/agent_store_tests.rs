use super::agent_store::*;
use crate::models::AgentConfig;
use std::{fs, path::{Path, PathBuf}};
use serde_json::{json, Value};
use anyhow::Result;

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!("spool-agent-settings-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("agents")).unwrap();
    root
}
fn create(root: &Path, name: &str) -> Result<Value> {
    save(root, json!({ "name": name, "description": "A --- quoted \"description\"",
        "prompt": "# Instructions\n\nPreserve content.", "icon": "search" }), true)
}
fn update(value: &Value, limit: Value) -> Value {
    json!({ "name": value["name"], "description": value["description"], "model": value["model"],
        "icon": value["icon"], "max_concurrent_runs": limit, "revision": value["revision"] })
}
#[test]
fn new_agents_can_start_with_a_blank_prompt_without_placeholder_instructions() -> Result<()> {
    let root = fixture();
    let created = save(&root, json!({ "name": "draft", "prompt": "", "model": null }), true)?;
    assert_eq!(created["name"], "draft");
    let file = root.join("agents/draft.md");
    assert_eq!(AgentConfig::from_file(&file)?.system_prompt, "");
    let changed = save(&root, update(&created, json!(2)), false)?;
    assert_eq!(changed["maxConcurrentRuns"], 2);
    assert_eq!(AgentConfig::from_file(&file)?.system_prompt, "");
    for prompt in [json!(null), json!("\0"), json!("x".repeat(120_001))] {
        assert!(save(&root, json!({ "name": "invalid", "prompt": prompt }), true).is_err());
    }
    fs::remove_dir_all(root)?;
    Ok(())
}
#[test]
fn agent_settings_create_update_preserves_prompt_and_unknown_configuration() -> Result<()> {
    let root = fixture();
    let created = create(&root, "researcher")?;
    assert_eq!(created["maxConcurrentRuns"], 1);
    assert_eq!(created["icon"], "search");
    assert!(created["model"].is_null());
    assert!(create(&root, "researcher").is_err());
    let file = root.join("agents/researcher.md");
    let original = fs::read_to_string(&file)?.replacen("---\n",
        &format!("---\nreasoning: high\ntools: read, search\ndefault_workspace: {}\n", json!(root)), 1);
    fs::write(&file, &original)?;
    let current = get(&root, "researcher")?;
    let changed = save(&root, update(&current, Value::Null), false)?;
    assert!(changed["maxConcurrentRuns"].is_null());
    assert_eq!(changed["defaultWorkspace"], json!(root));
    assert!(save(&root, update(&current, json!(2)), false).is_err());
    let config = AgentConfig::from_file(&file)?;
    assert_eq!(config.description, "A --- quoted \"description\"");
    assert_eq!(config.reasoning_effort.as_deref(), Some("high"));
    assert_eq!(config.tools, ["read", "search"]);
    assert_eq!(config.system_prompt, "# Instructions\n\nPreserve content.");
    assert_eq!(list(&root)?.as_array().unwrap().len(), 1);
    fs::remove_dir_all(root)?;
    Ok(())
}
#[test]
fn agent_settings_rejects_invalid_inputs_and_does_not_touch_other_writers() -> Result<()> {
    let root = fixture();
    for name in ["../escape", "bad/name", "NUL", "com1", ""] {
        assert!(create(&root, name).is_err());
    }
    for limit in [json!(0), json!(-1), json!(1.5), json!("2"), json!(9007199254740992_u64)] {
        assert!(save(&root, json!({ "name": "bad", "prompt": "Instructions", "max_concurrent_runs": limit }), true).is_err());
    }
    let current = create(&root, "engineer")?;
    let lock = root.join("agents/engineer.md.lock");
    fs::write(&lock, "Other writer")?;
    assert!(save(&root, update(&current, json!(2)), false).is_err());
    assert_eq!(fs::read_to_string(&lock)?, "Other writer");
    fs::remove_file(lock)?;
    assert!(save(&root, json!({ "name": "engineer", "revision": current["revision"] }), false).is_err());
    assert_eq!(get(&root, "engineer")?, current);
    fs::remove_dir_all(root)?;
    Ok(())
}
#[test]
fn agent_settings_creation_races_never_replace_a_definition() -> Result<()> {
    let root = fixture();
    let workers: Vec<_> = (0..8).map(|_| {
        let root = root.clone();
        std::thread::spawn(move || create(&root, "unique").is_ok())
    }).collect();
    assert_eq!(workers.into_iter().filter_map(|worker| worker.join().ok()).filter(|ok| *ok).count(), 1);
    assert_eq!(get(&root, "unique")?["name"], "unique");
    assert_eq!(fs::read_dir(root.join("agents"))?.count(), 1);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn agent_images_persist_without_rewriting_hidden_metadata_and_remove_explicitly() -> Result<()> {
    let root = fixture();
    let image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=";
    let current = save(&root, json!({ "name": "portrait", "prompt": "Instructions", "image": image,
        "description": "Keep this description", "icon": "shield" }), true)?;
    assert_eq!(current["image"], image);
    let change = |current: &Value| json!({ "name": "portrait", "model": null,
        "max_concurrent_runs": 2, "revision": current["revision"] });
    let next = save(&root, change(&current), false)?;
    assert_eq!(next["image"], image);
    assert_eq!(next["description"], "Keep this description");
    assert_eq!(next["icon"], "shield");
    let mut invalid = change(&next);
    invalid["image"] = json!("data:image/svg+xml;base64,PHN2Zz4=");
    assert!(save(&root, invalid, false).is_err());
    for image in ["data:image/png;base64,AAAA", "https://example.com/image.png", "data:image/png;base64,!!"] {
        let mut invalid = change(&next);
        invalid["image"] = json!(image);
        assert!(save(&root, invalid, false).is_err());
    }
    let mut oversized = change(&next);
    oversized["image"] = json!(format!("data:image/png;base64,{}", "A".repeat(65_536)));
    assert!(save(&root, oversized, false).is_err());
    assert_eq!(get(&root, "portrait")?, next);
    let mut remove = change(&next);
    remove["image"] = Value::Null;
    assert!(save(&root, remove, false)?["image"].is_null());
    assert!(save(&root, change(&current), false).is_err());
    assert_eq!(AgentConfig::from_file(root.join("agents/portrait.md"))?.system_prompt, "Instructions");
    fs::remove_dir_all(root)?;
    Ok(())
}
