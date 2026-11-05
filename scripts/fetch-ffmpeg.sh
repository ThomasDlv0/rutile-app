#!/usr/bin/env bash
# Télécharge le FFmpeg statique embarqué dans Rutile (sidecar Tauri) pour une cible Rust, et le
# place dans src-tauri/binaries/rutile-ffmpeg-<cible>[.exe], le nom qu'attend Tauri.
#
#   scripts/fetch-ffmpeg.sh                         # cible de la machine
#   scripts/fetch-ffmpeg.sh universal-apple-darwin  # macOS Apple Silicon + Intel (lipo)
#
# FFmpeg 9.0.2 (licence GPL v3), en builds statiques : macOS et Linux par Martin Riedl
# (ffmpeg.martin-riedl.de), Windows par Gyan Doshi (gyan.dev, publiés sur
# github.com/GyanD/codexffmpeg). L'empreinte SHA-256 de chaque archive est vérifiée avant usage.
set -euo pipefail

VERSION="9.0.2"

# Adresse de l'archive, son empreinte, et le chemin de l'exécutable dans l'archive
source_of() {
  local riedl="https://ffmpeg.martin-riedl.de/download"
  case "$1" in
    darwin-arm64)
      echo "$riedl/macos/arm64/1789931890_$VERSION/ffmpeg.zip" \
        "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924" ffmpeg
      ;;
    darwin-x64)
      echo "$riedl/macos/amd64/1789931006_$VERSION/ffmpeg.zip" \
        "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4" ffmpeg
      ;;
    linux-x64)
      echo "$riedl/linux/amd64/1789931100_$VERSION/ffmpeg.zip" \
        "fa8ecf4abbd290d98f7d188b8649cc6b391ae209a98452be955a15aab1909d7f" ffmpeg
      ;;
    win32-x64)
      echo "https://github.com/GyanD/codexffmpeg/releases/download/$VERSION/ffmpeg-$VERSION-essentials_build.zip" \
        "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba" \
        "ffmpeg-$VERSION-essentials_build/bin/ffmpeg.exe"
      ;;
    *) return 1 ;;
  esac
}

target="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out_dir="$root/src-tauri/binaries"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$out_dir"

checksum() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Un fichier d'une archive zip, sur la sortie standard (unzip, ou 7-Zip sous Windows)
unzip_member() {
  if command -v unzip >/dev/null; then
    unzip -p "$1" "$2"
  elif command -v 7z >/dev/null; then
    7z e -so "$1" "$2"
  else
    echo "Ni unzip ni 7z pour ouvrir l'archive de FFmpeg" >&2
    return 1
  fi
}

# Télécharge, vérifie et extrait le binaire d'une plateforme ; affiche son chemin
fetch() {
  local platform="$1" url expected member
  read -r url expected member <<<"$(source_of "$platform")"
  local archive="$work/ffmpeg-$platform.zip" binary="$work/ffmpeg-$platform"
  curl -fsSL --retry 3 -o "$archive" "$url"
  local actual
  actual="$(checksum "$archive")"
  if [ "$actual" != "$expected" ]; then
    echo "Empreinte inattendue pour FFmpeg ($platform) : $actual" >&2
    exit 1
  fi
  unzip_member "$archive" "$member" >"$binary"
  if [ ! -s "$binary" ]; then
    echo "FFmpeg absent de l'archive ($platform)" >&2
    exit 1
  fi
  chmod +x "$binary"
  echo "$binary"
}

# Les chemins passent par des variables : un échec dans fetch arrête alors le script
case "$target" in
  aarch64-apple-darwin | x86_64-apple-darwin | x86_64-unknown-linux-gnu)
    case "$target" in
      aarch64-apple-darwin) platform=darwin-arm64 ;;
      x86_64-apple-darwin) platform=darwin-x64 ;;
      *) platform=linux-x64 ;;
    esac
    binary="$(fetch "$platform")"
    cp "$binary" "$out_dir/rutile-ffmpeg-$target"
    ;;
  universal-apple-darwin)
    # Tauri compile chaque processeur à part (il veut alors leurs deux FFmpeg), puis embarque un
    # seul exécutable pour les deux, signé ad hoc comme l'exige Apple Silicon
    arm="$(fetch darwin-arm64)"
    intel="$(fetch darwin-x64)"
    cp "$arm" "$out_dir/rutile-ffmpeg-aarch64-apple-darwin"
    cp "$intel" "$out_dir/rutile-ffmpeg-x86_64-apple-darwin"
    lipo -create -output "$out_dir/rutile-ffmpeg-$target" "$arm" "$intel"
    codesign --force --sign - "$out_dir/rutile-ffmpeg-$target"
    ;;
  x86_64-pc-windows-msvc)
    binary="$(fetch win32-x64)"
    cp "$binary" "$out_dir/rutile-ffmpeg-$target.exe"
    ;;
  *)
    echo "Pas de FFmpeg embarqué prévu pour $target" >&2
    exit 1
    ;;
esac

echo "FFmpeg $VERSION prêt pour $target dans $out_dir"
