# Rutile

Utilitaire léger qui tourne en arrière-plan et convertit des images et des vidéos grâce à une
roue radiale : chaque part de la roue correspond à un format de sortie. Un clic au centre fait
passer la roue du mode Images (PNG, JPEG, WebP, AVIF, SVG, ICO) au mode Vidéo (MP4, WebM, MOV,
MKV, GIF, MP3).
La roue s'ouvre avec un raccourci clavier, depuis l'icône de la barre système, ou en secouant
un fichier pendant qu'on le glisse.

> État : tout est validé sur macOS. Les versions Windows et Linux compilent (le code système
> est vérifié pour chaque cible et l'intégration continue construit les paquets), mais n'ont
> pas encore été essayées sur une vraie machine.

## Installation

Les paquets sont produits par l'intégration continue (onglet *Actions* du dépôt, ou une
version GitHub pour un tag `v*`). Ils ne sont pas signés : chaque système affiche donc un
avertissement au premier lancement.

### macOS (11 ou plus récent)

1. Ouvrir le `.dmg` et glisser Rutile dans Applications.
2. Premier lancement : clic droit sur Rutile → Ouvrir, puis confirmer. Si macOS refuse,
   Réglages Système → Confidentialité et sécurité → « Ouvrir quand même ».
3. Rutile n'a pas d'icône dans le Dock : elle apparaît dans la barre des menus.

### Windows 10 et 11

1. Lancer l'installateur `Rutile_x.y.z_x64-setup.exe` (installation pour l'utilisateur, sans
   droits d'administrateur). WebView2 est installé s'il manque.
2. SmartScreen : « Informations complémentaires » → « Exécuter quand même ».

### Linux

- AppImage : `chmod +x Rutile_*.AppImage` puis la lancer. Sur Bazzite, Gear Lever (déjà
  installé) l'intègre au menu des applications. Si l'AppImage refuse de démarrer faute de
  FUSE : `./Rutile_*.AppImage --appimage-extract-and-run`.
- Paquet `.deb` pour Debian et Ubuntu : la commande `rutile` est alors dans le `PATH`.
- L'icône de la barre système demande, sous GNOME, l'extension « AppIndicator ».

### Pour le mode Vidéo : FFmpeg

Rutile utilise le FFmpeg déjà installé sur la machine, sans l'embarquer.

| Système | Installation |
|---|---|
| macOS | `brew install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` |
| Linux | `sudo apt install ffmpeg`, `sudo dnf install ffmpeg`, ou `brew install ffmpeg` sur Bazzite |

