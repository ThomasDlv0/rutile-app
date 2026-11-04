//! Souris : état du bouton, écoute des mouvements pendant un appui, glisser de fichiers en cours.
//!
//! macOS et Linux X11 relèvent l'état de la souris (25 fois par seconde au repos, 125 pendant un
//! appui), ce qui ne demande aucune autorisation et marche aussi pendant un glisser du système.
//! Windows utilise un hook souris bas niveau ; Wayland, les mouvements relatifs d'evdev.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[cfg(target_os = "linux")]
mod evdev;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod poll;
#[cfg(windows)]
mod windows;
#[cfg(target_os = "linux")]
mod x11;

/// Mouvement depuis le relevé précédent, en points, avec l'état du bouton principal.
#[derive(Debug, Clone, Copy)]
pub struct Motion {
    pub time: Duration,
    pub dx: f64,
    pub dy: f64,
    pub pressed: bool,
}

#[derive(Debug)]
pub enum WatchError {
    /// Wayland : lire les souris avec evdev demande d'appartenir au groupe `input`.
    NeedsInputGroup,
    Unsupported(String),
}

/// Écoute en cours ; elle s'arrête quand cette valeur est libérée.
pub struct Watcher {
    stop: Arc<AtomicBool>,
    #[cfg(windows)]
    thread_id: u32,
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        #[cfg(windows)]
        windows::stop(self.thread_id);
    }
}

/// Le bouton principal de la souris est-il enfoncé, n'importe où sur l'écran ?
///
/// `None` quand le système ne permet pas de le savoir : Wayland ne l'expose jamais.
pub fn primary_button_pressed() -> Option<bool> {
    #[cfg(target_os = "macos")]
    return Some(macos::primary_button_pressed());
    #[cfg(windows)]
    return Some(windows::primary_button_pressed());
    #[cfg(target_os = "linux")]
    return x11::shared()
        .and_then(|x11| x11.pointer())
        .map(|(_, _, pressed)| pressed);
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    None
}

/// Appelle `on_motion` pour chaque mouvement pendant un appui, puis au relâchement,
/// depuis un thread de fond.
pub fn watch(on_motion: impl FnMut(Motion) + Send + 'static) -> Result<Watcher, WatchError> {
    let stop = Arc::new(AtomicBool::new(false));

    #[cfg(target_os = "macos")]
    {
        poll::spawn(macos::pointer, on_motion, stop.clone());
        Ok(Watcher { stop })
    }

    #[cfg(windows)]
    {
        let thread_id = windows::spawn(on_motion)?;
        Ok(Watcher { stop, thread_id })
    }

    #[cfg(target_os = "linux")]
    {
        if crate::session::is_wayland_session() {
            evdev::spawn(on_motion, stop.clone())?;
        } else {
            let x11 = x11::X11::connect()
                .ok_or_else(|| WatchError::Unsupported("serveur X11 injoignable".into()))?;
            poll::spawn(move || x11.pointer(), on_motion, stop.clone());
        }
        Ok(Watcher { stop })
    }

    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        let _ = (on_motion, stop);
        Err(WatchError::Unsupported("système non pris en charge".into()))
    }
}

/// Dit si un glisser de fichiers est en cours, pour ignorer un secouage pendant une sélection
/// de texte ou le déplacement d'une fenêtre.
pub struct DragProbe {
    #[cfg(target_os = "macos")]
    change_count: isize,
    #[cfg(target_os = "linux")]
    x11: Option<x11::X11>,
}

impl DragProbe {
    pub fn new() -> Self {
        DragProbe {
            #[cfg(target_os = "macos")]
            change_count: macos::drag_change_count(),
            #[cfg(target_os = "linux")]
            x11: if crate::session::is_wayland_session() {
                None
            } else {
                x11::X11::connect()
            },
        }
    }

    /// À appeler au relâchement du bouton : seul un glisser commencé ensuite comptera.
    pub fn rearm(&mut self) {
        #[cfg(target_os = "macos")]
        {
            self.change_count = macos::drag_change_count();
        }
    }

    /// `Some(true)` si des fichiers sont en train d'être glissés, `None` si le système ne le dit pas
    /// (Windows, Wayland).
    pub fn file_drag(&self) -> Option<bool> {
        #[cfg(target_os = "macos")]
        return Some(macos::file_drag_since(self.change_count));
        #[cfg(target_os = "linux")]
        return self.x11.as_ref().and_then(|x11| x11.drag_in_progress());
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        None
    }
}

impl Default for DragProbe {
    fn default() -> Self {
        DragProbe::new()
    }
}
