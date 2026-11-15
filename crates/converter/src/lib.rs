//! Conversion d'images de Rutile : lecture, encodage et écriture à côté de l'original.
//!
//! Les fonctions sont bloquantes : l'app les appelle depuis un thread séparé.

mod decode;
mod encode;
mod error;
pub mod files;
mod format;
mod heic;
mod output;
pub mod retouch;
pub mod self_test;
mod site_icon;
pub mod video;

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use image::GenericImageView;
use image::imageops::FilterType;
use serde::{Deserialize, Serialize};

pub use encode::ICO_SIZES;
pub use error::ConvertError;
use error::shielded;
pub use format::{InputFormat, OutputFormat};
pub use site_icon::site_tile;

/// Qualité de 1 à 100 des formats avec perte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quality {
    pub jpeg: u8,
    pub webp: u8,
    pub avif: u8,
}

impl Default for Quality {
    fn default() -> Self {
        Quality {
            jpeg: 90,
            webp: 85,
            avif: 70,
        }
    }
}

/// Plus grand côté d'une image convertie « en 1920 px ».
const FULL_HD_SIDE: u32 = 1920;
/// Qualité de la variante « qualité max ».
const BEST: Quality = Quality {
    jpeg: 95,
    webp: 95,
    avif: 85,
};
/// Plafond de la variante « plus léger », à moins qu'un réglage ne soit déjà plus bas.
pub(crate) const LIGHT: Quality = Quality {
    jpeg: 70,
    webp: 70,
    avif: 50,
};

/// Variante d'une conversion, proposée en restant sur un format de la roue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Variant {
    /// Qualité la plus haute du format.
    Best,
    /// Fichier plus léger, au prix d'un peu de qualité.
    Light,
    /// 1920 pixels au plus de grand côté.
    FullHd,
    /// Moitié de la largeur et de la hauteur.
    Half,
}

impl Variant {
    fn quality(self, quality: &Quality) -> Quality {
        match self {
            Variant::Best => BEST,
            Variant::Light => Quality {
                jpeg: quality.jpeg.min(LIGHT.jpeg),
                webp: quality.webp.min(LIGHT.webp),
                avif: quality.avif.min(LIGHT.avif),
            },
            Variant::FullHd | Variant::Half => *quality,
        }
    }

    fn resize(self, image: image::DynamicImage) -> image::DynamicImage {
        let (width, height) = image.dimensions();
        match self {
            Variant::FullHd if width.max(height) > FULL_HD_SIDE => {
                image.resize(FULL_HD_SIDE, FULL_HD_SIDE, FilterType::Lanczos3)
            }
            Variant::Half => image.resize_exact(
                (width / 2).max(1),
                (height / 2).max(1),
                FilterType::Lanczos3,
            ),
            _ => image,
        }
    }