Rutile le cherche dans le `PATH`, puis aux emplacements de Homebrew, MacPorts, winget et
Linuxbrew (une app lancée depuis le Finder n'hérite pas du `PATH` du terminal). La variable
`RUTILE_FFMPEG` peut aussi indiquer son chemin. Sans FFmpeg, le mode Vidéo l'indique au centre
de la roue, avec la commande d'installation.

## Utilisation

### Ouvrir la roue

- Raccourci global : `⌘⇧Espace` sur macOS, `Ctrl+Maj+Espace` sous Windows et Linux X11.
  Un nouvel appui referme la roue. Il se change dans les réglages.
- Icône de la barre système : « Ouvrir la roue », « Réglages… », « Quitter Rutile ».
  Sous Windows, un clic gauche sur l'icône ouvre directement la roue.
- `rutile --open` ouvre la roue de Rutile déjà lancée, ou lance Rutile et l'ouvre.
  `rutile --open photo.png logo.svg` (ou les fichiers seuls) l'ouvre avec ces fichiers.
- Sous GNOME Wayland, où les apps ne peuvent pas écouter le clavier : Paramètres → Clavier →
  Raccourcis personnalisés, avec la commande `/chemin/vers/Rutile.AppImage --open`.

Si une autre app utilise déjà le même raccourci, macOS le lui laisse sans rien signaler :
il faut le libérer dans l'autre app ou en choisir un autre dans les réglages.

### Images ou vidéos

- Un clic au centre de la roue passe du mode Images au mode Vidéo, et inversement.
- Des vidéos sélectionnées ou glissées font passer la roue en mode Vidéo d'elles-mêmes, et
  des images en mode Images. Un GIF animé se convertit dans les deux modes.

### Choisir le fichier

- Si le Finder ou l'Explorateur est au premier plan, la roue reprend les fichiers qui y sont
  sélectionnés : il suffit de cliquer sur un format. Le format d'origine est grisé.
- Sinon, un clic sur un format ouvre le sélecteur de fichiers (images ou vidéos selon le
  mode), puis convertit aussitôt dans ce format.
- On peut toujours glisser un ou plusieurs fichiers directement sur une part.
- Linux : aucune interface commune ne donne la sélection des gestionnaires de fichiers.
  Avec Nautilus, un script dans `~/.local/share/nautilus/scripts/` (clic droit → Scripts)
  joue le même rôle :

  ```sh
  #!/bin/sh
  exec /chemin/vers/Rutile.AppImage --open "$@"
  ```

### Glisser et secouer

- Glisser une image sur une part et relâcher : elle est convertie tout de suite. Pendant le
  glisser, la part visée s'éclaire en bleu et le centre annonce l'action (« Convertir en WebP »).
- Relâcher au centre, sur un format grisé ou hors du disque annule.
- Une vidéo affiche son avancement au centre. `Échap` ferme la roue sans arrêter la
  conversion, et la notification arrive à la fin.
- Pendant un glisser, quelques allers-retours rapides ouvrent la roue sous le curseur, sans
  voler le focus. Lâché ailleurs, ou sans fichier au-dessus d'elle pendant 3 secondes, la roue
  se referme. La sensibilité se règle de « franc » à « léger ».
- Fermeture : `Échap`, clic à l'extérieur, ou fin de la conversion. Un clic à l'extérieur qui
  commence un glisser ne ferme pas la roue : elle attend que le bouton soit relâché.

À la fin, une notification indique le résultat ; son bouton « Afficher » (ou un clic sur la
notification) montre le fichier dans le Finder ou l'Explorateur.

### Réglages

Depuis l'icône de la barre système → « Réglages… » : raccourci, secouage et sensibilité,
qualité JPEG / WebP / AVIF, lancement à l'ouverture de session et, sur macOS, état de
l'autorisation du Finder. Ils s'appliquent tout de suite et sont enregistrés dans
`settings.json`, dans le dossier de configuration de l'app (`~/Library/Application Support/
fr.rutile.desktop` sur macOS, `%APPDATA%\fr.rutile.desktop` sous Windows,
`~/.config/fr.rutile.desktop` sous Linux).

## Autorisations

| Système | Ce qui est demandé | Pourquoi |
|---|---|---|
| macOS | Automatisation → Finder (demandée à la première utilisation) | lire les fichiers sélectionnés dans le Finder |
| macOS | Notifications | annoncer la fin d'une conversion |
| Windows | aucune | |
| Linux X11 | aucune | |
| Wayland | appartenance au groupe `input` (facultatif) | secouer un fichier |

Sur macOS, un refus de l'accès au Finder est signalé au démarrage, avec un lien vers Réglages
Système → Confidentialité et sécurité → Automatisation. L'écoute de la souris pour le secouage
ne demande aucune autorisation : Rutile relève l'état de la souris sans intercepter d'événement.

Sous Wayland, aucune app ne peut suivre la souris ailleurs que sur ses propres fenêtres.
Rutile lit donc directement les souris avec evdev, ce qui demande d'appartenir au groupe
`input`. Ce groupe permet aussi de lire le clavier : le secouage y est donc désactivé par
défaut. Sur une distribution immuable comme Bazzite, le groupe doit d'abord être copié dans
`/etc/group` :

```sh
grep -E '^input:' /usr/lib/group | sudo tee -a /etc/group
sudo usermod -aG input "$USER"
```

Puis fermer et rouvrir la session, et activer le secouage dans les réglages.

## Limites par système

| | macOS | Windows | Linux X11 | Wayland (GNOME) |
|---|---|---|---|---|
| Raccourci global | oui | oui | oui | non : `rutile --open` lié à un raccourci du système |
| Sélection du gestionnaire de fichiers | Finder | Explorateur (onglets et bureau compris) | non : script Nautilus | non : script Nautilus |
| Secouage | oui, seulement pendant un glisser de fichiers | oui | oui | avec le groupe `input` |
| Roue sous le curseur | oui | oui | oui | non : centre de l'écran |
| Bouton « Afficher » de la notification | oui | tant que la notification est à l'écran | oui | oui |

- Windows : le hook souris ne voit pas les fenêtres d'une app lancée en administrateur.
- Wayland : la roue passe par XWayland (`GDK_BACKEND=x11`), seul moyen sous GNOME de la garder
  au premier plan. Avec un pilote NVIDIA, Rutile désactive le rendu DMA-BUF de WebKitGTK, qui
  peut afficher une fenêtre vide.
- Paquets non signés : macOS (Gatekeeper) et Windows (SmartScreen) préviennent au premier
  lancement. Une signature demanderait un compte développeur Apple et un certificat de code.

## Conversion

- Entrée : PNG, JPEG, WebP, AVIF, GIF (première image), BMP, TIFF, ICO (plus grande taille) et SVG.
  Le format est reconnu d'après le contenu du fichier, pas son extension.
- Sortie : PNG, JPEG, WebP, AVIF, SVG et ICO, dans le même dossier, sous le même nom.
  Si le nom est pris, `-1`, `-2`… sont ajoutés : un fichier existant n'est jamais écrasé.
- JPEG : la transparence devient un fond blanc. ICO : tailles 16, 32, 48 et 256 px,
  l'image étant centrée sur un fond transparent si elle n'est pas carrée.
- SVG en entrée : rendu à sa taille, agrandi à 512 px de côté s'il est plus petit.
- SVG en sortie : vectorisation approximative (image réduite à 1024 px pour le tracé,
  dimensions d'origine conservées). Les dégradés deviennent des aplats.
- Qualité par défaut : JPEG 90, WebP 85, AVIF 70.

Les métadonnées (EXIF, profil de couleur ICC) ne sont pas conservées, seule l'orientation EXIF
est appliquée : une photo en Display P3 peut donc légèrement changer de couleur.

### Vidéos

- Entrée : tout ce que lit FFmpeg (MP4, MOV, WebM, MKV, AVI, WMV, FLV, MPEG-TS…), et les GIF
  animés. Le conteneur est reconnu d'après le contenu du fichier.
- MP4 et MOV : H.264 (libx264, ou l'encodeur matériel du système à défaut) et son AAC ; les
  dimensions impaires sont arrondies, comme l'exige le H.264.
- WebM : VP9 et Opus. MKV : les pistes sont recopiées sans réencodage, c'est instantané.
- GIF : 12 images par seconde, 640 px de large au plus, palette calculée sur la vidéo.
- MP3 : seulement le son ; une vidéo muette le refuse avec un message clair.
- Même règle de nom que pour les images : `clip.mp4`, puis `clip-1.mp4`… jamais d'écrasement.

## Développement

Prérequis : [Rust](https://rustup.rs) stable, Node 22 et les
[dépendances système de Tauri](https://tauri.app/start/prerequisites/). Pour compiler sur
x86_64 (Windows, Linux, Mac Intel), `nasm` est aussi nécessaire au décodeur AVIF.

```bash
npm install
npm run tauri dev        # lance l'app (icône dans la barre système)
npm test                 # tests de l'interface
cargo test --workspace   # conversion (48 paires d'images, vidéos avec FFmpeg), secouage…
npm run tauri build      # paquets d'installation du système courant
```

- Aperçu de l'interface sans Tauri : `npm run dev`, puis `http://localhost:1420/?file=photo.png`
  (ou `?file=clip.mov`) pour la roue, `http://localhost:1420/?view=settings` pour les réglages.
- Les tests vidéo utilisent le FFmpeg de la machine ; sans lui, ils s'annoncent ignorés.
- Conversion sans interface :
  `cargo run -p rutile-converter --release --example convert -- photo.jpg webp 80`
- Le code système (`crates/platform`) n'a ni Tauri ni code C : il se vérifie pour les autres
  systèmes depuis n'importe quelle machine.

  ```bash
  rustup target add x86_64-pc-windows-msvc x86_64-unknown-linux-gnu
  cargo clippy -p rutile-platform --target x86_64-pc-windows-msvc
  cargo clippy -p rutile-platform --target x86_64-unknown-linux-gnu
  ```

L'intégration continue (`.github/workflows/build.yml`) lance les tests et clippy sur macOS,
Windows et Ubuntu 22.04, puis construit le `.dmg` (Apple Silicon et Intel), l'installateur
Windows, l'AppImage et le `.deb`.

### Organisation

```
src/                    interface React + TypeScript
  wheel/                roue : rendu, géométrie, survol, dépôt
  settings/             fenêtre de réglages
crates/converter/       conversion d'images (Rust) et de vidéos (FFmpeg), sans Tauri
crates/shake_detector/  reconnaissance du secouage à partir des mouvements de la souris
crates/platform/        code propre à chaque système : souris, sélection, session
src-tauri/              app Tauri
  src/app/              roue, raccourci, barre système, réglages, notifications…
```
