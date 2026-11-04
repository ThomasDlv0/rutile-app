//! Les apps sont décrites par des fichiers `.desktop` ; leurs icônes viennent du thème.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;

use super::{App, Icon};

pub fn describe(path: &Path) -> Option<App> {
    if path.extension().is_some_and(|ext| ext == "desktop") {
        let text = std::fs::read_to_string(path).ok()?;
        let entry = DesktopEntry::parse(&text);
        return Some(App {
            name: entry.name?,
            icon: entry.icon.as_deref().and_then(find_icon).map(Icon::File),
        });
    }
    let name = path.file_name()?.to_string_lossy().into_owned();
    Some(App { name, icon: None })
}

pub fn launch(app: &Path, files: &[PathBuf]) -> Result<(), String> {
    if app.extension().is_some_and(|ext| ext == "desktop") {
        // gio lit le `.desktop` comme le ferait le bureau, fichiers compris
        let status = Command::new("gio")
            .arg("launch")
            .arg(app)
            .args(files)
            .status()
            .map_err(|err| format!("gio introuvable ({err})"))?;
        return if status.success() {
            Ok(())
        } else {
            Err(format!("impossible de lancer « {} »", app.display()))
        };
    }
    let mut child = Command::new(app)
        .args(files)
        .spawn()
        .map_err(|err| err.to_string())?;
    // Attendu à part, pour ne pas laisser de processus zombie quand l'app se ferme
    thread::spawn(move || child.wait());
    Ok(())
}

#[derive(Debug, Default, PartialEq, Eq)]
struct DesktopEntry {
    name: Option<String>,
    icon: Option<String>,
}

impl DesktopEntry {
    /// Lit la section `[Desktop Entry]`, en préférant le nom traduit en français.
    fn parse(text: &str) -> Self {
        let mut entry = DesktopEntry::default();
        let mut french_name = None;
        let mut in_entry = false;
        for line in text.lines().map(str::trim) {
            if line.starts_with('[') {
                in_entry = line == "[Desktop Entry]";
                continue;
            }
            if !in_entry {
                continue;
            }
            if let Some(value) = line.strip_prefix("Name[fr]=") {
                french_name = Some(value.to_string());
            } else if let Some(value) = line.strip_prefix("Name=") {
                entry.name.get_or_insert_with(|| value.to_string());
            } else if let Some(value) = line.strip_prefix("Icon=") {
                entry.icon = Some(value.to_string());
            }
        }
        if french_name.is_some() {
            entry.name = french_name;
        }
        entry
    }
}

/// Cherche l'icône dans les thèmes (hicolor), Flatpak compris, puis dans `pixmaps`.
fn find_icon(name: &str) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.is_absolute() {
        return path.is_file().then(|| path.to_path_buf());
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut themes: Vec<PathBuf> = Vec::new();
    if let Some(home) = &home {
        themes.push(home.join(".local/share/icons"));
        themes.push(home.join(".local/share/flatpak/exports/share/icons"));
    }
    themes.push(PathBuf::from("/var/lib/flatpak/exports/share/icons"));
    themes.push(PathBuf::from("/usr/share/icons"));
    let sizes = [
        "scalable", "512x512", "256x256", "128x128", "96x96", "64x64", "48x48",
    ];
    for theme in &themes {
        for size in sizes {
            for extension in ["svg", "png"] {
                let candidate = theme.join(format!("hicolor/{size}/apps/{name}.{extension}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    ["png", "svg"]
        .iter()
        .map(|extension| PathBuf::from(format!("/usr/share/pixmaps/{name}.{extension}")))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lit_le_nom_traduit_et_l_icone() {
        let text = "[Desktop Entry]\nName=Files\nName[fr]=Fichiers\nIcon=org.gnome.Nautilus\n\
                    [Desktop Action new-window]\nName=New Window\n";
        assert_eq!(
            DesktopEntry::parse(text),
            DesktopEntry {
                name: Some("Fichiers".into()),
                icon: Some("org.gnome.Nautilus".into()),
            }
        );
    }
}
