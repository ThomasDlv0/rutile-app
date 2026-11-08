use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::ConvertError;

/// Garde-fou contre une boucle infinie si le dossier refuse toute création.
const MAX_ATTEMPTS: u32 = 10_000;

/// Réserve un nom à côté de l'original, avec la nouvelle extension, puis `-1`, `-2`… si le
/// nom est pris. Le fichier est créé vide : un fichier existant n'est jamais écrasé.
pub(crate) fn reserve(input: &Path, extension: &str) -> Result<(PathBuf, File), ConvertError> {
    let dir = input.parent().unwrap_or(Path::new("."));
    let stem = input.file_stem().unwrap_or(input.as_os_str());

    for attempt in 0..MAX_ATTEMPTS {
        let mut name = OsString::from(stem);
        if attempt > 0 {
            name.push(format!("-{attempt}"));
        }
        name.push(".");
        name.push(extension);
        let path = dir.join(name);

        // `create_new` réserve le nom de façon atomique, même si un autre programme écrit en même temps
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(source) => return Err(write_error(dir, source)),
        }
    }

    Err(write_error(
        dir,
        io::Error::other("aucun nom de fichier disponible"),
    ))
}

/// Crée un dossier vide au chemin `target`, ou `target-1`, `target-2`… si le nom est pris.
pub(crate) fn reserve_dir(target: &Path) -> Result<PathBuf, ConvertError> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = target.file_name().unwrap_or(target.as_os_str());
    for attempt in 0..MAX_ATTEMPTS {
        let mut candidate = OsString::from(name);
        if attempt > 0 {
            candidate.push(format!("-{attempt}"));
        }
        let path = dir.join(candidate);
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(source) => return Err(write_error(dir, source)),
        }
    }
    Err(write_error(
        dir,
        io::Error::other("aucun nom de dossier disponible"),
    ))
}

/// Chemin à donner à [`reserve`] pour un fichier nommé `stem`, à côté de `input`.
pub(crate) fn sibling(input: &Path, stem: &str) -> PathBuf {
    // L'extension factice protège un nom qui contient un point : `reserve` la retire
    input.with_file_name(format!("{stem}.x"))
}

/// Nom d'un fichier sans son extension, suivi de `suffix`.
pub(crate) fn suffixed(input: &Path, suffix: &str) -> String {
    let stem = input.file_stem().unwrap_or(input.as_os_str());
    format!("{}{suffix}", stem.to_string_lossy())
}

/// Écrit le contenu sous un nom réservé par [`reserve`].
pub(crate) fn write_unique(
    input: &Path,
    extension: &str,
    bytes: &[u8],
) -> Result<PathBuf, ConvertError> {
    let (path, mut file) = reserve(input, extension)?;
    if let Err(source) = file.write_all(bytes) {
        drop(file);
        let _ = fs::remove_file(&path);
        let dir = path.parent().unwrap_or(Path::new("."));
        return Err(write_error(dir, source));
    }
    Ok(path)
}

fn write_error(dir: &Path, source: io::Error) -> ConvertError {
    ConvertError::Write {
        dir: dir.to_path_buf(),
        source,
    }
}
