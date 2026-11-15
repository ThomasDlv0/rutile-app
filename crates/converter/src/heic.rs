//! Photos HEIC (iPhone, AirDrop), lues par ImageIO, le décodeur de macOS : l'orientation de la
//! photo est appliquée et ses couleurs (souvent en Display P3) sont ramenées en sRGB.
//! Ailleurs, Rutile ne sait pas encore les lire.

use image::DynamicImage;

use crate::ConvertError;

/// Marques ISO BMFF d'une image HEIF codée en HEVC, ce qu'écrit un iPhone.
const HEIC_BRANDS: [&[u8; 4]; 8] = [
    b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs",
];

/// Vrai si l'en-tête est celui d'une image HEIC (et non d'un AVIF, qui a la même enveloppe).
pub(crate) fn is_heic(header: &[u8]) -> bool {
    if header.len() < 16 || &header[4..8] != b"ftyp" {
        return false;
    }
    let size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
    let end = size.clamp(16, header.len());
    // Marque principale, version, puis marques compatibles
    let brands = std::iter::once(&header[8..12])
        .chain(
            header[16..end]
                .as_chunks::<4>()
                .0
                .iter()
                .map(|brand| brand.as_slice()),
        )
        .collect::<Vec<_>>();
    let avif = brands
        .iter()
        .any(|brand| *brand == b"avif" || *brand == b"avis");
    !avif
        && brands
            .iter()
            .any(|brand| HEIC_BRANDS.iter().any(|heic| *brand == heic.as_slice()))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn decode(_bytes: &[u8]) -> Result<DynamicImage, ConvertError> {
    Err(ConvertError::HeicUnsupported)
}

#[cfg(target_os = "macos")]
pub(crate) fn decode(bytes: &[u8]) -> Result<DynamicImage, ConvertError> {
    use std::ffi::c_void;

    use image::{RgbImage, RgbaImage};
    use objc2_core_foundation::{
        CFBoolean, CFData, CFDictionary, CFString, CFType, CGPoint, CGRect, CGSize,
    };
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
        kCGColorSpaceSRGB,
    };
    use objc2_image_io::{
        CGImageSource, kCGImageSourceCreateThumbnailFromImageAlways,
        kCGImageSourceCreateThumbnailWithTransform,
    };

    /// Au-delà, l'image n'est pas décodée (comme les limites de la crate image).
    const MAX_PIXELS: usize = 200_000_000;

    let unreadable = || ConvertError::Decode("HEIC".into());
    let data = CFData::from_bytes(bytes);
    // SAFETY : pas d'options
    let source = unsafe { CGImageSource::with_data(&data, None) }.ok_or_else(unreadable)?;

    // Une « vignette » sans taille maximale est l'image entière ; elle seule sait appliquer
    // l'orientation de la photo
    let yes: &CFType = CFBoolean::new(true).as_ref();
    // SAFETY : clés fournies par ImageIO, valeurs booléennes comme attendu
    let options = unsafe {
        CFDictionary::<CFString, CFType>::from_slices(
            &[
                kCGImageSourceCreateThumbnailFromImageAlways,
                kCGImageSourceCreateThumbnailWithTransform,
            ],
            &[yes, yes],
        )
    };
    // SAFETY : dictionnaire de clés et de valeurs de types attendus
    let image =
        unsafe { source.thumbnail_at_index(0, Some(options.as_ref())) }.ok_or_else(unreadable)?;

    let width = CGImage::width(Some(&image));
    let height = CGImage::height(Some(&image));
    if width == 0 || height == 0 {
        return Err(unreadable());
    }
    if width.saturating_mul(height) > MAX_PIXELS {
        return Err(ConvertError::TooLarge);
    }
    let opaque = matches!(
        CGImage::alpha_info(Some(&image)),
        CGImageAlphaInfo::None | CGImageAlphaInfo::NoneSkipLast | CGImageAlphaInfo::NoneSkipFirst
    );

    // Dessinée dans une image sRGB : ColorSync convertit les couleurs au passage
    // SAFETY : nom de profil fourni par CoreGraphics
    let srgb =
        CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB })).ok_or_else(unreadable)?;
    let mut pixels = vec![0u8; width * height * 4];
    let alpha = if opaque {
        CGImageAlphaInfo::NoneSkipLast
    } else {
        CGImageAlphaInfo::PremultipliedLast
    };
    {
        // SAFETY : `pixels` fait `height` lignes de `width * 4` octets et survit au contexte
        let context = unsafe {
            CGBitmapContextCreate(
                pixels.as_mut_ptr().cast::<c_void>(),
                width,
                height,
                8,
                width * 4,
                Some(&srgb),
                alpha.0,
            )
        }
        .ok_or_else(unreadable)?;
        let rect = CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(width as f64, height as f64),
        );
        CGContext::draw_image(Some(&context), rect, Some(&image));
    }

    let (width, height) = (width as u32, height as u32);
    if opaque {
        let rgb = pixels
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|pixel| [pixel[0], pixel[1], pixel[2]])
            .collect();
        return RgbImage::from_raw(width, height, rgb)
            .map(DynamicImage::ImageRgb8)
            .ok_or_else(unreadable);
    }
    // CoreGraphics travaille en alpha prémultiplié
    for pixel in pixels.as_chunks_mut::<4>().0 {
        let alpha = u16::from(pixel[3]);
        if alpha > 0 && alpha < 255 {
            for channel in &mut pixel[..3] {
                *channel = ((u16::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
    }
    RgbaImage::from_raw(width, height, pixels)
        .map(DynamicImage::ImageRgba8)
        .ok_or_else(unreadable)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ftyp(major: &[u8; 4], compatible: &[&[u8; 4]]) -> Vec<u8> {
        let size = 16 + 4 * compatible.len();
        let mut header = (size as u32).to_be_bytes().to_vec();
        header.extend_from_slice(b"ftyp");
        header.extend_from_slice(major);
        header.extend_from_slice(&[0, 0, 0, 0]);
        for brand in compatible {
            header.extend_from_slice(*brand);
        }
        header.resize(64, 0);
        header
    }

    #[test]
    fn reconnait_une_photo_heic_et_pas_un_avif() {
        assert!(is_heic(&ftyp(b"heic", &[b"mif1", b"heic"])));
        assert!(is_heic(&ftyp(b"mif1", &[b"mif1", b"heic"])));
        assert!(!is_heic(&ftyp(b"avif", &[b"mif1", b"avif"])));
        assert!(!is_heic(&ftyp(b"mif1", &[b"mif1", b"avif", b"heic"])));
        assert!(!is_heic(&ftyp(b"isom", &[b"mp41"])));
        assert!(!is_heic(b"pas une image"));
    }
}
