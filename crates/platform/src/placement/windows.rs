use std::mem::size_of;
use std::sync::atomic::{AtomicIsize, Ordering};

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, IsWindow, SW_RESTORE, SWP_NOACTIVATE, SWP_NOZORDER,
    SetWindowPos, ShowWindow,
};

use super::{Layout, PlacementError, Rect};

static REMEMBERED: AtomicIsize = AtomicIsize::new(0);

pub fn remember() {
    // SAFETY : simple lecture
    let window = unsafe { GetForegroundWindow() };
    REMEMBERED.store(window.0 as isize, Ordering::Relaxed);
}

pub fn remembered() -> Option<isize> {
    let window = REMEMBERED.load(Ordering::Relaxed);
    (window != 0).then_some(window)
}

fn rect(area: RECT) -> Rect {
    Rect {
        x: area.left.into(),
        y: area.top.into(),
        width: (area.right - area.left).into(),
        height: (area.bottom - area.top).into(),
    }
}

/// Les fenêtres de Windows ont une bordure invisible autour de leur cadre visible : sans la
/// compter, deux moitiés d'écran laisseraient un espace entre elles.
fn invisible_border(window: HWND, outer: RECT) -> (i32, i32, i32, i32) {
    let mut visible = RECT::default();
    // SAFETY : `visible` a la taille annoncée
    let read = unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut visible).cast(),
            size_of::<RECT>() as u32,
        )
    };
    if read.is_err() {
        return (0, 0, 0, 0);
    }
    (
        visible.left - outer.left,
        visible.top - outer.top,
        outer.right - visible.right,
        outer.bottom - visible.bottom,
    )
}

pub fn place(layout: Layout) -> Result<(), PlacementError> {
    let window = HWND(remembered().ok_or(PlacementError::NoWindow)? as *mut _);
    // SAFETY : une fenêtre fermée entre-temps est simplement signalée
    if !unsafe { IsWindow(Some(window)) }.as_bool() {
        return Err(PlacementError::NoWindow);
    }
    // SAFETY : `window` vient d'être vérifiée ; les structures sont valides pendant les appels
    unsafe {
        // Une fenêtre agrandie ne se déplace pas
        let _ = ShowWindow(window, SW_RESTORE);
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err(PlacementError::Failed("écran introuvable".into()));
        }
        let mut outer = RECT::default();
        GetWindowRect(window, &mut outer).map_err(|err| PlacementError::Failed(err.message()))?;
        let (left, top, right, bottom) = invisible_border(window, outer);
        let frame = layout.frame(rect(info.rcWork), rect(outer));
        SetWindowPos(
            window,
            None,
            frame.x as i32 - left,
            frame.y as i32 - top,
            frame.width as i32 + left + right,
            frame.height as i32 + top + bottom,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
        .map_err(|err| PlacementError::Failed(err.message()))
    }
}
