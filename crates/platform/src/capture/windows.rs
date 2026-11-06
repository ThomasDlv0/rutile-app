use std::mem::size_of;
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::{FileAccessMode, StorageFile};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, GetPixel, ReleaseDC, SRCCOPY,
    SelectObject,
};
use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetCursorPos, GetMessageW, GetSystemMetrics, MSG,
    PostThreadMessageW, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, SW_SHOWNORMAL, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    WH_MOUSE_LL, WM_LBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN,
};
use windows::core::{HSTRING, PCWSTR, w};

use super::{CaptureError, CaptureTarget};
use crate::placement;

/// Temps laissé pour tracer une zone avec l'outil de capture de Windows.
const SNIP_TIMEOUT: Duration = Duration::from_secs(60);
const SNIP_POLL: Duration = Duration::from_millis(150);
/// La pipette se referme d'elle-même si personne ne clique.
const PICK_TIMEOUT: Duration = Duration::from_secs(30);

fn failed(err: impl ToString) -> CaptureError {
    CaptureError::Failed(err.to_string())
}

pub fn capture(target: CaptureTarget, delay: u32, output: &Path) -> Result<bool, CaptureError> {
    thread::sleep(Duration::from_secs(delay.into()));
    match target {
        CaptureTarget::Zone => snip(output),
        CaptureTarget::Window => {
            let area = window_area().ok_or_else(|| failed("aucune fenêtre active"))?;
            save_area(area, output).map(|()| true)
        }
        CaptureTarget::Screen => {
            // SAFETY : simples lectures de métriques du système
            let area = unsafe {
                RECT {
                    left: GetSystemMetrics(SM_XVIRTUALSCREEN),
                    top: GetSystemMetrics(SM_YVIRTUALSCREEN),
                    right: GetSystemMetrics(SM_XVIRTUALSCREEN)
                        + GetSystemMetrics(SM_CXVIRTUALSCREEN),
                    bottom: GetSystemMetrics(SM_YVIRTUALSCREEN)
                        + GetSystemMetrics(SM_CYVIRTUALSCREEN),
                }
            };
            save_area(area, output).map(|()| true)
        }
    }
}

/// L'outil de capture de Windows met la zone dans le presse-papiers : on attend qu'elle y
/// arrive. Annuler n'y change rien, d'où le délai.
fn snip(output: &Path) -> Result<bool, CaptureError> {
    // SAFETY : simple lecture d'un compteur
    let before = unsafe { GetClipboardSequenceNumber() };
    // SAFETY : chaînes valides pendant l'appel, sans fenêtre parente
    let opened = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            w!("ms-screenclip:"),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if opened.0 as isize <= 32 {
        return Err(failed("l'outil de capture de Windows ne s'ouvre pas"));
    }
    let start = Instant::now();
    while start.elapsed() < SNIP_TIMEOUT {
        thread::sleep(SNIP_POLL);
        // SAFETY : simple lecture d'un compteur
        if unsafe { GetClipboardSequenceNumber() } == before {
            continue;
        }
        let image = arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.get_image())
            .map_err(failed)?;
        return image::save_buffer(
            output,
            &image.bytes,
            image.width as u32,
            image.height as u32,
            image::ColorType::Rgba8,
        )
        .map(|()| true)
        .map_err(failed);
    }
    Ok(false)
}

/// Rectangle visible de la fenêtre active avant l'ouverture de la roue.
fn window_area() -> Option<RECT> {
    let window = HWND(placement::remembered_window()? as *mut _);
    let mut area = RECT::default();
    // SAFETY : `area` a la taille annoncée
    unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut area).cast(),
            size_of::<RECT>() as u32,
        )
    }
    .ok()?;
    Some(area)
}

fn save_area(area: RECT, output: &Path) -> Result<(), CaptureError> {
    let (width, height) = (area.right - area.left, area.bottom - area.top);
    if width <= 0 || height <= 0 {
        return Err(failed("rectangle vide"));
    }
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    // SAFETY : les objets GDI sont libérés plus bas ; `pixels` a la taille décrite par `info`
    unsafe {
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let previous = SelectObject(memory, bitmap.into());
        let copied = BitBlt(
            memory,
            0,
            0,
            width,
            height,
            Some(screen),
            area.left,
            area.top,
            SRCCOPY,
        );
        SelectObject(memory, previous);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Négatif : les lignes arrivent de haut en bas
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let read = GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        copied.map_err(failed)?;
        if read == 0 {
            return Err(failed("lecture de l'écran impossible"));
        }
    }
    // GDI donne du BGRA, avec une transparence sans valeur
    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
    image::save_buffer(
        output,
        &pixels,
        width as u32,
        height as u32,
        image::ColorType::Rgba8,
    )
    .map_err(failed)
}

