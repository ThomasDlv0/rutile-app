//! Règles particulières de la conversion.

mod common;

use std::fs;

use converter::{ConvertError, InputFormat, OutputFormat, Quality, convert, detect_format};
use image::{DynamicImage, GenericImageView, Rgba, RgbaImage};
use resvg::usvg;

fn convert_default(path: &std::path::Path, target: OutputFormat) -> converter::Conversion {
    convert(path, target, &Quality::default()).unwrap()
}

#[test]
fn le_jpeg_remplace_la_transparence_par_du_blanc() {
    let dir = tempfile::tempdir().unwrap();
    let source = common::write_fixture(dir.path(), InputFormat::Png);

    let output = convert_default(&source, OutputFormat::Jpeg).output;

    let image = image::open(output).unwrap().to_rgb8();
    let corner = image.get_pixel(2, 2).0;
    assert!(
        corner.iter().all(|&channel| channel > 245),
        "coin {corner:?}"
    );
}

#[test]
fn l_ico_contient_quatre_tailles_carrees_sans_deformation() {
    let dir = tempfile::tempdir().unwrap();
    let source = common::write_fixture(dir.path(), InputFormat::Png);

    let output = convert_default(&source, OutputFormat::Ico).output;

    let entries = common::ico_entries(&fs::read(output).unwrap());
    let sides: Vec<u32> = entries.iter().map(|(side, _)| *side).collect();
    assert_eq!(sides, [16, 32, 48, 256]);
    for (side, data) in &entries {
        let frame = image::load_from_memory(data).unwrap();
        assert_eq!(frame.dimensions(), (*side, *side));
    }
    // Image 40 × 30 centrée : bandes transparentes en haut et en bas
    let large = image::load_from_memory(&entries[3].1).unwrap().to_rgba8();
    assert_eq!(large.get_pixel(128, 5)[3], 0, "bande du haut");
    assert_eq!(large.get_pixel(128, 128)[3], 255, "centre");
}

#[test]
fn n_ecrase_jamais_un_fichier_existant() {
    let dir = tempfile::tempdir().unwrap();
    let source = common::write_fixture(dir.path(), InputFormat::Jpeg);
    let existing = dir.path().join("source.png");
    fs::write(&existing, b"ne pas toucher").unwrap();

    let first = convert_default(&source, OutputFormat::Png).output;
    let second = convert_default(&source, OutputFormat::Png).output;

    assert_eq!(first, dir.path().join("source-1.png"));
    assert_eq!(second, dir.path().join("source-2.png"));
    assert_eq!(fs::read(existing).unwrap(), b"ne pas toucher");
}

#[test]
fn le_gif_anime_donne_sa_premiere_image() {
    let dir = tempfile::tempdir().unwrap();
    let source = common::write_fixture(dir.path(), InputFormat::Gif);

    let output = convert_default(&source, OutputFormat::Png).output;

    let pixel = image::open(output).unwrap().to_rgba8().get_pixel(20, 15).0;
    let [r, g, b, _] = pixel;
    let first = common::GIF_FIRST.0;
    assert!(r.abs_diff(first[0]) < 10 && g.abs_diff(first[1]) < 10 && b.abs_diff(first[2]) < 10);
}

#[test]
fn le_format_est_lu_dans_le_contenu_et_pas_dans_l_extension() {
    let dir = tempfile::tempdir().unwrap();
    let png = common::write_fixture(dir.path(), InputFormat::Png);
    let misnamed = dir.path().join("photo.jpg");
    fs::rename(&png, &misnamed).unwrap();

    assert_eq!(detect_format(&misnamed).unwrap(), InputFormat::Png);
    // Le fichier est un PNG : la conversion en JPEG est permise et ne l'écrase pas
    let output = convert_default(&misnamed, OutputFormat::Jpeg).output;
    assert_eq!(output, dir.path().join("photo-1.jpg"));
    assert_eq!(detect_format(&output).unwrap(), InputFormat::Jpeg);
}

