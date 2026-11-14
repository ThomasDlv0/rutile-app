use std::io::Cursor;
use std::sync::{Arc, OnceLock};

use image::{
    DynamicImage, ImageBuffer, ImageDecoder, ImageReader, Luma, Rgb, RgbImage, Rgba, RgbaImage,
    metadata::Orientation,
};
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
    let mut image = DynamicImage::from_decoder(decoder).map_err(ConvertError::decode)?;
    image.apply_orientation(orientation);
    Ok(image)
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
