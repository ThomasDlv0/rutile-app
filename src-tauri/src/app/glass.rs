//! Le disque de la roue en vrai Liquid Glass, sur les versions de macOS qui l'ont. Ailleurs,
//! la page dessine une imitation : aucun autre système ne donne accès à ce verre.

use tauri::{AppHandle, Manager, Runtime};

/// Le vrai verre existe-t-il sur ce système ?
pub fn available() -> bool {
    #[cfg(target_os = "macos")]
    return platform::glass::available();
    #[cfg(not(target_os = "macos"))]
    false
}

/// Pose ou retire le verre sous la page de la roue.
pub fn apply<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    #[cfg(target_os = "macos")]
    {
        use super::wheel::{WHEEL_LABEL, WHEEL_SIZE};
        use platform::glass::{self, Disc};
        /// Rayons de `src/wheel/geometry.ts` : le disque, puis le centre.
        const RADII: [f64; 2] = [165.0, 48.0];
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(window) = handle.get_webview_window(WHEEL_LABEL) else {
                return;
            };
            let Ok(ns_window) = window.ns_window() else {
                return;
            };
            let center = WHEEL_SIZE / 2.0;
            let discs = RADII.map(|radius| Disc {
                center_x: center,
                center_y: center,
                radius,
            });
            let discs: &[Disc] = if enabled { &discs } else { &[] };
            // SAFETY : fenêtre valide, sur le thread principal
            unsafe { glass::apply(ns_window, discs) };
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, enabled);
}

/// Accompagne le fondu de la page : le verre natif n'en fait pas partie.
pub fn fade<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        use super::wheel::WHEEL_LABEL;
        /// Durées de `src/styles.css`.
        const OPEN_SECONDS: f64 = 0.15;
        const CLOSE_SECONDS: f64 = 0.12;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(window) = handle.get_webview_window(WHEEL_LABEL) else {
                return;
            };
            let Ok(ns_window) = window.ns_window() else {
                return;
            };
            // SAFETY : fenêtre valide, sur le thread principal
            unsafe {
                if visible {
                    platform::glass::fade(ns_window, 0.0, 0.0);
                    platform::glass::fade(ns_window, 1.0, OPEN_SECONDS);
                } else {
                    platform::glass::fade(ns_window, 0.0, CLOSE_SECONDS);
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

/// La roue commence à se fermer.
#[tauri::command]
pub fn wheel_closing<R: Runtime>(app: AppHandle<R>) {
    fade(&app, false);
}
