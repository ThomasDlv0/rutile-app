//! Autorisations du système. Sur macOS, lire la sélection du Finder demande l'autorisation
//! « Automatisation » ; les autres systèmes n'en ont pas besoin.

use tauri::{AppHandle, Runtime};

#[cfg(target_os = "macos")]
use {
    super::notify::{self, Action, Message},
    platform::selection::{AUTOMATION_SETTINGS_URL, AutomationPermission},
    std::sync::atomic::{AtomicBool, Ordering},
};

#[cfg(target_os = "macos")]
static FINDER_WARNED: AtomicBool = AtomicBool::new(false);

/// Au démarrage, prévient si l'accès au Finder a été refusé. Si la question n'a jamais été
/// posée, macOS la posera à la première utilisation, au moment où elle a du sens.
pub fn check_at_startup<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if platform::selection::finder_automation_permission() == AutomationPermission::Denied {
                selection_denied(&handle);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// La lecture de la sélection a été refusée : on explique comment l'autoriser, une fois par session.
pub fn selection_denied<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    if !FINDER_WARNED.swap(true, Ordering::Relaxed) {
        notify::show(
            app,
            Message {
                title: i18n::t("permissions.title"),
                body: i18n::t("permissions.finderBody"),
                action: Some(Action::OpenUrl(AUTOMATION_SETTINGS_URL.into())),
            },
        );
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}
