use std::fmt;
use std::path::Path;

use image::ImageFormat;
use serde::{Deserialize, Serialize};

/// Formats proposés sur la roue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Png,
    Jpeg,
    Webp,
    Avif,
    Svg,
    Ico,
}

impl OutputFormat {
    pub const ALL: [OutputFormat; 6] = [
        OutputFormat::Png,
        OutputFormat::Jpeg,
        OutputFormat::Webp,
        OutputFormat::Avif,
        OutputFormat::Svg,
        OutputFormat::Ico,
    ];

    pub fn extension(self) -> &'static str {
        match self {
            OutputFormat::Png => "png",
            OutputFormat::Jpeg => "jpg",
            OutputFormat::Webp => "webp",
            OutputFormat::Avif => "avif",
            OutputFormat::Svg => "svg",
            OutputFormat::Ico => "ico",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            OutputFormat::Png => "PNG",
            OutputFormat::Jpeg => "JPEG",
            OutputFormat::Webp => "WebP",
            OutputFormat::Avif => "AVIF",
            OutputFormat::Svg => "SVG",
            OutputFormat::Ico => "ICO",
        }
    }

    /// Lecture souple, pour l'outil en ligne de commande.
    pub fn parse(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "png" => Some(OutputFormat::Png),
            "jpg" | "jpeg" => Some(OutputFormat::Jpeg),
            "webp" => Some(OutputFormat::Webp),
            "avif" => Some(OutputFormat::Avif),
            "svg" => Some(OutputFormat::Svg),
            "ico" => Some(OutputFormat::Ico),
            _ => None,
        }
    }
}

impl fmt::Display for OutputFormat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// Formats acceptés en entrée.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputFormat {
    Png,
    Jpeg,
    Webp,
    Avif,
    Gif,
    Bmp,
    Tiff,
    Ico,
    Svg,
}

impl InputFormat {
    pub const ALL: [InputFormat; 9] = [
        InputFormat::Png,
        InputFormat::Jpeg,
        InputFormat::Webp,
        InputFormat::Avif,
        InputFormat::Gif,
        InputFormat::Bmp,
        InputFormat::Tiff,
        InputFormat::Ico,
        InputFormat::Svg,
    ];

    /// Taille du début de fichier suffisante pour reconnaître tous les formats.
    pub const HEADER_LEN: usize = 4096;

    /// Détecte le format d'après le contenu ; l'extension ne départage que les SVG.
    pub fn detect(header: &[u8], path: &Path) -> Option<Self> {
        if let Ok(format) = image::guess_format(header) {
            let detected = match format {
                ImageFormat::Png => InputFormat::Png,
                ImageFormat::Jpeg => InputFormat::Jpeg,
                ImageFormat::WebP => InputFormat::Webp,
                ImageFormat::Avif => InputFormat::Avif,
                ImageFormat::Gif => InputFormat::Gif,
                ImageFormat::Bmp => InputFormat::Bmp,
                ImageFormat::Tiff => InputFormat::Tiff,
                ImageFormat::Ico => InputFormat::Ico,
                _ => return None,
            };
            return Some(detected);
        }
        looks_like_svg(header, path).then_some(InputFormat::Svg)
    }

    /// Le même format sur la roue, grisé car la conversion n'aurait pas de sens.
    pub fn as_output(self) -> Option<OutputFormat> {
        match self {
            InputFormat::Png => Some(OutputFormat::Png),
            InputFormat::Jpeg => Some(OutputFormat::Jpeg),
            InputFormat::Webp => Some(OutputFormat::Webp),
            InputFormat::Avif => Some(OutputFormat::Avif),
            InputFormat::Svg => Some(OutputFormat::Svg),
            InputFormat::Ico => Some(OutputFormat::Ico),
            InputFormat::Gif | InputFormat::Bmp | InputFormat::Tiff => None,
        }
    }

    pub(crate) fn image_format(self) -> Option<ImageFormat> {
        match self {
            InputFormat::Png => Some(ImageFormat::Png),
            InputFormat::Jpeg => Some(ImageFormat::Jpeg),
            InputFormat::Webp => Some(ImageFormat::WebP),
            InputFormat::Gif => Some(ImageFormat::Gif),
            InputFormat::Bmp => Some(ImageFormat::Bmp),
            InputFormat::Tiff => Some(ImageFormat::Tiff),
            InputFormat::Ico => Some(ImageFormat::Ico),
            InputFormat::Avif | InputFormat::Svg => None,
        }
    }
}

fn looks_like_svg(header: &[u8], path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase);
    if header.starts_with(&[0x1f, 0x8b]) {
        return extension.as_deref() == Some("svgz");
    }
    let start = &header[..header.len().min(InputFormat::HEADER_LEN)];
    extension.as_deref() == Some("svg") || String::from_utf8_lossy(start).contains("<svg")
}
