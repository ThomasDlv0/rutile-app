use std::io;
use std::path::PathBuf;

use crate::OutputFormat;

/// Erreurs affichées telles quelles à l'utilisateur, d'où les messages traduits.
#[derive(Debug, thiserror::Error)]
pub enum ConvertError {
    #[error("{}", i18n::tf("errors.read", &[("path", &.path.display()), ("reason", &io_reason(.source))]))]
    Read { path: PathBuf, source: io::Error },

    #[error("{}", i18n::t("errors.unsupportedFormat"))]
    UnsupportedFormat,

    #[error("{}", i18n::tf("errors.sameFormat", &[("format", .0)]))]
    SameFormat(OutputFormat),

    #[error("{}", i18n::tf("errors.decode", &[("reason", .0)]))]
    Decode(String),

    #[error("{}", i18n::t("errors.tooLarge"))]
    TooLarge,

    #[error("{}", i18n::tf("errors.encode", &[("format", .format), ("message", .message)]))]
    Encode {
        format: OutputFormat,
        message: String,
    },

    #[error("{}", i18n::tf("errors.write", &[("dir", &.dir.display()), ("reason", &io_reason(.source))]))]
    Write { dir: PathBuf, source: io::Error },

    #[error("{}", i18n::t("errors.notRaster"))]
    NotRaster,

    #[error("{}", i18n::t("errors.alreadySmall"))]
    AlreadySmall,

    #[error("{}", i18n::t("errors.notSmaller"))]
    NotSmaller,

    #[error("{}", i18n::t("errors.noFiles"))]
    NoFiles,

    #[error("{}", i18n::tf("errors.pdf", &[("reason", .0)]))]
    Pdf(String),

    #[error("{}", i18n::t("errors.protectedPdf"))]
    ProtectedPdf,

    #[error("{}", i18n::tf("errors.archive", &[("reason", .0)]))]
    Archive(String),

    #[error("{}", i18n::tf("errors.badArchive", &[("reason", .0)]))]
    BadArchive(String),

    #[error("{}", i18n::t("errors.protectedArchive"))]
    ProtectedArchive,

    #[error("{}", i18n::t("errors.archiveTooLarge"))]
    ArchiveTooLarge,

    #[error("{}", i18n::t("errors.emptyArchive"))]
    EmptyArchive,
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
        io::ErrorKind::NotFound => i18n::t("errors.io.notFound"),
        io::ErrorKind::PermissionDenied => i18n::t("errors.io.denied"),
        io::ErrorKind::StorageFull => i18n::t("errors.io.full"),
        io::ErrorKind::ReadOnlyFilesystem => i18n::t("errors.io.readOnly"),
        io::ErrorKind::IsADirectory => i18n::t("errors.io.directory"),
        _ => error.to_string(),
    }
}
