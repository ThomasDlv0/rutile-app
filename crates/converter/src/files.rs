//! Actions sur des fichiers : archive ZIP, PDF, renommage en lot. Comme pour les conversions,
//! rien n'est écrasé : un nom déjà pris reçoit `-1`, `-2`…

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Cursor, Read};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};
use image::{ColorType, ImageDecoder, ImageReader, metadata::Orientation};
use lopdf::{Document, Object, ObjectId, Stream, dictionary};
use serde::{Deserialize, Serialize};
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::{CompressionMethod, ZipArchive};

use crate::encode::flatten_on_white;
use crate::{ConvertError, InputFormat, decode, output};

/// Résolution des pages d'un PDF fait d'images, en points par pixel.
const PDF_POINTS_PER_PIXEL: f32 = 72.0 / 150.0;
/// Fichiers que macOS laisse dans les dossiers, sans intérêt dans une archive.
const IGNORED_IN_ARCHIVE: [&str; 2] = [".DS_Store", "Thumbs.db"];
/// Dossier de métadonnées que macOS ajoute à ses archives.
const MACOS_ARCHIVE_EXTRAS: &str = "__MACOSX";
/// Au-delà, une archive est sans doute piégée (bombe de décompression).
const MAX_EXTRACTED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
/// Ligatures des PDF, rendues lettre par lettre pour que le texte copié se cherche.
const LIGATURES: [(char, &str); 7] = [
    ('ﬀ', "ff"),
    ('ﬁ', "fi"),
    ('ﬂ', "fl"),
    ('ﬃ', "ffi"),
    ('ﬄ', "ffl"),
    ('ﬅ', "st"),
    ('ﬆ', "st"),
];

/// Compare deux noms comme un humain : « photo 2 » avant « photo 10 », sans tenir compte de
/// la casse.
fn natural_order(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let read = |chars: &mut std::iter::Peekable<std::str::Chars<'_>>| {
                    let mut value = 0u64;
                    while let Some(digit) = chars.peek().and_then(|c| c.to_digit(10)) {
                        value = value.saturating_mul(10).saturating_add(u64::from(digit));
                        chars.next();
                    }
                    value
                };
                match read(&mut a).cmp(&read(&mut b)) {
                    Ordering::Equal => {}
                    other => return other,
                }
            }
            (Some(x), Some(y)) => {
                match x.to_lowercase().cmp(y.to_lowercase()) {
                    Ordering::Equal => {}
                    other => return other,
                }
                a.next();
                b.next();
            }
        }
    }
}

/// Fichiers dans l'ordre de leurs noms : celui de la sélection dépend du Finder.
fn sorted(paths: &[PathBuf]) -> Vec<PathBuf> {
    let name = |path: &PathBuf| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let mut sorted = paths.to_vec();
    sorted.sort_by(|a, b| natural_order(&name(a), &name(b)));
    sorted
}

fn read(path: &Path) -> Result<Vec<u8>, ConvertError> {
    fs::read(path).map_err(|source| ConvertError::Read {
        path: path.to_path_buf(),
        source,
    })
}

/// Nom du fichier produit à partir de plusieurs entrées : celui de l'entrée s'il n'y en a
/// qu'une, sinon `fallback`.
fn combined_name(paths: &[PathBuf], fallback: &str) -> Result<PathBuf, ConvertError> {
    let first = paths.first().ok_or(ConvertError::NoFiles)?;
    Ok(if paths.len() == 1 {
        output::sibling(first, &output::suffixed(first, ""))
    } else {
        output::sibling(first, fallback)
    })
}

/// Rassemble fichiers et dossiers dans un ZIP, à côté du premier.
pub fn zip_files(paths: &[PathBuf]) -> Result<PathBuf, ConvertError> {
    let (output, file) = output::reserve(&combined_name(paths, "Archive")?, "zip")?;
    let result = write_zip(paths, file);
    if result.is_err() {
        let _ = fs::remove_file(&output);
    }
    result.map(|()| output)
}

