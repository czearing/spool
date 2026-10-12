use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tokio::process::Command;

pub struct PaperclipImporter {
    pub base_url: String,
    pub company_id: String,
    pub root: PathBuf,
}

impl PaperclipImporter {
    pub fn new(base_url: &str, company_id: &str, root: impl AsRef<Path>) -> Self {
        Self { base_url: base_url.trim_end_matches('/').to_owned(), company_id: company_id.to_owned(), root: root.as_ref().to_path_buf() }
    }

    pub async fn run_import(&self) -> Result<usize> {
        let bridge = self.root.parent().context("Spool root has no parent")?
            .join("spool-runners").join("bridge").join("migrate-paperclip.mjs");
        anyhow::ensure!(bridge.is_file(), "Verified import bridge is missing: {}", bridge.display());
        let mut command = Command::new("node");
        command.arg(bridge).arg("--apply").arg("--spool-root").arg(&self.root)
            .arg("--paperclip-url").arg(&self.base_url).arg("--company-id").arg(&self.company_id);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let output = command.output().await.context("Cannot run verified migration")?;
        anyhow::ensure!(output.status.success(), "Migration failed: {}", String::from_utf8_lossy(&output.stderr));
        let report: serde_json::Value = serde_json::from_slice(&output.stdout)?;
        println!("{}", String::from_utf8_lossy(&output.stdout));
        let count = report["tasks"].as_u64().context("Migration did not confirm an imported count")?;
        Ok(count as usize)
    }
}
