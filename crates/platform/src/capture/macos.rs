use std::cell::Cell;
use std::path::Path;
use std::process::{Command, Stdio};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSColor, NSColorSampler, NSColorSpace};
use objc2_foundation::{NSArray, NSDictionary, NSString, NSURL};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
};

use super::{CaptureError, CaptureTarget};

pub const SCREEN_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// L'outil du système trace la zone ou désigne la fenêtre à notre place, avec son interface
/// habituelle ; Échap annule sans écrire de fichier. Il lui faut l'autorisation de l'app qui le
/// lance, y compris pour une zone choisie à la main.
pub fn capture(target: CaptureTarget, delay: u32, output: &Path) -> Result<bool, CaptureError> {
    let mut command = Command::new("/usr/sbin/screencapture");
    command.arg("-x");
    if delay > 0 {
        command.args(["-T", &delay.to_string()]);
    }
    match target {
        CaptureTarget::Zone => {
            command.args(["-i", "-s"]);
        }
        CaptureTarget::Window => {
            command.args(["-i", "-w"]);
        }
        CaptureTarget::Screen => {}
    }
    let result = command
        .arg(output)
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| CaptureError::Failed(err.to_string()))?;
    if output.is_file() {
        return Ok(true);
    }
    let errors = String::from_utf8_lossy(&result.stderr);
    // SAFETY : simple question au système
    if refused(&errors) || !unsafe { CGPreflightScreenCaptureAccess() } {
        // SAFETY : la question ne s'affiche qu'une fois ; ensuite, c'est sans effet
        unsafe { CGRequestScreenCaptureAccess() };
        return Err(CaptureError::Permission);
    }
    match errors.trim() {
        "" => Ok(false),
        reason => Err(CaptureError::Failed(reason.to_string())),
    }
}

/// Message de `screencapture` quand macOS lui refuse l'écran.
fn refused(errors: &str) -> bool {
    errors.contains("could not create image")
}

/// Vision, le moteur de Live Text, reconnaît les lignes dans l'ordre de lecture.
pub fn read_text(image: &Path) -> Result<String, String> {
    let path = image
        .to_str()
        .ok_or_else(|| i18n::t("capture.unreadablePath"))?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let options = NSDictionary::new();
    // SAFETY : un dictionnaire vide ne contient aucune option à interpréter
    let handler = unsafe {
        VNImageRequestHandler::initWithURL_options(VNImageRequestHandler::alloc(), &url, &options)
    };
    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setUsesLanguageCorrection(true);
    let languages = ["fr-FR", "en-US"].map(NSString::from_str);
    request.setRecognitionLanguages(&NSArray::from_retained_slice(&languages));

    let generic: Retained<VNRequest> = Retained::into_super(Retained::into_super(request.clone()));
    handler
        .performRequests_error(&NSArray::from_retained_slice(&[generic]))
        .map_err(|err| err.localizedDescription().to_string())?;

    let mut lines = Vec::new();
    for observation in request.results().unwrap_or_default().iter() {
        if let Some(best) = observation.topCandidates(1).firstObject() {
            lines.push(best.string().to_string());
        }
    }
    Ok(lines.join("\n"))
}

/// La loupe du système : elle ne demande aucune autorisation, et Échap annule.
pub fn pick_color(done: impl FnOnce(Option<[u8; 3]>) + Send + 'static) {
    if MainThreadMarker::new().is_none() {
        done(None);
        return;
    }
    let sampler = NSColorSampler::new();
    let done = Cell::new(Some(done));
    // Le bloc garde la loupe en vie jusqu'à son appel
    let keep = Cell::new(Some(sampler.clone()));
    let handler = RcBlock::new(move |color: *mut NSColor| {
        keep.take();
        // SAFETY : AppKit passe une couleur valide, ou rien
        let rgb = unsafe { color.as_ref() }.and_then(srgb);
        if let Some(done) = done.take() {
            done(rgb);
        }
    });
    // SAFETY : le bloc reste valide tant qu'AppKit le garde
    unsafe { sampler.showSamplerWithSelectionHandler(&handler) };
}

fn srgb(color: &NSColor) -> Option<[u8; 3]> {
    let color = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
    let channel = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    Some([
        channel(color.redComponent()),
        channel(color.greenComponent()),
        channel(color.blueComponent()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PNG blanc avec du texte, dessiné par AppKit.
    fn sample(path: &Path) -> bool {
        let script = path.with_extension("swift");
        let source = r#"
import AppKit
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: 900, pixelsHigh: 200, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 900, height: 200).fill()
("Bonjour Rutile" as NSString).draw(
    at: NSPoint(x: 40, y: 60),
    withAttributes: [.font: NSFont.systemFont(ofSize: 64), .foregroundColor: NSColor.black])
try rep.representation(using: .png, properties: [:])!
    .write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
"#;
        let written = std::fs::write(&script, source).is_ok();
        let drawn = written
            && Command::new("/usr/bin/swift")
                .arg(&script)
                .arg(path)
                .status()
                .is_ok_and(|status| status.success());
        let _ = std::fs::remove_file(&script);
        drawn && path.is_file()
    }

    #[test]
    fn le_refus_de_macos_se_reconnait() {
        assert!(refused("screencapture: could not create image from rect\n"));
        assert!(!refused(""));
    }

    #[test]
    fn vision_lit_le_texte_d_une_image() {
        let path = std::env::temp_dir().join(format!("rutile-ocr-{}.png", std::process::id()));
        if !sample(&path) {
            eprintln!("image de test impossible à créer : test ignoré");
            return;
        }
        let text = read_text(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(text.contains("Bonjour"), "texte lu : {text:?}");
    }
}
