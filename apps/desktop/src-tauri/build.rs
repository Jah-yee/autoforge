fn main() {
    // Listing the app's commands makes Tauri generate one permission per command, so the
    // capability file has to grant each one explicitly.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "current_state",
        "open_url",
        "hide_popover",
        "fit_popover",
        "autostart_enabled",
        "set_autostart",
        "quit",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
