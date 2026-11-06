use std::sync::atomic::{AtomicU32, Ordering};

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ClientMessageEvent, ConnectionExt, EventMask, Window};

use super::{Layout, PlacementError, Rect};

static REMEMBERED: AtomicU32 = AtomicU32::new(0);

fn failed(err: impl ToString) -> PlacementError {
    PlacementError::Failed(err.to_string())
}

/// Fenêtre active d'après le gestionnaire de fenêtres.
fn active_window(connection: &impl Connection, root: Window) -> Option<Window> {
    let atom = connection
        .intern_atom(false, b"_NET_ACTIVE_WINDOW")
        .ok()?
        .reply()
        .ok()?
        .atom;
    connection
        .get_property(false, root, atom, AtomEnum::WINDOW, 0, 1)
        .ok()?
        .reply()
        .ok()?
        .value32()?
        .next()
        .filter(|window| *window != 0)
}

pub fn remember() {
    if !super::supported() {
        return;
    }
    let Ok((connection, screen)) = x11rb::connect(None) else {
        return;
    };
    let root = connection.setup().roots[screen].root;
    if let Some(window) = active_window(&connection, root) {
        REMEMBERED.store(window, Ordering::Relaxed);
    }
}

fn work_area(connection: &impl Connection, root: Window) -> Option<Rect> {
    let atom = connection
        .intern_atom(false, b"_NET_WORKAREA")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let reply = connection
        .get_property(false, root, atom, AtomEnum::CARDINAL, 0, 4)
        .ok()?
        .reply()
        .ok()?;
    let mut values = reply.value32()?;
    Some(Rect {
        x: values.next()?.into(),
        y: values.next()?.into(),
        width: values.next()?.into(),
        height: values.next()?.into(),
    })
}

fn send(
    connection: &impl Connection,
    root: Window,
    window: Window,
    name: &[u8],
    data: [u32; 5],
) -> Result<(), PlacementError> {
    let atom = connection.intern_atom(false, name).map_err(failed)?;
    let atom = atom.reply().map_err(failed)?.atom;
    let event = ClientMessageEvent::new(32, window, atom, data);
    connection
        .send_event(
            false,
            root,
            EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
            event,
        )
        .map_err(failed)?;
    Ok(())
}

pub fn place(layout: Layout) -> Result<(), PlacementError> {
    if !super::supported() {
        return Err(PlacementError::Failed(
            "Wayland ne laisse pas une app déplacer les fenêtres".into(),
        ));
    }
    let window = REMEMBERED.load(Ordering::Relaxed);
    if window == 0 {
        return Err(PlacementError::NoWindow);
    }
    let (connection, screen) = x11rb::connect(None).map_err(failed)?;
    let root = connection.setup().roots[screen].root;
    let area = work_area(&connection, root).ok_or(PlacementError::NoWindow)?;
    let geometry = connection.get_geometry(window).map_err(failed)?;
    let geometry = geometry.reply().map_err(|_| PlacementError::NoWindow)?;
    let current = Rect {
        x: 0.0,
        y: 0.0,
        width: geometry.width.into(),
        height: geometry.height.into(),
    };
    let frame = layout.frame(area, current);

    // Une fenêtre agrandie ne se déplace pas : on retire d'abord cet état
    let state = connection.intern_atom(false, b"_NET_WM_STATE_MAXIMIZED_VERT");
    let vertical = state.map_err(failed)?.reply().map_err(failed)?.atom;
    let state = connection.intern_atom(false, b"_NET_WM_STATE_MAXIMIZED_HORZ");
    let horizontal = state.map_err(failed)?.reply().map_err(failed)?.atom;
    const REMOVE: u32 = 0;
    send(
        &connection,
        root,
        window,
        b"_NET_WM_STATE",
        [REMOVE, vertical, horizontal, 1, 0],
    )?;

    // Bits 8 à 11 : x, y, largeur et hauteur fournis ; bit 12 : demande d'une app
    const FLAGS: u32 = 0b1111 << 8 | 1 << 12;
    send(
        &connection,
        root,
        window,
        b"_NET_MOVERESIZE_WINDOW",
        [
            FLAGS,
            frame.x as u32,
            frame.y as u32,
            frame.width as u32,
            frame.height as u32,
        ],
    )?;
    connection.flush().map_err(failed)?;
    Ok(())
}
