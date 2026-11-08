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

/// ZIP écrit à la main, `../` compris : le crate `zip` ne vérifie pas les noms à l'écriture.
fn zip_with(path: &std::path::Path, entries: &[(&str, &str)]) {
    use std::io::Write;
    let mut archive = zip::ZipWriter::new(fs::File::create(path).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    for (name, content) in entries {
        if name.ends_with('/') {
            archive.add_directory(*name, options).unwrap();
        } else {
            archive.start_file(*name, options).unwrap();
            archive.write_all(content.as_bytes()).unwrap();
        }
    }
    archive.finish().unwrap();
}

#[test]
fn un_zip_se_decompresse_dans_un_dossier_a_son_nom() {
    let dir = tempdir().unwrap();
    let archive = dir.path().join("Photos.zip");
    zip_with(
        &archive,
        &[
            ("a.txt", "un"),
            ("sous/b.txt", "deux"),
            ("__MACOSX/._a.txt", "x"),
            ("sous/.DS_Store", "x"),
        ],
    );
    let output = files::extract_zip(&archive).unwrap();
    assert_eq!(output, dir.path().join("Photos"));
    assert_eq!(fs::read_to_string(output.join("a.txt")).unwrap(), "un");
    assert_eq!(
        fs::read_to_string(output.join("sous/b.txt")).unwrap(),
        "deux"
    );
    assert!(!output.join("__MACOSX").exists());
    assert!(!output.join("sous/.DS_Store").exists());

    // Le nom est pris : rien n'est écrasé
    let again = files::extract_zip(&archive).unwrap();
    assert_eq!(again, dir.path().join("Photos-1"));
}

#[test]
fn un_zip_d_un_seul_dossier_redonne_ce_dossier() {
    let dir = tempdir().unwrap();
    let archive = dir.path().join("envoi.zip");
    zip_with(&archive, &[("Rapport/", ""), ("Rapport/page.txt", "texte")]);
    let output = files::extract_zip(&archive).unwrap();
    assert_eq!(output, dir.path().join("Rapport"));
    assert_eq!(
        fs::read_to_string(output.join("page.txt")).unwrap(),
        "texte"
    );
}

#[test]
fn un_nom_piege_ne_sort_pas_du_dossier() {
    let dir = tempdir().unwrap();
    let inside = dir.path().join("dedans");
    fs::create_dir(&inside).unwrap();
    let archive = inside.join("piege.zip");
    zip_with(
        &archive,
        &[
            ("../evade.txt", "non"),
            ("/abs.txt", "non"),
            ("ok.txt", "oui"),
        ],
    );
    let output = files::extract_zip(&archive).unwrap();
    assert!(!dir.path().join("evade.txt").exists());
    assert_eq!(fs::read_to_string(output.join("ok.txt")).unwrap(), "oui");
    assert_eq!(fs::read_dir(&output).unwrap().count(), 1);
}

#[test]
fn une_archive_vide_ou_illisible_est_refusee() {
    let dir = tempdir().unwrap();
    let empty = dir.path().join("vide.zip");
    zip_with(&empty, &[("dossier/", "")]);
    assert!(matches!(
        files::extract_zip(&empty),
        Err(converter::ConvertError::EmptyArchive)
    ));
    assert!(!dir.path().join("dossier").exists());
    let fake = dir.path().join("faux.zip");
    fs::write(&fake, "pas une archive").unwrap();
    assert!(matches!(
        files::extract_zip(&fake),
        Err(converter::ConvertError::BadArchive(_))
    ));
}

/// PDF d'une page avec une ligne de texte en Helvetica.
fn text_pdf(path: &std::path::Path, text: &str) {
    use lopdf::content::{Content, Operation};
    use lopdf::{Object, Stream, dictionary};
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
    });
    let resources = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
    let content = Content {
        operations: vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 24.into()]),
            Operation::new("Td", vec![72.into(), 700.into()]),
            Operation::new("Tj", vec![Object::string_literal(text)]),
            Operation::new("ET", vec![]),
        ],
    };
    let contents = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
    let page = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "Contents" => contents,
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page.into()],
            "Count" => 1,
            "Resources" => resources,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    doc.save(path).unwrap();
}

#[test]
fn le_texte_des_pdf_se_lit_dans_l_ordre_des_noms() {
    let dir = tempdir().unwrap();
    let second = dir.path().join("page 10.pdf");
    let first = dir.path().join("page 2.pdf");
    text_pdf(&second, "Fin du document");
    text_pdf(&first, "Bonjour la confiance");
    let text = files::pdf_text(&[second, first]).unwrap();
    let start = text.find("Bonjour").expect(&text);
    let end = text.find("Fin du document").expect(&text);
    assert!(start < end, "{text}");
}

#[test]
fn une_image_se_relit_en_png() {
    let dir = tempdir().unwrap();
    let jpeg = dir.path().join("photo.jpg");
    image::RgbImage::from_pixel(8, 6, image::Rgb([200, 30, 30]))
        .save(&jpeg)
        .unwrap();
    let png = converter::to_png(&jpeg).unwrap();
    let decoded = image::load_from_memory(&png).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (8, 6));
    assert!(converter::to_png(&dir.path().join("absent.png")).is_err());
}