fn write_zip(paths: &[PathBuf], file: File) -> Result<(), ConvertError> {
    let mut archive = ZipWriter::new(BufWriter::new(file));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for path in paths {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "fichier".into());
        add_to_zip(&mut archive, path, &name, options)?;
    }
    archive
        .finish()
        .map_err(|err| ConvertError::Archive(err.to_string()))?;
    Ok(())
}

fn add_to_zip<W: io::Write + io::Seek>(
    archive: &mut ZipWriter<W>,
    path: &Path,
    name: &str,
    options: SimpleFileOptions,
) -> Result<(), ConvertError> {
    let read_error = |source| ConvertError::Read {
        path: path.to_path_buf(),
        source,
    };
    let archive_error = |err: zip::result::ZipError| ConvertError::Archive(err.to_string());
    // Sans suivre les liens : un lien vers un dossier parent n'aurait pas de fin
    let metadata = fs::symlink_metadata(path).map_err(read_error)?;
    if metadata.is_dir() {
        archive
            .add_directory(format!("{name}/"), options)
            .map_err(archive_error)?;
        let children = fs::read_dir(path)
            .map_err(read_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(read_error)?;
        for child in sorted(
            &children
                .iter()
                .map(|entry| entry.path())
                .collect::<Vec<_>>(),
        ) {
            let child_name = child
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !IGNORED_IN_ARCHIVE.contains(&child_name.as_str()) {
                add_to_zip(archive, &child, &format!("{name}/{child_name}"), options)?;
            }
        }
    } else if metadata.is_file() {
        archive.start_file(name, options).map_err(archive_error)?;
        let mut file = File::open(path).map_err(read_error)?;
        io::copy(&mut file, archive).map_err(read_error)?;
    }
    Ok(())
}

/// Entrée d'une archive à décompresser.
struct Entry {
    index: usize,
    path: PathBuf,
    is_dir: bool,
    mode: Option<u32>,
}

/// Décompresse un ZIP à côté de lui, dans un dossier à son nom. Une archive qui ne contient
/// qu'un dossier le redonne tel quel, comme l'Utilitaire d'archive.
pub fn extract_zip(path: &Path) -> Result<PathBuf, ConvertError> {
    let read_error = |source| ConvertError::Read {
        path: path.to_path_buf(),
        source,
    };
    let bad = |err: zip::result::ZipError| ConvertError::BadArchive(err.to_string());
    let file = File::open(path).map_err(read_error)?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(bad)?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(ConvertError::ArchiveTooLarge);
    }

    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(bad)?;
        // Un nom en `../` ou absolu sortirait du dossier, un lien pourrait y mener : écartés
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let extra = name
            .components()
            .next()
            .is_some_and(|first| first.as_os_str() == MACOS_ARCHIVE_EXTRAS)
            || name
                .file_name()
                .is_some_and(|file| IGNORED_IN_ARCHIVE.iter().any(|ignored| file == *ignored));
        if extra || entry.is_symlink() || name.as_os_str().is_empty() {
            continue;
        }
        if entry.encrypted() {
            return Err(ConvertError::ProtectedArchive);
        }
        entries.push(Entry {
            index,
            path: name,
            is_dir: entry.is_dir(),
            mode: entry.unix_mode(),
        });
    }
    if entries.iter().all(|entry| entry.is_dir) {
        return Err(ConvertError::EmptyArchive);
    }

    // Un seul dossier à la racine : il prend sa place à côté de l'archive
    let first = |entry: &Entry| {
        entry
            .path
            .components()
            .next()
            .map(|c| c.as_os_str().to_owned())
    };
    let root = first(&entries[0]);
    let single_folder = root.is_some()
        && entries.iter().all(|entry| first(entry) == root)
        && entries
            .iter()
            .any(|entry| entry.is_dir || entry.path.components().count() > 1);
    let (target, strip) = match (single_folder, root) {
        (true, Some(root)) => (path.with_file_name(&root), Some(PathBuf::from(root))),
        _ => (path.with_file_name(output::suffixed(path, "")), None),
    };
    let output = output::reserve_dir(&target)?;
    let result = write_entries(&mut archive, &entries, strip.as_deref(), &output);
    if result.is_err() {
        // Le dossier vient d'être créé : il ne contient que ce que l'on y a écrit
        let _ = fs::remove_dir_all(&output);
    }
    result.map(|()| output)
}