    /// Ajouté au nom du fichier produit, pour le distinguer d'une conversion ordinaire.
    fn suffix(self) -> String {
        match self {
            Variant::Best => String::new(),
            Variant::Light => i18n::t("files.suffix.compressed"),
            Variant::FullHd => "-1920".into(),
            Variant::Half => i18n::t("files.suffix.shrunk"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversion {
    pub output: PathBuf,
    pub format: OutputFormat,
    /// Vrai pour une vectorisation vers le SVG, qui n'est qu'une approximation.
    pub approximate: bool,
}

/// Format réel d'un fichier, lu dans ses premiers octets.
pub fn detect_format(path: &Path) -> Result<InputFormat, ConvertError> {
    let read_error = |source| ConvertError::Read {
        path: path.to_path_buf(),
        source,
    };
    let mut header = Vec::with_capacity(InputFormat::HEADER_LEN);
    File::open(path)
        .and_then(|file| {
            file.take(InputFormat::HEADER_LEN as u64)
                .read_to_end(&mut header)
        })
        .map_err(read_error)?;
    InputFormat::detect(&header, path).ok_or(ConvertError::UnsupportedFormat)
}

/// Convertit `input` vers `target` et renvoie le chemin du nouveau fichier.
pub fn convert(
    input: &Path,
    target: OutputFormat,
    quality: &Quality,
) -> Result<Conversion, ConvertError> {
    convert_variant(input, target, quality, None)
}

/// Comme [`convert`], avec une variante (qualité, taille) choisie sur la roue.
pub fn convert_variant(
    input: &Path,
    target: OutputFormat,
    quality: &Quality,
    variant: Option<Variant>,
) -> Result<Conversion, ConvertError> {
    shielded(|| convert_unshielded(input, target, quality, variant))
}

fn convert_unshielded(
    input: &Path,
    target: OutputFormat,
    quality: &Quality,
    variant: Option<Variant>,
) -> Result<Conversion, ConvertError> {
    let bytes = std::fs::read(input).map_err(|source| ConvertError::Read {
        path: input.to_path_buf(),
        source,
    })?;
    let source = InputFormat::detect(&bytes, input).ok_or(ConvertError::UnsupportedFormat)?;
    // Une variante (1920 px, plus léger…) a un sens même dans le format d'origine
    if source.as_output() == Some(target) && variant.is_none() {
        return Err(ConvertError::SameFormat(target));
    }

    let image = decode::decode(&bytes, source)?;
    let (image, quality, named) = match variant {
        Some(variant) => {
            let suffix = variant.suffix();
            let named = output::sibling(input, &output::suffixed(input, &suffix));
            (variant.resize(image), variant.quality(quality), named)
        }
        None => (image, *quality, input.to_path_buf()),
    };
    let encoded = encode::encode(&image, target, &quality)?;
    let output = output::write_unique(&named, target.extension(), &encoded)?;

    Ok(Conversion {
        output,
        format: target,
        approximate: target == OutputFormat::Svg,
    })
}

/// Une image de n'importe quel format pris en charge, en PNG : pour en lire le texte ou la
/// mettre dans le presse-papiers.
pub fn to_png(input: &Path) -> Result<Vec<u8>, ConvertError> {
    shielded(|| {
        let bytes = std::fs::read(input).map_err(|source| ConvertError::Read {
            path: input.to_path_buf(),
            source,
        })?;
        let source = InputFormat::detect(&bytes, input).ok_or(ConvertError::UnsupportedFormat)?;
        let image = decode::decode(&bytes, source)?;
        encode::encode(&image, OutputFormat::Png, &Quality::default())
    })
}

/// Vignette PNG d'une image, `side` pixels au plus de grand côté : l'image d'un fichier qu'on
/// glisse hors de la roue.
pub fn thumbnail_png(input: &Path, side: u32) -> Option<Vec<u8>> {
    shielded(|| {
        let bytes = std::fs::read(input).map_err(|source| ConvertError::Read {
            path: input.to_path_buf(),
            source,
        })?;
        let format = InputFormat::detect(&bytes, input).ok_or(ConvertError::UnsupportedFormat)?;
        let image = decode::decode(&bytes, format)?;
        let small = image.resize(side, side, FilterType::Triangle);
        encode::encode(&small, OutputFormat::Png, &Quality::default())
    })
    .ok()
}

/// Icône carrée en PNG à partir d'une image (PNG, SVG…), pour la roue des apps.
pub fn icon_png(data: &[u8], size: u32) -> Option<Vec<u8>> {
    shielded(|| {
        let name = Path::new("icone");
        let format = InputFormat::detect(data, name).ok_or(ConvertError::UnsupportedFormat)?;
        let image = decode::decode(data, format)?;
        let icon = image.resize(size, size, image::imageops::FilterType::Lanczos3);
        encode::encode(&icon, OutputFormat::Png, &Quality::default())
    })
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn une_icone_svg_devient_un_png_carre() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#e33"/></svg>"##;
        let png = icon_png(svg, 128).unwrap();
        let decoded = image::load_from_memory(&png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (128, 128));
    }
}
