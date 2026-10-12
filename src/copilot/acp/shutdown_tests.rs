use super::*;

#[cfg(windows)]
fn provider(script: &str) -> Result<Child> {
    Ok(Command::new("pwsh").args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x08000000).stdin(Stdio::piped()).stderr(Stdio::piped())
        .stdout(Stdio::null()).spawn()?)
}

#[cfg(windows)]
fn reader(child: &mut Child) -> Option<StderrTask> {
    let mut stderr = child.stderr.take().unwrap();
    Some(tokio::spawn(async move {
        tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await?;
        Ok(())
    }))
}

#[cfg(windows)]
#[tokio::test]
async fn normal_eof_shutdown_preserves_success() -> Result<()> {
    let mut child = provider("[Console]::In.ReadToEnd() | Out-Null; exit 0")?;
    let mut stderr = reader(&mut child);
    drop(child.stdin.take());
    let status = finish(&mut child, &mut stderr, Duration::from_secs(10)).await?;
    assert!(status.success());
    assert!(stderr.is_none());
    Ok(())
}

#[cfg(windows)]
#[tokio::test]
async fn hung_shutdown_is_bounded_and_preserves_the_original_execution_error() -> Result<()> {
    let mut child = provider("Start-Sleep 120")?;
    let mut stderr = reader(&mut child);
    drop(child.stdin.take());
    let cleanup = timeout(Duration::from_secs(20),
        finish(&mut child, &mut stderr, Duration::from_millis(100))).await??;
    assert!(child.try_wait()?.is_some());
    assert!(stderr.is_none());
    let result = outcome(Err(anyhow::anyhow!("There is not enough space on the disk (os error 112)")), Ok(cleanup));
    assert!(format!("{:#}", result.err().unwrap()).contains("os error 112"));
    Ok(())
}

#[cfg(windows)]
#[tokio::test]
async fn open_stderr_retains_ownership_until_the_reader_really_finishes() -> Result<()> {
    let mut child = provider("exit 0")?;
    child.wait().await?;
    let (release, wait) = tokio::sync::oneshot::channel::<()>();
    let mut stderr = Some(tokio::spawn(async move { let _ = wait.await; Ok(()) }));
    let error = finish(&mut child, &mut stderr, Duration::from_millis(25)).await.unwrap_err();
    assert!(error.is::<CleanupUncertain>());
    assert!(stderr.is_some(), "Do not detach or discard the unconfirmed reader");
    release.send(()).unwrap();
    assert!(finish(&mut child, &mut stderr, Duration::from_secs(5)).await?.success());
    assert!(stderr.is_none());
    Ok(())
}

#[cfg(windows)]
#[tokio::test]
async fn stderr_write_failure_is_reported_after_reaping_and_never_masks_the_session_error() -> Result<()> {
    let mut child = provider("exit 0")?;
    let mut stderr = Some(tokio::spawn(async { Err(std::io::Error::other("disk full")) }));
    let cleanup = finish(&mut child, &mut stderr, Duration::from_secs(10)).await;
    assert!(child.try_wait()?.is_some());
    assert!(cleanup.is_err());
    let result = outcome(Err(anyhow::anyhow!("original session failure")), cleanup);
    let error = format!("{:#}", result.err().unwrap());
    assert!(error.contains("disk full") && error.contains("original session failure"));
    Ok(())
}
