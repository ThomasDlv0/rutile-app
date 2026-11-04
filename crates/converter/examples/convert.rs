//! Essai manuel de la conversion, sans l'interface :
//! `cargo run -p rutile-converter --example convert -- <fichier> <format> [qualité]`

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use converter::{OutputFormat, Quality, convert, detect_format};

const USAGE: &str = "Usage : convert <fichier> <png|jpeg|webp|avif|svg|ico> [qualité 1-100]";

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (Some(path), Some(format)) = (args.next(), args.next()) else {
        eprintln!("{USAGE}");
        return ExitCode::FAILURE;
    };
    let Some(target) = OutputFormat::parse(&format) else {
        eprintln!("Format inconnu : {format}\n{USAGE}");
        return ExitCode::FAILURE;
    };
    let mut quality = Quality::default();
    if let Some(value) = args.next() {
        match value.parse::<u8>() {
            Ok(value @ 1..=100) => {
                quality = Quality {
                    jpeg: value,
                    webp: value,
                    avif: value,
                }
            }
            _ => {
                eprintln!("Qualité invalide : {value}\n{USAGE}");
                return ExitCode::FAILURE;
            }
        }
    }

    let path = PathBuf::from(path);
    match detect_format(&path) {
        Ok(source) => println!("Format d'origine : {source:?}"),
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::FAILURE;
        }
    }

    let start = Instant::now();
    match convert(&path, target, &quality) {
        Ok(conversion) => {
            println!(
                "Converti en {} ({} ms) : {}",
                conversion.format,
                start.elapsed().as_millis(),
                conversion.output.display()
            );
            if conversion.approximate {
                println!("Attention : la vectorisation n'est qu'une approximation de l'image.");
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}
