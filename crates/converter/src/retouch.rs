//! Retouches d'une image : réduire, compresser, retirer les métadonnées. L'image reste dans
//! son format quand il le permet, et le résultat est écrit à côté de l'original.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageReader};
use serde::{Deserialize, Serialize};

use crate::{ConvertError, InputFormat, OutputFormat, Quality, decode, encode, output};

/// Plus grand côté de l'image après « Grand format réduit ».
const FULL_HD_SIDE: u32 = 1920;
/// Qualités employées par « Compresser », à moins qu'un réglage ne soit déjà plus bas.
const COMPRESSED: Quality = Quality {
    jpeg: 70,
    webp: 70,
    avif: 50,
};
/// Qualité d'un JPEG réécrit pour remettre à l'endroit une photo : presque sans perte visible.
const UPRIGHT_JPEG: Quality = Quality {
    jpeg: 95,
    webp: 95,
    avif: 90,
};

/// Retouches proposées par la roue Actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Retouch {
    /// Moitié de la largeur et de la hauteur.
    Half,
    /// 1920 pixels au plus de grand côté.
    FullHd,
    Compress,
    /// Sans position GPS, appareil, date ni commentaires.
    StripMetadata,
}

/// Format du fichier produit : celui d'origine, ou PNG pour ceux qu'on ne sait pas écrire.
fn output_format(source: InputFormat) -> Result<OutputFormat, ConvertError> {
    match source.as_output() {
        Some(OutputFormat::Svg | OutputFormat::Ico) => Err(ConvertError::NotRaster),
        Some(format) => Ok(format),
        None if matches!(source, InputFormat::Svg) => Err(ConvertError::NotRaster),
        None => Ok(OutputFormat::Png),
    }
}

/// Applique `retouch` à `input` et renvoie le chemin du nouveau fichier.
pub fn retouch(input: &Path, retouch: Retouch, quality: &Quality) -> Result<PathBuf, ConvertError> {
    let bytes = fs::read(input).map_err(|source| ConvertError::Read {
        path: input.to_path_buf(),
        source,
    })?;
    let source = InputFormat::detect(&bytes, input).ok_or(ConvertError::UnsupportedFormat)?;
    let format = output_format(source)?;
    let image = || decode::decode(&bytes, source);
    let (encoded, suffix) = match retouch {
        Retouch::Half => {
            let image = image()?;
            let (width, height) = image.dimensions();
            let half = image.resize_exact(
                (width / 2).max(1),
                (height / 2).max(1),
                FilterType::Lanczos3,
            );
            (
                encode::encode(&half, format, quality)?,
                i18n::t("files.suffix.shrunk"),
            )
        }
        Retouch::FullHd => {
            let image = image()?;
            let (width, height) = image.dimensions();
            if width.max(height) <= FULL_HD_SIDE {
                return Err(ConvertError::AlreadySmall);
            }
            let smaller = image.resize(FULL_HD_SIDE, FULL_HD_SIDE, FilterType::Lanczos3);
            (
                encode::encode(&smaller, format, quality)?,
                "-1920".to_string(),
            )
        }
        Retouch::Compress => {
            let encoded = compress(&image()?, format, quality)?;
            if encoded.len() >= bytes.len() {
                return Err(ConvertError::NotSmaller);
            }
            (encoded, i18n::t("files.suffix.compressed"))
        }
        Retouch::StripMetadata => (
            strip_metadata(&bytes, source, format, quality)?,
            i18n::t("files.suffix.noMetadata"),
        ),
    };
    let target = output::sibling(input, &output::suffixed(input, &suffix));
    output::write_unique(&target, format.extension(), &encoded)
}

fn compress(
    image: &DynamicImage,
    format: OutputFormat,
    quality: &Quality,
) -> Result<Vec<u8>, ConvertError> {
    if format == OutputFormat::Png {
        // Sans perte : le PNG ne connaît pas de qualité, seulement un effort de compression
        let mut out = Vec::new();
        let encoder =
            PngEncoder::new_with_quality(&mut out, CompressionType::Best, PngFilter::Adaptive);
        image
            .write_with_encoder(encoder)
            .map_err(|err| ConvertError::encode(format, err))?;
        return Ok(out);
    }
    let lowest = Quality {
        jpeg: quality.jpeg.min(COMPRESSED.jpeg),
        webp: quality.webp.min(COMPRESSED.webp),
        avif: quality.avif.min(COMPRESSED.avif),
    };
    encode::encode(image, format, &lowest)
}