/// Windows.Media.Ocr, dans les langues installées sur le système.
pub fn read_text(image: &Path) -> Result<String, String> {
    let describe = |err: windows::core::Error| err.message();
    let path = std::path::absolute(image).map_err(|err| err.to_string())?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_os_str()))
        .map_err(describe)?
        .join()
        .map_err(describe)?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(describe)?
        .join()
        .map_err(describe)?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(describe)?
        .join()
        .map_err(describe)?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(describe)?
        .join()
        .map_err(describe)?;
    let bitmap = SoftwareBitmap::Convert(&bitmap, BitmapPixelFormat::Bgra8).map_err(describe)?;
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .or_else(|_| {
            OcrEngine::TryCreateFromLanguage(&Language::CreateLanguage(&HSTRING::from("en-US"))?)
        })
        .map_err(|_| "Aucune langue de reconnaissance n'est installée sur Windows.".to_string())?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(describe)?
        .join()
        .map_err(describe)?;
    let mut lines = Vec::new();
    for line in result.Lines().map_err(describe)? {
        lines.push(line.Text().map_err(describe)?.to_string());
    }
    Ok(lines.join("\n"))
}

/// Résultat de la pipette, lu par le crochet de souris.
static PICKED: Mutex<Option<Option<[u8; 3]>>> = Mutex::new(None);

/// Le prochain clic gauche prend la couleur sans atteindre l'app en dessous ; un clic droit
/// annule.
unsafe extern "system" fn on_mouse(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 {
        let message = message.0 as u32;
        if message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN {
            let picked = (message == WM_LBUTTONDOWN)
                .then(pixel_under_cursor)
                .flatten();
            *PICKED.lock().unwrap() = Some(picked);
            // SAFETY : file de messages du thread du crochet
            unsafe {
                let _ = PostThreadMessageW(GetCurrentThreadId(), WM_QUIT, WPARAM(0), LPARAM(0));
            }
            return LRESULT(1);
        }
    }
    // SAFETY : arguments reçus tels quels
    unsafe { CallNextHookEx(None, code, message, data) }
}

fn pixel_under_cursor() -> Option<[u8; 3]> {
    let mut point = POINT::default();
    // SAFETY : `point` est valide ; le DC de l'écran est rendu aussitôt
    unsafe {
        GetCursorPos(&mut point).ok()?;
        let screen = GetDC(None);
        let color = GetPixel(screen, point.x, point.y);
        ReleaseDC(None, screen);
        // COLORREF : 0x00BBGGRR ; un point hors de l'écran donne CLR_INVALID
        (color.0 != u32::MAX).then_some([
            (color.0 & 0xff) as u8,
            ((color.0 >> 8) & 0xff) as u8,
            ((color.0 >> 16) & 0xff) as u8,
        ])
    }
}

pub fn pick_color(done: impl FnOnce(Option<[u8; 3]>) + Send + 'static) {
    thread::spawn(move || {
        *PICKED.lock().unwrap() = None;
        // SAFETY : le crochet est retiré avant la fin du thread qui le pompe
        let hook = unsafe {
            let module = GetModuleHandleW(None).ok();
            SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), module.map(Into::into), 0)
        };
        let Ok(hook) = hook else {
            done(None);
            return;
        };
        // SAFETY : identifiant du thread courant
        let thread = unsafe { GetCurrentThreadId() };
        // Échap ou le délai referment la pipette depuis un second thread : le premier reste
        // dans sa boucle de messages, que le crochet exige
        thread::spawn(move || {
            let start = Instant::now();
            while start.elapsed() < PICK_TIMEOUT && PICKED.lock().unwrap().is_none() {
                // SAFETY : simple lecture de l'état d'une touche
                if unsafe { GetAsyncKeyState(i32::from(VK_ESCAPE.0)) } < 0 {
                    break;
                }
                thread::sleep(Duration::from_millis(30));
            }
            // SAFETY : un message posté à un thread qui peut avoir fini est ignoré
            let _ = unsafe { PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0)) };
        });
        let mut message = MSG::default();
        // SAFETY : `message` est valide ; WM_QUIT termine la boucle
        unsafe {
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            let _ = UnhookWindowsHookEx(hook);
        }
        done(PICKED.lock().unwrap().take().flatten());
    });
}
