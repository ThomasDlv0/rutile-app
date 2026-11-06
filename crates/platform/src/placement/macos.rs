use std::ffi::{c_int, c_void};

use objc2::MainThreadMarker;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSScreen, NSWorkspace};
use objc2_foundation::{NSArray, NSPoint, NSSize, NSString};

use super::{Layout, PlacementError, Rect};

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateApplication(pid: c_int) -> *mut AnyObject;
    fn AXUIElementCopyAttributeValue(
        element: *const AnyObject,
        attribute: *const NSString,
        value: *mut *mut AnyObject,
    ) -> c_int;
    fn AXUIElementSetAttributeValue(
        element: *const AnyObject,
        attribute: *const NSString,
        value: *const AnyObject,
    ) -> c_int;
    fn AXValueCreate(kind: c_int, value: *const c_void) -> *mut AnyObject;
    fn AXValueGetValue(value: *const AnyObject, kind: c_int, out: *mut c_void) -> bool;
}

const AX_VALUE_POINT: c_int = 1;
const AX_VALUE_SIZE: c_int = 2;

/// Rien à noter : le panneau de la roue n'active pas Rutile, l'app d'avant reste au premier plan.
pub fn remember() {}

fn attribute(element: &AnyObject, name: &str) -> Option<Retained<AnyObject>> {
    let name = NSString::from_str(name);
    let mut value = std::ptr::null_mut();
    // SAFETY : fonction « Copy » : la valeur rendue nous appartient
    let status = unsafe { AXUIElementCopyAttributeValue(element, &*name, &mut value) };
    if status == 0 {
        unsafe { Retained::from_raw(value) }
    } else {
        None
    }
}

fn point(window: &AnyObject) -> Option<NSPoint> {
    let value = attribute(window, "AXPosition")?;
    let mut point = NSPoint::new(0.0, 0.0);
    // SAFETY : `point` correspond au type demandé
    unsafe { AXValueGetValue(&*value, AX_VALUE_POINT, (&raw mut point).cast()) }.then_some(point)
}

fn size(window: &AnyObject) -> Option<NSSize> {
    let value = attribute(window, "AXSize")?;
    let mut size = NSSize::new(0.0, 0.0);
    // SAFETY : `size` correspond au type demandé
    unsafe { AXValueGetValue(&*value, AX_VALUE_SIZE, (&raw mut size).cast()) }.then_some(size)
}

fn set(window: &AnyObject, name: &str, kind: c_int, value: *const c_void) -> bool {
    // SAFETY : `value` pointe vers un NSPoint ou un NSSize, selon `kind` ; fonction « Create »
    let Some(value) = (unsafe { Retained::<AnyObject>::from_raw(AXValueCreate(kind, value)) })
    else {
        return false;
    };
    let name = NSString::from_str(name);
    // SAFETY : objets valides pendant l'appel
    unsafe { AXUIElementSetAttributeValue(window, &*name, &*value) == 0 }
}

/// Zones utiles des écrans, en coordonnées d'Accessibilité : origine en haut à gauche de
/// l'écran principal, là où AppKit la met en bas.
fn work_areas(mtm: MainThreadMarker) -> Vec<Rect> {
    let screens: Retained<NSArray<NSScreen>> = NSScreen::screens(mtm);
    let Some(primary) = screens.firstObject() else {
        return Vec::new();
    };
    let height = primary.frame().size.height;
    screens
        .iter()
        .map(|screen| {
            let area = screen.visibleFrame();
            Rect {
                x: area.origin.x,
                y: height - area.origin.y - area.size.height,
                width: area.size.width,
                height: area.size.height,
            }
        })
        .collect()
}

pub fn place(layout: Layout) -> Result<(), PlacementError> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| PlacementError::Failed("hors du thread principal".into()))?;
    if !crate::apps::dock_access() {
        crate::apps::request_dock_access();
        return Err(PlacementError::Permission);
    }
    let front = NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .ok_or(PlacementError::NoWindow)?;
    let pid: c_int = unsafe { msg_send![&*front, processIdentifier] };
    // SAFETY : fonction « Create » : l'élément nous appartient
    let app = unsafe { Retained::from_raw(AXUIElementCreateApplication(pid)) }
        .ok_or(PlacementError::NoWindow)?;
    let window = attribute(&app, "AXFocusedWindow").ok_or(PlacementError::NoWindow)?;

    let position = point(&window).ok_or(PlacementError::NoWindow)?;
    let current_size = size(&window).ok_or(PlacementError::NoWindow)?;
    let current = Rect {
        x: position.x,
        y: position.y,
        width: current_size.width,
        height: current_size.height,
    };
    let (center_x, center_y) = (
        current.x + current.width / 2.0,
        current.y + current.height / 2.0,
    );
    let areas = work_areas(mtm);
    let area = areas
        .iter()
        .find(|area| {
            (area.x..area.x + area.width).contains(&center_x)
                && (area.y..area.y + area.height).contains(&center_y)
        })
        .or(areas.first())
        .copied()
        .ok_or(PlacementError::NoWindow)?;
    let frame = layout.frame(area, current);

    let origin = NSPoint::new(frame.x, frame.y);
    let target = NSSize::new(frame.width, frame.height);
    // Deux fois la taille : une fenêtre peut refuser une taille qui dépasse de son écran actuel,
    // puis l'accepter une fois déplacée
    let placed = set(&window, "AXSize", AX_VALUE_SIZE, (&raw const target).cast())
        | set(
            &window,
            "AXPosition",
            AX_VALUE_POINT,
            (&raw const origin).cast(),
        )
        | set(&window, "AXSize", AX_VALUE_SIZE, (&raw const target).cast());
    if placed {
        Ok(())
    } else {
        Err(PlacementError::Failed(
            "cette fenêtre ne se laisse pas déplacer".into(),
        ))
    }
}
