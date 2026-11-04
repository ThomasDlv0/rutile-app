//! Wayland ne donne pas la souris aux apps : on lit les mouvements relatifs des souris avec
//! evdev, ce qui demande d'être dans le groupe `input` (qui donne aussi accès au clavier).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use evdev::{Device, EventSummary, KeyCode, RelativeAxisCode};

use super::{Motion, WatchError};

struct Shared {
    on_motion: Box<dyn FnMut(Motion) + Send>,
    start: Instant,
    pressed: bool,
}

fn is_mouse(device: &Device) -> bool {
    let relative = device.supported_relative_axes().is_some_and(|axes| {
        axes.contains(RelativeAxisCode::REL_X) && axes.contains(RelativeAxisCode::REL_Y)
    });
    let button = device
        .supported_keys()
        .is_some_and(|keys| keys.contains(KeyCode::BTN_LEFT));
    relative && button
}

pub fn spawn(
    on_motion: impl FnMut(Motion) + Send + 'static,
    stop: Arc<AtomicBool>,
) -> Result<(), WatchError> {
    // `enumerate` saute en silence les périphériques illisibles
    let mice: Vec<Device> = evdev::enumerate()
        .map(|(_, device)| device)
        .filter(is_mouse)
        .collect();
    if mice.is_empty() {
        let has_devices = std::fs::read_dir("/dev/input").is_ok_and(|entries| {
            entries
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().starts_with("event"))
        });
        return Err(if has_devices {
            WatchError::NeedsInputGroup
        } else {
            WatchError::Unsupported("aucune souris trouvée".into())
        });
    }

    let shared = Arc::new(Mutex::new(Shared {
        on_motion: Box::new(on_motion),
        start: Instant::now(),
        pressed: false,
    }));
    for mut mouse in mice {
        let shared = shared.clone();
        let stop = stop.clone();
        let _ = thread::Builder::new()
            .name("rutile-evdev".into())
            .spawn(move || {
                let (mut dx, mut dy) = (0, 0);
                while !stop.load(Ordering::Relaxed) {
                    let Ok(events) = mouse.fetch_events() else {
                        break;
                    };
                    for event in events {
                        match event.destructure() {
                            EventSummary::RelativeAxis(_, RelativeAxisCode::REL_X, value) => {
                                dx += value
                            }
                            EventSummary::RelativeAxis(_, RelativeAxisCode::REL_Y, value) => {
                                dy += value
                            }
                            EventSummary::Key(_, KeyCode::BTN_LEFT, value) => {
                                shared.lock().unwrap().pressed = value != 0;
                            }
                            // Fin d'un paquet d'événements : un mouvement complet
                            EventSummary::Synchronization(..) => {
                                let mut shared = shared.lock().unwrap();
                                let motion = Motion {
                                    time: shared.start.elapsed(),
                                    dx: f64::from(dx),
                                    dy: f64::from(dy),
                                    pressed: shared.pressed,
                                };
                                (shared.on_motion)(motion);
                                (dx, dy) = (0, 0);
                            }
                            _ => {}
                        }
                    }
                }
            });
    }
    Ok(())
}
