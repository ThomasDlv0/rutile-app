//! Icône de la barre système (barre des menus sur macOS) et son menu.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use super::wheel::{self, Source};
use super::{settings, updates};

const OPEN: &str = "open";
const SETTINGS: &str = "settings";
const UPDATES: &str = "updates";
const QUIT: &str = "quit";

/// Entrée « Ouvrir la roue », gardée pour y afficher le raccourci choisi.
struct OpenItem<R: Runtime>(MenuItem<R>);

/// Le menu rappelle le raccourci, sauf là où il n'existe pas (Wayland).
pub fn show_shortcut<R: Runtime>(app: &AppHandle<R>, accelerator: &str) {
    if !platform::session::global_shortcuts_supported() {
        return;
    }
    if let Some(item) = app.try_state::<OpenItem<R>>() {
        let _ = item.0.set_accelerator(Some(accelerator));
    }
}

pub fn setup<R: Runtime>(app: &AppHandle<R>, shortcut: &str) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN, "Ouvrir la roue", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, SETTINGS, "Réglages…", true, None::<&str>)?;
    let updates = MenuItem::with_id(
        app,
        UPDATES,
        "Rechercher les mises à jour…",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, QUIT, "Quitter Rutile", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &updates,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let builder = TrayIconBuilder::with_id("rutile")
        .tooltip("Rutile")
        .menu(&menu)
        // Sous Windows, le clic gauche ouvre la roue et le clic droit affiche le menu
        .show_menu_on_left_click(cfg!(not(windows)))
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN => wheel::open(app, Source::Selection),
            SETTINGS => settings::open_window(app, None),
            UPDATES => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { updates::offer(&app, true).await });
            }
            QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if cfg!(windows)
                && let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
            {
                wheel::open(tray.app_handle(), Source::Selection);
            }
        });

    // Image « modèle » monochrome sur macOS, que le système adapte au thème clair ou sombre
    #[cfg(target_os = "macos")]
    let builder = builder
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../../icons/tray-template.png"
        ))?)
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let builder = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()),
        None => builder,
    };

    builder.build(app)?;
    app.manage(OpenItem(open));
    show_shortcut(app, shortcut);
    Ok(())
}
