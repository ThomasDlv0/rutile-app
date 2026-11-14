//! Les clés de traduction appelées côté Rust (`i18n::t`, `i18n::tf`, `i18n::tn`) et le fichier
//! français `src/i18n/locales/fr/app.json` doivent dire la même chose : pas de clé appelée mais
//! absente, pas de clé écrite mais jamais appelée.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const SOURCES: [&str; 3] = [
    "src-tauri/src",
    "crates/converter/src",
    "crates/platform/src",
];
const PLURAL_FORMS: [&str; 6] = ["zero", "one", "two", "few", "many", "other"];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri est dans le dépôt")
        .to_path_buf()
}

fn rust_files(dir: &Path, found: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(dir).unwrap_or_else(|err| panic!("{} : {err}", dir.display()));
    for entry in entries.map(|entry| entry.unwrap().path()) {
        if entry.is_dir() {
            rust_files(&entry, found);
        } else if entry.extension().is_some_and(|extension| extension == "rs") {
            found.push(entry);
        }
    }
}

/// Appels d'un fichier : (fonction, clé) pour chaque `i18n::t(`, `tf(` ou `tn(`. Une clé qui
/// n'est pas un texte entre guillemets (un menu qui passe ses clés à une fonction) rend le
/// fichier « indirect » : ses textes entre guillemets comptent alors comme des clés employées.
fn calls(source: &str, calls: &mut Vec<(String, String)>, indirect: &mut Vec<String>) {
    let code: String = source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut rest = code.as_str();
    while let Some(start) = rest.find("i18n::t") {
        rest = &rest[start + "i18n::t".len()..];
        let function = if rest.starts_with("f(") {
            "tf"
        } else if rest.starts_with("n(") {
            "tn"
        } else if rest.starts_with('(') {
            "t"
        } else {
            continue;
        };
        let after = rest[rest.find('(').unwrap() + 1..].trim_start();
        match after
            .strip_prefix('"')
            .and_then(|text| text.split_once('"'))
        {
            Some((key, _)) => calls.push((function.to_string(), key.to_string())),
            None => indirect.push(code.clone()),
        }
    }
}

#[test]
fn les_cles_du_code_et_du_fichier_francais_concordent() {
    let root = root();
    let json = fs::read_to_string(root.join("src/i18n/locales/fr/app.json")).unwrap();
    let texts: BTreeMap<String, String> = serde_json::from_str(&json).unwrap();

    let mut files = Vec::new();
    for dir in SOURCES {
        rust_files(&root.join(dir), &mut files);
    }
    let (mut used, mut indirect, mut problems) = (Vec::new(), Vec::new(), Vec::<String>::new());
    for file in &files {
        calls(&fs::read_to_string(file).unwrap(), &mut used, &mut indirect);
    }
    assert!(
        used.len() > 50,
        "trop peu d'appels trouvés : {}",
        used.len()
    );

    // Clé réellement lue dans le fichier : `tn` ajoute la forme du pluriel
    let mut needed = BTreeSet::new();
    let mut plural_bases = BTreeSet::new();
    for (function, key) in &used {
        if function == "tn" {
            needed.insert(format!("{key}.other"));
            plural_bases.insert(key.clone());
        } else {
            needed.insert(key.clone());
        }
    }
    for key in &needed {
        if !texts.contains_key(key) {
            problems.push(format!("clé appelée mais absente de app.json : {key}"));
        }
    }
    for key in texts.keys() {
        let plural_form = key.rsplit_once('.').is_some_and(|(base, form)| {
            PLURAL_FORMS.contains(&form) && plural_bases.contains(base)
        });
        let quoted = format!("\"{key}\"");
        let indirectly = indirect.iter().any(|code| code.contains(&quoted));
        if !needed.contains(key) && !plural_form && !indirectly {
            problems.push(format!("clé de app.json jamais appelée : {key}"));
        }
    }
    assert!(problems.is_empty(), "\n{}", problems.join("\n"));
}
