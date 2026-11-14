//! Notifications, avec un bouton qui affiche les fichiers produits ou ouvre les réglages.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI32, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::{Action as Button, ActionType, NotificationExt};
use tauri_plugin_opener::OpenerExt;

use super::wheel::WHEEL_LABEL;

/// Résultat d'une action à afficher, reçu par la page de la roue.
const TOAST_EVENT: &str = "wheel://toast";
const CONVERTED: &str = "converted";
const REVEAL: &str = "reveal";
const SETTINGS: &str = "settings";
const OPEN_SETTINGS: &str = "open-settings";
/// Identifiant donné par le plugin à un clic sur la notification elle-même.
const TAP: &str = "tap";
/// Actions retenues pour les notifications encore susceptibles d'être cliquées.
const REMEMBERED: i32 = 50;

/// Ce que fait un clic sur la notification ou sur son bouton.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// « Afficher » : montre les fichiers dans le Finder ou l'Explorateur.
    Reveal(Vec<PathBuf>),
    /// « Ouvrir les réglages » : ouvre une page des réglages du système (macOS seulement).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    OpenUrl(String),
}

/// Résultat affiché par Rutile lui-même, à côté du curseur : les notifications peuvent être
/// coupées dans les réglages du système, et l'utilisateur ne saurait pas que c'est fait.
#[derive(Clone, Serialize)]
struct Toast<'a> {
    title: &'a str,
    body: &'a str,
    ok: bool,
}

/// Annonce le résultat d'une action demandée sur la roue : à l'écran, et par une notification.
pub fn announce<R: Runtime>(app: &AppHandle<R>, message: Message, ok: bool) {
    let toast = Toast {
        title: &message.title,
        body: &message.body,
        ok,
    };
    let _ = app.emit_to(WHEEL_LABEL, TOAST_EVENT, toast);
    show(app, message);
}

pub struct Message {
    pub title: String,
    pub body: String,
    pub action: Option<Action>,
}

#[derive(Default)]
struct Notifier {
    last_id: AtomicI32,
    actions: Mutex<HashMap<i32, Action>>,
}

/// Déclare les boutons des notifications, dans la langue en cours.
fn register_actions<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), tauri_plugin_notification::Error> {
    app.notification().register_action_types(vec![
        ActionType::builder(CONVERTED)
            .actions(vec![
                Button::builder(REVEAL, i18n::t("notify.reveal")).build(),
            ])
            .build(),
        ActionType::builder(SETTINGS)
            .actions(vec![
                Button::builder(OPEN_SETTINGS, i18n::t("notify.openSettings")).build(),
            ])
            .build(),
    ])
}

/// Redéclare les boutons après un changement de langue.
pub fn translate<R: Runtime>(app: &AppHandle<R>) {
    if let Err(err) = register_actions(app) {
        eprintln!("rutile : boutons de notification impossibles : {err}");
    }
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), tauri_plugin_notification::Error> {
    app.manage(Notifier::default());
    register_actions(app)?;
    let notification = app.notification();

    let handle = app.clone();
    notification.on_action(move |performed| {
        if !matches!(performed.action_id(), REVEAL | OPEN_SETTINGS | TAP) {
            return;
        }
        let Some(id) = performed.notification().map(|n| n.id()) else {
            return;
        };
        let action = handle
            .state::<Notifier>()
            .actions
            .lock()
            .unwrap()
            .get(&id)
            .cloned();
        let result = match action {
            Some(Action::Reveal(paths)) => handle.opener().reveal_items_in_dir(paths),
            Some(Action::OpenUrl(url)) => handle.opener().open_url(url, None::<&str>),
            None => Ok(()),
        };
        if let Err(err) = result {
            eprintln!("rutile : action de notification impossible : {err}");
        }
    })
}

pub fn show<R: Runtime>(app: &AppHandle<R>, message: Message) {
    let notifier = app.state::<Notifier>();
    let id = notifier.last_id.fetch_add(1, Ordering::Relaxed) + 1;
    let mut builder = app
        .notification()
        .builder()
        .id(id)
        .title(message.title)
        .body(message.body);

    if let Some(action) = message.action {
        builder = builder.action_type_id(match action {
            Action::Reveal(_) => CONVERTED,
            Action::OpenUrl(_) => SETTINGS,
        });
        let mut actions = notifier.actions.lock().unwrap();
        actions.retain(|&old, _| old > id - REMEMBERED);
        actions.insert(id, action);
    }
    if let Err(err) = builder.show() {
        eprintln!("rutile : notification impossible : {err}");
    }
}
