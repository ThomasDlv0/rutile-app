#!/usr/bin/env bash
# Écrit sur la sortie standard le latest.json que lit le module de mise à jour de Rutile : pour
# chaque façon d'installer Rutile, l'adresse du fichier de mise à jour publié et sa signature.
#
#   scripts/updater-manifest.sh <dossier des paquets> <version> <adresse de la release> <notes.md>
#
# Le dossier contient les paquets construits et leurs signatures (.sig, créées avec la clé de
# TAURI_SIGNING_PRIVATE_KEY) ; les noms publiés sont ceux du job de publication. Un paquet sans
# signature n'a pas d'entrée : l'app installée par lui renvoie alors vers la page des versions.
set -euo pipefail

bundles="$1"
version="$2"
base="$3"
notes_file="$4"

signature() {
  local file
  file="$(find "$bundles" -name "$1" | head -1)"
  if [ -n "$file" ]; then cat "$file"; fi
}

# Entrées d'un fichier publié : motif de sa signature, nom publié, puis les clés où le module
# le cherche (`{système}-{processeur}-{paquet}`, puis `{système}-{processeur}`)
entries() {
  local pattern="$1" name="$2" sig
  shift 2
  sig="$(signature "$pattern")"
  [ -n "$sig" ] || return 0
  for key in "$@"; do
    jq -n --arg key "$key" --arg url "$base/$name" --arg sig "$sig" \
      '{($key): {url: $url, signature: $sig}}'
  done
}

# Un seul .app pour Apple Silicon et Intel. Sous Linux, chaque paquet se met à jour par
# lui-même, sans entrée commune : un .deb ne doit pas recevoir une AppImage.
all_entries() {
  entries '*.app.tar.gz.sig' "Rutile_${version}_macos_universal.app.tar.gz" \
    darwin-aarch64-app darwin-x86_64-app darwin-aarch64 darwin-x86_64
  entries '*-setup.exe.sig' "Rutile_${version}_windows_x64_setup.exe" \
    windows-x86_64-nsis windows-x86_64
  entries '*.msi.sig' "Rutile_${version}_windows_x64.msi" windows-x86_64-msi
  entries '*.AppImage.sig' "Rutile_${version}_linux_x86_64.AppImage" linux-x86_64-appimage
  entries '*.deb.sig' "Rutile_${version}_linux_amd64.deb" linux-x86_64-deb
  entries '*.rpm.sig' "Rutile_${version}_linux_x86_64.rpm" linux-x86_64-rpm
}
platforms="$(all_entries | jq -s 'add // {}')"

if [ "$platforms" = "{}" ]; then
  echo "Aucune signature de mise à jour dans $bundles" >&2
  exit 1
fi

# Le premier paragraphe des notes de version, en texte simple, pour la fenêtre de proposition
notes="$(awk 'NF { started = 1 } started && !NF { exit } started' "$notes_file" |
  tr '\n' ' ' | sed -e 's/\*\*//g' -e 's/  */ /g' -e 's/ $//')"

# Les notes en Markdown, jusqu'aux fichiers à télécharger (inutiles pour une mise à jour),
# pour la fenêtre de mise à jour des versions 1.5 et suivantes ; les précédentes ne lisent
# que `notes`
details="$(awk '/^## Fichiers/ { exit } { print }' "$notes_file")"

jq -n \
  --arg version "$version" \
  --arg notes "$notes" \
  --arg details "$details" \
  --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson platforms "$platforms" \
  '{version: $version, notes: $notes, details: $details, pub_date: $date, platforms: $platforms}'
