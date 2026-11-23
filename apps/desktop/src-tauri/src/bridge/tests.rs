use super::*;
use std::time::Instant;

fn until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "Fixture desktop process did not reach its expected state"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn runner_host_survives_backend_crash_reconnect_and_desktop_shutdown(
) -> Result<(), Box<dyn std::error::Error>> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = std::env::temp_dir().join(format!("spool-bridge-{}", std::process::id()));
    std::fs::create_dir_all(&root)?;
    let runtime = manifest
        .join("binaries")
        .join("spool-runtime-x86_64-pc-windows-msvc.exe");
    std::fs::copy(
        manifest.join("resources").join("spool-engine.exe"),
        root.join("spool-engine.exe"),
    )?;
    let script = root.join("backend.mjs");
    std::fs::write(
        &script,
        r#"
    import { existsSync, writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    if (process.argv.includes("--runner-service")) {
      writeFileSync("service-pid", String(process.pid));
      const timer = setInterval(() => {
        if (existsSync("stop-service")) { clearInterval(timer); process.exit(0); }
        writeFileSync("heartbeat", String(Date.now()));
      }, 20);
      createInterface({ input: process.stdin }).on("line", line => {
        if (line === "shutdown") { clearInterval(timer); process.exit(0); }
      });
    } else {
      console.log(JSON.stringify({ id: "ready", type: "ready" }));
      createInterface({ input: process.stdin }).on("line", line => {
        const value = JSON.parse(line);
        if (value.crash) process.exit(7);
        if (value.shutdown) process.exit(0);
      });
    }
    "#,
    )?;
    let bridge = Bridge::start(&runtime, &script, &root)?;
    until(|| root.join("heartbeat").exists());
    let service = std::fs::read_to_string(root.join("service-pid"))?;
    {
        let mut connection = bridge.connection.lock().unwrap();
        let pid = connection.child.id();
        connection.send(&json!({ "crash": true }))?;
        until(|| connection.child.try_wait().unwrap().is_some());
        bridge.reconnect(&mut connection)?;
        assert_ne!(connection.child.id(), pid);
    }
    bridge.shutdown()?;
    drop(bridge);
    let heartbeat = std::fs::read_to_string(root.join("heartbeat"))?;
    until(|| std::fs::read_to_string(root.join("heartbeat")).unwrap_or_default() != heartbeat);
    assert_eq!(std::fs::read_to_string(root.join("service-pid"))?, service);
    std::fs::write(
        &script,
        format!(
            "{}\n// Updated runtime revision",
            std::fs::read_to_string(&script)?
        ),
    )?;
    let updated = Bridge::start(&runtime, &script, &root)?;
    until(|| std::fs::read_to_string(root.join("service-pid")).is_ok_and(|pid| pid != service));
    updated.shutdown()?;
    drop(updated);
    let heartbeat = std::fs::read_to_string(root.join("heartbeat"))?;
    until(|| std::fs::read_to_string(root.join("heartbeat")).unwrap_or_default() != heartbeat);
    std::fs::write(root.join("stop-service"), "")?;
    until(|| {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("runner-host.lock"));
        file.is_ok_and(|file| file.try_lock().is_ok())
    });
    until(|| std::fs::remove_dir_all(&root).is_ok() || !root.exists());
    Ok(())
}
