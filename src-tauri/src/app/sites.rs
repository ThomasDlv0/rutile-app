//! Sites web des roues : leur logo et leur nom, lus sur le site lui-même et nulle part
//! ailleurs. Le logo est gardé sur le disque, pour ne le demander qu'une fois.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use reqwest::redirect::Policy;
use reqwest::{Client, Url};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::apps;
use super::settings::{self, SETTINGS_LABEL};

/// Côté de la tuile, comme les icônes d'apps.
const ICON_SIZE: u32 = 128;
/// Les liens vers les icônes sont dans l'en-tête de la page : inutile de lire plus loin.
const PAGE_LIMIT: usize = 300 * 1024;
const ICON_LIMIT: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// Temps laissé à un site pour donner son logo, toutes requêtes comprises.
const SITE_TIMEOUT: Duration = Duration::from_secs(16);
/// Icônes essayées, de la plus prometteuse à la moins bonne.
const MAX_TRIES: usize = 6;
const MAX_REDIRECTS: usize = 5;
const MAX_NAME: usize = 40;
/// Les réglages relisent leurs icônes : un logo vient d'arriver.
const REFRESH_EVENT: &str = "settings://refresh";

/// Ce que Rutile sait du logo d'un site.
enum Known {
    /// PNG en data URL.
    Ready(String),
    /// Tuile vue dans les réglages, avant que le site rejoigne une roue : elle n'ira sur le
    /// disque que si elle sert.
    Previewed(Vec<u8>),
    /// Demandé au site, pas encore arrivé.
    Pending,
    /// Le site n'en a pas donné : on ne redemande pas avant le prochain lancement.
    Missing,
}

#[derive(Default)]
struct SiteIcons(Mutex<HashMap<String, Known>>);

fn state<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, SiteIcons> {
    if app.try_state::<SiteIcons>().is_none() {
        app.manage(SiteIcons::default());
    }
    app.state::<SiteIcons>()
}

/// Empreinte stable d'une adresse (FNV-1a), pour nommer son logo sur le disque.
fn fingerprint(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn cache_file<R: Runtime>(app: &AppHandle<R>, address: &str) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("sites");
    Some(dir.join(format!("{}.png", fingerprint(address))))
}

fn data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", STANDARD.encode(png))
}

/// Garde le logo en mémoire et sur le disque.
fn remember<R: Runtime>(app: &AppHandle<R>, address: &str, tile: &[u8]) -> String {
    if let Some(path) = cache_file(app, address) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, tile);
    }
    let url = data_url(tile);
    state(app)
        .0
        .lock()
        .unwrap()
        .insert(address.to_owned(), Known::Ready(url.clone()));
    url
}

/// Logo du site à cette adresse, s'il est déjà connu. Sinon il est demandé au site en tâche
/// de fond : la roue et les réglages sont prévenus à son arrivée.
pub fn icon<R: Runtime>(app: &AppHandle<R>, address: &str) -> Option<String> {
    let address = address.trim();
    if !settings::web_address(address) {
        return None;
    }
    let previewed = {
        let icons = state(app);
        let mut known = icons.0.lock().unwrap();
        match known.get(address) {
            Some(Known::Ready(url)) => return Some(url.clone()),
            Some(Known::Pending | Known::Missing) => return None,
            Some(Known::Previewed(tile)) => Some(tile.clone()),
            None => {
                let saved = cache_file(app, address).and_then(|path| std::fs::read(path).ok());
                if let Some(png) = saved {
                    let url = data_url(&png);
                    known.insert(address.to_owned(), Known::Ready(url.clone()));
                    return Some(url);
                }
                known.insert(address.to_owned(), Known::Pending);
                None
            }
        }
    };
    // Le site vient de rejoindre une roue : son logo, vu à l'aperçu, est gardé
    if let Some(tile) = previewed {
        return Some(remember(app, address, &tile));
    }
    let handle = app.clone();
    let address = address.to_owned();
    tauri::async_runtime::spawn(async move {
        match fetch(&address).await.and_then(|site| site.tile) {
            Some(tile) => {
                remember(&handle, &address, &tile);
                apps::config_changed(&handle);
                let _ = handle.emit_to(SETTINGS_LABEL, REFRESH_EVENT, ());
            }
            None => {
                let icons = state(&handle);
                let mut known = icons.0.lock().unwrap();
                // Un aperçu a pu donner le logo entre-temps
                if matches!(known.get(&address), Some(Known::Pending)) {
                    known.insert(address, Known::Missing);
                }
            }
        }
    });
    None
}

