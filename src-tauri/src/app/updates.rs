//! Mises à jour : Rutile regarde la dernière version publiée sur GitHub peu après son
//! lancement, puis toutes les six heures, et propose de l'installer. Le fichier téléchargé
//! n'est installé que si sa signature correspond à la clé publique de `tauri.conf.json`.

use std::sync::{Mutex, mpsc};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

use super::notify::{self, Message};
use super::settings;

/// Première recherche un peu après le lancement, pour ne pas ralentir l'ouverture de session.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Avancement du téléchargement (de 0 à 1), pour la fenêtre de réglages.
pub const PROGRESS_EVENT: &str = "updates://progress";
const RELEASES_URL: &str = "https://github.com/ThomasDlv0/rutile-app/releases/latest";

/// Version déjà proposée d'elle-même : après « Plus tard », Rutile ne la repropose qu'au
/// lancement suivant (ou si on la demande).
#[derive(Default)]
struct Offered(Mutex<Option<String>>);

/// Ce que montrent les réglages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current: String,
    /// Version publiée plus récente, s'il y en a une.
    available: Option<String>,
    notes: Option<String>,
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    app.manage(Offered::default());
    // En développement, la version locale n'est pas celle publiée
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            if settings::current(&app).auto_update {
                tauri::async_runtime::block_on(offer(&app, false));
            }
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

/// Dernière version publiée, si elle est plus récente que celle-ci.
async fn find<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Update>, String> {
    let updater = app.updater().map_err(|err| err.to_string())?;
    interpret(updater.check().await)
}

/// Réponse du module de mise à jour, en ce que Rutile en dit.
fn interpret(checked: Result<Option<Update>, Error>) -> Result<Option<Update>, String> {
    match checked {
        Ok(update) => Ok(update),
        // GitHub a répondu sans latest.json : la dernière release n'en publie pas (celles
        // d'avant les mises à jour automatiques), il n'y a donc rien à installer d'ici. Une
        // panne de réseau donne une autre erreur.
        Err(Error::ReleaseNotFound) => Ok(None),
        // Aucune mise à jour publiée pour ce type de paquet
        Err(Error::TargetNotFound(_) | Error::TargetsNotFound(_)) => Err(format!(
            "Cette installation ne se met pas à jour toute seule : téléchargez la nouvelle \
             version sur {RELEASES_URL}"
        )),
        Err(err) => Err(format!("Recherche impossible ({err}).")),
    }
}

/// Cherche une mise à jour et propose de l'installer. `manual` : demandée depuis le menu, elle
/// dit aussi quand Rutile est déjà à jour, ou pourquoi la recherche a échoué.
pub async fn offer<R: Runtime>(app: &AppHandle<R>, manual: bool) {
    let update = match find(app).await {
        Ok(Some(update)) => update,
        Ok(None) => {
            if manual {
                let version = app.package_info().version.to_string();
                tell(
                    app,
                    "Rutile est à jour",
                    &format!("Vous avez la dernière version, {version}."),
                );
            }
            return;
        }
        Err(err) => {
            if manual {
                tell(app, "Mises à jour", &err);
            }
            return;
        }
    };
    if !manual {
        let offered = app.state::<Offered>();
        let mut last = offered.0.lock().unwrap();
        if last.as_deref() == Some(update.version.as_str()) {
            return;
        }
        *last = Some(update.version.clone());
    }
    if ask(app, &update).await
        && let Err(err) = install(app, update).await
    {
        notify::show(
            app,
            Message {
                title: "Mise à jour impossible".into(),
                body: err,
                action: None,
            },
        );
    }
}

/// Texte de la proposition : versions, puis les nouveautés publiées avec la mise à jour.
fn proposal(version: &str, current: &str, notes: Option<&str>) -> String {
    let mut text = format!("Rutile {version} est disponible (vous avez la {current}).");
    if let Some(notes) = notes.map(str::trim).filter(|notes| !notes.is_empty()) {
        text.push_str("\n\n");
        text.push_str(notes);
    }
    text.push_str("\n\nRutile redémarrera une fois la mise à jour installée.");
    text
}

/// Fenêtre du système « Mettre à jour » / « Plus tard » ; vrai si l'utilisateur accepte.
async fn ask<R: Runtime>(app: &AppHandle<R>, update: &Update) -> bool {
    bring_to_front(app);
    let (sender, receiver) = mpsc::channel();
    app.dialog()
        .message(proposal(
            &update.version,
            &update.current_version,
            update.body.as_deref(),
        ))
        .title("Mise à jour de Rutile")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Mettre à jour".into(),
            "Plus tard".into(),
        ))
        .show(move |accepted| {
            let _ = sender.send(accepted);
        });
    tauri::async_runtime::spawn_blocking(move || receiver.recv().unwrap_or(false))
        .await
        .unwrap_or(false)
}