fn write_entries<R: Read + io::Seek>(
    archive: &mut ZipArchive<R>,
    entries: &[Entry],
    strip: Option<&Path>,
    output: &Path,
) -> Result<(), ConvertError> {
    let write_error = |source| ConvertError::Write {
        dir: output.to_path_buf(),
        source,
    };
    let mut written = 0u64;
    for entry in entries {
        let relative = match strip {
            Some(root) => entry.path.strip_prefix(root).unwrap_or(&entry.path),
            None => &entry.path,
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = output.join(relative);
        if entry.is_dir {
            fs::create_dir_all(&target).map_err(write_error)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(write_error)?;
        }
        // Un nom en double dans l'archive : le premier reste
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(write_error(err)),
        };
        let mut content = archive
            .by_index(entry.index)
            .map_err(|err| ConvertError::BadArchive(err.to_string()))?;
        let room = MAX_EXTRACTED_BYTES - written;
        written += io::copy(&mut (&mut content).take(room + 1), &mut file).map_err(write_error)?;
        if written > MAX_EXTRACTED_BYTES {
            return Err(ConvertError::ArchiveTooLarge);
        }
        // Un programme reste exécutable, sans droits d'écriture pour les autres
        #[cfg(unix)]
        if let Some(mode) = entry.mode {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o755));
        }
        #[cfg(not(unix))]
        let _ = entry.mode;
    }
    Ok(())
}

/// Écrit un PDF sous un nom réservé.
fn save_pdf(document: &mut Document, target: &Path) -> Result<PathBuf, ConvertError> {
    let (output, file) = output::reserve(target, "pdf")?;
    let mut writer = BufWriter::new(file);
    if let Err(err) = document.save_to(&mut writer) {
        drop(writer);
        let _ = fs::remove_file(&output);
        return Err(ConvertError::Pdf(err.to_string()));
    }
    Ok(output)
}

/// Image prête pour un PDF, avec sa taille. Un JPEG ordinaire est repris tel quel, sans perte ;
/// le reste est écrit en pixels compressés, la transparence sur fond blanc.
fn pdf_image(bytes: &[u8], format: InputFormat) -> Result<(Stream, u32, u32), ConvertError> {
    if format == InputFormat::Jpeg {
        let reader = ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Jpeg);
        let mut decoder = reader.into_decoder().map_err(ConvertError::decode)?;
        let upright =
            decoder.orientation().unwrap_or(Orientation::NoTransforms) == Orientation::NoTransforms;
        let space = match decoder.color_type() {
            ColorType::Rgb8 => Some("DeviceRGB"),
            ColorType::L8 => Some("DeviceGray"),
            _ => None,
        };
        if let (true, Some(space)) = (upright, space) {
            let (width, height) = decoder.dimensions();
            let mut stream = Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Image",
                    "Width" => width as i64,
                    "Height" => height as i64,
                    "ColorSpace" => space,
                    "BitsPerComponent" => 8,
                    "Filter" => "DCTDecode",
                },
                bytes.to_vec(),
            );
            stream.allows_compression = false;
            return Ok((stream, width, height));
        }
    }
    let image = flatten_on_white(&decode::decode(bytes, format)?).to_rgb8();
    let (width, height) = image.dimensions();
    let stream = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => width as i64,
            "Height" => height as i64,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        },
        image.into_raw(),
    );
    Ok((stream, width, height))
}

