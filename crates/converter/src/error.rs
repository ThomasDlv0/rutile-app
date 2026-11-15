use std::io;
use std::panic::{self, AssertUnwindSafe};
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

    #[error("{}", i18n::t("errors.heicUnsupported"))]
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    HeicUnsupported,

    /// Une bibliothèque de lecture a paniqué sur ce fichier (voir [`shielded`]).
    #[error("{}", i18n::t("errors.damaged"))]
    Damaged,
}

/// Un fichier malformé peut faire paniquer une bibliothèque de lecture (images, PDF, ZIP) :
/// la panique devient l'erreur de ce seul fichier, au lieu d'interrompre tout un lot.
/// Chaque fonction publique qui lit un fichier passe par ici.
pub(crate) fn shielded<T>(
    work: impl FnOnce() -> Result<T, ConvertError>,
) -> Result<T, ConvertError> {
    // Le travail ne partage rien avec l'appelant : rien ne reste à moitié modifié après une panique
    panic::catch_unwind(AssertUnwindSafe(work)).unwrap_or(Err(ConvertError::Damaged))
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
        io::ErrorKind::AlreadyExists => i18n::t("errors.io.exists"),
        _ => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn une_panique_devient_l_erreur_du_fichier() {
        let crashed: Result<(), ConvertError> = shielded(|| panic!("décodeur en déroute"));
        assert!(matches!(crashed, Err(ConvertError::Damaged)));
        assert!(matches!(shielded(|| Ok(7)), Ok(7)));
        assert!(matches!(
            shielded::<()>(|| Err(ConvertError::NoFiles)),
            Err(ConvertError::NoFiles)
        ));
    }
}
