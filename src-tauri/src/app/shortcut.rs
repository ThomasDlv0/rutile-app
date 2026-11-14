//! Raccourci clavier global qui ouvre ou ferme la roue.

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use super::notify::{self, Message};
use super::wheel;

/// ⌘⇧Espace sur macOS, Ctrl+Maj+Espace ailleurs ; réglable dans les réglages.
pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+Space";

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                wheel::toggle(app);
            }
        })
        .build()
}

/// Enregistre le raccourci, ou prévient s'il est déjà pris par une autre app.
pub fn register<R: Runtime>(app: &AppHandle<R>, accelerator: &str) {
    if !platform::session::global_shortcuts_supported() {
        eprintln!("rutile : pas de raccourci global sous Wayland, utilisez `rutile --open`");
        return;
    }
    if let Err(err) = app.global_shortcut().register(accelerator) {
        eprintln!("rutile : raccourci {accelerator} refusé : {err}");
        notify::show(
            app,
            Message {
                title: i18n::t("shortcut.unavailable"),
                body: i18n::tf(
                    "shortcut.unavailableBody",
                    &[("shortcut", &label(accelerator))],
                ),
                action: None,
            },
        );
    }
}

/// Remplace le raccourci ; s'il est refusé, l'ancien est remis en place.
///
/// macOS ne refuse pas un raccourci déjà pris par une autre app : il le lui laisse.
pub fn replace<R: Runtime>(app: &AppHandle<R>, old: &str, new: &str) -> Result<(), String> {
    if !platform::session::global_shortcuts_supported() {
        return Err(i18n::t("shortcut.noWayland"));
    }
    let shortcut: Shortcut = new
        .parse()
        .map_err(|_| i18n::tf("shortcut.invalid", &[("shortcut", &new)]))?;
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister(old);
    if let Err(err) = shortcuts.register(shortcut) {
        let _ = shortcuts.register(old);
        return Err(i18n::tf(
            "shortcut.refused",
            &[("shortcut", &label(new)), ("reason", &err)],
        ));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Style {
    Mac,
    Windows,
    Linux,
}

/// Raccourci tel qu'on l'écrit sur chaque système : « ⌘⇧Espace » ou « Ctrl+Maj+Espace ».
pub fn label(accelerator: &str) -> String {
    let style = if cfg!(target_os = "macos") {
        Style::Mac
    } else if cfg!(windows) {
        Style::Windows
    } else {
        Style::Linux
    };
    label_for(accelerator, style)
}

fn label_for(accelerator: &str, style: Style) -> String {
    let mac = matches!(style, Style::Mac);
    let parts: Vec<String> = accelerator
        .split('+')
        .map(|part| {
            let key = part.trim();
            let name = match key.to_ascii_uppercase().as_str() {
                "COMMANDORCONTROL" | "COMMANDORCTRL" | "CMDORCTRL" | "CMDORCONTROL" => {
                    if mac {
                        "⌘"
                    } else {
                        "Ctrl"
                    }
                }
                "COMMAND" | "CMD" | "SUPER" | "META" => match style {
                    Style::Mac => "⌘",
                    Style::Windows => "Win",
                    Style::Linux => "Super",
                },
                "CONTROL" | "CTRL" => {
                    if mac {
                        "⌃"
                    } else {
                        "Ctrl"
                    }
                }
                "SHIFT" => {
                    if mac {
                        "⇧"
                    } else {
                        "Maj"
                    }
                }
                "ALT" | "OPTION" => {
                    if mac {
                        "⌥"
                    } else {
                        "Alt"
                    }
                }
                "SPACE" => "Espace",
                _ => {
                    let short = key
                        .strip_prefix("Key")
                        .or_else(|| key.strip_prefix("Digit"))
                        .unwrap_or(key);
                    return short.to_string();
                }
            };
            name.to_string()
        })
        .collect();
    if mac { parts.concat() } else { parts.join("+") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raccourci_par_defaut_sur_chaque_systeme() {
        assert_eq!(label_for(DEFAULT_SHORTCUT, Style::Mac), "⌘⇧Espace");
        assert_eq!(
            label_for(DEFAULT_SHORTCUT, Style::Windows),
            "Ctrl+Maj+Espace"
        );
        assert_eq!(label_for(DEFAULT_SHORTCUT, Style::Linux), "Ctrl+Maj+Espace");
    }

    #[test]
    fn autres_touches() {
        assert_eq!(label_for("Alt+Super+KeyR", Style::Windows), "Alt+Win+R");
        assert_eq!(label_for("Ctrl+Option+Digit5", Style::Mac), "⌃⌥5");
    }
}
