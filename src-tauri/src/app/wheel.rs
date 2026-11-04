//! Fenêtre de la roue : créée masquée au démarrage, puis seulement déplacée et affichée.

use std::path::PathBuf;
use std::sync::Mutex;

use platform::selection::{self, SelectionError};
use serde::Serialize;
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, PhysicalPosition, Runtime, WebviewWindow, Window,
};
use tauri_plugin_dialog::DialogExt;

use super::convert::{self, FileInfo};
use super::permissions;

pub const WHEEL_LABEL: &str = "wheel";
const OPEN_EVENT: &str = "wheel://open";
const CLOSE_EVENT: &str = "wheel://close";
const FILES_EVENT: &str = "wheel://files";
const DRAG_EVENT: &str = "wheel://drag";

/// Taille logique de la fenêtre, identique à `tauri.conf.json`.
const WHEEL_SIZE: f64 = 360.0;

/// Extensions proposées par le sélecteur de fichiers.
const IMAGE_EXTENSIONS: [&str; 12] = [
    "png", "jpg", "jpeg", "webp", "avif", "gif", "bmp", "tif", "tiff", "ico", "svg", "svgz",
];
const VIDEO_EXTENSIONS: [&str; 16] = [
    "mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "ts", "mts", "m2ts",
    "3gp", "ogv", "gif",
];

/// D'où viennent les fichiers proposés à l'ouverture de la roue.
#[derive(Debug, PartialEq, Eq)]
pub enum Source {
    /// Sélection du Finder ou de l'Explorateur, s'il est au premier plan.
    Selection,
    /// Fichiers passés en ligne de commande (`rutile --open photo.png`).
    Files(Vec<PathBuf>),
}

#[derive(Default)]
pub struct WheelState(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    /// L'interface a branché ses écouteurs d'événements.
    ready: bool,
    /// Une ouverture demandée avant que l'interface soit prête.
    pending_open: Option<Source>,
    /// Numéro de la dernière ouverture, pour écarter des fichiers arrivés trop tard.
    last_open: u32,
}

/// `Focus` : ouverte par le raccourci ou le menu, avec le clavier.
/// `Drop` : ouverte par un secouage, sans focus, en attente du fichier glissé.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Focus,
    Drop,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    id: u32,
    mode: Mode,
}

#[derive(Clone, Serialize)]
struct Files {
    id: u32,
    files: Vec<FileInfo>,
}

enum Lookup {
    Selection(selection::Source),
    Paths(Vec<PathBuf>),
}

/// Ouvre la roue sous le curseur, ou dès que l'interface est chargée.
///
/// Appelable depuis n'importe quel thread : l'affichage du panneau macOS doit se faire sur
/// le thread principal, or l'instance unique (`rutile --open`) prévient depuis une tâche de fond.
pub fn open<R: Runtime>(app: &AppHandle<R>, source: Source) {
    let handle = app.clone();
    if let Err(err) = app.run_on_main_thread(move || open_on_main_thread(&handle, source)) {
        eprintln!("rutile : impossible d'ouvrir la roue : {err}");
    }
}

fn open_on_main_thread<R: Runtime>(app: &AppHandle<R>, source: Source) {
    let id = {
        let state = app.state::<WheelState>();
        let mut inner = state.0.lock().unwrap();
        if !inner.ready {
            inner.pending_open = Some(source);
            return;
        }
        inner.last_open += 1;
        inner.last_open
    };

    // Repéré avant d'afficher la roue, tant que le gestionnaire de fichiers est au premier plan
    let lookup = match source {
        Source::Files(paths) => Some(Lookup::Paths(paths)),
        Source::Selection => selection::capture_source().map(Lookup::Selection),
    };
    let opened = Opened {
        id,
        mode: Mode::Focus,
    };
    if let Err(err) = present(app, opened) {
        eprintln!("rutile : impossible d'afficher la roue : {err}");
        return;
    }

    // La roue s'affiche tout de suite ; les fichiers suivent dès qu'ils sont lus
    if let Some(lookup) = lookup {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let paths = match lookup {
                Lookup::Paths(paths) => paths,
                Lookup::Selection(source) => match selection::selected_files(source) {
                    Ok(paths) => paths,
                    Err(SelectionError::PermissionDenied) => {
                        permissions::selection_denied(&handle);
                        Vec::new()
                    }
                    Err(SelectionError::Failed(err)) => {
                        eprintln!("rutile : sélection illisible : {err}");
                        Vec::new()
                    }
                },
            };
            let files = Files {
                id,
                files: convert::inspect(paths),
            };
            let _ = handle.emit_to(WHEEL_LABEL, FILES_EVENT, files);
        });
    }
}

/// Ouvre la roue pour un fichier secoué : sous le curseur, sans focus, sauf si elle est déjà là.
pub fn open_for_drop<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(WHEEL_LABEL) else {
            return;
        };
        if window.is_visible().unwrap_or(false) {
            return;
        }
        let id = {
            let state = handle.state::<WheelState>();
            let mut inner = state.0.lock().unwrap();
            if !inner.ready {
                return;
            }
            inner.last_open += 1;
            inner.last_open
        };
        let opened = Opened {
            id,
            mode: Mode::Drop,
        };
        if let Err(err) = present(&handle, opened) {
            eprintln!("rutile : impossible d'afficher la roue : {err}");
        }
    });
}

/// Le raccourci ouvre la roue, ou la referme si elle est déjà affichée.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let visible = app
        .get_webview_window(WHEEL_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        // L'interface joue l'animation de fermeture avant de masquer la fenêtre
        let _ = app.emit_to(WHEEL_LABEL, CLOSE_EVENT, ());
    } else {
        open(app, Source::Selection);
    }
}

