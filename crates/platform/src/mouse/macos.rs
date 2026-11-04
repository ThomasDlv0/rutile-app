use std::ffi::c_void;

use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeFileURL};

// Constantes de CoreGraphics : kCGEventSourceStateCombinedSessionState et kCGMouseButtonLeft
const COMBINED_SESSION_STATE: i32 = 0;
const LEFT_BUTTON: u32 = 0;

#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventGetLocation(event: *const c_void) -> CGPoint;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(object: *const c_void);
}

/// Lecture de l'état global, sans autorisation particulière.
pub fn primary_button_pressed() -> bool {
    // SAFETY : simple lecture d'état, utilisable depuis n'importe quel thread
    unsafe { CGEventSourceButtonState(COMBINED_SESSION_STATE, LEFT_BUTTON) }
}

/// Position globale du curseur (points, origine en haut à gauche) et état du bouton.
pub fn pointer() -> Option<(f64, f64, bool)> {
    let pressed = primary_button_pressed();
    // SAFETY : un événement vide sert à lire la position courante, puis il est libéré
    let location = unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let location = CGEventGetLocation(event);
        CFRelease(event);
        location
    };
    Some((location.x, location.y, pressed))
}

fn drag_pasteboard() -> objc2::rc::Retained<NSPasteboard> {
    // SAFETY : constante d'AppKit, valable pendant toute la vie du programme
    NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag })
}

/// Compteur de modifications du presse-papiers de glisser : il change à chaque nouveau glisser.
pub fn drag_change_count() -> isize {
    drag_pasteboard().changeCount()
}

/// Un glisser a commencé depuis `change_count` et il transporte des fichiers.
/// Seuls les types sont lus, jamais le contenu.
pub fn file_drag_since(change_count: isize) -> bool {
    let pasteboard = drag_pasteboard();
    if pasteboard.changeCount() == change_count {
        return false;
    }
    // SAFETY : constante d'AppKit
    let file_url = unsafe { NSPasteboardTypeFileURL };
    pasteboard
        .types()
        .is_some_and(|types| types.iter().any(|kind| &*kind == file_url))
}