/// Assemble des images en un PDF d'une page par image, dans l'ordre de leurs noms.
pub fn images_to_pdf(paths: &[PathBuf]) -> Result<PathBuf, ConvertError> {
    let target = combined_name(paths, "Images")?;
    let mut document = Document::with_version("1.5");
    let pages_id = document.new_object_id();
    let mut kids = Vec::new();
    for path in sorted(paths) {
        let bytes = read(&path)?;
        let format = InputFormat::detect(&bytes, &path).ok_or(ConvertError::UnsupportedFormat)?;
        let (stream, width, height) = pdf_image(&bytes, format)?;
        let image_id = document.add_object(stream);
        let (page_width, page_height) = (
            width as f32 * PDF_POINTS_PER_PIXEL,
            height as f32 * PDF_POINTS_PER_PIXEL,
        );
        let drawing = format!("q {page_width} 0 0 {page_height} 0 0 cm /Image Do Q");
        let contents_id = document.add_object(Stream::new(dictionary! {}, drawing.into_bytes()));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), page_width.into(), page_height.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Image" => image_id } },
            "Contents" => contents_id,
        });
        kids.push(Object::Reference(page_id));
    }
    finish_pdf(&mut document, pages_id, kids);
    save_pdf(&mut document, &target)
}

/// Pose l'arbre des pages et le catalogue d'un PDF neuf.
fn finish_pdf(document: &mut Document, pages_id: ObjectId, kids: Vec<Object>) {
    let count = kids.len() as i64;
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => count,
        }),
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document.compress();
}

/// Attributs qu'une page hérite de son parent et qu'elle perdrait en changeant d'arbre.
const INHERITED: [&[u8]; 4] = [b"MediaBox", b"CropBox", b"Resources", b"Rotate"];

fn page_with_inherited(document: &Document, id: ObjectId) -> Option<lopdf::Dictionary> {
    let mut page = document.get_object(id).ok()?.as_dict().ok()?.clone();
    let mut parent = page.get(b"Parent").and_then(Object::as_reference).ok();
    // Borné : un PDF malformé peut faire boucler ses parents
    for _ in 0..64 {
        let Some(id) = parent else { break };
        let Some(node) = document.get_object(id).ok().and_then(|o| o.as_dict().ok()) else {
            break;
        };
        for key in INHERITED {
            if !page.has(key)
                && let Ok(value) = node.get(key)
            {
                page.set(key.to_vec(), value.clone());
            }
        }
        parent = node.get(b"Parent").and_then(Object::as_reference).ok();
    }
    Some(page)
}

/// Texte des PDF, dans l'ordre de leurs noms ; vide pour un PDF fait d'images (scanné).
pub fn pdf_text(paths: &[PathBuf]) -> Result<String, ConvertError> {
    let mut texts = Vec::new();
    for path in sorted(paths) {
        let document =
            Document::load_mem(&read(&path)?).map_err(|err| ConvertError::Pdf(err.to_string()))?;
        if document.is_encrypted() {
            return Err(ConvertError::ProtectedPdf);
        }
        let pages: Vec<u32> = document.get_pages().into_keys().collect();
        let text = document
            .extract_text(&pages)
            .map_err(|err| ConvertError::Pdf(err.to_string()))?;
        texts.push(tidy_text(&text));
    }
    Ok(texts
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n"))
}

/// Lignes sans espaces au bout, ligatures défaites, au plus une ligne vide d'affilée.
fn tidy_text(text: &str) -> String {
    let mut tidy = String::new();
    let mut blank = 0;
    for line in text.lines() {
        let mut line = line.trim_end().to_string();
        for (ligature, letters) in LIGATURES {
            line = line.replace(ligature, letters);
        }
        blank = if line.is_empty() { blank + 1 } else { 0 };
        if blank < 2 {
            tidy.push_str(&line);
            tidy.push('\n');
        }
    }
    tidy.trim().to_string()
}

/// Fusionne des PDF dans l'ordre de leurs noms, à côté du premier.
pub fn merge_pdfs(paths: &[PathBuf]) -> Result<PathBuf, ConvertError> {
    let target = combined_name(paths, "PDF fusionnés")?;
    let mut merged = Document::with_version("1.5");
    let mut objects = BTreeMap::new();
    let mut pages: Vec<(ObjectId, lopdf::Dictionary)> = Vec::new();
    let mut next_id = 1;
    for path in sorted(paths) {
        let mut document =
            Document::load_mem(&read(&path)?).map_err(|err| ConvertError::Pdf(err.to_string()))?;
        if document.is_encrypted() {
            return Err(ConvertError::ProtectedPdf);
        }
        document.renumber_objects_with(next_id);
        next_id = document.max_id + 1;
        for id in document.get_pages().into_values() {
            if let Some(page) = page_with_inherited(&document, id) {
                pages.push((id, page));
            }
        }
        objects.append(&mut document.objects);
    }
    if pages.is_empty() {
        return Err(ConvertError::Pdf("aucune page".into()));
    }

    // Tout sauf l'ancienne structure : pages, arbres de pages, catalogues et signets
    let dropped = |object: &Object| {
        object
            .as_dict()
            .ok()
            .and_then(|dict| dict.get(b"Type").ok())
            .and_then(|kind| kind.as_name().ok())
            .is_some_and(|kind| {
                [&b"Page"[..], b"Pages", b"Catalog", b"Outlines", b"Outline"].contains(&kind)
            })
    };
    merged.objects = objects
        .into_iter()
        .filter(|(_, object)| !dropped(object))
        .collect();
    merged.max_id = next_id;
    let pages_id = merged.new_object_id();
    let mut kids = Vec::with_capacity(pages.len());
    for (id, mut page) in pages {
        page.set("Parent", pages_id);
        merged.objects.insert(id, Object::Dictionary(page));
        kids.push(Object::Reference(id));
    }
    finish_pdf(&mut merged, pages_id, kids);
    save_pdf(&mut merged, &target)
}

/// Façons de renommer des fichiers en lot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenameStyle {
    /// « 01 photo.jpg », dans l'ordre des noms.
    Number,
    /// « 2026-11-06 photo.jpg », à la date de dernière modification.
    Date,
    /// « photo de vacances.jpg ».
    Lowercase,
    /// « Photo-de-vacances.jpg » : sans accents ni espaces.
    Clean,
}

