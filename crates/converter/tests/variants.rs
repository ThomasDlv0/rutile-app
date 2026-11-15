//! Variantes d'une conversion, choisies en restant sur un format de la roue.

use std::path::Path;

use converter::{OutputFormat, Quality, Variant, convert_variant};
use image::{Rgb, RgbImage};

/// Photo factice au contenu varié, pour que la qualité change vraiment le poids du fichier.
fn photo(dir: &Path) -> std::path::PathBuf {
    let path = dir.join("photo.png");
    RgbImage::from_fn(400, 300, |x, y| {
        let noise = (x.wrapping_mul(7919) ^ y.wrapping_mul(104_729)).wrapping_mul(2_654_435_761);
        Rgb([(x / 2) as u8, (y / 2) as u8, (noise >> 24) as u8])
    })
    .save(&path)
    .unwrap();
    path
}

fn convert(source: &Path, variant: Variant) -> std::path::PathBuf {
    convert_variant(
        source,
        OutputFormat::Webp,
        &Quality::default(),
        Some(variant),
    )
    .unwrap()
    .output
}

#[test]
fn moitie_et_1920_changent_la_taille() {
    let dir = tempfile::tempdir().unwrap();
    let source = photo(dir.path());

    let half = convert(&source, Variant::Half);
    assert_eq!(image::image_dimensions(&half).unwrap(), (200, 150));
    // Déjà plus petite que 1920 px : gardée telle quelle
    let full_hd = convert(&source, Variant::FullHd);
    assert_eq!(image::image_dimensions(&full_hd).unwrap(), (400, 300));
    assert_eq!(full_hd.file_name().unwrap(), "photo-1920.webp");
    assert_ne!(half.file_stem(), Some("photo".as_ref()));
}

#[test]
fn plus_leger_pese_moins_que_qualite_max() {
    let dir = tempfile::tempdir().unwrap();
    let source = photo(dir.path());

    let best = convert(&source, Variant::Best);
    let light = convert(&source, Variant::Light);
    assert_eq!(best.file_name().unwrap(), "photo.webp");
    let size = |path: &Path| std::fs::metadata(path).unwrap().len();
    assert!(
        size(&light) < size(&best),
        "{} ≥ {}",
        size(&light),
        size(&best)
    );
}
