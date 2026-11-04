#!/usr/bin/env bash
# Télécharge le FFmpeg statique embarqué dans Rutile (sidecar Tauri) pour une cible Rust, et le
# place dans src-tauri/binaries/rutile-ffmpeg-<cible>[.exe], le nom qu'attend Tauri.
#
#   scripts/fetch-ffmpeg.sh                         # cible de la machine
#   scripts/fetch-ffmpeg.sh universal-apple-darwin  # macOS Apple Silicon + Intel (lipo)
#
# Les binaires viennent de github.com/eugeneware/ffmpeg-static (FFmpeg 6.1, licence GPL v3,
# compilés par evermeet.cx, osxexperts.net, johnvansickle.com et gyan.dev) ; leur empreinte
# SHA-256 est vérifiée avant usage.
set -euo pipefail

RELEASE="b6.1.1"
BASE_URL="https://github.com/eugeneware/ffmpeg-static/releases/download/$RELEASE"

sha256_of() {
  case "$1" in
    darwin-arm64) echo "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa" ;;
    darwin-x64) echo "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106" ;;
    linux-x64) echo "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa" ;;
    win32-x64) echo "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77" ;;
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

# Télécharge, vérifie et décompresse le binaire d'une plateforme ; affiche son chemin
fetch() {
  local platform="$1" archive="$work/ffmpeg-$1.gz"
  curl -fsSL --retry 3 -o "$archive" "$BASE_URL/ffmpeg-$platform.gz"
  local expected actual
  expected="$(sha256_of "$platform")"
  actual="$(checksum "$archive")"
  if [ "$actual" != "$expected" ]; then
    echo "Empreinte inattendue pour ffmpeg-$platform : $actual" >&2
    exit 1
  fi
  gunzip -f "$archive"
  chmod +x "$work/ffmpeg-$platform"
  echo "$work/ffmpeg-$platform"
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
    # Un seul exécutable pour les deux processeurs, signé ad hoc comme l'exige Apple Silicon
    arm="$(fetch darwin-arm64)"
    intel="$(fetch darwin-x64)"
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

echo "FFmpeg prêt pour $target dans $out_dir"
