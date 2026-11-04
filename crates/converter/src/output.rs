use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::ConvertError;

/// Garde-fou contre une boucle infinie si le dossier refuse toute création.
const MAX_ATTEMPTS: u32 = 10_000;

/// Écrit à côté de l'original, sous le même nom avec la nouvelle extension,
/// puis `-1`, `-2`… si le nom est pris. Un fichier existant n'est jamais écrasé.
pub(crate) fn write_unique(
    input: &Path,
    extension: &str,
    bytes: &[u8],
) -> Result<PathBuf, ConvertError> {
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
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(source) => return Err(write_error(dir, source)),
        };
        if let Err(source) = file.write_all(bytes) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(write_error(dir, source));
        }
        return Ok(path);
    }

    Err(write_error(
        dir,
        io::Error::other("aucun nom de fichier disponible"),
    ))
}

fn write_error(dir: &Path, source: io::Error) -> ConvertError {
    ConvertError::Write {
        dir: dir.to_path_buf(),
        source,
    }
}
