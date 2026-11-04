//! Images d'AppKit converties en PNG, pour les icônes d'apps et de services de partage.

use objc2::AnyThread;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize};

/// Côté de l'icône en points ; un écran Retina la rend au double.
const ICON_SIZE: f64 = 128.0;

/// Rend l'image à la taille d'une icône, en prenant sa meilleure représentation.
pub fn png(image: &NSImage) -> Option<Vec<u8>> {
    let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(ICON_SIZE, ICON_SIZE));
    // SAFETY : rectangle valide pendant l'appel, sans contexte ni indications
    let cg_image = unsafe { image.CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
    let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg_image);
    // SAFETY : dictionnaire de propriétés vide, accepté par AppKit
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(png.to_vec())
}
