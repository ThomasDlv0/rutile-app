//! Conversions vidéo avec le vrai FFmpeg. Ignorées (avec un message) s'il n'est pas installé.

use std::path::{Path, PathBuf};
use std::process::Command;

use converter::video::{self, VideoError, VideoFormat};

/// Petite vidéo de test : mire et bip d'une seconde, aux dimensions impaires (321 × 241)
/// pour vérifier l'arrondi exigé par le H.264. FFV1 dans un MKV accepte ces dimensions.
fn source(dir: &Path, with_audio: bool) -> Option<PathBuf> {
    video::ffmpeg()?;
    let path = dir.join(if with_audio { "clip.mkv" } else { "muet.mkv" });
    let mut command = Command::new(ffmpeg_path());
    command.args(["-hide_banner", "-loglevel", "error", "-y"]);
    command.args([
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=321x241:rate=25:duration=1",
    ]);
    if with_audio {
        command.args(["-f", "lavfi", "-i", "sine=frequency=440:duration=1"]);
        command.args(["-c:a", "flac"]);
    }
    command.args(["-c:v", "ffv1"]).arg(&path);
    command.status().ok()?.success().then_some(path)
}

fn ffmpeg_path() -> PathBuf {
    // Le test utilise le même FFmpeg que Rutile, trouvé dans le PATH ou chez Homebrew
    let candidates = [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ];
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("ffmpeg"))
}

/// Types des pistes et largeur de la première image, lus par ffprobe.
fn streams(path: &Path) -> (Vec<String>, Option<u32>) {
    let ffprobe = ffmpeg_path().with_file_name("ffprobe");
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&output.stdout);
    let mut kinds = Vec::new();
    let mut width = None;
    for line in text.lines() {
        let mut fields = line.split(',');
        kinds.push(fields.next().unwrap_or_default().to_string());
        if let Some(value) = fields.next().and_then(|w| w.parse().ok()) {
            width.get_or_insert(value);
        }
    }
    (kinds, width)
}

#[test]
fn chaque_format_video_est_produit() {
    let dir = tempfile::tempdir().unwrap();
    let Some(clip) = source(dir.path(), true) else {
        eprintln!("FFmpeg absent : test ignoré");
        return;
    };

    for format in VideoFormat::ALL {
        if format == VideoFormat::Mkv {
            assert!(matches!(
                video::convert_video(&clip, format, |_| {}),
                Err(VideoError::SameFormat(VideoFormat::Mkv))
            ));
            continue;
        }
        let mut progress = Vec::new();
        let conversion = video::convert_video(&clip, format, |value| progress.push(value))
            .unwrap_or_else(|err| panic!("{format} : {err}"));
        let output = conversion.output;
        assert_eq!(output.extension().unwrap(), format.extension());
        assert_eq!(progress.last(), Some(&1.0), "{format} : progression finale");

        let (kinds, width) = streams(&output);
        match format {
            VideoFormat::Mp3 => assert_eq!(kinds, ["audio"], "MP3 : son seul"),
            VideoFormat::Gif => assert_eq!(kinds, ["video"], "GIF : image seule"),
            _ => {
                assert!(kinds.contains(&"video".to_string()), "{format} : {kinds:?}");
                assert!(kinds.contains(&"audio".to_string()), "{format} : {kinds:?}");
            }
        }
        if matches!(format, VideoFormat::Mp4 | VideoFormat::Mov) {
            assert_eq!(
                width,
                Some(320),
                "{format} : largeur arrondie au nombre pair"
            );
        }
    }
}

#[test]
fn le_mkv_recopie_les_pistes_d_un_mp4() {
    let dir = tempfile::tempdir().unwrap();
    let Some(clip) = source(dir.path(), true) else {
        eprintln!("FFmpeg absent : test ignoré");
        return;
    };
    let mp4 = video::convert_video(&clip, VideoFormat::Mp4, |_| {})
        .unwrap()
        .output;
    let mkv = video::convert_video(&mp4, VideoFormat::Mkv, |_| {})
        .unwrap()
        .output;

    // Le nom « clip.mkv » est pris par la source : le résultat devient « clip-1.mkv »
    assert_eq!(mkv.file_name().unwrap(), "clip-1.mkv");
    assert_eq!(streams(&mkv).0, ["video", "audio"]);
}

#[test]
fn une_video_muette_n_a_pas_de_son_a_extraire() {
    let dir = tempfile::tempdir().unwrap();
    let Some(muet) = source(dir.path(), false) else {
        eprintln!("FFmpeg absent : test ignoré");
        return;
    };
    let error = video::convert_video(&muet, VideoFormat::Mp3, |_| {}).unwrap_err();
    assert!(matches!(error, VideoError::NoAudio), "{error:?}");
    assert_eq!(error.to_string(), "Cette vidéo n'a pas de son à extraire.");
    // Aucun fichier vide ne reste à côté de la source
    assert!(!dir.path().join("muet.mp3").exists());
}

#[test]
fn un_fichier_qui_n_est_pas_une_video_echoue_proprement() {
    let dir = tempfile::tempdir().unwrap();
    if video::ffmpeg().is_none() {
        eprintln!("FFmpeg absent : test ignoré");
        return;
    }
    let fake = dir.path().join("faux.mp4");
    std::fs::write(&fake, "pas une vidéo").unwrap();

    let error = video::convert_video(&fake, VideoFormat::Webm, |_| {}).unwrap_err();
    assert!(
        matches!(
            error,
            VideoError::Failed(_) | VideoError::NoVideo | VideoError::UnsupportedInput
        ),
        "{error:?}"
    );
    assert!(!dir.path().join("faux.webm").exists());
}

#[test]
fn un_autre_format_deguise_en_video_est_refuse() {
    let dir = tempfile::tempdir().unwrap();
    if video::ffmpeg().is_none() {
        eprintln!("FFmpeg absent : test ignoré");
        return;
    }
    // Sans limite, FFmpeg lirait cette image avec son lecteur de PNG, comme n'importe lequel
    // de ses centaines de lecteurs de format : seuls les conteneurs vidéo passent
    let disguised = dir.path().join("image.ts");
    let status = Command::new(ffmpeg_path())
        .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"])
        .args([
            "-i",
            "testsrc=size=64x48",
            "-frames:v",
            "1",
            "-f",
            "image2",
            "-c:v",
            "png",
        ])
        .arg(&disguised)
        .status()
        .unwrap();
    assert!(status.success());

    let error = video::convert_video(&disguised, VideoFormat::Mp4, |_| {}).unwrap_err();
    assert!(
        matches!(error, VideoError::UnsupportedInput | VideoError::Failed(_)),
        "{error:?}"
    );
    assert!(!dir.path().join("image.mp4").exists());
}
