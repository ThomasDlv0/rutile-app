//! Accueil au premier lancement : comment ouvrir la roue, et où sont les réglages. Rutile vit en
//! arrière-plan, sans fenêtre ; sans lui, rien ne dirait qu'il tourne.

use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::wheel::{self, Source};

pub const WELCOME_LABEL: &str = "welcome";
/// La fenêtre se ferme avant que la roue ne s'ouvre à sa place.
const WHEEL_DELAY: Duration = Duration::from_millis(250);

pub fn open<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(WELCOME_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, WELCOME_LABEL, WebviewUrl::App("index.html".into()))
        .title(i18n::t("welcome.windowTitle"))
        .inner_size(440.0, 640.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .focused(true)
        .build();
    match built {
        // Une app sans icône dans le Dock doit passer devant explicitement
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(err) => eprintln!("rutile : fenêtre d'accueil impossible : {err}"),
    }
}

/// Ferme l'accueil ; `try_wheel` ouvre ensuite la roue sous le curseur, pour l'essayer.
#[tauri::command]
pub fn close_welcome<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, try_wheel: bool) {
    let _ = window.close();
    if try_wheel {
        std::thread::spawn(move || {
            std::thread::sleep(WHEEL_DELAY);
            wheel::open(&app, Source::Selection);
        });
    }
}
