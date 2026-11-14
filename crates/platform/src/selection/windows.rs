use std::ffi::c_void;
use std::path::PathBuf;

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize, IDispatch, IServiceProvider,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::{
    CSIDL_DESKTOP, IFolderView2, IShellBrowser, IShellWindows, IWebBrowserApp,
    SID_STopLevelBrowser, SIGDN_FILESYSPATH, SWC_DESKTOP, SWFO_NEEDDISPATCH, ShellWindows,
};
use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, GetClassNameW, GetForegroundWindow};
use windows::core::{Interface, PCWSTR, w};

use super::SelectionError;

const EXPLORER_CLASSES: [&str; 2] = ["CabinetWClass", "ExploreWClass"];
const DESKTOP_CLASSES: [&str; 2] = ["Progman", "WorkerW"];

/// Poignée de la fenêtre de l'Explorateur (ou du bureau) au premier plan.
pub fn foreground_explorer() -> Option<isize> {
    // SAFETY : simple lecture de la fenêtre active
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return None;
    }
    let class = class_name(hwnd);
    let known =
        EXPLORER_CLASSES.contains(&class.as_str()) || DESKTOP_CLASSES.contains(&class.as_str());
    known.then_some(hwnd.0 as isize)
}

pub fn explorer_selection(hwnd: isize) -> Result<Vec<PathBuf>, SelectionError> {
    let _com = ComGuard::new()?;
    let hwnd = HWND(hwnd as *mut c_void);
    let browser = if DESKTOP_CLASSES.contains(&class_name(hwnd).as_str()) {
        desktop_browser()?
    } else {
        window_browser(hwnd)?
    };
    selection_of(&browser)
}

fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 64];
    // SAFETY : le tampon est assez grand pour les classes cherchées, la longueur est bornée
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

/// COM est initialisé pour ce thread de fond le temps de la lecture.
struct ComGuard;

impl ComGuard {
    fn new() -> Result<Self, SelectionError> {
        // SAFETY : appariée avec CoUninitialize dans Drop
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(failed)?;
        Ok(ComGuard)
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        // SAFETY : CoInitializeEx a réussi sur ce même thread
        unsafe { CoUninitialize() };
    }
}

fn shell_windows() -> Result<IShellWindows, SelectionError> {
    // SAFETY : création d'un objet COM du shell, sans pointeur fourni
    unsafe { CoCreateInstance(&ShellWindows, None, CLSCTX_ALL) }.map_err(failed)
}

fn top_level_browser(dispatch: &IDispatch) -> Result<IShellBrowser, SelectionError> {
    let provider: IServiceProvider = dispatch.cast().map_err(failed)?;
    // SAFETY : le GUID de service est une constante du SDK
    unsafe { provider.QueryService(&SID_STopLevelBrowser) }.map_err(failed)
}

/// Sous Windows 11, chaque onglet est un navigateur distinct partageant la même fenêtre :
/// l'onglet affiché est le premier enfant `ShellTabWindowClass`.
fn window_browser(top: HWND) -> Result<IShellBrowser, SelectionError> {
    let windows = shell_windows()?;
    // SAFETY : recherche d'une fenêtre enfant par nom de classe
    let active_tab =
        unsafe { FindWindowExW(Some(top), None, w!("ShellTabWindowClass"), PCWSTR::null()) }.ok();
    // SAFETY : appels COM sur des objets valides du shell
    let count = unsafe { windows.Count() }.map_err(failed)?;
    let mut fallback = None;
    for index in 0..count {
        let Ok(dispatch) = (unsafe { windows.Item(&VARIANT::from(index)) }) else {
            continue;
        };
        let Ok(app) = dispatch.cast::<IWebBrowserApp>() else {
            continue;
        };
        let same_window = unsafe { app.HWND() }.is_ok_and(|handle| handle.0 == top.0 as isize);
        if !same_window {
            continue;
        }
        let browser = top_level_browser(&dispatch)?;
        match active_tab {
            Some(tab) if unsafe { browser.GetWindow() }.is_ok_and(|window| window == tab) => {
                return Ok(browser);
            }
            Some(_) => {
                fallback.get_or_insert(browser);
            }
            None => return Ok(browser),
        }
    }
    fallback.ok_or_else(|| failed(i18n::t("selection.explorerMissing")))
}

fn desktop_browser() -> Result<IShellBrowser, SelectionError> {
    let windows = shell_windows()?;
    let location = VARIANT::from(CSIDL_DESKTOP as i32);
    let root = VARIANT::default();
    let mut hwnd = 0i32;
    // SAFETY : les variants et la poignée de retour vivent pendant l'appel
    let dispatch = unsafe {
        windows.FindWindowSW(&location, &root, SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH)
    }
    .map_err(failed)?;
    top_level_browser(&dispatch)
}

fn selection_of(browser: &IShellBrowser) -> Result<Vec<PathBuf>, SelectionError> {
    // SAFETY : appels COM sur la vue active du navigateur
    let view = unsafe { browser.QueryActiveShellView() }.map_err(failed)?;
    let folder: IFolderView2 = view.cast().map_err(failed)?;
    // Une erreur ici signifie qu'aucun élément n'est sélectionné
    let Ok(items) = (unsafe { folder.GetSelection(false) }) else {
        return Ok(Vec::new());
    };
    let count = unsafe { items.GetCount() }.map_err(failed)?;
    let mut paths = Vec::new();
    for index in 0..count {
        let item = unsafe { items.GetItemAt(index) }.map_err(failed)?;
        // Les éléments virtuels (Ce PC, Corbeille…) n'ont pas de chemin de fichier
        if let Ok(name) = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) } {
            if let Ok(path) = unsafe { name.to_string() } {
                paths.push(PathBuf::from(path));
            }
            // SAFETY : la chaîne a été allouée par le shell pour l'appelant
            unsafe { CoTaskMemFree(Some(name.0 as *const c_void)) };
        }
    }
    Ok(paths)
}

fn failed(err: impl ToString) -> SelectionError {
    SelectionError::Failed(err.to_string())
}