/// Retire les accents, et remplace ce qui passe mal dans une adresse par des tirets.
fn clean_stem(stem: &str) -> String {
    let mut clean = String::with_capacity(stem.len());
    for c in stem.chars() {
        match c {
            'à' | 'â' | 'ä' | 'á' | 'ã' | 'å' => clean.push('a'),
            'À' | 'Â' | 'Ä' | 'Á' | 'Ã' | 'Å' => clean.push('A'),
            'é' | 'è' | 'ê' | 'ë' => clean.push('e'),
            'É' | 'È' | 'Ê' | 'Ë' => clean.push('E'),
            'î' | 'ï' | 'í' | 'ì' => clean.push('i'),
            'Î' | 'Ï' | 'Í' | 'Ì' => clean.push('I'),
            'ô' | 'ö' | 'ó' | 'ò' | 'õ' => clean.push('o'),
            'Ô' | 'Ö' | 'Ó' | 'Ò' | 'Õ' => clean.push('O'),
            'ù' | 'û' | 'ü' | 'ú' => clean.push('u'),
            'Ù' | 'Û' | 'Ü' | 'Ú' => clean.push('U'),
            'ç' => clean.push('c'),
            'Ç' => clean.push('C'),
            'ñ' => clean.push('n'),
            'Ñ' => clean.push('N'),
            'ÿ' => clean.push('y'),
            'œ' => clean.push_str("oe"),
            'Œ' => clean.push_str("OE"),
            'æ' => clean.push_str("ae"),
            'Æ' => clean.push_str("AE"),
            c if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') => clean.push(c),
            _ => {
                if !clean.ends_with('-') {
                    clean.push('-');
                }
            }
        }
    }
    let trimmed = clean.trim_matches('-');
    if trimmed.is_empty() {
        "fichier".into()
    } else {
        trimmed.into()
    }
}

