//! Mises à jour : Rutile regarde la dernière version publiée sur GitHub peu après son
//! lancement, puis toutes les six heures, et propose de l'installer. Le fichier téléchargé
//! n'est installé que si sa signature correspond à la clé publique de `tauri.conf.json`.
//!
//! La proposition, l'avancement du téléchargement et les réponses d'une recherche demandée
//! s'affichent dans une fenêtre de Rutile (`update`), la même sur les trois systèmes, plutôt
//! que dans une alerte du système.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Error, Update, UpdaterExt};

use super::settings;

/// Première recherche un peu après le lancement, pour ne pas ralentir l'ouverture de session.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Avancement du téléchargement (de 0 à 1), pour la fenêtre de réglages.
pub const PROGRESS_EVENT: &str = "updates://progress";
const RELEASES_URL: &str = "https://github.com/ThomasDlv0/rutile-app/releases/latest";
/// Fenêtre de mise à jour, et l'événement qui lui donne son nouvel état.
pub const UPDATE_LABEL: &str = "update";
const PROMPT_EVENT: &str = "update://prompt";
/// Largeur de la fenêtre ; sa hauteur suit son contenu, dans ces bornes.
const WINDOW_WIDTH: f64 = 420.0;
const HEIGHT_RANGE: (f64, f64) = (160.0, 640.0);
/// Hauteur d'attente, avant que la page ait mesuré son contenu.
const DEFAULT_HEIGHT: f64 = 420.0;
/// Si la page n'a rien demandé d'ici là (erreur de chargement), la fenêtre s'affiche quand même.
const SHOW_FALLBACK: Duration = Duration::from_secs(2);
/// Champ du manifeste avec les notes de version complètes, en Markdown. Les versions d'avant
/// la 1.5 l'ignorent et affichent `notes`, le premier paragraphe en texte simple.
const DETAILS_FIELD: &str = "details";

/// Version déjà proposée d'elle-même : après « Plus tard », Rutile ne la repropose qu'au
/// lancement suivant (ou si on la demande).
#[derive(Default)]
struct Offered(Mutex<Option<String>>);

/// Fenêtre de mise à jour : ce qu'elle montre, et la mise à jour qu'elle propose.
#[derive(Default)]
struct UpdateWindow {
    prompt: Mutex<Option<Prompt>>,
    pending: Mutex<Option<Update>>,
}

/// Ce que montre la fenêtre de mise à jour.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "step", rename_all = "camelCase")]
pub enum Prompt {
    /// Une version plus récente est publiée ; `notes` en Markdown.
    Available {
        version: String,
        current: String,
        notes: Option<String>,
    },
    /// Téléchargement en cours ; `progress` de 0 à 1 quand la taille est connue.
    Downloading {
        version: String,
        progress: Option<f64>,
    },
    /// Téléchargée et vérifiée : la mise à jour s'installe, puis Rutile redémarre.
    Installing { version: String },
    /// Recherche demandée : rien de plus récent.
    UpToDate { current: String },
    /// Recherche ou installation impossible.
    Failed { message: String },
}

impl Prompt {
    /// Un téléchargement ou une installation ne s'interrompt pas.
    fn busy(&self) -> bool {
        matches!(self, Prompt::Downloading { .. } | Prompt::Installing { .. })
    }
}

/// Ce que lit la page de la fenêtre à son chargement.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateView {
    /// `macos`, `windows` ou `linux` : la barre de titre n'est pas la même.
    platform: &'static str,
    prompt: Option<Prompt>,
}

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
    app.manage(UpdateWindow::default());
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
        Err(Error::TargetNotFound(_) | Error::TargetsNotFound(_)) => {
            Err(i18n::tf("update.manualInstall", &[("url", &RELEASES_URL)]))
        }
        Err(err) => Err(i18n::tf("update.searchFailed", &[("reason", &err)])),
    }
}

/// Notes à afficher : celles du champ `details` du manifeste (tout le fichier de notes, en
/// Markdown), sinon le premier paragraphe, seul connu des versions d'avant.
fn release_notes(raw: &Value, body: Option<&str>) -> Option<String> {
    let written = |notes: &str| !notes.trim().is_empty();
    raw.get(DETAILS_FIELD)
        .and_then(Value::as_str)
        .filter(|notes| written(notes))
        .or(body.filter(|notes| written(notes)))
        .map(|notes| notes.trim().to_owned())
}

