//! Reconnaît un secouage : plusieurs changements de direction rapides et amples pendant
//! que le bouton est maintenu. Reçoit des déplacements relatifs, pour fonctionner aussi
//! avec evdev qui ne connaît pas la position du curseur.

use std::collections::VecDeque;
use std::time::Duration;

/// Mouvement de la souris depuis l'échantillon précédent.
#[derive(Debug, Clone, Copy)]
pub struct Sample {
    /// Instant depuis une origine quelconque, mais croissant.
    pub time: Duration,
    pub dx: f64,
    pub dy: f64,
    /// Bouton principal enfoncé.
    pub pressed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Config {
    /// Longueur minimale, en points, d'un trait avant un demi-tour.
    pub min_stroke: f64,
    /// Durée dans laquelle les demi-tours doivent tenir.
    pub window: Duration,
    /// Nombre de demi-tours qui font un secouage.
    pub reversals: usize,
}

impl Config {
    pub const DEFAULT_SENSITIVITY: u8 = 5;

    /// Sensibilité de 1 (secouage franc) à 10 (petit secouage suffit).
    pub fn from_sensitivity(level: u8) -> Self {
        let level = level.clamp(1, 10);
        let step = f64::from(level - 1);
        Config {
            min_stroke: 50.0 - 3.0 * step,
            window: Duration::from_millis(500 + 25 * u64::from(level - 1)),
            reversals: if level <= 3 { 4 } else { 3 },
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Config::from_sensitivity(Config::DEFAULT_SENSITIVITY)
    }
}

/// En dessous, les petits mouvements sont cumulés : leur direction serait du bruit.
const STEP: f64 = 4.0;
/// Un demi-tour : plus de 120° entre la direction du trait et le nouveau mouvement.
const REVERSAL_COS: f64 = -0.5;

#[derive(Debug, Clone, Copy)]
struct Stroke {
    /// Direction moyenne, unitaire.
    direction: (f64, f64),
    length: f64,
}

#[derive(Debug)]
pub struct ShakeDetector {
    config: Config,
    pending: (f64, f64),
    stroke: Option<Stroke>,
    reversals: VecDeque<Duration>,
    /// Un seul secouage par appui sur le bouton.
    fired: bool,
}

impl ShakeDetector {
    pub fn new(config: Config) -> Self {
        ShakeDetector {
            config,
            pending: (0.0, 0.0),
            stroke: None,
            reversals: VecDeque::new(),
            fired: false,
        }
    }

    pub fn set_config(&mut self, config: Config) {
        self.config = config;
    }

    /// Renvoie vrai à l'instant où un secouage est reconnu.
    pub fn update(&mut self, sample: Sample) -> bool {
        if !sample.pressed {
            self.reset();
            return false;
        }
        if self.fired {
            return false;
        }

        self.pending.0 += sample.dx;
        self.pending.1 += sample.dy;
        let length = self.pending.0.hypot(self.pending.1);
        if length < STEP {
            return false;
        }
        let direction = (self.pending.0 / length, self.pending.1 / length);
        self.pending = (0.0, 0.0);
        self.follow(direction, length, sample.time);

        while let Some(&first) = self.reversals.front() {
            if sample.time.saturating_sub(first) > self.config.window {
                self.reversals.pop_front();
            } else {
                break;
            }
        }
        if self.reversals.len() >= self.config.reversals {
            self.fired = true;
            self.reversals.clear();
            return true;
        }
        false
    }

    fn follow(&mut self, direction: (f64, f64), length: f64, time: Duration) {
        let Some(stroke) = &mut self.stroke else {
            self.stroke = Some(Stroke { direction, length });
            return;
        };
        let cos = stroke.direction.0 * direction.0 + stroke.direction.1 * direction.1;
        if cos <= REVERSAL_COS {
            if stroke.length >= self.config.min_stroke {
                self.reversals.push_back(time);
            } else {
                // Un aller-retour trop court n'est pas un secouage : la série repart de zéro
                self.reversals.clear();
            }
            *stroke = Stroke { direction, length };
        } else {
            // Même sens : le trait s'allonge et sa direction suit les courbes douces
            let x = stroke.direction.0 * stroke.length + direction.0 * length;
            let y = stroke.direction.1 * stroke.length + direction.1 * length;
            let norm = x.hypot(y);
            if norm > 0.0 {
                stroke.direction = (x / norm, y / norm);
            }
            stroke.length += length;
        }
    }

