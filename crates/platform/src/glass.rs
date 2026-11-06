//! Le vrai Liquid Glass de macOS 26 : `NSGlassEffectView`, posée derrière la page de la roue.
//! Le verre réfracte et reflète ce qui est sous la fenêtre, ce qu'aucune page web ne peut faire.

use std::ffi::c_void;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, NSObjectProtocol};
use objc2::{MainThreadMarker, MainThreadOnly, msg_send};
use objc2_app_kit::{
    NSAnimationContext, NSGlassEffectView, NSGlassEffectViewStyle, NSView, NSWindow,
    NSWindowOrderingMode,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};

/// Le système a-t-il le vrai Liquid Glass ?
pub fn available() -> bool {
    AnyClass::get(c"NSGlassEffectView").is_some()
}

/// Disque ou centre de verre.
#[derive(Debug, Clone, Copy)]
pub struct Disc {
    pub center_x: f64,
    pub center_y: f64,
    pub radius: f64,
}

/// Le verre déjà posé dans la fenêtre.
fn glass_views(content: &NSView) -> Vec<Retained<NSView>> {
    let Some(class) = AnyClass::get(c"NSGlassEffectView") else {
        return Vec::new();
    };
    content
        .subviews()
        .to_vec()
        .into_iter()
        .filter(|view| view.isKindOfClass(class))
        .collect()
}

fn glass_view(
    mtm: MainThreadMarker,
    disc: Disc,
    style: NSGlassEffectViewStyle,
) -> Retained<NSGlassEffectView> {
    let frame = NSRect::new(
        NSPoint::new(disc.center_x - disc.radius, disc.center_y - disc.radius),
        NSSize::new(disc.radius * 2.0, disc.radius * 2.0),
    );
    let view = NSGlassEffectView::initWithFrame(NSGlassEffectView::alloc(mtm), frame);
    view.setCornerRadius(disc.radius);
    view.setStyle(style);
    view
}

/// Pose le verre sous la page de la fenêtre, ou le retire si `discs` est vide. Sans effet sur
/// une version de macOS qui ne l'a pas. À appeler depuis le thread principal.
///
/// # Safety
/// `window` doit être un `NSWindow` valide.
pub unsafe fn apply(window: *mut c_void, discs: &[Disc]) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    // SAFETY : garanti par l'appelant
    let Some(window) = (unsafe { window.cast::<NSWindow>().as_ref() }) else {
        return false;
    };
    let Some(content) = window.contentView() else {
        return false;
    };
    for view in glass_views(&content) {
        view.removeFromSuperview();
    }
    if discs.is_empty() || !available() {
        return false;
    }

    // Sous la page, qui reste la seule à recevoir la souris
    let page: Option<Retained<NSView>> = content.subviews().to_vec().into_iter().last();
    for (index, disc) in discs.iter().enumerate() {
        // Le disque en verre clair, le centre en verre plus dense, pour qu'on lise son texte
        let style = if index == 0 {
            NSGlassEffectViewStyle::Clear
        } else {
            NSGlassEffectViewStyle::Regular
        };
        let view = glass_view(mtm, *disc, style);
        // Le dernier disque doit passer au-dessus du premier, et les deux sous la page
        content.addSubview_positioned_relativeTo(
            &view,
            NSWindowOrderingMode::Below,
            page.as_deref(),
        );
    }
    true
}

/// Fondu du verre avec l'ouverture et la fermeture de la page : `alpha` de 0 à 1.
///
/// # Safety
/// `window` doit être un `NSWindow` valide.
pub unsafe fn fade(window: *mut c_void, alpha: f64, seconds: f64) {
    if MainThreadMarker::new().is_none() {
        return;
    }
    // SAFETY : garanti par l'appelant
    let Some(window) = (unsafe { window.cast::<NSWindow>().as_ref() }) else {
        return;
    };
    let Some(content) = window.contentView() else {
        return;
    };
    NSAnimationContext::beginGrouping();
    NSAnimationContext::currentContext().setDuration(seconds);
    for view in glass_views(&content) {
        if seconds <= 0.0 {
            view.setAlphaValue(alpha);
        } else {
            // SAFETY : `animator` existe sur toute NSView
            let animator: Retained<NSView> = unsafe { msg_send![&*view, animator] };
            animator.setAlphaValue(alpha);
        }
    }
    NSAnimationContext::endGrouping();
}