/// Nom et logo d'un site, pour les montrer avant de l'ajouter à une roue.
#[derive(Debug, Serialize)]
pub struct SitePreview {
    name: String,
    /// PNG en data URL ; absent si le site n'a pas donné de logo.
    icon: Option<String>,
}

/// Demande au site son nom et son logo. Sans réseau, le nom vient de l'adresse.
#[tauri::command]
pub async fn site_preview<R: Runtime>(
    app: AppHandle<R>,
    address: String,
) -> Result<SitePreview, String> {
    let address = address.trim().to_owned();
    if !settings::web_address(&address) {
        return Err("Ce n'est pas une adresse web.".into());
    }
    let Some(site) = fetch(&address).await else {
        return Err("Adresse illisible.".into());
    };
    let icons = state(&app);
    let mut known = icons.0.lock().unwrap();
    let in_use = matches!(known.get(&address), Some(Known::Ready(_)));
    let icon = match site.tile {
        // Déjà sur une roue : son logo est rafraîchi
        Some(tile) if in_use => {
            drop(known);
            Some(remember(&app, &address, &tile))
        }
        // Pas encore ajouté : un seul aperçu est gardé, le dernier
        Some(tile) => {
            known.retain(|_, logo| !matches!(logo, Known::Previewed(_)));
            let url = data_url(&tile);
            known.insert(address, Known::Previewed(tile));
            Some(url)
        }
        // Le logo d'une fois précédente vaut mieux que rien
        None => match known.get(&address) {
            Some(Known::Ready(url)) => Some(url.clone()),
            _ => None,
        },
    };
    Ok(SitePreview {
        name: site.name,
        icon,
    })
}

/// Ce qu'un site a donné.
struct Site {
    name: String,
    /// Tuile en PNG.
    tile: Option<Vec<u8>>,
}

fn client() -> Option<Client> {
    // Le module de mises à jour installe le même fournisseur de chiffrement, s'il passe avant
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    Client::builder()
        .user_agent(concat!(
            "Mozilla/5.0 (compatible; Rutile/",
            env!("CARGO_PKG_VERSION"),
            ")"
        ))
        .timeout(REQUEST_TIMEOUT)
        .redirect(Policy::limited(MAX_REDIRECTS))
        .build()
        .ok()
}

/// Lit le début d'une réponse : jusqu'à la fin de l'en-tête pour une page, en entier pour une
/// icône. `None` si une icône dépasse `limit`.
async fn body(mut response: reqwest::Response, limit: usize, page: bool) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        // La fin de l'en-tête peut être à cheval sur deux morceaux
        let from = bytes.len().saturating_sub(8);
        bytes.extend_from_slice(&chunk);
        if page && contains_ignoring_case(&bytes[from..], b"</head") {
            break;
        }
        if bytes.len() >= limit {
            if !page {
                return None;
            }
            bytes.truncate(limit);
            break;
        }
    }
    Some(bytes)
}

