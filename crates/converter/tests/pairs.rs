//! Chaque format d'entrée vers chaque format de sortie (48 paires).

mod common;

use converter::{ConvertError, InputFormat, OutputFormat, Quality, convert, detect_format};

fn check_all_outputs(input: InputFormat) {
    let dir = tempfile::tempdir().unwrap();
    let source = common::write_fixture(dir.path(), input);
    assert_eq!(
        detect_format(&source).unwrap(),
        input,
        "détection du format"
    );

    let mut failures = Vec::new();
    for target in OutputFormat::ALL {
        let label = format!("{input:?} → {target:?}");
        let result = convert(&source, target, &Quality::default());

        if input.as_output() == Some(target) {
            if !matches!(result, Err(ConvertError::SameFormat(_))) {
                failures.push(format!("{label} : le même format devrait être refusé"));
            }
            continue;
        }

        let conversion = match result {
            Ok(conversion) => conversion,
            Err(err) => {
                failures.push(format!("{label} : {err}"));
                continue;
            }
        };
        let output = &conversion.output;
        if output.parent() != source.parent()
            || output.file_stem() != source.file_stem()
            || output.extension().and_then(|ext| ext.to_str()) != Some(target.extension())
        {
            failures.push(format!("{label} : chemin inattendu {}", output.display()));
        }
        if conversion.approximate != (target == OutputFormat::Svg) {
            failures.push(format!("{label} : mention « approximatif » incorrecte"));
        }

        let expected = match target {
            OutputFormat::Ico => (256, 256),
            _ => common::expected_size(input),
        };
        match common::output_size(output, target) {
            Ok(size) if size == expected => {}
            Ok(size) => failures.push(format!("{label} : {size:?} au lieu de {expected:?}")),
            Err(err) => failures.push(format!("{label} : sortie illisible ({err})")),
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

macro_rules! pairs {
    ($($name:ident => $format:ident),* $(,)?) => {
        $(
            #[test]
            fn $name() {
                check_all_outputs(InputFormat::$format);
            }
        )*
    };
}

pairs! {
    depuis_png => Png,
    depuis_jpeg => Jpeg,
    depuis_webp => Webp,
    depuis_avif => Avif,
    depuis_gif => Gif,
    depuis_bmp => Bmp,
    depuis_tiff => Tiff,
    depuis_ico => Ico,
    depuis_svg => Svg,
}

#[test]
fn quarante_huit_paires_couvertes() {
    let pairs = InputFormat::ALL
        .iter()
        .flat_map(|input| OutputFormat::ALL.map(|output| (*input, output)))
        .filter(|(input, output)| input.as_output() != Some(*output))
        .count();
    assert_eq!(pairs, 48);
}
