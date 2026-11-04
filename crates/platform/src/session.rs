/// Tauri annonce des pixels physiques pour la position d'un glisser-déposer, mais wry ne
/// les fournit ainsi que sous Windows : macOS donne des points et GTK des pixels logiques.
pub fn drag_position_is_physical() -> bool {
    cfg!(windows)
}

/// Les raccourcis globaux de Tauri passent par X11 : ils n'existent pas sous Wayland,
/// où la roue s'ouvre avec `rutile --open` lié à un raccourci du système.
pub fn global_shortcuts_supported() -> bool {
    !is_wayland_session()
}

pub fn is_wayland_session() -> bool {
    cfg!(target_os = "linux")
        && (std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE").is_ok_and(|session| session == "wayland"))
}