fn contains_ignoring_case(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

async fn fetch(address: &str) -> Option<Site> {
    let started = Instant::now();
    let url = Url::parse(address).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    let client = client()?;

    // La page d'abord : elle dit où sont ses icônes. Refusée (protection contre les robots)
    // ou injoignable, il reste les adresses habituelles
    let page = match client.get(url.clone()).send().await {
        Ok(response) if response.status().is_success() => {
            let location = response.url().clone();
            body(response, PAGE_LIMIT, true)
                .await
                .map(|bytes| (location, String::from_utf8_lossy(&bytes).into_owned()))
        }
        _ => None,
    };
    let head = page.as_ref().map(|(_, html)| Head::read(html));
    let location = page.as_ref().map_or(&url, |(location, _)| location);
    let name = site_name(head.as_ref(), &url);

    let mut tile = None;
    for candidate in candidates(head.as_ref(), location) {
        if started.elapsed() > SITE_TIMEOUT {
            break;
        }
        let Ok(response) = client.get(candidate).send().await else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Some(bytes) = body(response, ICON_LIMIT, false).await else {
            continue;
        };
        // Le décodage d'une grande image prend du temps : hors des tâches asynchrones
        let made =
            tauri::async_runtime::spawn_blocking(move || converter::site_tile(&bytes, ICON_SIZE))
                .await
                .ok()
                .flatten();
        if made.is_some() {
            tile = made;
            break;
        }
    }
    Some(Site { name, tile })
}

/// Ce qui compte dans l'en-tête d'une page : ses liens, ses métadonnées et son titre.
#[derive(Debug, Default)]
struct Head {
    links: Vec<Attributes>,
    metas: Vec<Attributes>,
    base: Option<String>,
    title: Option<String>,
}

type Attributes = Vec<(String, String)>;

fn attribute<'a>(attributes: &'a Attributes, name: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

impl Head {
    /// Lecture tolérante : une page réelle n'est pas toujours bien formée, et elle peut
    /// être coupée au milieu d'une balise.
    fn read(html: &str) -> Head {
        let mut head = Head::default();
        let mut rest = html;
        while let Some(start) = rest.find('<') {
            rest = &rest[start + 1..];
            if let Some(comment) = rest.strip_prefix("!--") {
                rest = comment.find("-->").map_or("", |end| &comment[end + 3..]);
                continue;
            }
            let name_len = rest
                .find(|c: char| !c.is_ascii_alphanumeric())
                .unwrap_or(rest.len());
            let name = rest[..name_len].to_ascii_lowercase();
            rest = &rest[name_len..];
            match name.as_str() {
                "body" => break,
                "link" | "meta" | "base" => {
                    let (attributes, after) = read_attributes(rest);
                    rest = after;
                    match name.as_str() {
                        "link" => head.links.push(attributes),
                        "meta" => head.metas.push(attributes),
                        _ => {
                            if head.base.is_none() {
                                head.base = attribute(&attributes, "href").map(str::to_owned);
                            }
                        }
                    }
                }
                "title" if head.title.is_none() => {
                    let Some(open) = rest.find('>') else { break };
                    let text = &rest[open + 1..];
                    let end = find_ignoring_case(text, "</title").unwrap_or(text.len());
                    head.title = Some(unescape(text[..end].trim()));
                    rest = &text[end..];
                }
                // Leur contenu n'est pas du HTML : un « <link » dans un script ne compte pas
                "script" | "style" => {
                    let close = format!("</{name}");
                    rest = find_ignoring_case(rest, &close).map_or("", |end| &rest[end..]);
                }
                _ => {}
            }
        }
        head
    }

    fn meta(&self, key: &str) -> Option<&str> {
        self.metas.iter().find_map(|attributes| {
            let named = ["property", "name"].iter().any(|kind| {
                attribute(attributes, kind).is_some_and(|value| value.eq_ignore_ascii_case(key))
            });
            named
                .then(|| attribute(attributes, "content"))
                .flatten()
                .map(str::trim)
                .filter(|content| !content.is_empty())
        })
    }
}

fn find_ignoring_case(text: &str, needle: &str) -> Option<usize> {
    text.as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

/// Attributs d'une balise, noms en minuscules, et ce qui suit la balise.
fn read_attributes(tag: &str) -> (Attributes, &str) {
    let mut attributes = Vec::new();
    let mut rest = tag;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '/');
        if rest.is_empty() {
            return (attributes, rest);
        }
        if let Some(after) = rest.strip_prefix('>') {
            return (attributes, after);
        }
        let name_len = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '=' | '>' | '/'))
            .unwrap_or(rest.len());
        if name_len == 0 {
            // Un « = » isolé : on l'ignore pour ne pas tourner en rond
            rest = &rest[1..];
            continue;
        }
        let name = rest[..name_len].to_ascii_lowercase();
        rest = rest[name_len..].trim_start();
        let mut value = String::new();
        if let Some(after) = rest.strip_prefix('=') {
            let after = after.trim_start();
            let quote = after.chars().next().filter(|c| matches!(c, '"' | '\''));
            let (raw, following) = match quote {
                Some(quote) => {
                    let inner = &after[1..];
                    match inner.find(quote) {
                        Some(end) => (&inner[..end], &inner[end + 1..]),
                        None => (inner, ""),
                    }
                }
                None => {
                    let end = after
                        .find(|c: char| c.is_whitespace() || c == '>')
                        .unwrap_or(after.len());
                    (&after[..end], &after[end..])
                }
            };
            value = unescape(raw);
            rest = following;
        }
        attributes.push((name, value));
    }
}

