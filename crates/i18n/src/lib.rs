//! Langues de Rutile. Les textes du côté Rust (menu de la barre, notifications, erreurs,
//! sélecteurs de fichiers) viennent des mêmes fichiers que ceux de l'interface :
//! `src/i18n/locales/<langue>/app.json`, des clés à plat (« tray.open ») vers le texte.
//!
//! La langue est celle choisie dans les réglages, sinon la première langue préférée du système
//! que Rutile connaît, sinon l'anglais. Un texte absent d'une langue retombe sur le français,
//! la langue d'origine de Rutile, puis sur sa clé.

use std::collections::HashMap;
use std::fmt::Display;
use std::sync::{LazyLock, RwLock};

/// Langues de Rutile : code et nom dans la langue elle-même, dans l'ordre du menu des réglages.
pub const LANGUAGES: [(&str, &str); 10] = [
    ("fr", "Français"),
    ("en", "English"),
    ("es", "Español"),
    ("de", "Deutsch"),
    ("it", "Italiano"),
    ("pt", "Português (Brasil)"),
    ("zh", "简体中文"),
    ("ja", "日本語"),
    ("ko", "한국어"),
    ("ru", "Русский"),
];

/// Langue d'origine des textes : celle qui sert quand une traduction manque.
pub const SOURCE: &str = "fr";
/// Langue d'un système dont Rutile ne connaît aucune des langues préférées.
const FALLBACK: &str = "en";

macro_rules! files {
    ($($code:literal),*) => {
        [$(($code, include_str!(concat!("../../../src/i18n/locales/", $code, "/app.json")))),*]
    };
}

const FILES: [(&str, &str); 10] =
    files!("fr", "en", "es", "de", "it", "pt", "zh", "ja", "ko", "ru");

static DICTIONARIES: LazyLock<HashMap<&'static str, HashMap<String, String>>> =
    LazyLock::new(|| {
        FILES
            .iter()
            .map(|(code, text)| (*code, serde_json::from_str(text).unwrap_or_default()))
            .collect()
    });

/// Langue en cours ; le français tant que l'app n'en a pas choisi (les tests, entre autres).
static CURRENT: RwLock<&'static str> = RwLock::new(SOURCE);

/// Code d'une langue de Rutile d'après une étiquette de langue (« fr-FR », « zh_Hans_CN »,
/// « pt-BR »), `None` si Rutile ne la connaît pas. Le chinois est servi en caractères
/// simplifiés quelle que soit la variante.
pub fn supported(tag: &str) -> Option<&'static str> {
    let primary = tag
        .split(['-', '_', '.', '@'])
        .next()?
        .trim()
        .to_ascii_lowercase();
    LANGUAGES
        .iter()
        .map(|(code, _)| *code)
        .find(|code| *code == primary)
}

/// Langue du système : la première de ses langues préférées que Rutile connaît.
pub fn system() -> &'static str {
    sys_locale::get_locales()
        .find_map(|tag| supported(&tag))
        .unwrap_or(FALLBACK)
}

/// Langue à employer : celle choisie dans les réglages si Rutile la connaît, sinon celle du
/// système.
pub fn resolve(choice: Option<&str>) -> &'static str {
    choice.and_then(supported).unwrap_or_else(system)
}

/// Change la langue des textes à venir.
pub fn set(code: &str) {
    if let Some(code) = supported(code) {
        *CURRENT
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = code;
    }
}

pub fn current() -> &'static str {
    *CURRENT
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Nom d'une langue dans la langue elle-même (« Deutsch »).
pub fn name(code: &str) -> &'static str {
    LANGUAGES
        .iter()
        .find(|(known, _)| *known == code)
        .map_or("", |(_, name)| *name)
}

fn lookup(language: &str, key: &str) -> Option<&'static str> {
    DICTIONARIES
        .get(language)
        .and_then(|dictionary| dictionary.get(key))
        .map(String::as_str)
}

fn text(key: &str) -> String {
    lookup(current(), key)
        .or_else(|| lookup(SOURCE, key))
        .map_or_else(|| key.to_owned(), str::to_owned)
}

/// Texte de `key` dans la langue en cours.
pub fn t(key: &str) -> String {
    text(key)
}

/// Texte de `key` dont les `{nom}` sont remplacés par leurs valeurs.
pub fn tf(key: &str, args: &[(&str, &dyn Display)]) -> String {
    fill(text(key), args)
}

/// Texte de `key` accordé au nombre `count` (« key.one », « key.few », « key.many » ou
/// « key.other » selon la langue), avec `{count}` et les autres valeurs remplacés.
pub fn tn(key: &str, count: u64, args: &[(&str, &dyn Display)]) -> String {
    let language = current();
    let form = plural(language, count);
    let text = [form, "other"]
        .iter()
        .find_map(|form| {
            let key = format!("{key}.{form}");
            lookup(language, &key).or_else(|| lookup(SOURCE, &key))
        })
        .map_or_else(|| key.to_owned(), str::to_owned);
    let text = text.replace("{count}", &count.to_string());
    fill(text, args)
}

fn fill(mut text: String, args: &[(&str, &dyn Display)]) -> String {
    for (name, value) in args {
        text = text.replace(&format!("{{{name}}}"), &value.to_string());
    }
    text
}

/// Forme du pluriel, comme `Intl.PluralRules` côté interface, pour les langues de Rutile.
fn plural(language: &str, count: u64) -> &'static str {
    match language {
        // Le français met 0 et 1 au singulier
        "fr" | "pt" if count < 2 => "one",
        "zh" | "ja" | "ko" => "other",
        "ru" => {
            let (unit, tens) = (count % 10, count % 100);
            if unit == 1 && tens != 11 {
                "one"
            } else if (2..=4).contains(&unit) && !(12..=14).contains(&tens) {
                "few"
            } else {
                "many"
            }
        }
        _ if count == 1 => "one",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn les_etiquettes_du_systeme_trouvent_leur_langue() {
        assert_eq!(supported("fr-FR"), Some("fr"));
        assert_eq!(supported("zh-Hans-CN"), Some("zh"));
        assert_eq!(supported("zh_TW"), Some("zh"));
        assert_eq!(supported("pt-BR"), Some("pt"));
        assert_eq!(supported("en_US.UTF-8"), Some("en"));
        assert_eq!(supported("ar-SA"), None);
        assert_eq!(resolve(Some("de")), "de");
        assert_eq!(name("ja"), "日本語");
    }

    #[test]
    fn le_pluriel_suit_la_langue() {
        assert_eq!(plural("fr", 0), "one");
        assert_eq!(plural("en", 0), "other");
        assert_eq!(plural("en", 1), "one");
        assert_eq!(plural("ru", 21), "one");
        assert_eq!(plural("ru", 3), "few");
        assert_eq!(plural("ru", 12), "many");
        assert_eq!(plural("ja", 1), "other");
    }

    #[test]
    fn chaque_fichier_de_langue_se_lit() {
        for (code, text) in FILES {
            assert!(
                serde_json::from_str::<HashMap<String, String>>(text).is_ok(),
                "{code}/app.json n'est pas un objet de textes"
            );
        }
    }

    #[test]
    fn une_cle_inconnue_se_rend_telle_quelle() {
        assert_eq!(t("cle.inconnue"), "cle.inconnue");
        assert_eq!(
            fill("{a} et {b}".into(), &[("a", &1), ("b", &"deux")]),
            "1 et deux"
        );
    }
}
