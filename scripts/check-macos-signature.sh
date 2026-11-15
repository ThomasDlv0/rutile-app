#!/usr/bin/env bash
# Vérifie qu'une app Rutile est signée par le certificat « Rutile Self-Signed » et que son
# exigence désignée dépend de ce certificat, pas de l'empreinte du binaire : c'est ce qui permet
# à macOS de garder les autorisations d'une version à l'autre.
#
#   scripts/check-macos-signature.sh chemin/vers/Rutile.app
set -euo pipefail

fail() {
  echo "::error::$1"
  exit 1
}

app="${1:-}"
[ -d "$app" ] || fail "Usage : scripts/check-macos-signature.sh chemin/vers/Rutile.app"
codesign --verify --deep --strict "$app"
details="$(codesign -dvv "$app" 2>&1)"
requirement="$(codesign -d -r- "$app" 2>&1)"
grep -E "^(Identifier|Authority|Signature|CodeDirectory|Runtime)" <<< "$details" || true
echo "$requirement"

grep -qx "Authority=Rutile Self-Signed" <<< "$details" \
  || fail "Rutile n'est pas signé par le certificat « Rutile Self-Signed »"
grep -Eq 'certificate (root|leaf) = H"' <<< "$requirement" \
  || fail "L'exigence désignée ne cite pas le certificat"
if grep -q "cdhash" <<< "$requirement"; then
  fail "L'exigence désignée dépend de l'empreinte du binaire"
fi
for helper in "$app"/Contents/MacOS/*; do
  signed="$(codesign -dvv "$helper" 2>&1)"
  grep -qx "Authority=Rutile Self-Signed" <<< "$signed" \
    || fail "$(basename "$helper") n'est pas signé par le certificat de Rutile"
done
echo "Signature correcte : l'exigence désignée suit le certificat."
