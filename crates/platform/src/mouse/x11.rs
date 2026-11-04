use std::sync::OnceLock;

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{Atom, ConnectionExt, KeyButMask, Window};
use x11rb::rust_connection::RustConnection;

/// Connexion partagée pour les lectures ponctuelles ; aucune sous Wayland, où XWayland ne
/// connaît le pointeur qu'au-dessus de ses propres fenêtres.
pub fn shared() -> Option<&'static X11> {
    static SHARED: OnceLock<Option<X11>> = OnceLock::new();
    SHARED
        .get_or_init(|| {
            if crate::session::is_wayland_session() {
                None
            } else {
                X11::connect()
            }
        })
        .as_ref()
}

/// Connexion au serveur X11 pour lire le pointeur et le glisser-déposer en cours.
pub struct X11 {
    connection: RustConnection,
    root: Window,
    xdnd_selection: Option<Atom>,
}

impl X11 {
    pub fn connect() -> Option<Self> {
        let (connection, screen) = x11rb::connect(None).ok()?;
        let root = connection.setup().roots.get(screen)?.root;
        let xdnd_selection = connection
            .intern_atom(false, b"XdndSelection")
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|reply| reply.atom);
        Some(X11 {
            connection,
            root,
            xdnd_selection,
        })
    }

    /// Position globale du pointeur et état du bouton principal, même pendant un glisser.
    pub fn pointer(&self) -> Option<(f64, f64, bool)> {
        let reply = self
            .connection
            .query_pointer(self.root)
            .ok()?
            .reply()
            .ok()?;
        let pressed = u16::from(reply.mask) & u16::from(KeyButMask::BUTTON1) != 0;
        Some((f64::from(reply.root_x), f64::from(reply.root_y), pressed))
    }

    /// Une app possède la sélection XDND : un glisser-déposer est en cours.
    pub fn drag_in_progress(&self) -> Option<bool> {
        let reply = self
            .connection
            .get_selection_owner(self.xdnd_selection?)
            .ok()?
            .reply()
            .ok()?;
        Some(reply.owner != x11rb::NONE)
    }
}