#[test]
fn le_meme_format_est_refuse() {
    let dir = tempfile::tempdir().unwrap();
    let source = common::write_fixture(dir.path(), InputFormat::Webp);

    let error = convert(&source, OutputFormat::Webp, &Quality::default()).unwrap_err();

    assert!(matches!(
        error,
        ConvertError::SameFormat(OutputFormat::Webp)
    ));
    assert_eq!(error.to_string(), "Le fichier est déjà au format WebP.");
}

#[test]
fn un_fichier_qui_n_est_pas_une_image_est_refuse() {
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("faux.png");
    fs::write(&fake, "ceci n'est pas une image").unwrap();

    let error = convert(&fake, OutputFormat::Jpeg, &Quality::default()).unwrap_err();

    assert!(
        matches!(error, ConvertError::UnsupportedFormat),
        "{error:?}"
    );
}

#[test]
fn une_image_tronquee_donne_une_erreur_claire() {
    let dir = tempfile::tempdir().unwrap();
    let source = common::write_fixture(dir.path(), InputFormat::Png);
    let bytes = fs::read(&source).unwrap();
    fs::write(&source, &bytes[..bytes.len() / 2]).unwrap();

    let error = convert(&source, OutputFormat::Jpeg, &Quality::default()).unwrap_err();

    assert!(matches!(error, ConvertError::Decode(_)), "{error:?}");
    assert!(
        error
            .to_string()
            .starts_with("Image illisible ou endommagée")
    );
}

#[test]
fn un_fichier_introuvable_donne_une_erreur_en_francais() {
    let error = convert(
        std::path::Path::new("/dossier/inexistant/photo.png"),
        OutputFormat::Jpeg,
        &Quality::default(),
    )
    .unwrap_err();

    assert!(
        error.to_string().contains("fichier ou dossier introuvable"),
        "{error}"
    );
}

#[cfg(unix)]
#[test]
fn un_dossier_protege_en_ecriture_donne_une_erreur() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let source = common::write_fixture(dir.path(), InputFormat::Png);
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();

    let result = convert(&source, OutputFormat::Jpeg, &Quality::default());
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();

    let error = result.unwrap_err();
    assert!(matches!(error, ConvertError::Write { .. }), "{error:?}");
    assert!(error.to_string().contains("accès refusé"), "{error}");
}

/// Image bruitée : la taille du fichier dépend nettement de la qualité.
fn noisy() -> DynamicImage {
    let mut seed = 7u32;
    DynamicImage::ImageRgba8(RgbaImage::from_fn(96, 96, |_, _| {
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        let [r, g, b, _] = seed.to_le_bytes();
        Rgba([r, g, b, 255])
    }))
}

#[test]
fn la_qualite_change_la_taille_des_formats_avec_perte() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("bruit.png");
    noisy().save(&source).unwrap();

    for format in [OutputFormat::Jpeg, OutputFormat::Webp, OutputFormat::Avif] {
        let size_at = |value: u8| {
            let quality = Quality {
                jpeg: value,
                webp: value,
                avif: value,
            };
            let output = convert(&source, format, &quality).unwrap().output;
            fs::metadata(output).unwrap().len()
        };
        let (low, high) = (size_at(20), size_at(95));
        assert!(low < high, "{format:?} : {low} octets à 20, {high} à 95");
    }
}

#[test]
fn la_vectorisation_garde_les_dimensions_d_une_grande_image() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("large.png");
    RgbaImage::from_fn(2000, 500, |x, _| {
        if x < 1000 {
            Rgba([200, 30, 30, 255])
        } else {
            Rgba([30, 30, 200, 255])
        }
    })
    .save(&source)
    .unwrap();

    let conversion = convert_default(&source, OutputFormat::Svg);

    assert!(conversion.approximate);
    let svg = fs::read_to_string(&conversion.output).unwrap();
    assert!(
        svg.contains(r#"viewBox="0 0 1024 256""#),
        "le tracé est réduit à 1024 px"
    );
    let tree = usvg::Tree::from_str(&svg, &usvg::Options::default()).unwrap();
    assert_eq!((tree.size().width(), tree.size().height()), (2000.0, 500.0));
}
