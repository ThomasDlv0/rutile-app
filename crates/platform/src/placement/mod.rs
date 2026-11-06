//! Ranger la fenêtre active : moitié d'écran, plein écran ou centrée.

use serde::Deserialize;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as system;
#[cfg(target_os = "macos")]
use macos as system;
#[cfg(windows)]
use windows as system;

/// Où mettre la fenêtre.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layout {
    Left,
    Right,
    Top,
    Bottom,
    Maximize,
    Center,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Layout {
    /// Rectangle visé dans `area`, la partie utile de l'écran. `window` : la fenêtre, qui garde
    /// sa taille quand on la centre.
    pub fn frame(self, area: Rect, window: Rect) -> Rect {
        let half_width = (area.width / 2.0).round();
        let half_height = (area.height / 2.0).round();
        match self {
            Layout::Left => Rect {
                width: half_width,
                ..area
            },
            Layout::Right => Rect {
                x: area.x + area.width - half_width,
                width: half_width,
                ..area
            },
            Layout::Top => Rect {
                height: half_height,
                ..area
            },
            Layout::Bottom => Rect {
                y: area.y + area.height - half_height,
                height: half_height,
                ..area
            },
            Layout::Maximize => area,
            Layout::Center => {
                let width = window.width.min(area.width);
                let height = window.height.min(area.height);
                Rect {
                    x: area.x + ((area.width - width) / 2.0).round(),
                    y: area.y + ((area.height - height) / 2.0).round(),
                    width,
                    height,
                }
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PlacementError {
    /// macOS : Rutile n'a pas l'autorisation Accessibilité.
    Permission,
    NoWindow,
    Failed(String),
}

/// Le système sait-il ranger les fenêtres ? Non sous Wayland, qui le réserve au bureau.
pub fn supported() -> bool {
    !crate::session::is_wayland_session()
}

/// Note la fenêtre active. À appeler avant d'afficher la roue, qui prend le focus sous Windows
/// et sous Linux.
pub fn remember() {
    system::remember();
}

/// Fenêtre notée par [`remember`].
#[cfg(windows)]
pub fn remembered_window() -> Option<isize> {
    system::remembered()
}

/// Range la fenêtre active. À appeler depuis le thread principal sur macOS.
pub fn place(layout: Layout) -> Result<(), PlacementError> {
    system::place(layout)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect {
        x: 100.0,
        y: 25.0,
        width: 1001.0,
        height: 800.0,
    };
    const WINDOW: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 400.0,
        height: 300.0,
    };

    #[test]
    fn les_moities_remplissent_l_ecran_sans_se_chevaucher() {
        let left = Layout::Left.frame(AREA, WINDOW);
        let right = Layout::Right.frame(AREA, WINDOW);
        assert_eq!(left.x, 100.0);
        assert_eq!(right.x + right.width, 1101.0);
        assert_eq!(left.height, 800.0);
        let top = Layout::Top.frame(AREA, WINDOW);
        let bottom = Layout::Bottom.frame(AREA, WINDOW);
        assert_eq!(top.y + top.height, bottom.y);
    }

    #[test]
    fn centrer_garde_la_taille_de_la_fenetre() {
        let center = Layout::Center.frame(AREA, WINDOW);
        assert_eq!((center.width, center.height), (400.0, 300.0));
        assert_eq!(center.y, 275.0);
    }

    #[test]
    fn centrer_une_fenetre_trop_grande_la_ramene_a_l_ecran() {
        let big = Rect {
            width: 3000.0,
            height: 2000.0,
            ..WINDOW
        };
        let center = Layout::Center.frame(AREA, big);
        assert_eq!((center.width, center.height), (1001.0, 800.0));
        assert_eq!((center.x, center.y), (100.0, 25.0));
    }
}
