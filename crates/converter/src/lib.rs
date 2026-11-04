//! Conversion d'images de Rutile : lecture, encodage et écriture à côté de l'original.
//!
//! Les fonctions sont bloquantes : l'app les appelle depuis un thread séparé.

mod decode;
mod encode;
mod error;
mod format;
mod output;

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

pub use encode::ICO_SIZES;
pub use error::ConvertError;
pub use format::{InputFormat, OutputFormat};

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
    let bytes = std::fs::read(input).map_err(|source| ConvertError::Read {
        path: input.to_path_buf(),
        source,
    })?;
    let source = InputFormat::detect(&bytes, input).ok_or(ConvertError::UnsupportedFormat)?;
    if source.as_output() == Some(target) {
        return Err(ConvertError::SameFormat(target));
    }

    let image = decode::decode(&bytes, source, input)?;
    let encoded = encode::encode(&image, target, quality)?;
    let output = output::write_unique(input, target.extension(), &encoded)?;

    Ok(Conversion {
        output,
        format: target,
        approximate: target == OutputFormat::Svg,
    })
}
