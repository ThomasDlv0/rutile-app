#!/usr/bin/env bash
# Prépare la signature macOS de Rutile sur une machine de CI : importe le certificat auto-signé
# « Rutile Self-Signed » (secrets MACOS_SIGNING_CERTIFICATE, le .p12 en base64, et
# MACOS_SIGNING_PASSWORD) dans un trousseau temporaire où codesign le trouve par son nom
# (src-tauri/tauri.signing.conf.json).
#
# Pourquoi un certificat, même auto-signé : macOS rattache les autorisations (Accessibilité,
# Enregistrement de l'écran, Automatisation) à l'exigence désignée de l'app. Signée « ad hoc »,
# elle dépend de l'empreinte du binaire, qui change à chaque version ; signée par un
# certificat, elle dépend du certificat et ne change plus.
#
# Tauri sait importer un certificat (APPLE_CERTIFICATE), mais n'y reconnaît que ceux d'Apple.
# L'original et son mot de passe sont dans ~/.tauri/rutile-signing.* sur le Mac de Thomas.
set -euo pipefail

: "${MACOS_SIGNING_CERTIFICATE:?secret MACOS_SIGNING_CERTIFICATE absent}"
: "${MACOS_SIGNING_PASSWORD:?secret MACOS_SIGNING_PASSWORD absent}"

work="${RUNNER_TEMP:-$(mktemp -d)}"
keychain="$work/rutile-signing.keychain-db"
keychain_password="$(openssl rand -hex 16)"
certificate="$work/rutile-signing.p12"
trap 'rm -f "$certificate"' EXIT

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
printf '%s' "$MACOS_SIGNING_CERTIFICATE" | base64 --decode > "$certificate"
security import "$certificate" -k "$keychain" -P "$MACOS_SIGNING_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" \
  "$keychain" > /dev/null
# Devant les trousseaux de la machine, que codesign parcourt
# shellcheck disable=SC2046
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
security find-certificate -c "Rutile Self-Signed" "$keychain" > /dev/null
echo "Certificat « Rutile Self-Signed » prêt dans $keychain"
