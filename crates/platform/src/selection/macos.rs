use std::ffi::c_void;
use std::path::PathBuf;
use std::process::Command;

use objc2_app_kit::NSWorkspace;

use super::SelectionError;

const FINDER: &str = "com.apple.finder";

/// Volet « Automatisation » des Réglages Système.
pub const AUTOMATION_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

pub fn finder_is_frontmost() -> bool {
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .and_then(|app| app.bundleIdentifier())
        .is_some_and(|id| id.to_string() == FINDER)
}

/// Chemins POSIX de la sélection, un par ligne (bureau compris quand il a le focus).
const SELECTION_SCRIPT: &str = r#"tell application "Finder"
    set output to ""
    repeat with anItem in (selection as alias list)
        set output to output & POSIX path of anItem & linefeed
    end repeat
    return output
end tell"#;

/// osascript est lancé par Rutile : macOS demande l'autorisation au nom de Rutile.
pub fn finder_selection() -> Result<Vec<PathBuf>, SelectionError> {
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", SELECTION_SCRIPT])
        .output()
        .map_err(|err| SelectionError::Failed(err.to_string()))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(
            if message.contains(&ERR_AE_EVENT_NOT_PERMITTED.to_string()) {
                SelectionError::PermissionDenied
            } else {
                SelectionError::Failed(message.trim().to_string())
            },
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutomationPermission {
    Granted,
    Denied,
    /// Pas encore demandée : macOS posera la question à la première utilisation.
    NotAsked,
    Unknown,
}

// Apple Events (CoreServices)
#[repr(C)]
struct AEDesc {
    descriptor_type: u32,
    data_handle: *mut c_void,
}

const TYPE_APPLICATION_BUNDLE_ID: u32 = u32::from_be_bytes(*b"bund");
const TYPE_WILDCARD: u32 = u32::from_be_bytes(*b"****");
const NO_ERR: i32 = 0;
const ERR_AE_EVENT_NOT_PERMITTED: i32 = -1743;
const ERR_AE_EVENT_WOULD_REQUIRE_USER_CONSENT: i32 = -1744;

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn AECreateDesc(type_code: u32, data: *const c_void, size: isize, result: *mut AEDesc) -> i16;
    fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
    fn AEDeterminePermissionToAutomateTarget(
        target: *const AEDesc,
        event_class: u32,
        event_id: u32,
        ask_user_if_needed: u8,
    ) -> i32;
}

/// État de l'autorisation de piloter le Finder, sans jamais poser la question.
pub fn finder_automation_permission() -> AutomationPermission {
    let mut target = AEDesc {
        descriptor_type: 0,
        data_handle: std::ptr::null_mut(),
    };
    // SAFETY : descripteur créé à partir d'une chaîne valide, puis libéré
    let status = unsafe {
        let created = AECreateDesc(
            TYPE_APPLICATION_BUNDLE_ID,
            FINDER.as_ptr().cast(),
            FINDER.len() as isize,
            &mut target,
        );
        if created != 0 {
            return AutomationPermission::Unknown;
        }
        let status =
            AEDeterminePermissionToAutomateTarget(&target, TYPE_WILDCARD, TYPE_WILDCARD, 0);
        AEDisposeDesc(&mut target);
        status
    };
    match status {
        NO_ERR => AutomationPermission::Granted,
        ERR_AE_EVENT_NOT_PERMITTED => AutomationPermission::Denied,
        ERR_AE_EVENT_WOULD_REQUIRE_USER_CONSENT => AutomationPermission::NotAsked,
        _ => AutomationPermission::Unknown,
    }
}
