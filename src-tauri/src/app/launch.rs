//! Ligne de commande : `rutile --open [fichiers…]`, ou des fichiers seuls (« Ouvrir avec »).

use std::path::Path;

use super::wheel::Source;

const OPEN_ARG: &str = "--open";

/// Ouverture demandée par les arguments (le premier est le programme), ou `None`.
pub fn request(args: &[String], cwd: &Path) -> Option<Source> {
    let mut open = false;
    let mut files = Vec::new();
    for arg in args.iter().skip(1) {
        if arg == OPEN_ARG {
            open = true;
        } else if !arg.starts_with('-') {
            // Un chemin relatif est relatif au dossier de la commande, pas à celui de Rutile
            files.push(cwd.join(arg));
        }
    }
    if !files.is_empty() {
        Some(Source::Files(files))
    } else if open {
        Some(Source::Selection)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn sans_argument_rien_ne_s_ouvre() {
        assert_eq!(request(&args(&["rutile"]), Path::new("/")), None);
    }

    #[test]
    fn open_seul_lit_la_selection() {
        assert_eq!(
            request(&args(&["rutile", "--open"]), Path::new("/")),
            Some(Source::Selection)
        );
    }

    #[test]
    fn fichiers_relatifs_et_absolus() {
        let request = request(
            &args(&["rutile", "--open", "photo.png", "/tmp/logo.svg"]),
            Path::new("/home/thomas/Images"),
        );
        assert_eq!(
            request,
            Some(Source::Files(vec![
                PathBuf::from("/home/thomas/Images/photo.png"),
                PathBuf::from("/tmp/logo.svg"),
            ]))
        );
    }

    #[test]
    fn fichiers_sans_open_et_options_inconnues() {
        assert_eq!(
            request(&args(&["rutile", "-psn_0_12345", "a.jpg"]), Path::new("/x")),
            Some(Source::Files(vec![PathBuf::from("/x/a.jpg")]))
        );
    }
}
