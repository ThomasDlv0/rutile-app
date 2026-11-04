//! Fichiers de test générés à la volée, pour ne pas stocker d'images dans le dépôt.

#![allow(dead_code)]

use std::fs::{self, File};
use std::path::{Path, PathBuf};

use converter::{InputFormat, OutputFormat};
use image::codecs::gif::GifEncoder;
use image::{DynamicImage, Frame, Rgba, RgbaImage};
use resvg::usvg;

pub const WIDTH: u32 = 40;
pub const HEIGHT: u32 = 30;

/// Dégradé avec un coin transparent en haut à gauche.
pub fn sample() -> RgbaImage {
    RgbaImage::from_fn(WIDTH, HEIGHT, |x, y| {
        let alpha = if x < 10 && y < 10 { 0 } else { 255 };
        Rgba([(x * 6) as u8, (y * 8) as u8, 128, alpha])
    })
}

pub const SVG_SOURCE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" viewBox="0 0 40 30">
  <rect width="40" height="30" fill="#3366cc"/>
  <circle cx="20" cy="15" r="10" fill="#ffcc00"/>
</svg>"##;

/// Un SVG de 40 px est rendu à 512 px de côté au minimum.
pub const SVG_RENDERED: (u32, u32) = (512, 384);

pub fn extension(format: InputFormat) -> &'static str {
    match format {
        InputFormat::Png => "png",
        InputFormat::Jpeg => "jpg",
        InputFormat::Webp => "webp",
        InputFormat::Avif => "avif",
        InputFormat::Gif => "gif",
        InputFormat::Bmp => "bmp",
        InputFormat::Tiff => "tiff",
        InputFormat::Ico => "ico",
        InputFormat::Svg => "svg",
    }
}

/// Écrit `source.<ext>` dans `dir` au format demandé.
pub fn write_fixture(dir: &Path, format: InputFormat) -> PathBuf {
    let path = dir.join(format!("source.{}", extension(format)));
    let image = DynamicImage::ImageRgba8(sample());
    match format {
        InputFormat::Svg => fs::write(&path, SVG_SOURCE).unwrap(),
        InputFormat::Jpeg => image.to_rgb8().save(&path).unwrap(),
        InputFormat::Gif => write_two_frame_gif(&path),
        _ => image.save(&path).unwrap(),
    }
    path
}

pub const GIF_FIRST: Rgba<u8> = Rgba([220, 20, 20, 255]);
pub const GIF_SECOND: Rgba<u8> = Rgba([20, 20, 220, 255]);

/// GIF animé : une première image rouge, puis une bleue.
fn write_two_frame_gif(path: &Path) {
    let frames = [GIF_FIRST, GIF_SECOND]
        .map(|color| Frame::new(RgbaImage::from_pixel(WIDTH, HEIGHT, color)));
    let mut encoder = GifEncoder::new(File::create(path).unwrap());
    encoder.encode_frames(frames).unwrap();
}

pub fn expected_size(format: InputFormat) -> (u32, u32) {
    match format {
        InputFormat::Svg => SVG_RENDERED,
        _ => (WIDTH, HEIGHT),
    }
}

/// Entrées d'un fichier ICO : (côté, données PNG ou BMP de l'entrée).
pub fn ico_entries(bytes: &[u8]) -> Vec<(u32, Vec<u8>)> {
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    (0..count)
        .map(|index| {
            let entry = &bytes[6 + index * 16..6 + (index + 1) * 16];
            let side = if entry[0] == 0 {
                256
            } else {
                u32::from(entry[0])
            };
            let size = u32::from_le_bytes(entry[8..12].try_into().unwrap()) as usize;
            let offset = u32::from_le_bytes(entry[12..16].try_into().unwrap()) as usize;
            (side, bytes[offset..offset + size].to_vec())
        })
        .collect()
}

/// Dimensions d'un fichier produit, en le relisant avec un décodeur indépendant.
pub fn output_size(path: &Path, format: OutputFormat) -> Result<(u32, u32), String> {
    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    match format {
        OutputFormat::Avif => avif_size(&bytes),
        OutputFormat::Svg => {
            let tree = usvg::Tree::from_data(&bytes, &usvg::Options::default())
                .map_err(|err| err.to_string())?;
            let size = tree.size();
            Ok((size.width().round() as u32, size.height().round() as u32))
        }
        OutputFormat::Ico => {
            let sides: Vec<u32> = ico_entries(&bytes).iter().map(|(side, _)| *side).collect();
            if sides != converter::ICO_SIZES {
                return Err(format!("tailles ICO inattendues : {sides:?}"));
            }
            Ok((256, 256))
        }
        _ => image::image_dimensions(path).map_err(|err| err.to_string()),
    }
}

fn avif_size(bytes: &[u8]) -> Result<(u32, u32), String> {
    let image = avif_decode::Decoder::from_avif(bytes)
        .and_then(|decoder| decoder.to_image())
        .map_err(|err| err.to_string())?;
    let (width, height) = match image {
        avif_decode::Image::Rgb8(img) => (img.width(), img.height()),
        avif_decode::Image::Rgb16(img) => (img.width(), img.height()),
        avif_decode::Image::Rgba8(img) => (img.width(), img.height()),
        avif_decode::Image::Rgba16(img) => (img.width(), img.height()),
        avif_decode::Image::Gray8(img) => (img.width(), img.height()),
        avif_decode::Image::Gray16(img) => (img.width(), img.height()),
    };
    Ok((width as u32, height as u32))
}