fn present<R: Runtime>(app: &AppHandle<R>, opened: Opened) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(WHEEL_LABEL) else {
        return Ok(());
    };
    place(&window)?;
    // On affiche avant d'émettre : l'interface est invisible tant qu'elle n'a pas reçu l'ordre
    match opened.mode {
        Mode::Focus => focus(app, &window)?,
        Mode::Drop => show_without_focus(app, &window)?,
    }
    app.emit_to(WHEEL_LABEL, OPEN_EVENT, opened)
}

/// Affiche la roue et lui donne le clavier, sans activer l'app sur macOS.
fn focus<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        super::macos_panel::show_and_make_key(app);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        window.set_focusable(true)?;
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

/// Affiche la roue sans voler le focus à l'app d'où vient le glisser.
fn show_without_focus<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        super::macos_panel::show_without_focus(app);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        // Une fenêtre qui ne peut pas prendre le focus s'affiche sans s'activer
        window.set_focusable(false)?;
        window.show()?;
    }
    Ok(())
}

/// Prépare la fenêtre pré-chargée, à appeler une fois au démarrage.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window(WHEEL_LABEL) {
        super::macos_panel::convert(&window)?;
    }
    // Les autres systèmes n'ont rien à préparer
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

/// Centre la fenêtre sur le curseur, sans déborder de la zone utile de l'écran. Sous Wayland,
/// la position du curseur est inconnue : la roue s'ouvre au centre de l'écran principal.
fn place<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    if platform::session::is_wayland_session() {
        return window.center();
    }
    let cursor = window.cursor_position()?;
    let monitor = match window.monitor_from_point(cursor.x, cursor.y)? {
        Some(monitor) => monitor,
        None => match window.primary_monitor()? {
            Some(monitor) => monitor,
            None => return Ok(()),
        },
    };

    let size = (WHEEL_SIZE * monitor.scale_factor()).round() as i32;
    let area = monitor.work_area();
    let clamp = |center: f64, start: i32, length: u32| {
        let max = start + length as i32 - size;
        (center.round() as i32 - size / 2).clamp(start, max.max(start))
    };

    window.set_position(PhysicalPosition::new(
        clamp(cursor.x, area.position.x, area.size.width),
        clamp(cursor.y, area.position.y, area.size.height),
    ))
}

/// Glisser-déposer relayé à l'interface, avec une position en pixels CSS.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum WheelDrag {
    Enter { paths: Vec<PathBuf>, x: f64, y: f64 },
    Over { x: f64, y: f64 },
    Drop { paths: Vec<PathBuf>, x: f64, y: f64 },
    Leave,
}

pub fn forward_drag<R: Runtime>(window: &Window<R>, event: &DragDropEvent) {
    let scale = if platform::session::drag_position_is_physical() {
        window.scale_factor().unwrap_or(1.0)
    } else {
        1.0
    };
    let css = |position: &PhysicalPosition<f64>| (position.x / scale, position.y / scale);
    let drag = match event {
        DragDropEvent::Enter { paths, position } => {
            let (x, y) = css(position);
            WheelDrag::Enter {
                paths: paths.clone(),
                x,
                y,
            }
        }
        DragDropEvent::Over { position } => {
            let (x, y) = css(position);
            WheelDrag::Over { x, y }
        }
        DragDropEvent::Drop { paths, position } => {
            let (x, y) = css(position);
            WheelDrag::Drop {
                paths: paths.clone(),
                x,
                y,
            }
        }
        DragDropEvent::Leave => WheelDrag::Leave,
        _ => return,
    };
    let _ = window.emit_to(WHEEL_LABEL, DRAG_EVENT, drag);
}

#[tauri::command]
pub fn wheel_ready<R: Runtime>(app: AppHandle<R>) {
    let pending = {
        let state = app.state::<WheelState>();
        let mut inner = state.0.lock().unwrap();
        inner.ready = true;
        inner.pending_open.take()
    };
    if let Some(source) = pending {
        open(&app, source);
    }
}

#[tauri::command]
pub fn hide_wheel<R: Runtime>(window: WebviewWindow<R>) -> tauri::Result<()> {
    window.hide()
}

/// Permet à la roue de rester ouverte quand un clic à l'extérieur commence un glisser.
#[tauri::command]
pub fn primary_button_pressed() -> Option<bool> {
    platform::mouse::primary_button_pressed()
}

/// Sélecteur de fichiers du système, affiché au-dessus de la roue qui reste ouverte ;
/// il ne propose que les images ou que les vidéos, selon le mode de la roue.
#[tauri::command]
pub async fn pick_files<R: Runtime>(app: AppHandle<R>, videos: bool) -> Vec<FileInfo> {
    let (title, filter, extensions): (_, _, &[&str]) = if videos {
        (
            "Choisir les vidéos à convertir",
            "Vidéos",
            &VIDEO_EXTENSIONS,
        )
    } else {
        (
            "Choisir les images à convertir",
            "Images",
            &IMAGE_EXTENSIONS,
        )
    };
    let dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .dialog()
            .file()
            .set_title(title)
            .add_filter(filter, extensions)
            .blocking_pick_files()
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default();

    // Le sélecteur a pris le clavier : on le rend à la roue
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(WHEEL_LABEL) {
            let _ = focus(&handle, &window);
        }
    });

    let paths = picked
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .collect();
    tauri::async_runtime::spawn_blocking(move || convert::inspect(paths))
        .await
        .unwrap_or_default()
}
