use crate::bridge::Bridge;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

static CHECKING: AtomicBool = AtomicBool::new(false);

pub fn check(app: AppHandle, automatic: bool) {
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        if automatic {
            std::thread::sleep(Duration::from_secs(10));
        }
        let result = tauri::async_runtime::block_on(update(&app, automatic));
        if let Err(error) = result {
            eprintln!("Spool update failed: {error}");
            if !automatic {
                app.dialog()
                    .message(format!("The update could not finish: {error}"))
                    .title("Spool update")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            }
        }
        CHECKING.store(false, Ordering::SeqCst);
    });
}

async fn update(app: &AppHandle, automatic: bool) -> Result<(), String> {
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let Some(mut update) = updater.check().await.map_err(|error| error.to_string())? else {
        if !automatic {
            app.dialog()
                .message(format!(
                    "Spool {} is up to date.",
                    app.package_info().version
                ))
                .title("Spool update")
                .blocking_show();
        }
        return Ok(());
    };
    if !app.dialog()
        .message(format!("Spool {} is available. Save any unsaved work before continuing. The update will download, wait for running automation to finish, and restart Spool.", update.version))
        .title("Update Spool")
        .buttons(MessageDialogButtons::OkCancelCustom("Update and restart".into(), "Later".into()))
        .blocking_show() {
        return Ok(());
    }
    update.timeout = Some(Duration::from_secs(600));
    let installation = async {
        let bytes = update
            .download(|_, _| {}, || {})
            .await
            .map_err(|error| error.to_string())?;
        app.state::<Bridge>().shutdown()?;
        update
            .install(bytes)
            .map_err(|error| format!("{error}. Restart Spool to resume automation."))
    }
    .await;
    if let Err(error) = installation {
        eprintln!("Spool installation failed: {error}");
        app.dialog()
            .message(error)
            .title("Spool update")
            .kind(MessageDialogKind::Error)
            .blocking_show();
        return Ok(());
    }
    app.request_restart();
    Ok(())
}
