#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod bridge;
mod job;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window
            .show()
            .and_then(|_| window.unminimize())
            .and_then(|_| window.set_focus())
        {
            eprintln!("Cannot show Spool: {error}");
        }
    }
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            bridge::request,
            bridge::cancel_request
        ])
        .setup(|app| {
            let resources = app.path().resource_dir()?;
            let runtime = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("binaries")
                    .join(if cfg!(windows) {
                        "spool-runtime-x86_64-pc-windows-msvc.exe"
                    } else {
                        "spool-runtime-x86_64-unknown-linux-gnu"
                    })
            } else {
                std::env::current_exe()?.with_file_name(if cfg!(windows) {
                    "spool-runtime.exe"
                } else {
                    "spool-runtime"
                })
            };
            let script = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/backend.mjs")
            } else {
                resources.join("resources/backend.mjs")
            };
            app.manage(bridge::Bridge::start(
                &runtime,
                &script,
                &app.path().app_data_dir()?,
            )?);
            let open = MenuItem::with_id(app, "open", "Open Spool", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Spool", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .ok_or("Application icon missing")?
                        .clone(),
                )
                .tooltip("Spool")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, tauri::tray::TrayIconEvent::DoubleClick { .. }) {
                        show(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("Cannot hide Spool: {error}");
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Spool could not start");
}
