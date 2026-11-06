use std::io;
use std::path::PathBuf;

use crate::OutputFormat;

/// Erreurs affichées telles quelles à l'utilisateur, d'où les messages en français.
#[derive(Debug, thiserror::Error)]
pub enum ConvertError {
    #[error("Impossible de lire « {} » : {}", .path.display(), io_reason(.source))]
    Read { path: PathBuf, source: io::Error },

    #[error(
        "Ce fichier n'est pas une image prise en charge \
         (PNG, JPEG, WebP, AVIF, GIF, BMP, TIFF, ICO ou SVG)."
    )]
    UnsupportedFormat,

    #[error("Le fichier est déjà au format {0}.")]
    SameFormat(OutputFormat),

    #[error("Image illisible ou endommagée ({0}).")]
    Decode(String),

    #[error("Image trop grande pour être convertie.")]
    TooLarge,

    #[error("Échec de l'encodage en {format} ({message}).")]
    Encode {
        format: OutputFormat,
        message: String,
    },

    #[error("Impossible d'écrire dans « {} » : {}", .dir.display(), io_reason(.source))]
    Write { dir: PathBuf, source: io::Error },

    #[error("Cette action ne s'applique pas aux images SVG et ICO.")]
    NotRaster,

    #[error("Cette image est déjà assez petite.")]
    AlreadySmall,

    #[error("Impossible de compresser davantage cette image.")]
    NotSmaller,

    #[error("Aucun fichier à traiter.")]
    NoFiles,

    #[error("PDF illisible ou endommagé ({0}).")]
    Pdf(String),

    #[error("Ce PDF est protégé par un mot de passe.")]
    ProtectedPdf,

    #[error("Échec de la création de l'archive ({0}).")]
    Archive(String),
}

impl ConvertError {
    pub(crate) fn encode(format: OutputFormat, message: impl ToString) -> Self {
        ConvertError::Encode {
            format,
            message: message.to_string(),
        }
    }

    pub(crate) fn decode(error: image::ImageError) -> Self {
        match error {
            image::ImageError::Limits(_) => ConvertError::TooLarge,
            other => ConvertError::Decode(other.to_string()),
        }
    }
}

fn io_reason(error: &io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => "fichier ou dossier introuvable".into(),
        io::ErrorKind::PermissionDenied => "accès refusé".into(),
        io::ErrorKind::StorageFull => "disque plein".into(),
        io::ErrorKind::ReadOnlyFilesystem => "disque en lecture seule".into(),
        io::ErrorKind::IsADirectory => "c'est un dossier, pas une image".into(),
        _ => error.to_string(),
    }
}
