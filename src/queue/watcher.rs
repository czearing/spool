use anyhow::Result;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub struct QueueEvent {
    pub path: PathBuf,
    pub is_incoming: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn idle_watchers_do_not_block_scheduler_timers() -> Result<()> {
        let root = std::env::temp_dir().join(format!("spool-watcher-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()?;
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let (watchers, receivers) = runtime.block_on(async {
            let mut watchers = Vec::new();
            let mut receivers = Vec::new();
            for _ in 0..2 {
                let (tx, rx) = mpsc::channel(1);
                watchers.push(QueueWatcher::start(&root, tx)?);
                receivers.push(rx);
            }
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let _ = done_tx.send(());
            });
            Ok::<_, anyhow::Error>((watchers, receivers))
        })?;
        let progressed = done_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        drop(watchers);
        drop(receivers);
        runtime.shutdown_timeout(Duration::from_secs(1));
        std::fs::remove_dir_all(root)?;
        assert!(
            progressed,
            "Idle queue watchers prevented the scheduler timer from running"
        );
        Ok(())
    }

    #[tokio::test]
    async fn delivers_changes_after_idle_and_a_full_notification_channel() -> Result<()> {
        let root =
            std::env::temp_dir().join(format!("spool-watcher-events-{}", uuid::Uuid::new_v4()));
        let incoming = root.join("incoming");
        std::fs::create_dir_all(&incoming)?;
        let (tx, mut rx) = mpsc::channel(1);
        let watcher = QueueWatcher::start(&root, tx)?;
        tokio::time::sleep(Duration::from_millis(50)).await;
        for n in 0..20 {
            std::fs::write(incoming.join(format!("burst-{n}.json")), "{}")?;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await?
            .expect("Watcher closed before delivering a change");
        assert!(event.is_incoming);
        let final_path = incoming.join("after-burst.json");
        let observed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                while rx.try_recv().is_ok() {}
                std::fs::write(&final_path, "{}")?;
                if let Some(event) = rx.recv().await {
                    if event.path == final_path {
                        break Ok::<_, std::io::Error>(());
                    }
                }
            }
        })
        .await;
        drop(watcher);
        std::fs::remove_dir_all(root)?;
        observed??;
        Ok(())
    }

    #[tokio::test]
    async fn task_watcher_ignores_other_tasks_and_observes_atomic_updates_and_queue_moves(
    ) -> Result<()> {
        let root =
            std::env::temp_dir().join(format!("spool-task-watcher-{}", uuid::Uuid::new_v4()));
        let paths = crate::queue::fs::QueuePaths::new(&root);
        paths.ensure_dirs()?;
        let (tx, mut rx) = mpsc::channel(1);
        let watcher = QueueWatcher::start_task(&root, "original", tx)?;
        let result = async {
            crate::queue::fs::write_json(
                paths.incoming.join("unrelated.json"),
                &serde_json::json!({}),
            )?;
            assert!(tokio::time::timeout(Duration::from_millis(100), rx.recv())
                .await
                .is_err());
            let incoming = paths.incoming.join("original.json");
            crate::queue::fs::write_json(&incoming, &serde_json::json!({ "message": "first" }))?;
            let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await?
                .expect("Task watcher closed");
            assert_eq!(event.path, incoming);
            while rx.try_recv().is_ok() {}
            let active = paths.in_progress.join("original.json");
            std::fs::rename(&incoming, &active)?;
            crate::queue::fs::write_json(&active, &serde_json::json!({ "message": "follow-up" }))?;
            let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await?
                .expect("Task watcher closed after move");
            assert_eq!(event.path.file_stem().unwrap(), "original");
            Ok::<_, anyhow::Error>(())
        }
        .await;
        drop(watcher);
        std::fs::remove_dir_all(root)?;
        result
    }
}

pub struct QueueWatcher {
    _watcher: RecommendedWatcher,
}

impl QueueWatcher {
    pub fn start(queues_root: impl AsRef<Path>, tx: mpsc::Sender<QueueEvent>) -> Result<Self> {
        Self::start_filtered(queues_root, tx, None)
    }

    pub fn start_task(
        queues_root: impl AsRef<Path>,
        task_id: &str,
        tx: mpsc::Sender<QueueEvent>,
    ) -> Result<Self> {
        Self::start_filtered(queues_root, tx, Some(task_id.to_owned()))
    }

    fn start_filtered(
        queues_root: impl AsRef<Path>,
        tx: mpsc::Sender<QueueEvent>,
        task_id: Option<String>,
    ) -> Result<Self> {
        let queues_path = queues_root.as_ref().to_path_buf();
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                let event = match res {
                    Ok(event) => event,
                    Err(error) => {
                        eprintln!("Queue watcher failed: {error}; periodic scheduler scans remain enabled");
                        return;
                    }
                };
                match event.kind {
                    EventKind::Create(_)
                    | EventKind::Modify(_)
                    | EventKind::Remove(_)
                    | EventKind::Any => {
                        for path in event.paths {
                            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                                if task_id.as_ref().is_some_and(|id| {
                                    path.file_stem().and_then(|name| name.to_str())
                                        != Some(id.as_str())
                                }) {
                                    continue;
                                }
                                let is_incoming =
                                    path.components().any(|c| c.as_os_str() == "incoming");
                                // Consumers rescan the queues, so a pending notification covers
                                // subsequent changes. Never block a runtime worker or the watcher.
                                match tx.try_send(QueueEvent { path, is_incoming }) {
                                    Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => {}
                                    Err(mpsc::error::TrySendError::Closed(_)) => return,
                                }
                            }
                        }
                    }
                    _ => {}
                }
            },
            Config::default(),
        )?;

        watcher.watch(&queues_path, RecursiveMode::Recursive)?;

        Ok(Self { _watcher: watcher })
    }
}