/// Nouveau nom d'un fichier, sans chercher s'il est libre.
fn renamed(path: &Path, style: RenameStyle, index: usize, digits: usize) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    Some(match style {
        RenameStyle::Number => format!("{:0digits$} {name}", index + 1),
        RenameStyle::Date => {
            let modified = fs::metadata(path).and_then(|meta| meta.modified()).ok()?;
            let date: DateTime<Local> = modified.into();
            format!("{} {name}", date.format("%Y-%m-%d"))
        }
        RenameStyle::Lowercase => name.to_lowercase(),
        RenameStyle::Clean => {
            let stem = path.file_stem()?.to_string_lossy();
            match path.extension() {
                Some(extension) => {
                    format!("{}.{}", clean_stem(&stem), extension.to_string_lossy())
                }
                None => clean_stem(&stem),
            }
        }
    })
}

/// Premier nom libre, en ajoutant `-1`, `-2`… avant l'extension.
fn free_name(dir: &Path, name: &str, taken: &HashSet<PathBuf>) -> PathBuf {
    let wanted = dir.join(name);
    let free = |path: &Path| !path.exists() && !taken.contains(path);
    if free(&wanted) {
        return wanted;
    }
    let stem = Path::new(name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.into());
    let extension = Path::new(name).extension();
    (1..)
        .map(|attempt| {
            let mut candidate = format!("{stem}-{attempt}");
            if let Some(extension) = extension {
                candidate.push('.');
                candidate.push_str(&extension.to_string_lossy());
            }
            dir.join(candidate)
        })
        .find(|path| free(path))
        .expect("une suite infinie de noms contient un nom libre")
}

/// Renomme les fichiers sur place et renvoie leurs nouveaux chemins.
pub fn rename_files(paths: &[PathBuf], style: RenameStyle) -> Result<Vec<PathBuf>, ConvertError> {
    if paths.is_empty() {
        return Err(ConvertError::NoFiles);
    }
    let digits = paths.len().to_string().len().max(2);
    let mut taken = HashSet::new();
    let mut renamed_paths = Vec::with_capacity(paths.len());
    for (index, path) in sorted(paths).iter().enumerate() {
        let dir = path.parent().unwrap_or(Path::new("."));
        let name = renamed(path, style, index, digits).ok_or_else(|| ConvertError::Read {
            path: path.clone(),
            source: io::Error::from(io::ErrorKind::NotFound),
        })?;
        if path.file_name().is_some_and(|current| *current == *name) {
            renamed_paths.push(path.clone());
            continue;
        }
        let write_error = |source| ConvertError::Write {
            dir: dir.to_path_buf(),
            source,
        };
        // Sur un disque insensible à la casse, « Photo » et « photo » sont le même fichier :
        // le nom paraît pris alors qu'il s'agit de lui-même
        let case_only = path
            .file_name()
            .is_some_and(|current| current.to_string_lossy().to_lowercase() == name.to_lowercase());
        let target = if case_only && same_file(path, &dir.join(&name)) {
            let target = dir.join(&name);
            let step = free_name(dir, &format!("{name}.rutile"), &taken);
            fs::rename(path, &step).map_err(write_error)?;
            fs::rename(&step, &target).map_err(write_error)?;
            target
        } else {
            let target = free_name(dir, &name, &taken);
            fs::rename(path, &target).map_err(write_error)?;
            target
        };
        taken.insert(target.clone());
        renamed_paths.push(target);
    }
    Ok(renamed_paths)
}

/// Les deux chemins mènent-ils au même fichier ?
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn les_nombres_se_classent_par_valeur() {
        let mut names = vec!["photo 10", "Photo 2", "photo 1"];
        names.sort_by(|a, b| natural_order(a, b));
        assert_eq!(names, ["photo 1", "Photo 2", "photo 10"]);
    }

    #[test]
    fn un_nom_nettoye_garde_lettres_et_chiffres() {
        assert_eq!(clean_stem("Été à Noël (2026)"), "Ete-a-Noel-2026");
        assert_eq!(clean_stem("œuvre  n°1"), "oeuvre-n-1");
        assert_eq!(clean_stem("???"), "fichier");
    }

    #[test]
    fn le_texte_d_un_pdf_se_copie_sans_ligatures_ni_vides() {
        let text = "Merci de votre conﬁance.   \n\n\n\nAﬄuence  \n";
        assert_eq!(tidy_text(text), "Merci de votre confiance.\n\nAffluence");
    }
}
