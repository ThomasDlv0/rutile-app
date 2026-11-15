use std::io::Cursor;
use std::sync::{Arc, OnceLock};

use image::{
    DynamicImage, ImageBuffer, ImageDecoder, ImageReader, Luma, Rgb, RgbImage, Rgba, RgbaImage,
    metadata::Orientation,
};
use moxcms::{ColorProfile, DataColorSpace, Layout, TransformOptions, Xyzd};
use resvg::{tiny_skia, usvg};

use crate::{ConvertError, InputFormat};

/// Un petit SVG (souvent une icône de 24 px) est rendu à cette taille au minimum.
const SVG_MIN_SIDE: f32 = 512.0;
/// Évite d'allouer une image énorme pour un SVG aux dimensions déclarées démesurées.
const SVG_MAX_SIDE: f32 = 8192.0;

pub(crate) fn decode(bytes: &[u8], format: InputFormat) -> Result<DynamicImage, ConvertError> {
    match format {
        InputFormat::Avif => decode_avif(bytes),
        InputFormat::Svg => render_svg(bytes),
        InputFormat::Heic => crate::heic::decode(bytes),
        raster => decode_raster(bytes, raster),
    }
}

/// PNG, JPEG, WebP, GIF (première image), BMP, TIFF et ICO (plus grande taille).
fn decode_raster(bytes: &[u8], format: InputFormat) -> Result<DynamicImage, ConvertError> {
    let image_format = format
        .image_format()
        .expect("format matriciel lu par la crate image");
    let mut decoder = ImageReader::with_format(Cursor::new(bytes), image_format)
        .into_decoder()
        .map_err(ConvertError::decode)?;
    // L'orientation EXIF des photos est appliquée, car elle est perdue à l'écriture
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let icc = decoder.icc_profile().ok().flatten();
    let mut image = DynamicImage::from_decoder(decoder).map_err(ConvertError::decode)?;
    image.apply_orientation(orientation);
    Ok(match icc {
        Some(icc) => to_srgb(image, &icc),
        None => image,
    })
}

/// Ramène en sRGB une image décrite par un profil de couleur (Display P3 des captures d'écran du
/// Mac et des photos d'iPhone, Adobe RGB…). Le profil n'est pas écrit dans le résultat : sans
/// cette conversion, ses couleurs seraient lues comme du sRGB et paraîtraient ternes. Un profil
/// illisible, sRGB, gris ou CMJN laisse l'image telle quelle.
pub(crate) fn to_srgb(image: DynamicImage, icc: &[u8]) -> DynamicImage {
    let Ok(source) = ColorProfile::new_from_slice(icc) else {
        return image;
    };
    let srgb = ColorProfile::new_srgb();
    if source.color_space != DataColorSpace::Rgb || same_primaries(&source, &srgb) {
        return image;
    }
    let options = TransformOptions::default();

    macro_rules! convert {
        ($buffer:expr, $variant:ident, $layout:expr, $create:ident) => {{
            let buffer = $buffer;
            let converted = source
                .$create($layout, &srgb, $layout, options)
                .ok()
                .and_then(|transform| {
                    let mut out = ImageBuffer::new(buffer.width(), buffer.height());
                    transform.transform(&buffer, &mut out).ok().map(|()| out)
                });
            DynamicImage::$variant(converted.unwrap_or(buffer))
        }};
    }
    match image {
        DynamicImage::ImageRgb8(buffer) => {
            convert!(buffer, ImageRgb8, Layout::Rgb, create_transform_8bit)
        }
        DynamicImage::ImageRgba8(buffer) => {
            convert!(buffer, ImageRgba8, Layout::Rgba, create_transform_8bit)
        }
        DynamicImage::ImageRgb16(buffer) => {
            convert!(buffer, ImageRgb16, Layout::Rgb, create_transform_16bit)
        }
        DynamicImage::ImageRgba16(buffer) => {
            convert!(buffer, ImageRgba16, Layout::Rgba, create_transform_16bit)
        }
        other => other,
    }
}

/// Mêmes couleurs primaires que le sRGB : l'image peut rester telle quelle.
fn same_primaries(profile: &ColorProfile, srgb: &ColorProfile) -> bool {
    let close = |a: &Xyzd, b: &Xyzd| {
        (a.x - b.x).abs() < 2e-3 && (a.y - b.y).abs() < 2e-3 && (a.z - b.z).abs() < 2e-3
    };
    close(&profile.red_colorant, &srgb.red_colorant)
        && close(&profile.green_colorant, &srgb.green_colorant)
        && close(&profile.blue_colorant, &srgb.blue_colorant)
}

