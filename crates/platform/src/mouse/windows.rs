use std::cell::RefCell;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::GetDpiForSystem;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, GetSystemMetrics, MSG, MSLLHOOKSTRUCT,
    PostThreadMessageW, SM_SWAPBUTTON, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_QUIT,
};

use super::{Motion, WatchError};

pub fn primary_button_pressed() -> bool {
    // GetAsyncKeyState lit les boutons physiques : les gauchers peuvent les avoir inversés
    // SAFETY : simples lectures d'état, sans pointeur
    unsafe {
        let button = if GetSystemMetrics(SM_SWAPBUTTON) != 0 {
            VK_RBUTTON
        } else {
            VK_LBUTTON
        };
        GetAsyncKeyState(i32::from(button.0)) < 0
    }
}

type Sink = Box<dyn FnMut(Motion) + Send>;

/// Le hook est une fonction sans contexte : sa destination est rangée ici.
static SINK: Mutex<Option<Sink>> = Mutex::new(None);

struct HookState {
    start: Instant,
    /// Pixels physiques par point, pour que les seuils ne dépendent pas de l'écran.
    scale: f64,
    pressed: bool,
    last: (i32, i32),
}

thread_local! {
    static STATE: RefCell<Option<HookState>> = const { RefCell::new(None) };
}

/// Installe le hook sur un thread qui fait tourner sa boucle de messages ; renvoie ce thread.
pub fn spawn(on_motion: impl FnMut(Motion) + Send + 'static) -> Result<u32, WatchError> {
    *SINK.lock().unwrap() = Some(Box::new(on_motion));
    let (ready, installed) = mpsc::channel();
    thread::Builder::new()
        .name("rutile-souris".into())
        .spawn(move || {
            // SAFETY : hook installé et retiré sur ce même thread, qui pompe ses messages
            unsafe {
                STATE.with(|state| {
                    *state.borrow_mut() = Some(HookState {
                        start: Instant::now(),
                        scale: f64::from(GetDpiForSystem()) / 96.0,
                        pressed: false,
                        last: (0, 0),
                    });
                });
                let module = GetModuleHandleW(None).ok();
                let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(hook), module.map(Into::into), 0);
                let _ = ready.send(
                    hook.as_ref()
                        .map(|_| GetCurrentThreadId())
                        .map_err(|err| err.to_string()),
                );
                let Ok(hook) = hook else {
                    return;
                };
                let mut message = MSG::default();
                // GetMessageW renvoie 0 sur WM_QUIT, envoyé par `stop`
                while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                let _ = UnhookWindowsHookEx(hook);
            }
        })
        .map_err(|err| WatchError::Unsupported(err.to_string()))?;
    installed
        .recv()
        .map_err(|err| WatchError::Unsupported(err.to_string()))?
        .map_err(WatchError::Unsupported)
}

pub fn stop(thread_id: u32) {
    // SAFETY : message sans paramètre vers le thread du hook
    let _ = unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
}

/// Windows retire un hook trop lent : ce code ne fait que transmettre le mouvement.
unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        // SAFETY : pour WH_MOUSE_LL, lparam pointe vers un MSLLHOOKSTRUCT valide pendant l'appel
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        handle(wparam.0 as u32, info.pt.x, info.pt.y);
    }
    // SAFETY : on passe la main aux autres hooks avec les paramètres reçus
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn handle(message: u32, x: i32, y: i32) {
    let motion = STATE.with(|state| {
        let mut state = state.borrow_mut();
        let state = state.as_mut()?;
        let (dx, dy) = match message {
            WM_LBUTTONDOWN => {
                state.pressed = true;
                (0, 0)
            }
            WM_LBUTTONUP => {
                state.pressed = false;
                (0, 0)
            }
            WM_MOUSEMOVE if state.pressed => (x - state.last.0, y - state.last.1),
            _ => {
                state.last = (x, y);
                return None;
            }
        };
        state.last = (x, y);
        Some(Motion {
            time: state.start.elapsed(),
            dx: f64::from(dx) / state.scale,
            dy: f64::from(dy) / state.scale,
            pressed: state.pressed,
        })
    });
    if let Some(motion) = motion
        && let Some(sink) = SINK.lock().unwrap().as_mut()
    {
        sink(motion);
    }
}
