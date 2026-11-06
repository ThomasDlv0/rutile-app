//! Actions de la roue sur de vrais fichiers, dans un dossier temporaire.

mod common;

use std::fs;
use std::io::Read;
use std::path::PathBuf;

use converter::files::{self, RenameStyle};
use converter::retouch::{self, Retouch};
use converter::{OutputFormat, Quality};
use lopdf::Document;
use tempfile::tempdir;

fn image_file(dir: &std::path::Path, name: &str, width: u32, height: u32) -> PathBuf {
    let path = dir.join(name);
    let image = image::RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x * y) % 239) as u8])
    });
    image.save(&path).unwrap();
    path
}

#[test]
fn un_zip_contient_les_fichiers_et_les_dossiers() {
    let dir = tempdir().unwrap();
    let folder = dir.path().join("Vacances");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("note.txt"), "bonjour").unwrap();
    fs::write(folder.join(".DS_Store"), "x").unwrap();
    let single = dir.path().join("seul.txt");
    fs::write(&single, "un").unwrap();

    let zip_path = files::zip_files(&[folder, single]).unwrap();
    assert_eq!(zip_path.file_name().unwrap(), "Archive.zip");

    let mut archive = zip::ZipArchive::new(fs::File::open(&zip_path).unwrap()).unwrap();
    let mut text = String::new();
    archive
        .by_name("Vacances/note.txt")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, "bonjour");
    assert!(archive.by_name("seul.txt").is_ok());
    assert!(archive.by_name("Vacances/.DS_Store").is_err());
}

#[test]
fn un_seul_fichier_donne_son_nom_a_l_archive() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("rapport.final.txt");
    fs::write(&file, "x").unwrap();
    let first = files::zip_files(std::slice::from_ref(&file)).unwrap();
    assert_eq!(first.file_name().unwrap(), "rapport.final.zip");
    let second = files::zip_files(&[file]).unwrap();
    assert_eq!(second.file_name().unwrap(), "rapport.final-1.zip");
}

#[test]
fn des_images_font_un_pdf_d_une_page_par_image_dans_l_ordre() {
    let dir = tempdir().unwrap();
    let second = image_file(dir.path(), "photo 10.png", 300, 150);
    let first = image_file(dir.path(), "photo 2.jpg", 150, 300);
    let pdf = files::images_to_pdf(&[second, first]).unwrap();
    assert_eq!(pdf.file_name().unwrap(), "Images.pdf");

    let document = Document::load(&pdf).unwrap();
    let pages = document.get_pages();
    assert_eq!(pages.len(), 2);
    let width = |number: u32| {
        let page = document
            .get_object(pages[&number])
            .unwrap()
            .as_dict()
            .unwrap();
        page.get(b"MediaBox").unwrap().as_array().unwrap()[2]
            .as_float()
            .unwrap()
    };
    // « photo 2 » (150 px à 150 dpi : 72 pt) avant « photo 10 » (144 pt)
    assert!((width(1) - 72.0).abs() < 0.01);
    assert!((width(2) - 144.0).abs() < 0.01);
}

#[test]
fn deux_pdf_fusionnes_gardent_toutes_leurs_pages() {
    let dir = tempdir().unwrap();
    let a = image_file(dir.path(), "a.png", 150, 150);
    let b = image_file(dir.path(), "b.png", 300, 150);
    let c = image_file(dir.path(), "c.png", 150, 300);
    let first = files::images_to_pdf(&[a, b]).unwrap();
    let renamed = dir.path().join("premier.pdf");
    fs::rename(&first, &renamed).unwrap();
    let second = files::images_to_pdf(&[c]).unwrap();

    let merged = files::merge_pdfs(&[renamed, second]).unwrap();
    assert_eq!(merged.file_name().unwrap(), "PDF fusionnés.pdf");
    let document = Document::load(&merged).unwrap();
    assert_eq!(document.get_pages().len(), 3);
    for id in document.get_pages().values() {
        let page = document.get_object(*id).unwrap().as_dict().unwrap();
        assert!(page.has(b"MediaBox") && page.has(b"Resources") && page.has(b"Contents"));
    }
}

