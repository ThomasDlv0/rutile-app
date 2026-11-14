//! Secouage d'un fichier pendant un glisser : la roue s'ouvre sous le curseur, sans prendre
//! le focus, et sert de zone de dépôt.

use std::sync::Mutex;

use platform::mouse::{self, DragProbe, WatchError, Watcher};
use shake_detector::{Config, Sample, ShakeDetector};
use tauri::{AppHandle, Manager, Runtime};

use super::wheel;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShakeSettings {
    pub enabled: bool,
    /// De 1 (secouage franc) à 10 (petit secouage).
    pub sensitivity: u8,
}

impl Default for ShakeSettings {
    fn default() -> Self {
        ShakeSettings {
            // Sous Wayland, evdev donne aussi accès au clavier : le secouage reste une option
            enabled: !platform::session::is_wayland_session(),
            sensitivity: Config::DEFAULT_SENSITIVITY,
        }
    }
}

/// Écoute de la souris en cours ; la remplacer arrête l'ancienne.
#[derive(Default)]
struct ShakeWatcher(Mutex<Option<Watcher>>);

/// Démarre, redémarre ou arrête l'écoute selon les réglages.
pub fn apply<R: Runtime>(app: &AppHandle<R>, settings: ShakeSettings) -> Result<(), String> {
    if app.try_state::<ShakeWatcher>().is_none() {
        app.manage(ShakeWatcher::default());
    }
    let state = app.state::<ShakeWatcher>();
    let mut current = state.0.lock().unwrap();
    // L'ancienne écoute s'arrête avant que la nouvelle commence
    *current = None;
    if !settings.enabled {
        return Ok(());
    }
    match watch(app, settings) {
        Ok(watcher) => {
            *current = Some(watcher);
            Ok(())
        }
        Err(WatchError::NeedsInputGroup) => Err(i18n::t("shake.needsInputGroup")),
        Err(WatchError::Unsupported(reason)) => {
            Err(i18n::tf("shake.unavailableReason", &[("reason", &reason)]))
        }
    }
}

fn watch<R: Runtime>(app: &AppHandle<R>, settings: ShakeSettings) -> Result<Watcher, WatchError> {
    let mut detector = ShakeDetector::new(Config::from_sensitivity(settings.sensitivity));
    let mut probe = DragProbe::new();
    let handle = app.clone();
    mouse::watch(move |motion| {
        let shaken = detector.update(Sample {
            time: motion.time,
            dx: motion.dx,
            dy: motion.dy,
            pressed: motion.pressed,
        });
        if !motion.pressed {
            probe.rearm();
            return;
        }
        // Une sélection de texte ou une fenêtre déplacée ne doit pas ouvrir la roue
        if shaken && probe.file_drag() != Some(false) {
            wheel::open_for_drop(&handle);
        }
    })
}