/// Cherche une mise à jour et propose de l'installer. `manual` : demandée depuis le menu, elle
/// dit aussi quand Rutile est déjà à jour, ou pourquoi la recherche a échoué.
pub async fn offer<R: Runtime>(app: &AppHandle<R>, manual: bool) {
    let state = app.state::<UpdateWindow>();
    // Un téléchargement en cours ne se remplace pas : la fenêtre revient seulement devant
    let current = state.prompt.lock().unwrap().clone();
    if let Some(prompt) = current.filter(Prompt::busy) {
        if manual {
            present(app, prompt);
        }
        return;
    }
    let prompt = match find(app).await {
        Ok(Some(update)) => {
            if !manual {
                let offered = app.state::<Offered>();
                let mut last = offered.0.lock().unwrap();
                if last.as_deref() == Some(update.version.as_str()) {
                    return;
                }
                *last = Some(update.version.clone());
            }
            let prompt = Prompt::Available {
                version: update.version.clone(),
                current: update.current_version.clone(),
                notes: release_notes(&update.raw_json, update.body.as_deref()),
            };
            *state.pending.lock().unwrap() = Some(update);
            prompt
        }
        Ok(None) if manual => Prompt::UpToDate {
            current: app.package_info().version.to_string(),
        },
        Err(message) if manual => Prompt::Failed { message },
        // Recherche automatique : rien à dire
        Ok(None) | Err(_) => return,
    };
    present(app, prompt);
}

/// Enregistre le nouvel état et le montre à la fenêtre, si elle est ouverte.
fn set_prompt<R: Runtime>(app: &AppHandle<R>, prompt: Prompt) {
    *app.state::<UpdateWindow>().prompt.lock().unwrap() = Some(prompt.clone());
    let _ = app.emit_to(UPDATE_LABEL, PROMPT_EVENT, prompt);
}

/// Montre `prompt` dans la fenêtre de mise à jour, ouverte au besoin, et la passe devant.
fn present<R: Runtime>(app: &AppHandle<R>, prompt: Prompt) {
    set_prompt(app, prompt);
    if let Some(window) = app.get_webview_window(UPDATE_LABEL) {
        bring_to_front(app);
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    // Cachée tant que la page n'a pas mesuré son contenu : elle s'affiche à la bonne taille
    let builder =
        WebviewWindowBuilder::new(app, UPDATE_LABEL, WebviewUrl::App("index.html".into()))
            .title(i18n::t("update.windowTitle"))
            .inner_size(WINDOW_WIDTH, DEFAULT_HEIGHT)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .visible(false)
            .center();
    // macOS : la page passe sous la barre de titre, dont il ne reste que les boutons ronds
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    // Windows et Linux : la page dessine sa propre barre ; l'ombre arrondit aussi les coins
    // sous Windows 11
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false).shadow(true);
    match builder.build() {
        Ok(_) => {
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(SHOW_FALLBACK);
                if let Some(window) = app.get_webview_window(UPDATE_LABEL)
                    && !window.is_visible().unwrap_or(true)
                {
                    reveal(&app, &window);
                }
            });
        }
        Err(err) => eprintln!("rutile : fenêtre de mise à jour impossible : {err}"),
    }
}

/// Affiche la fenêtre au centre de l'écran, devant les autres.
fn reveal<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let _ = window.center();
    bring_to_front(app);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Rutile n'a pas d'icône dans le Dock : sans cela, sa fenêtre s'ouvrirait derrière l'app
/// active.
fn bring_to_front<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.run_on_main_thread(platform::session::activate);
}

/// Hauteur de la fenêtre pour un contenu de `height` points.
fn fitted_height(height: f64) -> f64 {
    if height.is_finite() {
        height.clamp(HEIGHT_RANGE.0, HEIGHT_RANGE.1)
    } else {
        DEFAULT_HEIGHT
    }
}

/// Télécharge, vérifie la signature, installe, puis relance Rutile. Sous Windows,
/// l'installateur ferme Rutile et le rouvre lui-même.
async fn install<R: Runtime>(app: &AppHandle<R>, update: Update) -> Result<(), String> {
    let version = update.version.clone();
    set_prompt(
        app,
        Prompt::Downloading {
            version: version.clone(),
            progress: None,
        },
    );
    let progress = app.clone();
    let downloading = version.clone();
    let mut received = 0usize;
    // Un état par pour cent, pas un par morceau reçu
    let mut shown: Option<u32> = None;
    let finished = app.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                received += chunk;
                let Some(total) = total.filter(|total| *total > 0) else {
                    return;
                };
                let fraction = (received as f64 / total as f64).min(1.0);
                let percent = (fraction * 100.0) as u32;
                if shown == Some(percent) {
                    return;
                }
                shown = Some(percent);
                let _ = progress.emit(PROGRESS_EVENT, fraction);
                set_prompt(
                    &progress,
                    Prompt::Downloading {
                        version: downloading.clone(),
                        progress: Some(fraction),
                    },
                );
            },
            move || set_prompt(&finished, Prompt::Installing { version }),
        )
        .await;
    if let Err(err) = result {
        let message = i18n::tf("update.installFailed", &[("reason", &err)]);
        set_prompt(
            app,
            Prompt::Failed {
                message: message.clone(),
            },
        );
        return Err(message);
    }
    app.restart()
}