/// Les entités HTML courantes, celles qu'on trouve dans une adresse ou un titre.
fn unescape(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let entity = rest[1..]
            .find(';')
            .filter(|end| *end <= 8)
            .map(|end| &rest[1..=end]);
        let decoded = entity.and_then(|entity| match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => {
                let code = entity.strip_prefix('#')?;
                let number = match code.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                    None => code.parse().ok()?,
                };
                char::from_u32(number)
            }
        });
        match (decoded, entity) {
            (Some(character), Some(entity)) => {
                out.push(character);
                rest = &rest[entity.len() + 2..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Plus grand côté annoncé par `sizes="32x32 48x48"` ; `None` pour « any » ou rien.
fn declared_size(sizes: Option<&str>) -> Option<u32> {
    sizes?
        .split_whitespace()
        .filter_map(|size| {
            let (width, height) = size
                .to_ascii_lowercase()
                .split_once('x')
                .map(|(w, h)| (w.parse::<u32>().ok(), h.parse::<u32>().ok()))?;
            Some(width?.max(height?))
        })
        .max()
}

/// Adresses des icônes à essayer, de la plus prometteuse à la moins bonne : celles que la page
/// annonce, puis les deux adresses habituelles d'un site.
fn candidates(head: Option<&Head>, location: &Url) -> Vec<Url> {
    // Une grande image vaut mieux, et à taille égale celle faite pour servir de tuile
    let mut ranked: Vec<(u32, Url)> = Vec::new();
    let mut add = |score: u32, url: Url| {
        if matches!(url.scheme(), "http" | "https")
            && !ranked.iter().any(|(_, known)| *known == url)
        {
            ranked.push((score, url));
        }
    };
    if let Some(head) = head {
        let base = head
            .base
            .as_deref()
            .and_then(|href| location.join(href).ok())
            .unwrap_or_else(|| location.clone());
        for link in &head.links {
            let rel = attribute(link, "rel")
                .unwrap_or_default()
                .to_ascii_lowercase();
            let rels: Vec<&str> = rel.split_whitespace().collect();
            // Une silhouette d'une seule couleur, pour les onglets épinglés
            if rels.contains(&"mask-icon") {
                continue;
            }
            let apple = rels.iter().any(|rel| rel.starts_with("apple-touch-icon"));
            let fluid = rels.contains(&"fluid-icon");
            if !apple && !fluid && !rels.contains(&"icon") {
                continue;
            }
            let Some(url) = attribute(link, "href").and_then(|href| base.join(href.trim()).ok())
            else {
                continue;
            };
            let path = url.path().to_ascii_lowercase();
            let kind = attribute(link, "type")
                .unwrap_or_default()
                .to_ascii_lowercase();
            let sizes = attribute(link, "sizes");
            let vector = kind.contains("svg")
                || path.ends_with(".svg")
                || sizes.is_some_and(|sizes| sizes.eq_ignore_ascii_case("any"));
            let size = declared_size(sizes);
            let (side, rank) = if apple {
                (size.unwrap_or(180), 3)
            } else if fluid {
                (256, 2)
            } else if vector {
                (160, 1)
            } else if let Some(size) = size {
                (size, 2)
            } else if path.ends_with(".ico") {
                (48, 0)
            } else {
                (64, 2)
            };
            add(side.min(256) * 10 + rank, url);
        }
    }
    if let Ok(url) = location.join("/apple-touch-icon.png") {
        add(1500, url);
    }
    if let Ok(url) = location.join("/favicon.ico") {
        add(160, url);
    }
    ranked.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    ranked
        .into_iter()
        .take(MAX_TRIES)
        .map(|(_, url)| url)
        .collect()
}

/// Lettres sans accents et en minuscules, pour comparer un titre au nom de domaine.
fn folded(text: &str) -> String {
    text.chars()
        .flat_map(char::to_lowercase)
        .filter_map(|character| match character {
            'à' | 'â' | 'ä' | 'á' | 'ã' | 'å' => Some('a'),
            'ç' => Some('c'),
            'é' | 'è' | 'ê' | 'ë' => Some('e'),
            'î' | 'ï' | 'í' | 'ì' => Some('i'),
            'ñ' => Some('n'),
            'ô' | 'ö' | 'ó' | 'ò' | 'õ' => Some('o'),
            'ù' | 'û' | 'ü' | 'ú' => Some('u'),
            other => other.is_alphanumeric().then_some(other),
        })
        .collect()
}

/// Seconds niveaux qui ne nomment pas un site : le « co » de `bbc.co.uk`.
const GENERIC_LABELS: [&str; 9] = [
    "co", "com", "org", "net", "gov", "gouv", "ac", "edu", "asso",
];

/// Mot du nom de domaine qui désigne le site : « wikipedia » pour `fr.wikipedia.org`.
fn host_label(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    let host = host.strip_prefix("www.").unwrap_or(host);
    // Une adresse IP n'a pas de mot à retenir
    if !matches!(url.host(), Some(url::Host::Domain(_))) {
        return host.to_owned();
    }
    let mut labels: Vec<&str> = host.split('.').collect();
    if labels.len() > 1 {
        labels.pop();
    }
    if labels.len() > 1
        && labels
            .last()
            .is_some_and(|label| GENERIC_LABELS.contains(label))
    {
        labels.pop();
    }
    labels.last().copied().unwrap_or(host).to_owned()
}

fn capitalized(word: &str) -> String {
    let mut letters = word.chars();
    match letters.next() {
        Some(first) => first.to_uppercase().chain(letters).collect(),
        None => String::new(),
    }
}

fn short(name: &str) -> String {
    name.trim().chars().take(MAX_NAME).collect()
}

/// Nom du site : celui qu'il se donne, sinon la partie de son titre qui ressemble à son nom
/// de domaine (« Wikipédia » dans « Wikipédia, l'encyclopédie libre »), sinon ce nom de
/// domaine. Un titre sans rapport (page d'attente, article) n'est pas repris.
fn site_name(head: Option<&Head>, url: &Url) -> String {
    let label = host_label(url);
    let Some(head) = head else {
        return capitalized(&label);
    };
    let wanted = folded(&label);
    for key in [
        "og:site_name",
        "application-name",
        "apple-mobile-web-app-title",
    ] {
        if let Some(name) = head.meta(key)
            && name.chars().count() <= MAX_NAME
        {
            return short(name);
        }
    }
    if let Some(title) = &head.title
        && !wanted.is_empty()
    {
        const SEPARATORS: [&str; 8] = [" - ", " – ", " — ", " | ", " · ", " • ", " : ", ", "];
        let mut parts = vec![title.as_str()];
        for separator in SEPARATORS {
            parts = parts
                .into_iter()
                .flat_map(|part| part.split(separator))
                .collect();
        }
        let matching = parts
            .into_iter()
            .map(str::trim)
            .filter(|part| part.chars().count() <= MAX_NAME && folded(part).contains(&wanted))
            .min_by_key(|part| part.chars().count());
        if let Some(part) = matching {
            return short(part);
        }
    }
    capitalized(&label)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    fn first_icons(html: &str, page: &str) -> Vec<String> {
        candidates(Some(&Head::read(html)), &url(page))
            .into_iter()
            .map(String::from)
            .collect()
    }

    #[test]
    fn la_plus_grande_icone_annoncee_passe_en_premier() {
        let html = r#"<html><head><title>YouTube</title>
<link rel="shortcut icon" href="https://www.youtube.com/s/desktop/a2c/img/favicon.ico" type="image/x-icon">
<link rel="icon" href="https://www.youtube.com/s/desktop/a2c/img/favicon_32x32.png" sizes="32x32">
<link rel="icon" href="https://www.youtube.com/s/desktop/a2c/img/favicon_144x144.png" sizes="144x144">
<link rel="manifest" href="/manifest.webmanifest">
</head><body><link rel="icon" href="/trop-tard.png" sizes="512x512">"#;
        let icons = first_icons(html, "https://www.youtube.com/");
        assert_eq!(
            icons[..2],
            [
                "https://www.youtube.com/apple-touch-icon.png",
                "https://www.youtube.com/s/desktop/a2c/img/favicon_144x144.png",
            ]
        );
        assert!(!icons.iter().any(|icon| icon.contains("trop-tard")));
        assert_eq!(icons.last().unwrap(), "https://www.youtube.com/favicon.ico");
    }

    #[test]
    fn l_icone_faite_pour_une_tuile_est_preferee() {
        let html = r##"<head>
<link rel="icon" href="/cdn/assets/favicon.svg" type="image/svg+xml"/>
<link rel="icon" href="/cdn/assets/favicon-48x48.png" type="image/png" sizes="48x48"/>
<link rel="apple-touch-icon" href="/cdn/assets/favicon-180x180.png" sizes="180x180"/>
<link rel="mask-icon" href="/silhouette.svg" color="#000">"##;
        let icons = first_icons(html, "https://chatgpt.com/");
        assert_eq!(
            icons[0],
            "https://chatgpt.com/cdn/assets/favicon-180x180.png"
        );
        assert_eq!(icons[1], "https://chatgpt.com/cdn/assets/favicon.svg");
        assert!(!icons.iter().any(|icon| icon.contains("silhouette")));
    }

    #[test]
    fn les_attributs_se_lisent_dans_n_importe_quel_ordre() {
        let html = "<head><LINK href=/assets/favicon.ico rel=icon><link href='/a?b=1&amp;c=2' REL=\"Shortcut Icon\">";
        let icons = first_icons(html, "https://discord.com/app");
        assert!(icons.contains(&"https://discord.com/assets/favicon.ico".to_owned()));
        assert!(icons.contains(&"https://discord.com/a?b=1&c=2".to_owned()));
    }

    #[test]
    fn sans_page_il_reste_les_adresses_habituelles() {
        let icons: Vec<String> = candidates(None, &url("https://claude.ai/new"))
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            icons,
            [
                "https://claude.ai/apple-touch-icon.png",
                "https://claude.ai/favicon.ico"
            ]
        );
    }

    #[test]
    fn la_base_de_la_page_et_les_liens_piege_sont_respectes() {
        let html = r#"<head><base href="https://cdn.exemple.fr/v2/">
<link rel="icon" href="logo.png" sizes="96x96">
<link rel="icon" href="javascript:alert(1)">
<link rel="icon" href="data:image/png;base64,AAAA">
<script>var x = '<link rel="icon" href="/dans-un-script.png" sizes="512x512">';</script>
<!-- <link rel="icon" href="/en-commentaire.png" sizes="512x512"> -->"#;
        let icons = first_icons(html, "https://exemple.fr/");
        assert_eq!(icons[1], "https://cdn.exemple.fr/v2/logo.png");
        assert_eq!(icons.len(), 3, "{icons:?}");
    }

    #[test]
    fn le_nom_vient_du_site_ou_de_son_titre() {
        let name = |html: &str, page: &str| site_name(Some(&Head::read(html)), &url(page));
        assert_eq!(
            name(
                r#"<head><meta property="og:site_name" content="GitHub" /><title>GitHub · Change is constant</title>"#,
                "https://github.com/"
            ),
            "GitHub"
        );
        assert_eq!(
            name(
                "<head><title>Wikipédia, l&#39;encyclopédie libre</title>",
                "https://fr.wikipedia.org/"
            ),
            "Wikipédia"
        );
        assert_eq!(
            name("<head><title>YouTube</title>", "https://www.youtube.com/"),
            "YouTube"
        );
        assert_eq!(
            name(
                "<head><title>Discord - Group Chat That's All Fun &amp; Games</title>",
                "https://discord.com/app"
            ),
            "Discord"
        );
        // Un titre sans rapport avec le site n'est pas repris
        assert_eq!(
            name(
                "<head><title>Just a moment...</title>",
                "https://claude.ai/"
            ),
            "Claude"
        );
    }

    #[test]
    fn sans_page_le_nom_vient_de_l_adresse() {
        assert_eq!(site_name(None, &url("https://claude.ai/")), "Claude");
        assert_eq!(site_name(None, &url("https://www.bbc.co.uk/news")), "Bbc");
        assert_eq!(
            site_name(None, &url("https://www.impots.gouv.fr/")),
            "Impots"
        );
        assert_eq!(
            site_name(None, &url("http://192.168.1.10:8080/")),
            "192.168.1.10"
        );
    }

    #[test]
    fn les_entites_d_un_titre_sont_decodees() {
        assert_eq!(
            unescape("l&#39;&eacute;t&#xe9; &amp; co"),
            "l'&eacute;té & co"
        );
        assert_eq!(unescape("a & b &"), "a & b &");
    }

    #[test]
    fn une_page_coupee_ou_mal_formee_ne_fait_rien_planter() {
        for html in [
            "<",
            "<link",
            "<link rel=",
            "<link rel=\"icon",
            "<title>Sans fin",
            "<head><link = = href=x rel=icon",
            "<!-- jamais fermé <link rel=icon href=/x.png>",
            "<script>jamais fermé",
        ] {
            let _ = Head::read(html);
        }
        assert_eq!(declared_size(Some("16x16 64X64 any")), Some(64));
        assert_eq!(declared_size(Some("any")), None);
    }

    #[test]
    fn chaque_adresse_a_son_fichier() {
        assert_eq!(
            fingerprint("https://youtube.com/"),
            fingerprint("https://youtube.com/")
        );
        assert_ne!(
            fingerprint("https://youtube.com/"),
            fingerprint("https://youtu.be/")
        );
        assert_eq!(fingerprint("").len(), 16);
    }

    /// À lancer à la main, avec le réseau : `cargo test -p rutile sites -- --ignored --nocapture`.
    #[test]
    #[ignore = "demande le réseau"]
    fn les_vrais_sites_donnent_leur_logo() {
        let out = std::env::var_os("RUTILE_SITES_OUT").map(PathBuf::from);
        for address in [
            "https://youtube.com/",
            "https://fr.wikipedia.org/",
            "https://claude.ai/",
            "https://chatgpt.com/",
            "https://discord.com/app",
            "https://github.com/",
        ] {
            let site = tauri::async_runtime::block_on(fetch(address)).unwrap();
            let tile = site
                .tile
                .unwrap_or_else(|| panic!("pas de logo pour {address}"));
            eprintln!("{address} → {} ({} octets)", site.name, tile.len());
            if let Some(dir) = &out {
                std::fs::write(dir.join(format!("{}.png", site.name)), &tile).unwrap();
            }
        }
    }
}