    fn reset(&mut self) {
        self.pending = (0.0, 0.0);
        self.stroke = None;
        self.reversals.clear();
        self.fired = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Intervalle entre deux échantillons, comme une souris à 125 Hz.
    const TICK: Duration = Duration::from_millis(8);

    /// Parcourt les points à vitesse constante (points par seconde), bouton enfoncé.
    fn path(points: &[(f64, f64)], speed: f64) -> Vec<Sample> {
        let mut samples = Vec::new();
        let mut time = Duration::ZERO;
        for pair in points.windows(2) {
            let (from, to) = (pair[0], pair[1]);
            let distance = (to.0 - from.0).hypot(to.1 - from.1);
            let steps = ((distance / speed) / TICK.as_secs_f64()).ceil().max(1.0) as usize;
            for _ in 0..steps {
                time += TICK;
                samples.push(Sample {
                    time,
                    dx: (to.0 - from.0) / steps as f64,
                    dy: (to.1 - from.1) / steps as f64,
                    pressed: true,
                });
            }
        }
        samples
    }

    fn shakes(samples: &[Sample], config: Config) -> usize {
        let mut detector = ShakeDetector::new(config);
        samples.iter().filter(|s| detector.update(**s)).count()
    }

    fn zigzag(amplitude: f64, strokes: usize) -> Vec<(f64, f64)> {
        let mut points = vec![(0.0, 0.0)];
        for index in 0..strokes {
            let x = if index % 2 == 0 { amplitude } else { 0.0 };
            points.push((x, 0.0));
        }
        points
    }

    #[test]
    fn un_secouage_horizontal_est_reconnu() {
        let samples = path(&zigzag(80.0, 5), 900.0);
        assert_eq!(shakes(&samples, Config::default()), 1);
    }

    #[test]
    fn un_secouage_vertical_ou_en_diagonale_aussi() {
        let vertical: Vec<_> = zigzag(80.0, 5).iter().map(|&(x, y)| (y, x)).collect();
        let diagonal: Vec<_> = zigzag(80.0, 5).iter().map(|&(x, _)| (x, x)).collect();
        assert_eq!(shakes(&path(&vertical, 900.0), Config::default()), 1);
        assert_eq!(shakes(&path(&diagonal, 900.0), Config::default()), 1);
    }

    #[test]
    fn un_glisser_ordinaire_ne_declenche_rien() {
        let straight = path(&[(0.0, 0.0), (600.0, 300.0)], 900.0);
        let curve: Vec<(f64, f64)> = (0..=40)
            .map(|step| {
                let angle = f64::from(step) * 0.08;
                (300.0 * angle.cos(), 300.0 * angle.sin())
            })
            .collect();
        let corner = path(
            &[(0.0, 0.0), (300.0, 0.0), (300.0, 300.0), (0.0, 300.0)],
            900.0,
        );
        assert_eq!(shakes(&straight, Config::default()), 0);
        assert_eq!(shakes(&path(&curve, 900.0), Config::default()), 0);
        assert_eq!(shakes(&corner, Config::default()), 0);
    }

    #[test]
    fn des_allers_retours_lents_ne_declenchent_rien() {
        let samples = path(&zigzag(80.0, 5), 150.0);
        assert_eq!(shakes(&samples, Config::default()), 0);
    }

    #[test]
    fn un_tremblement_ne_declenche_rien() {
        let samples = path(&zigzag(6.0, 20), 900.0);
        assert_eq!(shakes(&samples, Config::default()), 0);
    }

    #[test]
    fn rien_sans_bouton_enfonce() {
        let samples: Vec<_> = path(&zigzag(80.0, 5), 900.0)
            .into_iter()
            .map(|sample| Sample {
                pressed: false,
                ..sample
            })
            .collect();
        assert_eq!(shakes(&samples, Config::default()), 0);
    }

    #[test]
    fn un_seul_secouage_par_appui() {
        let mut samples = path(&zigzag(80.0, 12), 900.0);
        assert_eq!(shakes(&samples, Config::default()), 1);

        // Bouton relâché puis nouvel appui : un nouveau secouage compte
        let release_time = samples.last().unwrap().time + TICK;
        samples.push(Sample {
            time: release_time,
            dx: 0.0,
            dy: 0.0,
            pressed: false,
        });
        let second: Vec<_> = path(&zigzag(80.0, 5), 900.0)
            .into_iter()
            .map(|sample| Sample {
                time: sample.time + release_time,
                ..sample
            })
            .collect();
        samples.extend(second);
        assert_eq!(shakes(&samples, Config::default()), 2);
    }

    #[test]
    fn la_sensibilite_regle_l_amplitude_necessaire() {
        let small = path(&zigzag(30.0, 5), 700.0);
        assert_eq!(shakes(&small, Config::from_sensitivity(10)), 1);
        assert_eq!(shakes(&small, Config::from_sensitivity(1)), 0);
    }

    #[test]
    fn la_sensibilite_est_bornee() {
        assert_eq!(Config::from_sensitivity(0), Config::from_sensitivity(1));
        assert_eq!(Config::from_sensitivity(42), Config::from_sensitivity(10));
    }
}