/// Copie sans métadonnées. Un JPEG ou un PNG ne perd aucune qualité : seuls les blocs de
/// métadonnées sont retirés. Les autres formats sont réécrits, ce qui les efface.
fn strip_metadata(
    bytes: &[u8],
    source: InputFormat,
    format: OutputFormat,
    quality: &Quality,
) -> Result<Vec<u8>, ConvertError> {
    let stripped = match source {
        InputFormat::Jpeg => strip_jpeg(bytes),
        InputFormat::Png => strip_png(bytes),
        _ => None,
    };
    if let Some(stripped) = stripped {
        return Ok(stripped);
    }
    let quality = if source == InputFormat::Jpeg {
        &UPRIGHT_JPEG
    } else {
        quality
    };
    encode::encode(&decode::decode(bytes, source)?, format, quality)
}

/// Sens d'origine d'une photo. Il vit dans l'EXIF : le retirer d'une photo tournée la
/// mettrait de travers.
fn is_upright(bytes: &[u8]) -> bool {
    ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Jpeg)
        .into_decoder()
        .ok()
        .and_then(|mut decoder| decoder.orientation().ok())
        .is_none_or(|orientation| orientation == Orientation::NoTransforms)
}

/// JPEG sans EXIF, XMP, IPTC ni commentaire ; le profil de couleur (APP2) reste. `None` pour
/// un fichier inattendu, ou une photo tournée qu'il faut réécrire.
fn strip_jpeg(bytes: &[u8]) -> Option<Vec<u8>> {
    const SOI: [u8; 2] = [0xff, 0xd8];
    const SOS: u8 = 0xda;
    const APP1: u8 = 0xe1;
    const APP13: u8 = 0xed;
    const COM: u8 = 0xfe;
    if !bytes.starts_with(&SOI) || !is_upright(bytes) {
        return None;
    }
    let mut out = SOI.to_vec();
    let mut at = 2;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xff {
            return None;
        }
        let marker = bytes[at + 1];
        // Des données compressées suivent : tout reste jusqu'à la fin du fichier
        if marker == SOS {
            out.extend_from_slice(&bytes[at..]);
            return Some(out);
        }
        let length = usize::from(u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]));
        let end = at + 2 + length;
        if length < 2 || end > bytes.len() {
            return None;
        }
        if !matches!(marker, APP1 | APP13 | COM) {
            out.extend_from_slice(&bytes[at..end]);
        }
        at = end;
    }
    None
}

/// PNG sans ses textes, sa date ni son EXIF. `None` pour un fichier inattendu.
fn strip_png(bytes: &[u8]) -> Option<Vec<u8>> {
    const SIGNATURE: usize = 8;
    const METADATA: [&[u8; 4]; 5] = [b"tEXt", b"zTXt", b"iTXt", b"eXIf", b"tIME"];
    let mut out = bytes.get(..SIGNATURE)?.to_vec();
    let mut at = SIGNATURE;
    while at + 12 <= bytes.len() {
        let length = u32::from_be_bytes(bytes[at..at + 4].try_into().ok()?) as usize;
        let end = at.checked_add(12)?.checked_add(length)?;
        let chunk = bytes.get(at..end)?;
        if !METADATA.iter().any(|kind| kind[..] == chunk[4..8]) {
            out.extend_from_slice(chunk);
        }
        at = end;
    }
    (at == bytes.len()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Petit JPEG sans métadonnées, encodé à la volée.
    fn jpeg() -> Vec<u8> {
        let image = DynamicImage::new_rgb8(16, 16);
        encode::encode(&image, OutputFormat::Jpeg, &Quality::default()).unwrap()
    }

    /// Ajoute un bloc APP1 (EXIF) juste après l'en-tête.
    fn with_app1(jpeg: &[u8]) -> Vec<u8> {
        let payload = b"Exif\0\0GPS Paris";
        let mut out = jpeg[..2].to_vec();
        out.extend_from_slice(&[0xff, 0xe1]);
        out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(payload);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    #[test]
    fn un_jpeg_perd_son_exif_sans_changer_ses_images() {
        let original = jpeg();
        let stripped = strip_jpeg(&with_app1(&original)).unwrap();
        assert_eq!(stripped, original);
    }

    #[test]
    fn un_png_perd_ses_textes() {
        let image = DynamicImage::new_rgb8(4, 4);
        let png = encode::encode(&image, OutputFormat::Png, &Quality::default()).unwrap();
        let mut tagged = png[..33].to_vec();
        tagged.extend_from_slice(&5u32.to_be_bytes());
        tagged.extend_from_slice(b"tEXtAuteu");
        tagged.extend_from_slice(&[0; 4]);
        tagged.extend_from_slice(&png[33..]);
        assert_eq!(strip_png(&tagged).unwrap(), png);
    }

    #[test]
    fn un_fichier_coupe_n_est_pas_traite() {
        let png = encode::encode(
            &DynamicImage::new_rgb8(4, 4),
            OutputFormat::Png,
            &Quality::default(),
        )
        .unwrap();
        assert_eq!(strip_png(&png[..png.len() - 3]), None);
    }
}
