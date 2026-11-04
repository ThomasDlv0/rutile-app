use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use super::Motion;

/// Au repos, seul l'appui est guetté.
const IDLE: Duration = Duration::from_millis(40);
/// Pendant un appui, le rythme d'une souris ordinaire.
const ACTIVE: Duration = Duration::from_millis(8);

/// Relève `read` (position globale en points, bouton enfoncé) et transmet les mouvements.
pub fn spawn(
    mut read: impl FnMut() -> Option<(f64, f64, bool)> + Send + 'static,
    mut on_motion: impl FnMut(Motion) + Send + 'static,
    stop: Arc<AtomicBool>,
) {
    let spawned = thread::Builder::new()
        .name("rutile-souris".into())
        .spawn(move || {
            let start = Instant::now();
            let mut last: Option<(f64, f64)> = None;
            let mut was_pressed = false;
            while !stop.load(Ordering::Relaxed) {
                if let Some((x, y, pressed)) = read() {
                    let (dx, dy) = match last {
                        Some((last_x, last_y)) if was_pressed && pressed => {
                            (x - last_x, y - last_y)
                        }
                        _ => (0.0, 0.0),
                    };
                    if pressed || was_pressed {
                        on_motion(Motion {
                            time: start.elapsed(),
                            dx,
                            dy,
                            pressed,
                        });
                    }
                    last = Some((x, y));
                    was_pressed = pressed;
                }
                thread::sleep(if was_pressed { ACTIVE } else { IDLE });
            }
        });
    if let Err(err) = spawned {
        eprintln!("rutile : écoute de la souris impossible : {err}");
    }
}
