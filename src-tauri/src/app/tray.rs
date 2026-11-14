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

/// Entrées du menu, gardées pour y afficher le raccourci choisi et les traduire quand la
/// langue change.
struct Items<R: Runtime> {
    open: MenuItem<R>,
    settings: MenuItem<R>,
    updates: MenuItem<R>,
    quit: MenuItem<R>,
}

/// Textes du menu dans la langue en cours.
pub fn translate<R: Runtime>(app: &AppHandle<R>) {
    if let Some(items) = app.try_state::<Items<R>>() {
        let _ = items.open.set_text(i18n::t("tray.open"));
        let _ = items.settings.set_text(i18n::t("tray.settings"));
        let _ = items.updates.set_text(i18n::t("tray.updates"));
        let _ = items.quit.set_text(i18n::t("tray.quit"));
    }
}

/// Le menu rappelle le raccourci, sauf là où il n'existe pas (Wayland).
pub fn show_shortcut<R: Runtime>(app: &AppHandle<R>, accelerator: &str) {
    if !platform::session::global_shortcuts_supported() {
        return;
    }
    if let Some(items) = app.try_state::<Items<R>>() {
        let _ = items.open.set_accelerator(Some(accelerator));
    }
}

pub fn setup<R: Runtime>(app: &AppHandle<R>, shortcut: &str) -> tauri::Result<()> {
    let item = |id: &str, key: &str| MenuItem::with_id(app, id, i18n::t(key), true, None::<&str>);
    let open = item(OPEN, "tray.open")?;
    let settings = item(SETTINGS, "tray.settings")?;
    let updates = item(UPDATES, "tray.updates")?;
    let quit = item(QUIT, "tray.quit")?;
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
    app.manage(Items {
        open,
        settings,
        updates,
        quit,
    });
    // Windows note l'icône dans le registre peu après sa création
    #[cfg(windows)]
    std::thread::spawn(|| {
        for _ in 0..10 {
            if platform::tray::keep_visible() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
    show_shortcut(app, shortcut);
    Ok(())
}