/// Ce que la fenêtre de mise à jour affiche, à son chargement.
#[tauri::command]
pub fn update_view<R: Runtime>(app: AppHandle<R>) -> UpdateView {
    UpdateView {
        platform: std::env::consts::OS,
        prompt: app.state::<UpdateWindow>().prompt.lock().unwrap().clone(),
    }
}

/// La page a mesuré son contenu : la fenêtre prend sa hauteur, et s'affiche la première fois.
#[tauri::command]
pub fn fit_update_window<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, height: f64) {
    if window.label() != UPDATE_LABEL {
        return;
    }
    let _ = window.set_size(LogicalSize::new(WINDOW_WIDTH, fitted_height(height)));
    if !window.is_visible().unwrap_or(true) {
        reveal(&app, &window);
    }
}

/// « Mettre à jour » : installe la version proposée. Un échec s'affiche dans la fenêtre.
#[tauri::command]
pub async fn accept_update<R: Runtime>(app: AppHandle<R>) {
    let pending = app.state::<UpdateWindow>().pending.lock().unwrap().take();
    if let Some(update) = pending {
        let _ = install(&app, update).await;
    }
}

/// « Plus tard », « OK » ou la croix : ferme la fenêtre. Un téléchargement en cours continue,
/// et Rutile redémarre à la fin.
#[tauri::command]
pub fn dismiss_update<R: Runtime>(window: WebviewWindow<R>) {
    if window.label() == UPDATE_LABEL {
        let _ = window.close();
    }
}

/// Page des versions publiées, dans le navigateur.
#[tauri::command]
pub fn open_releases<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.opener()
        .open_url(RELEASES_URL, None::<&str>)
        .map_err(|err| err.to_string())
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
    let update = find(&app)
        .await?
        .ok_or_else(|| i18n::t("update.alreadyCurrent"))?;
    install(&app, update).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ce qu'écrit scripts/updater-manifest.sh, lu comme le lit le module de mise à jour.
    #[test]
    fn le_manifeste_publie_est_lisible_par_le_module() {
        let manifest = r#"{
          "version": "1.2.0",
          "notes": "Mises à jour automatiques.",
          "details": "**Rutile 1.2.0** se met à jour.\n\n## Nouveautés\n\n- Une fenêtre.",
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
        // Le champ `details` ne gêne pas le module (ni celui des versions d'avant)
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

        let raw: Value = serde_json::from_str(manifest).unwrap();
        let notes = release_notes(&raw, release.notes.as_deref()).unwrap();
        assert!(notes.starts_with("**Rutile 1.2.0**"));
        assert!(notes.ends_with("- Une fenêtre."));
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
    fn sans_notes_completes_le_premier_paragraphe_suffit() {
        let raw = serde_json::json!({ "version": "1.4.0", "notes": "Roues perso." });
        assert_eq!(
            release_notes(&raw, Some("  Roues perso.\n")).as_deref(),
            Some("Roues perso.")
        );
        // Des notes complètes vides ne masquent pas le paragraphe
        let raw = serde_json::json!({ "details": "  \n" });
        assert_eq!(
            release_notes(&raw, Some("Roues perso.")).as_deref(),
            Some("Roues perso.")
        );
        assert_eq!(release_notes(&serde_json::json!({}), Some("   ")), None);
        assert_eq!(release_notes(&serde_json::json!({}), None), None);
    }

    #[test]
    fn la_fenetre_suit_son_contenu_dans_ses_bornes() {
        assert_eq!(fitted_height(300.0), 300.0);
        assert_eq!(fitted_height(20.0), HEIGHT_RANGE.0);
        assert_eq!(fitted_height(5000.0), HEIGHT_RANGE.1);
        assert_eq!(fitted_height(f64::NAN), DEFAULT_HEIGHT);
    }

    /// La forme que lit `src/update/ipc.ts`.
    #[test]
    fn les_etats_arrivent_a_la_page_sous_la_forme_attendue() {
        let prompt = |prompt: Prompt| serde_json::to_value(prompt).unwrap();
        assert_eq!(
            prompt(Prompt::UpToDate {
                current: "1.4.0".into()
            }),
            serde_json::json!({ "step": "upToDate", "current": "1.4.0" })
        );
        assert_eq!(
            prompt(Prompt::Downloading {
                version: "1.5.0".into(),
                progress: Some(0.5)
            }),
            serde_json::json!({ "step": "downloading", "version": "1.5.0", "progress": 0.5 })
        );
        assert_eq!(
            prompt(Prompt::Available {
                version: "1.5.0".into(),
                current: "1.4.0".into(),
                notes: None
            }),
            serde_json::json!({
                "step": "available", "version": "1.5.0", "current": "1.4.0", "notes": null
            })
        );
        assert!(
            Prompt::Installing {
                version: "1.5.0".into()
            }
            .busy()
        );
        assert!(
            !Prompt::Failed {
                message: String::new()
            }
            .busy()
        );
    }
}
