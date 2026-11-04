//! Sur macOS, la roue est un NSPanel non activant : comme Spotlight, elle reçoit le clavier
//! sans activer l'app (macOS refuse souvent d'activer une app en arrière-plan) et
//! s'affiche aussi au-dessus des apps en plein écran.

use tauri::{AppHandle, Runtime, WebviewWindow};
use tauri_nspanel::{
    CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt, tauri_panel,
};

use super::wheel::WHEEL_LABEL;

tauri_panel! {
    panel!(WheelPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

pub fn convert<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let panel = window.to_panel::<WheelPanel<R>>()?;
    // Au-dessus du Dock et de la barre des menus
    panel.set_level(PanelLevel::Status.value());
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .can_join_all_spaces()
            .full_screen_auxiliary()
            .ignores_cycle()
            .into(),
    );
    panel
        .add_style_mask(StyleMask::empty().nonactivating_panel().value())
        .map_err(|err| tauri::Error::Anyhow(err.into()))
}

pub fn show_and_make_key<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_panel(WHEEL_LABEL) {
        Ok(panel) => panel.show_and_make_key(),
        Err(err) => eprintln!("rutile : panneau de la roue introuvable : {err:?}"),
    }
}

/// Affiche la roue sans lui donner le clavier : l'app d'où vient le glisser le garde.
pub fn show_without_focus<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_panel(WHEEL_LABEL) {
        Ok(panel) => panel.order_front_regardless(),
        Err(err) => eprintln!("rutile : panneau de la roue introuvable : {err:?}"),
    }
}
