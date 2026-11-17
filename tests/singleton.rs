use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

struct Fixture {
    child: Child,
    root: PathBuf,
}

impl Fixture {
    fn start() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("spool-process-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("agents")).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_spool"))
            .arg("--root")
            .arg(&root)
            .arg("daemon")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let fixture = Self { child, root };
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            let _ = tx.send(result);
        });
        let line = rx
            .recv_timeout(Duration::from_secs(15))
            .expect("Fixture daemon startup timed out")
            .unwrap();
        assert!(line.contains("Spool Daemon running"), "{line}");
        fixture
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // This fixture has no agent definitions and cannot launch a real agent.
        if self.child.try_wait().ok().flatten().is_none() {
            self.child.kill().expect("Cannot stop empty fixture daemon");
            self.child.wait().expect("Cannot reap fixture daemon");
        }
        std::fs::remove_dir_all(&self.root).expect("Cannot clean up isolated process fixture");
    }
}

#[test]
fn simultaneous_terminal_starts_cannot_recover_or_dispatch_another_daemons_tasks() {
    let fixture = Fixture::start();
    let sentinel = fixture
        .root
        .join("queues")
        .join("in_progress")
        .join("sentinel.json");
    let content = r#"{"id":"sentinel","agent":"unconfigured","title":"Must not move","prompt":"Never execute","status":"in_progress"}"#;
    std::fs::write(&sentinel, content).unwrap();
    let clients: Vec<_> = [Some("daemon"), Some("run"), None, Some("daemon")]
        .into_iter()
        .map(|mode| {
            let root = fixture.root.join(".");
            std::thread::spawn(move || {
                let mut command = Command::new(env!("CARGO_BIN_EXE_spool"));
                command.arg("--root").arg(root);
                if let Some(mode) = mode {
                    command.arg(mode);
                }
                let output = command.output().unwrap();
                assert!(!output.status.success());
                assert!(
                    String::from_utf8_lossy(&output.stderr).contains("duplicate startup refused")
                );
            })
        })
        .collect();
    for client in clients {
        client.join().unwrap();
    }
    assert_eq!(std::fs::read_to_string(sentinel).unwrap(), content);
    assert_eq!(
        std::fs::read_dir(fixture.root.join("queues").join("incoming"))
            .unwrap()
            .count(),
        0
    );
    let status = Command::new(env!("CARGO_BIN_EXE_spool"))
        .arg("--root")
        .arg(&fixture.root)
        .arg("status")
        .output()
        .unwrap();
    assert!(status.status.success());
}

#[test]
fn process_exit_releases_lease_without_stale_lock_file_cleanup() {
    let mut fixture = Fixture::start();
    fixture.child.kill().unwrap();
    fixture.child.wait().unwrap();
    assert!(fixture.root.join(".runner").join("daemon.lock").exists());
    let mut second = Command::new(env!("CARGO_BIN_EXE_spool"))
        .arg("--root")
        .arg(&fixture.root)
        .arg("daemon")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(second.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    fixture.child = second;
    assert!(line.contains("Spool Daemon running"), "{line}");
}