fn decode_avif(bytes: &[u8]) -> Result<DynamicImage, ConvertError> {
    let decoded = avif_decode::Decoder::from_avif(bytes)
        .and_then(|decoder| decoder.to_image())
        .map_err(|err| ConvertError::Decode(err.to_string()))?;

    let image = match decoded {
        avif_decode::Image::Rgb8(img) => {
            let (pixels, width, height) = img.into_contiguous_buf();
            let raw = pixels.iter().flat_map(|p| [p.r, p.g, p.b]).collect();
            RgbImage::from_raw(width as u32, height as u32, raw).map(DynamicImage::ImageRgb8)
        }
        avif_decode::Image::Rgba8(img) => {
            let (pixels, width, height) = img.into_contiguous_buf();
            let raw = pixels.iter().flat_map(|p| [p.r, p.g, p.b, p.a]).collect();
            RgbaImage::from_raw(width as u32, height as u32, raw).map(DynamicImage::ImageRgba8)
        }
        avif_decode::Image::Rgb16(img) => {
            let (pixels, width, height) = img.into_contiguous_buf();
            let raw = pixels.iter().flat_map(|p| [p.r, p.g, p.b]).collect();
            ImageBuffer::<Rgb<u16>, _>::from_raw(width as u32, height as u32, raw)
                .map(DynamicImage::ImageRgb16)
        }
        avif_decode::Image::Rgba16(img) => {
            let (pixels, width, height) = img.into_contiguous_buf();
            let raw = pixels.iter().flat_map(|p| [p.r, p.g, p.b, p.a]).collect();
            ImageBuffer::<Rgba<u16>, _>::from_raw(width as u32, height as u32, raw)
                .map(DynamicImage::ImageRgba16)
        }
        avif_decode::Image::Gray8(img) => {
            let (pixels, width, height) = img.into_contiguous_buf();
            let raw = pixels.iter().map(|p| p.value()).collect();
            ImageBuffer::<Luma<u8>, _>::from_raw(width as u32, height as u32, raw)
                .map(DynamicImage::ImageLuma8)
        }
        avif_decode::Image::Gray16(img) => {
            let (pixels, width, height) = img.into_contiguous_buf();
            let raw = pixels.iter().map(|p| p.value()).collect();
            ImageBuffer::<Luma<u16>, _>::from_raw(width as u32, height as u32, raw)
                .map(DynamicImage::ImageLuma16)
        }
    };
    image.ok_or_else(|| ConvertError::Decode(i18n::t("errors.avifSize")))
}

/// Rendu d'un SVG avec ce qu'il contient seulement. Une image désignée par un chemin ou une
/// adresse (`<image href="…/photo.jpg">`) n'est pas lue : un SVG piégé ferait sinon entrer
/// dans le résultat, puis dans un partage, une autre image du compte de l'utilisateur. Les
/// images intégrées au fichier (`data:`) restent rendues.
fn render_svg(bytes: &[u8]) -> Result<DynamicImage, ConvertError> {
    let mut options = usvg::Options {
        resources_dir: None,
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
            resolve_string: Box::new(|_, _| None),
        },
        ..Default::default()
    };
    options.fontdb = system_fonts();
    let tree = usvg::Tree::from_data(bytes, &options)
        .map_err(|err| ConvertError::Decode(err.to_string()))?;

    let size = tree.size();
    let longest = size.width().max(size.height());
    let scale = (SVG_MIN_SIDE / longest).clamp(1.0, SVG_MAX_SIDE / longest);
    let width = (size.width() * scale).round().max(1.0) as u32;
    let height = (size.height() * scale).round().max(1.0) as u32;

    let mut pixmap = tiny_skia::Pixmap::new(width, height).ok_or(ConvertError::TooLarge)?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );

    // tiny-skia travaille en alpha prémultiplié
    let raw = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| {
            let color = pixel.demultiply();
            [color.red(), color.green(), color.blue(), color.alpha()]
        })
        .collect();
    let image = RgbaImage::from_raw(width, height, raw).expect("taille du pixmap cohérente");
    Ok(DynamicImage::ImageRgba8(image))
}

/// Chargées une seule fois : la lecture des polices du système prend du temps.
fn system_fonts() -> Arc<usvg::fontdb::Database> {
    static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    FONTS
        .get_or_init(|| {
            let mut database = usvg::fontdb::Database::new();
            database.load_system_fonts();
            Arc::new(database)
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use image::{ImageEncoder, Rgb, codecs::png::PngEncoder};

    use super::*;

    const GREEN: Rgb<u8> = Rgb([40, 180, 60]);

    fn green() -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_pixel(2, 2, GREEN))
    }

    #[test]
    fn un_profil_display_p3_est_ramene_en_srgb() {
        let p3 = ColorProfile::new_display_p3().encode().unwrap();
        let pixel = *to_srgb(green(), &p3).to_rgb8().get_pixel(0, 0);
        // Le vert de Display P3 est plus vif : en sRGB, il lui faut plus de vert et moins de rouge
        assert!(pixel[1] > GREEN[1] && pixel[0] < GREEN[0], "{pixel:?}");

        let srgb = ColorProfile::new_srgb().encode().unwrap();
        assert_eq!(*to_srgb(green(), &srgb).to_rgb8().get_pixel(0, 0), GREEN);
        assert_eq!(
            *to_srgb(green(), b"pas un profil").to_rgb8().get_pixel(0, 0),
            GREEN
        );
    }

    #[test]
    fn un_png_en_display_p3_est_lu_en_srgb() {
        let mut bytes = Vec::new();
        let mut encoder = PngEncoder::new(&mut bytes);
        encoder
            .set_icc_profile(ColorProfile::new_display_p3().encode().unwrap())
            .unwrap();
        encoder
            .write_image(green().as_bytes(), 2, 2, image::ExtendedColorType::Rgb8)
            .unwrap();
        let pixel = *decode(&bytes, InputFormat::Png)
            .unwrap()
            .to_rgb8()
            .get_pixel(0, 0);
        assert_ne!(pixel, GREEN);
    }
}
