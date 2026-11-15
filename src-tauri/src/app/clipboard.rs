//! Image du presse-papiers comme source de la roue, quand rien n'est sélectionné : une capture
//! ou une image copiée sur un site se convertit comme un fichier. Elle est écrite dans le cache ;
//! ce qui en sort rejoint Images › Rutile, comme les captures, et le presse-papiers, prêt à être
//! collé dans un message ou un envoi.

use std::hash::{DefaultHasher, Hasher};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use image::ImageEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use tauri::{AppHandle, Manager, Runtime};

/// Une image copiée il y a plus longtemps n'est plus proposée : ouvrir la roue sans sélection
/// redonne le sélecteur de fichiers.
const RECENT: Duration = Duration::from_secs(10 * 60);

/// Dernière image vue dans le presse-papiers.
struct Seen {
    hash: u64,
    since: Instant,
    path: PathBuf,
}

#[derive(Default)]
pub struct ClipboardState(Mutex<Option<Seen>>);

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    Some(app.path().app_cache_dir().ok()?.join("clipboard"))
}

/// Image copiée depuis peu, écrite en PNG dans le cache ; `None` s'il n'y en a pas.
pub fn recent_image<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let image = platform::capture::clipboard_image()?;
    let mut hasher = DefaultHasher::new();
    hasher.write_u32(image.width());
    hasher.write_u32(image.height());
    hasher.write(image.as_raw());
    let hash = hasher.finish();

    let state = app.state::<ClipboardState>();
    let mut seen = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let since = match &*seen {
        Some(known) if known.hash == hash => known.since,
        _ => Instant::now(),
    };
    if since.elapsed() > RECENT {
        return None;
    }
    if let Some(known) = &*seen
        && known.hash == hash
        && known.path.exists()
    {
        return Some(known.path.clone());
    }

    let dir = cache_dir(app)?;
    // Une seule image à la fois : la précédente n'a plus lieu d'être
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    let now = chrono::Local::now();
    let name = i18n::tf(
        "clipboard.fileName",
        &[
            ("date", &now.format("%Y-%m-%d")),
            ("time", &now.format("%H.%M.%S")),
        ],
    );
    let path = dir.join(format!("{name}.png"));
    let file = std::fs::File::create(&path).ok()?;
    // Compression rapide : le fichier ne sert qu'à la conversion qui suit
    PngEncoder::new_with_quality(
        BufWriter::new(file),
        CompressionType::Fast,
        FilterType::NoFilter,
    )
    .write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::Rgba8,
    )
    .ok()?;
    *seen = Some(Seen {
        hash,
        since,
        path: path.clone(),
    });
    Some(path)
}

/// Vrai si `path` est l'image du presse-papiers écrite par [`recent_image`], ou un fichier tiré
/// d'elle.
pub fn is_from_clipboard<R: Runtime>(app: &AppHandle<R>, path: &Path) -> bool {
    cache_dir(app).is_some_and(|dir| path.parent() == Some(dir.as_path()))
}

/// Range dans Images › Rutile les fichiers tirés de l'image du presse-papiers, puis les met
/// dans le presse-papiers. Les autres chemins restent tels quels. Renvoie les chemins à jour
/// et vrai si des fichiers ont été rangés.
pub fn settle<R: Runtime>(app: &AppHandle<R>, outputs: Vec<PathBuf>) -> (Vec<PathBuf>, bool) {
    let Some(dir) = app
        .path()
        .picture_dir()
        .ok()
        .map(|pictures| pictures.join("Rutile"))
    else {
        return (outputs, false);
    };
    let mut moved = Vec::new();
    let settled = outputs
        .into_iter()
        .map(|path| {
            if !is_from_clipboard(app, &path) || std::fs::create_dir_all(&dir).is_err() {
                return path;
            }
            let target = free_name(&dir, &path);
            // Un renommage échoue d'un disque à l'autre : copie, puis retrait
            let placed = std::fs::rename(&path, &target).is_ok()
                || std::fs::copy(&path, &target)
                    .map(|_| {
                        let _ = std::fs::remove_file(&path);
                    })
                    .is_ok();
            if placed {
                moved.push(target.clone());
                target
            } else {
                path
            }
        })
        .collect();
    if !moved.is_empty() {
        let _ = platform::share::copy_files(&moved);
    }
    (settled, !moved.is_empty())
}

/// `dir/nom.ext`, ou `dir/nom-1.ext`… si le nom est pris.
fn free_name(dir: &Path, path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default();
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();
    (1..)
        .map(|attempt| dir.join(format!("{stem}-{attempt}{extension}")))
        .find(|candidate| !candidate.exists())
        .unwrap_or(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_nom_pris_recoit_un_numero() {
        let dir =
            std::env::temp_dir().join(format!("rutile-presse-papiers-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = Path::new("/cache/Presse-papiers 2026-11-15.jpg");
        assert_eq!(
            free_name(&dir, source),
            dir.join("Presse-papiers 2026-11-15.jpg")
        );
        std::fs::write(dir.join("Presse-papiers 2026-11-15.jpg"), "").unwrap();
        assert_eq!(
            free_name(&dir, source),
            dir.join("Presse-papiers 2026-11-15-1.jpg")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
