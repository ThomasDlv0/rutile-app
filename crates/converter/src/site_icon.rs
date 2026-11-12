//! Logo d'un site web, présenté comme une icône d'app : une tuile carrée aux coins arrondis.
//!
//! Une image qui remplit son carré (l'« apple-touch-icon » des sites) devient la tuile
//! elle-même. Un logo détouré est posé sur une tuile blanche, ou sombre s'il est clair, pour
//! rester lisible sur la roue comme dans les réglages.

use std::io::Cursor;
use std::path::Path;

use image::imageops::{self, FilterType};
use image::{DynamicImage, ImageReader, Rgba, RgbaImage};

use crate::{InputFormat, OutputFormat, Quality, decode, encode};

/// Au-delà, ce n'est plus une icône : l'image n'est pas décodée.
const MAX_SOURCE_SIDE: u32 = 2048;
/// Marge autour de la tuile et rayon de ses coins, en parts du côté de l'icône : les mêmes
/// que les tuiles dessinées par l'interface (le globe d'un site, le menu de partage).
const MARGIN: f32 = 4.0 / 64.0;
const CORNER: f32 = 13.0 / 64.0;
/// Place d'un logo détouré dans sa tuile.
const LOGO_SHARE: f32 = 0.66;
/// Un pixel compte comme visible au-dessus de cette opacité.
const VISIBLE: u8 = 24;
const WHITE: [u8; 3] = [255, 255, 255];
const DARK: [u8; 3] = [38, 38, 42];
/// Au-dessus de cette clarté moyenne, un logo détouré se perdrait sur du blanc.
const LIGHT_LOGO: f32 = 0.82;

/// Tuile carrée de `size` pixels en PNG, à partir du logo d'un site (PNG, ICO, SVG, JPEG,
/// WebP, GIF ou BMP). `None` si les données ne sont pas une image utilisable.
pub fn site_tile(data: &[u8], size: u32) -> Option<Vec<u8>> {
    let format = InputFormat::detect(data, Path::new("icone"))?;
    // L'AVIF ne se mesure pas sans tout décoder, et aucun site ne s'en sert pour son logo
    if format == InputFormat::Avif {
        return None;
    }
    if format != InputFormat::Svg {
        let (width, height) = ImageReader::new(Cursor::new(data))
            .with_guessed_format()
            .ok()?
            .into_dimensions()
            .ok()?;
        if width.max(height) > MAX_SOURCE_SIDE {
            return None;
        }
    }
    let logo = decode::decode(data, format).ok()?.to_rgba8();
    if logo.width() == 0 || logo.height() == 0 {
        return None;
    }
    let tile = compose(&logo, size.max(16));
    encode::encode(
        &DynamicImage::ImageRgba8(tile),
        OutputFormat::Png,
        &Quality::default(),
    )
    .ok()
}

fn compose(logo: &RgbaImage, size: u32) -> RgbaImage {
    let margin = (size as f32 * MARGIN).round();
    let side = size as f32 - 2.0 * margin;
    let inner = side.round() as u32;
    let offset = margin as i64;

    let mut content = RgbaImage::new(size, size);
    let dark = if fills_its_square(logo) {
        let square = imageops::resize(&centered_square(logo), inner, inner, FilterType::Lanczos3);
        imageops::replace(&mut content, &square, offset, offset);
        false
    } else {
        let Some(cut) = trimmed(logo) else {
            return content;
        };
        let dark = is_light(&cut);
        let [red, green, blue] = if dark { DARK } else { WHITE };
        for pixel in content.pixels_mut() {
            *pixel = Rgba([red, green, blue, 255]);
        }
        let room = side * LOGO_SHARE;
        let scale = room / cut.width().max(cut.height()) as f32;
        let width = ((cut.width() as f32 * scale).round() as u32).max(1);
        let height = ((cut.height() as f32 * scale).round() as u32).max(1);
        let scaled = imageops::resize(&cut, width, height, FilterType::Lanczos3);
        imageops::overlay(
            &mut content,
            &scaled,
            i64::from(size - width) / 2,
            i64::from(size - height) / 2,
        );
        dark
    };

    // Coins arrondis, et un filet au bord pour qu'une tuile blanche se détache d'un fond blanc
    let center = size as f32 / 2.0;
    let half = side / 2.0;
    let radius = size as f32 * CORNER;
    let edge: [f32; 3] = if dark {
        [255.0, 255.0, 255.0]
    } else {
        [0.0, 0.0, 0.0]
    };
    for (x, y, pixel) in content.enumerate_pixels_mut() {
        let dx = (x as f32 + 0.5 - center).abs() - (half - radius);
        let dy = (y as f32 + 0.5 - center).abs() - (half - radius);
        let outside = dx.max(0.0).hypot(dy.max(0.0)) + dx.max(dy).min(0.0) - radius;
        let coverage = (0.5 - outside).clamp(0.0, 1.0);
        if coverage == 0.0 {
            *pixel = Rgba([0, 0, 0, 0]);
            continue;
        }
        let line = 0.13 * (1.0 - (outside + 0.75).abs() / 0.75).clamp(0.0, 1.0);
        for (channel, tint) in pixel.0.iter_mut().zip(edge) {
            *channel = (f32::from(*channel) * (1.0 - line) + tint * line).round() as u8;
        }
        pixel.0[3] = (f32::from(pixel.0[3]) * coverage).round() as u8;
    }
    content
}

