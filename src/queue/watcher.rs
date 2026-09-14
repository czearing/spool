use std::path::{Path, PathBuf};
use anyhow::Result;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub struct QueueEvent {
    pub path: PathBuf,
    pub is_incoming: bool,
}

pub struct QueueWatcher {
    _watcher: RecommendedWatcher,
}

impl QueueWatcher {
    pub fn start(
        queues_root: impl AsRef<Path>,
        tx: mpsc::Sender<QueueEvent>,
    ) -> Result<Self> {
        let queues_path = queues_root.as_ref().to_path_buf();
        let (sync_tx, sync_rx) = std::sync::mpsc::channel();

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = sync_tx.send(event);
                }
            },
            Config::default(),
        )?;

        watcher.watch(&queues_path, RecursiveMode::Recursive)?;

        // Background worker forwarding to tokio channel
        tokio::spawn(async move {
            while let Ok(event) = sync_rx.recv() {
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) => {
                        for path in event.paths {
                            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                                let is_incoming = path.components().any(|c| c.as_os_str() == "incoming");
                                let _ = tx.send(QueueEvent { path, is_incoming }).await;
                            }
                        }
                    }
                    _ => {}
                }
            }
        });

        Ok(Self { _watcher: watcher })
    }
}
