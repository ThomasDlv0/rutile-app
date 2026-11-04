//! Notifications, avec un bouton qui affiche les fichiers produits ou ouvre les réglages.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI32, Ordering};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::{Action as Button, ActionType, NotificationExt};
use tauri_plugin_opener::OpenerExt;

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
    /// « Ouvrir les réglages » : ouvre une page des réglages du système.
    OpenUrl(String),
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

pub fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), tauri_plugin_notification::Error> {
    app.manage(Notifier::default());
    let notification = app.notification();
    notification.register_action_types(vec![
        ActionType::builder(CONVERTED)
            .actions(vec![Button::builder(REVEAL, "Afficher").build()])
            .build(),
        ActionType::builder(SETTINGS)
            .actions(vec![
                Button::builder(OPEN_SETTINGS, "Ouvrir les réglages").build(),
            ])
            .build(),
    ])?;

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
