use super::*;
use std::process::ExitStatus;
use tokio::process::Child;
use tokio::task::JoinHandle;

#[derive(Debug)]
pub(super) struct CleanupUncertain(pub String);

impl std::fmt::Display for CleanupUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.0) }
}
impl std::error::Error for CleanupUncertain {}

pub(super) type StderrTask = JoinHandle<std::io::Result<()>>;

pub(super) async fn finish(
    child: &mut Child, stderr: &mut Option<StderrTask>, grace: Duration,
) -> Result<ExitStatus> {
    let uncertain = |message| anyhow::Error::new(CleanupUncertain(message));
    let status = match timeout(grace, child.wait()).await {
        Ok(status) => status.map_err(|error| uncertain(format!("Cannot reap provider: {error}")))?,
        Err(_) => {
            match timeout(Duration::from_secs(15), super::super::oneshot::stop(child)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => return Err(uncertain(format!("Provider tree cleanup failed: {error:#}"))),
                Err(_) => return Err(uncertain("Provider tree cleanup exceeded 15 seconds".into())),
            }
            child.try_wait().map_err(|error| uncertain(format!("Cannot confirm provider exit: {error}")))?
                .ok_or_else(|| uncertain("Provider survived tree cleanup".into()))?
        }
    };
    if let Some(reader) = stderr.as_mut() {
        let result = timeout(grace, reader).await.map_err(|_| uncertain(
            "Provider exited but stderr remains open; possible surviving descendant, retaining ownership".into()))?;
        *stderr = None;
        result.context("Provider stderr reader failed")?.context("Cannot persist provider stderr")?;
    }
    Ok(status)
}

pub(super) fn outcome(
    result: Result<CopilotExecutionResult>, cleanup: Result<ExitStatus>,
) -> Result<CopilotExecutionResult> {
    match (result, cleanup) {
        (Err(error), Err(cleanup)) => Err(error.context(format!("Provider cleanup also failed: {cleanup:#}"))),
        (Err(error), Ok(_)) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(mut result), Ok(status)) => {
            if !status.success() { result.exit_code = status.code().unwrap_or(-1); }
            Ok(result)
        }
    }
}

#[cfg(test)]
#[path = "shutdown_tests.rs"]
mod tests;