fn tell<R: Runtime>(app: &AppHandle<R>, title: &str, text: &str) {
    bring_to_front(app);
    app.dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

/// Rutile n'a pas de fenêtre au premier plan : sans cela, la fenêtre du système s'ouvrirait
/// derrière l'app active.
fn bring_to_front<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.run_on_main_thread(platform::session::activate);
}

/// Télécharge, vérifie la signature, installe, puis relance Rutile. Sous Windows,
/// l'installateur ferme Rutile et le rouvre lui-même.
async fn install<R: Runtime>(app: &AppHandle<R>, update: Update) -> Result<(), String> {
    notify::show(
        app,
        Message {
            title: format!("Téléchargement de Rutile {}", update.version),
            body: "Rutile redémarrera une fois la mise à jour installée.".into(),
            action: None,
        },
    );
    let progress = app.clone();
    let mut received = 0usize;
    update
        .download_and_install(
            move |chunk, total| {
                received += chunk;
                if let Some(total) = total.filter(|total| *total > 0) {
                    let _ = progress.emit(PROGRESS_EVENT, received as f64 / total as f64);
                }
            },
            || {},
        )
        .await
        .map_err(|err| err.to_string())?;
    app.restart()
}

/// État des mises à jour pour les réglages : version installée et version disponible.
#[tauri::command]
pub async fn check_update<R: Runtime>(app: AppHandle<R>) -> Result<UpdateStatus, String> {
    let current = app.package_info().version.to_string();
    let update = find(&app).await?;
    Ok(UpdateStatus {
        current,
        available: update.as_ref().map(|update| update.version.clone()),
        notes: update.and_then(|update| update.body),
    })
}

/// Installe la dernière version, depuis les réglages.
#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let update = find(&app).await?.ok_or("Rutile est déjà à jour.")?;
    install(&app, update).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_proposition_annonce_les_versions_les_nouveautes_et_le_redemarrage() {
        let text = proposal("1.2.0", "1.1.0", Some("  Pastilles sur la roue.\n"));
        assert!(text.starts_with("Rutile 1.2.0 est disponible (vous avez la 1.1.0)."));
        assert!(text.contains("\n\nPastilles sur la roue.\n\n"));
        assert!(text.ends_with("redémarrera une fois la mise à jour installée."));
    }

    /// Ce qu'écrit scripts/updater-manifest.sh, lu comme le lit le module de mise à jour.
    #[test]
    fn le_manifeste_publie_est_lisible_par_le_module() {
        let manifest = r#"{
          "version": "1.2.0",
          "notes": "Mises à jour automatiques.",
          "pub_date": "2026-11-05T11:27:55Z",
          "platforms": {
            "darwin-aarch64-app": {
              "url": "https://github.com/ThomasDlv0/rutile-app/releases/download/v1.2.0/Rutile_1.2.0_macos_universal.app.tar.gz",
              "signature": "c2ln"
            },
            "windows-x86_64-msi": {
              "url": "https://github.com/ThomasDlv0/rutile-app/releases/download/v1.2.0/Rutile_1.2.0_windows_x64.msi",
              "signature": "c2ln"
            },
            "linux-x86_64-appimage": {
              "url": "https://github.com/ThomasDlv0/rutile-app/releases/download/v1.2.0/Rutile_1.2.0_linux_x86_64.AppImage",
              "signature": "c2ln"
            }
          }
        }"#;
        let release: tauri_plugin_updater::RemoteRelease = serde_json::from_str(manifest).unwrap();
        assert_eq!(release.version.to_string(), "1.2.0");
        assert!(
            release
                .download_url("windows-x86_64-msi")
                .unwrap()
                .as_str()
                .ends_with("_windows_x64.msi")
        );
        assert_eq!(release.signature("darwin-aarch64-app").unwrap(), "c2ln");
        // Un .deb sans entrée ne reçoit pas l'AppImage
        assert!(release.download_url("linux-x86_64-deb").is_err());
    }

    #[test]
    fn une_release_sans_manifeste_ne_propose_rien() {
        assert!(matches!(interpret(Err(Error::ReleaseNotFound)), Ok(None)));
    }

    #[test]
    fn un_paquet_absent_du_manifeste_renvoie_vers_les_versions() {
        let targets = vec!["darwin-aarch64-app".into(), "darwin-aarch64".into()];
        let Err(message) = interpret(Err(Error::TargetsNotFound(targets))) else {
            panic!("une erreur était attendue");
        };
        assert!(message.contains(RELEASES_URL));
    }

    #[test]
    fn sans_nouveautes_la_proposition_reste_courte() {
        let text = proposal("1.2.0", "1.1.0", Some("   "));
        assert_eq!(
            text,
            "Rutile 1.2.0 est disponible (vous avez la 1.1.0).\n\n\
             Rutile redémarrera une fois la mise à jour installée."
        );
    }
}