#[test]
fn un_faux_pdf_est_refuse_sans_laisser_de_fichier() {
    let dir = tempdir().unwrap();
    let fake = dir.path().join("faux.pdf");
    fs::write(&fake, "ceci n'est pas un PDF").unwrap();
    assert!(files::merge_pdfs(&[fake]).is_err());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn renommer_numerote_dans_l_ordre_sans_rien_ecraser() {
    let dir = tempdir().unwrap();
    let names = ["b 10.txt", "b 2.txt"];
    let paths: Vec<PathBuf> = names.iter().map(|name| dir.path().join(name)).collect();
    for path in &paths {
        fs::write(path, path.to_string_lossy().as_bytes()).unwrap();
    }
    fs::write(dir.path().join("01 b 2.txt"), "déjà là").unwrap();

    let renamed = files::rename_files(&paths, RenameStyle::Number).unwrap();
    let names: Vec<_> = renamed
        .iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["01 b 2-1.txt", "02 b 10.txt"]);
    assert_eq!(
        fs::read_to_string(dir.path().join("01 b 2.txt")).unwrap(),
        "déjà là"
    );
}

#[test]
fn renommer_en_minuscules_marche_aussi_sur_un_disque_insensible_a_la_casse() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("PHOTO.JPG");
    fs::write(&path, "x").unwrap();
    let renamed = files::rename_files(&[path], RenameStyle::Lowercase).unwrap();
    assert_eq!(renamed[0].file_name().unwrap(), "photo.jpg");
    assert_eq!(fs::read_to_string(&renamed[0]).unwrap(), "x");
    let entries: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(entries, ["photo.jpg"]);
}

#[test]
fn nettoyer_retire_accents_et_espaces() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("Été à Noël.png");
    fs::write(&path, "x").unwrap();
    let renamed = files::rename_files(&[path], RenameStyle::Clean).unwrap();
    assert_eq!(renamed[0].file_name().unwrap(), "Ete-a-Noel.png");
}

#[test]
fn renommer_a_la_date_prefixe_le_nom() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("note.txt");
    fs::write(&path, "x").unwrap();
    let renamed = files::rename_files(&[path], RenameStyle::Date).unwrap();
    let name = renamed[0].file_name().unwrap().to_string_lossy();
    assert!(name.ends_with(" note.txt"));
    assert_eq!(name.split(' ').next().unwrap().len(), "2026-11-06".len());
}

#[test]
fn reduire_de_moitie_garde_le_format_et_l_original() {
    let dir = tempdir().unwrap();
    let path = image_file(dir.path(), "photo.jpg", 200, 100);
    let output = retouch::retouch(&path, Retouch::Half, &Quality::default()).unwrap();
    assert_eq!(output.file_name().unwrap(), "photo-reduite.jpg");
    assert_eq!(image::image_dimensions(&output).unwrap(), (100, 50));
    assert_eq!(image::image_dimensions(&path).unwrap(), (200, 100));
}

#[test]
fn le_grand_format_refuse_une_image_deja_petite() {
    let dir = tempdir().unwrap();
    let small = image_file(dir.path(), "petite.png", 200, 100);
    assert!(retouch::retouch(&small, Retouch::FullHd, &Quality::default()).is_err());
    let large = image_file(dir.path(), "grande.png", 2400, 1200);
    let output = retouch::retouch(&large, Retouch::FullHd, &Quality::default()).unwrap();
    assert_eq!(image::image_dimensions(&output).unwrap(), (1920, 960));
}

#[test]
fn compresser_reduit_le_poids_d_un_jpeg() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("photo.jpg");
    let image = image::RgbImage::from_fn(400, 300, |x, y| {
        image::Rgb([
            (x * 7 % 256) as u8,
            (y * 11 % 256) as u8,
            ((x ^ y) % 256) as u8,
        ])
    });
    let mut bytes = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 98);
    image.write_with_encoder(encoder).unwrap();
    fs::write(&path, &bytes).unwrap();

    let output = retouch::retouch(&path, Retouch::Compress, &Quality::default()).unwrap();
    assert!(fs::metadata(&output).unwrap().len() < bytes.len() as u64);
}

#[test]
fn un_svg_ne_se_retouche_pas() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("logo.svg");
    fs::write(&path, common::SVG_SOURCE).unwrap();
    assert!(matches!(
        retouch::retouch(&path, Retouch::Half, &Quality::default()),
        Err(converter::ConvertError::NotRaster)
    ));
}

#[test]
fn retirer_les_metadonnees_nomme_le_fichier_produit() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("logo.png");
    converter::convert(
        &image_file(dir.path(), "source.jpg", 8, 8),
        OutputFormat::Png,
        &Quality::default(),
    )
    .unwrap();
    fs::rename(dir.path().join("source.png"), &path).unwrap();
    let output = retouch::retouch(&path, Retouch::StripMetadata, &Quality::default()).unwrap();
    assert_eq!(output.file_name().unwrap(), "logo-sans-metadonnees.png");
    assert_eq!(fs::read(&output).unwrap(), fs::read(&path).unwrap());
}
