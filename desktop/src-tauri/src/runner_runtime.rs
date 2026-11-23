use serde_json::json;
use std::fs::{self, OpenOptions};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};

fn copy_tree(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), target.join(entry.file_name()))?;
        }
    }
    Ok(())
}

pub fn snapshot(
    runtime: &Path,
    script: &Path,
    data: &Path,
) -> std::io::Result<(PathBuf, PathBuf, PathBuf)> {
    let resources = script
        .parent()
        .ok_or_else(|| std::io::Error::other("Missing runner resources"))?;
    let engine = resources.join(if cfg!(windows) {
        "spool-engine.exe"
    } else {
        "spool-engine"
    });
    let mut revision = DefaultHasher::new();
    for file in [runtime, &engine, script] {
        fs::read(file)?.hash(&mut revision);
    }
    let manifest = resources.join("runners").join("runtime-manifest.json");
    if manifest.exists() {
        fs::read(manifest)?.hash(&mut revision);
    }
    let directory = data
        .join("runner-runtimes")
        .join(format!("{:016x}", revision.finish()));
    let lease = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(data.join("runner-runtime.lock"))?;
    lease.lock()?;
    let target_runtime = directory.join(if cfg!(windows) {
        "spool-runtime.exe"
    } else {
        "spool-runtime"
    });
    let target_engine = directory.join(engine.file_name().unwrap());
    let target_script = directory.join("backend.mjs");
    if !directory.join("complete").exists() {
        fs::create_dir_all(&directory)?;
        fs::copy(runtime, &target_runtime)?;
        fs::copy(&engine, &target_engine)?;
        fs::copy(script, &target_script)?;
        for name in ["runners", "copilot"] {
            let source = resources.join(name);
            if source.is_dir() {
                copy_tree(&source, &directory.join(name))?;
            }
        }
        fs::write(directory.join("complete"), "")?;
    }
    let temporary = data.join(format!("runner-host-target.{}.tmp", std::process::id()));
    fs::write(
        &temporary,
        serde_json::to_vec(&json!({
            "runtime": target_runtime, "script": target_script, "engine": target_engine,
        }))?,
    )?;
    fs::rename(temporary, data.join("runner-host-target.json"))?;
    Ok((target_runtime, target_script, target_engine))
}
