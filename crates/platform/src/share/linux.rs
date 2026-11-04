use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::session;

/// Il n'y a pas d'interface commune au presse-papiers : on passe par `wl-copy` sous Wayland,
/// `xclip` sous X11, avec la liste d'URI qu'utilisent les gestionnaires de fichiers.
pub fn copy_files(files: &[PathBuf]) -> Result<(), String> {
    let uris: String = files
        .iter()
        .map(|file| format!("file://{}\r\n", encode_path(&file.to_string_lossy())))
        .collect();
    let (program, args): (&str, &[&str]) = if session::is_wayland_session() {
        ("wl-copy", &["--type", "text/uri-list"])
    } else {
        ("xclip", &["-selection", "clipboard", "-t", "text/uri-list"])
    };
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|_| format!("Copier des fichiers demande « {program} », introuvable."))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(uris.as_bytes())
            .map_err(|err| err.to_string())?;
    }
    // L'outil continue en arrière-plan pour servir le presse-papiers ; le premier processus
    // rend la main dès que le contenu est lu
    let status = child.wait().map_err(|err| err.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "« {program} » n'a pas pu remplir le presse-papiers."
        ))
    }
}

/// Encode un chemin pour une URI `file://` : tout sauf les caractères sûrs devient `%XX`.
fn encode_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_les_espaces_et_les_accents() {
        assert_eq!(
            encode_path("/home/moi/Été 2026.png"),
            "/home/moi/%C3%89t%C3%A9%202026.png"
        );
    }
}
