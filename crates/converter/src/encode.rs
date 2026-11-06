use std::borrow::Cow;

use image::codecs::avif::AvifEncoder;
use image::codecs::ico::{IcoEncoder, IcoFrame};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::{self, FilterType};
use image::{ColorType, DynamicImage, ExtendedColorType, GenericImageView, RgbImage, RgbaImage};

use crate::{ConvertError, OutputFormat, Quality};

/// Tailles générées dans un fichier ICO.
pub const ICO_SIZES: [u32; 4] = [16, 32, 48, 256];
/// Au-delà, la vectorisation devient lente et produit des fichiers énormes.
const VECTORIZE_MAX_SIDE: u32 = 1024;
/// Compromis vitesse / taille de rav1e (0 = le plus lent, 10 = le plus rapide).
const AVIF_SPEED: u8 = 6;

pub(crate) fn encode(
    image: &DynamicImage,
    format: OutputFormat,
    quality: &Quality,
) -> Result<Vec<u8>, ConvertError> {
    let mut out = Vec::new();
    match format {
        OutputFormat::Png => {
            let image = without_float(image);
            image
                .write_with_encoder(PngEncoder::new(&mut out))
                .map_err(|err| ConvertError::encode(format, err))?;
        }
        OutputFormat::Jpeg => {
            flatten_on_white(image)
                .write_with_encoder(JpegEncoder::new_with_quality(&mut out, quality.jpeg))
                .map_err(|err| ConvertError::encode(format, err))?;
        }
        OutputFormat::Webp => out = encode_webp(image, quality.webp)?,
        OutputFormat::Avif => {
            let encoder = AvifEncoder::new_with_speed_quality(&mut out, AVIF_SPEED, quality.avif);
            to_8_bits(image)
                .write_with_encoder(encoder)
                .map_err(|err| ConvertError::encode(format, err))?;
        }
        OutputFormat::Ico => encode_ico(image, &mut out)?,
        OutputFormat::Svg => out = vectorize(image)?.into_bytes(),
    }
    Ok(out)
}

/// Le PNG n'accepte pas les images en virgule flottante (TIFF HDR).
fn without_float(image: &DynamicImage) -> Cow<'_, DynamicImage> {
    match image.color() {
        ColorType::Rgb32F | ColorType::Rgba32F => {
            Cow::Owned(DynamicImage::ImageRgba16(image.to_rgba16()))
        }
        _ => Cow::Borrowed(image),
    }
}

fn to_8_bits(image: &DynamicImage) -> DynamicImage {
    if image.color().has_alpha() {
        DynamicImage::ImageRgba8(image.to_rgba8())
    } else {
        DynamicImage::ImageRgb8(image.to_rgb8())
    }
}

/// Le JPEG n'a pas de transparence : on la remplace par un fond blanc.
pub(crate) fn flatten_on_white(image: &DynamicImage) -> DynamicImage {
    if !image.color().has_alpha() {
        return DynamicImage::ImageRgb8(image.to_rgb8());
    }
    let rgba = image.to_rgba8();
    let flat = RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let blend = |channel: u8| {
            let (channel, alpha) = (u32::from(channel), u32::from(a));
            ((channel * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        };
        image::Rgb([blend(r), blend(g), blend(b)])
    });
    DynamicImage::ImageRgb8(flat)
}

/// Le WebP de la crate image ne fait que du sans perte : libwebp gère la qualité.
fn encode_webp(image: &DynamicImage, quality: u8) -> Result<Vec<u8>, ConvertError> {
    let (width, height) = image.dimensions();
    let encoded = if image.color().has_alpha() {
        let rgba = image.to_rgba8();
        webp::Encoder::from_rgba(&rgba, width, height).encode_simple(false, f32::from(quality))
    } else {
        let rgb = image.to_rgb8();
        webp::Encoder::from_rgb(&rgb, width, height).encode_simple(false, f32::from(quality))
    };
    encoded
        .map(|memory| memory.to_vec())
        .map_err(|err| ConvertError::encode(OutputFormat::Webp, format!("{err:?}")))
}

fn encode_ico(image: &DynamicImage, out: &mut Vec<u8>) -> Result<(), ConvertError> {
    let square = pad_to_square(image.to_rgba8());
    let resized: Vec<RgbaImage> = ICO_SIZES
        .iter()
        .map(|&size| imageops::resize(&square, size, size, FilterType::Lanczos3))
        .collect();
    let frames = resized
        .iter()
        .map(|frame| {
            IcoFrame::as_png(
                frame.as_raw(),
                frame.width(),
                frame.height(),
                ExtendedColorType::Rgba8,
            )
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| ConvertError::encode(OutputFormat::Ico, err))?;
    IcoEncoder::new(out)
        .encode_images(&frames)
        .map_err(|err| ConvertError::encode(OutputFormat::Ico, err))
}

/// Une icône est carrée : on centre l'image sur un fond transparent plutôt que la déformer.
fn pad_to_square(image: RgbaImage) -> RgbaImage {
    let (width, height) = image.dimensions();
    if width == height {
        return image;
    }
    let side = width.max(height);
    let mut square = RgbaImage::new(side, side);
    let x = i64::from((side - width) / 2);
    let y = i64::from((side - height) / 2);
    imageops::overlay(&mut square, &image, x, y);
    square
}

/// Vectorisation approximative : les aplats sont tracés en chemins, les dégradés en bandes.
fn vectorize(image: &DynamicImage) -> Result<String, ConvertError> {
    let (width, height) = image.dimensions();
    let rgba = if width.max(height) > VECTORIZE_MAX_SIDE {
        image
            .resize(VECTORIZE_MAX_SIDE, VECTORIZE_MAX_SIDE, FilterType::Triangle)
            .to_rgba8()
    } else {
        image.to_rgba8()
    };
    let (traced_width, traced_height) = rgba.dimensions();

    let color_image = vtracer::ColorImage {
        pixels: rgba.into_raw(),
        width: traced_width as usize,
        height: traced_height as usize,
    };
    let svg = vtracer::convert(color_image, vtracer::Config::default())
        .map_err(|err| ConvertError::encode(OutputFormat::Svg, err))?
        .to_string();

    if (traced_width, traced_height) == (width, height) {
        return Ok(svg);
    }
    // Le tracé est fait en petit, mais le SVG garde les dimensions d'origine
    let header = format!(r#"width="{traced_width}" height="{traced_height}">"#);
    let scaled = format!(
        r#"width="{width}" height="{height}" viewBox="0 0 {traced_width} {traced_height}">"#
    );
    Ok(svg.replacen(&header, &scaled, 1))
}