/// L'image est opaque jusqu'à ses bords : c'est déjà une tuile, pas un logo détouré.
fn fills_its_square(logo: &RgbaImage) -> bool {
    let (width, height) = logo.dimensions();
    let opaque = |x: u32, y: u32| logo.get_pixel(x, y).0[3] >= 250;
    let border = (0..width)
        .flat_map(|x| [(x, 0), (x, height - 1)])
        .chain((0..height).flat_map(|y| [(0, y), (width - 1, y)]));
    let (mut total, mut solid) = (0u32, 0u32);
    for (x, y) in border {
        total += 1;
        solid += u32::from(opaque(x, y));
    }
    solid * 100 >= total * 98
}

/// Carré pris au milieu d'une image plus large que haute, ou l'inverse.
fn centered_square(logo: &RgbaImage) -> RgbaImage {
    let side = logo.width().min(logo.height());
    let x = (logo.width() - side) / 2;
    let y = (logo.height() - side) / 2;
    imageops::crop_imm(logo, x, y, side, side).to_image()
}

/// Le logo sans ses marges transparentes ; `None` s'il n'a aucun pixel visible.
fn trimmed(logo: &RgbaImage) -> Option<RgbaImage> {
    let (mut left, mut top) = (u32::MAX, u32::MAX);
    let (mut right, mut bottom) = (0u32, 0u32);
    for (x, y, pixel) in logo.enumerate_pixels() {
        if pixel.0[3] > VISIBLE {
            left = left.min(x);
            top = top.min(y);
            right = right.max(x);
            bottom = bottom.max(y);
        }
    }
    (left <= right && top <= bottom)
        .then(|| imageops::crop_imm(logo, left, top, right - left + 1, bottom - top + 1).to_image())
}

/// Clarté moyenne des pixels visibles, pondérée par leur opacité.
fn is_light(logo: &RgbaImage) -> bool {
    let (mut light, mut weight) = (0.0f32, 0.0f32);
    for pixel in logo.pixels() {
        let [red, green, blue, alpha] = pixel.0;
        if alpha > VISIBLE {
            let opacity = f32::from(alpha) / 255.0;
            let luma =
                0.2126 * f32::from(red) + 0.7152 * f32::from(green) + 0.0722 * f32::from(blue);
            light += luma / 255.0 * opacity;
            weight += opacity;
        }
    }
    weight > 0.0 && light / weight > LIGHT_LOGO
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(image: &RgbaImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    fn tile(image: &RgbaImage) -> RgbaImage {
        image::load_from_memory(&site_tile(&png(image), 128).unwrap())
            .unwrap()
            .to_rgba8()
    }

    #[test]
    fn une_image_pleine_devient_la_tuile_aux_coins_arrondis() {
        let red = RgbaImage::from_pixel(180, 180, Rgba([220, 30, 30, 255]));
        let tile = tile(&red);
        assert_eq!(tile.dimensions(), (128, 128));
        assert_eq!(tile.get_pixel(0, 0).0[3], 0, "la marge est transparente");
        assert_eq!(tile.get_pixel(9, 9).0[3], 0, "le coin est arrondi");
        assert_eq!(tile.get_pixel(64, 64).0, [220, 30, 30, 255]);
    }

    #[test]
    fn un_logo_detoure_se_pose_sur_une_tuile_blanche() {
        let mut logo = RgbaImage::new(64, 64);
        for (x, y, pixel) in logo.enumerate_pixels_mut() {
            if (20..44).contains(&x) && (24..40).contains(&y) {
                *pixel = Rgba([230, 20, 20, 255]);
            }
        }
        let tile = tile(&logo);
        assert_eq!(tile.get_pixel(64, 64).0, [230, 20, 20, 255]);
        assert_eq!(tile.get_pixel(64, 14).0, [255, 255, 255, 255]);
        assert_eq!(tile.get_pixel(2, 64).0[3], 0);
    }

    #[test]
    fn un_logo_clair_se_pose_sur_une_tuile_sombre() {
        let mut logo = RgbaImage::new(48, 48);
        for (x, y, pixel) in logo.enumerate_pixels_mut() {
            if (12..36).contains(&x) && (12..36).contains(&y) {
                *pixel = Rgba([250, 250, 250, 255]);
            }
        }
        let tile = tile(&logo);
        let [red, green, blue, alpha] = tile.get_pixel(64, 14).0;
        assert_eq!(alpha, 255);
        assert!(red < 60 && green < 60 && blue < 60, "fond sombre");
        assert_eq!(tile.get_pixel(64, 64).0, [250, 250, 250, 255]);
    }

    #[test]
    fn un_logo_svg_est_rendu() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#10a37f"/></svg>"##;
        let tile = image::load_from_memory(&site_tile(svg, 128).unwrap())
            .unwrap()
            .to_rgba8();
        let [red, green, blue, _] = tile.get_pixel(64, 64).0;
        assert!(green > red && green > blue, "le disque vert est au centre");
    }

    #[test]
    fn ce_qui_n_est_pas_une_image_est_refuse() {
        assert!(site_tile(b"<!doctype html><html><body>404</body></html>", 128).is_none());
        assert!(site_tile(&[], 128).is_none());
        let empty = RgbaImage::new(32, 32);
        assert!(
            site_tile(&png(&empty), 128).is_some(),
            "tuile vide, sans planter"
        );
    }

    #[test]
    fn une_image_demesuree_n_est_pas_decodee() {
        let huge = RgbaImage::from_pixel(MAX_SOURCE_SIDE + 1, 4, Rgba([0, 0, 0, 255]));
        assert!(site_tile(&png(&huge), 128).is_none());
    }
}
