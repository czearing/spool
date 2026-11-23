use serde_json::json;
use std::fs::{self, OpenOptions};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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

fn snapshot(
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

pub fn start(runtime: &Path, script: &Path, data: &Path) -> std::io::Result<()> {
    let (runtime, script, engine) = snapshot(runtime, script, data)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(data.join("runners.log"))?;
    let mut command = Command::new(&engine);
    command
        .arg("runner-host")
        .arg("--runtime")
        .arg(dunce::simplified(&runtime))
        .arg("--script")
        .arg(dunce::simplified(&script))
        .arg("--data")
        .arg(dunce::simplified(data))
        .current_dir(data)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The runner host must not inherit the desktop's kill-on-close job.
        command.creation_flags(0x01000000 | 0x08000000);
    }
    let child = command.spawn();
    #[cfg(windows)]
    let child = match child {
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            use std::os::windows::process::CommandExt;
            let quote = |value: &Path| format!("\"{}\"", dunce::simplified(value).display());
            let line = format!(
                "{} runner-host --runtime {} --script {} --data {}",
                quote(&engine),
                quote(&runtime),
                quote(&script),
                quote(data)
            );
            let literal = |value: &str| format!("'{}'", value.replace('\'', "''"));
            let shell =
                PathBuf::from(std::env::var_os("SystemRoot").ok_or_else(|| {
                    std::io::Error::other("Windows system directory is unavailable")
                })?)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            let script = format!("$ErrorActionPreference='Stop'; $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{{CreateFlags=[uint32]0x09000000;ShowWindow=[uint16]0}}; $p=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine={};CurrentDirectory={};ProcessStartupInformation=$startup}}; if($p.ReturnValue -ne 0) {{ throw \"Runner host creation failed: $($p.ReturnValue)\" }}",
                literal(&line), literal(&data.to_string_lossy()));
            let log = OpenOptions::new()
                .create(true)
                .append(true)
                .open(data.join("runners.log"))?;
            Command::new(shell)
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(log)
                .spawn()
        }
        result => result,
    };
    let mut child = child?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
