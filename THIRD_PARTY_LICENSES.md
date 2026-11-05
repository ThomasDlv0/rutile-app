# Logiciels tiers embarqués

## FFmpeg

Les paquets de Rutile (`.dmg`, installateurs Windows, AppImage, `.deb`, `.rpm`) contiennent un
exécutable FFmpeg, `rutile-ffmpeg`, utilisé pour la conversion des vidéos. Rutile le lance comme
un programme séparé : il n'est pas lié au code de Rutile.

- Projet : FFmpeg, https://ffmpeg.org
- Version : 9.0.2, en builds statiques compilés par Martin Riedl pour macOS et Linux
  (https://ffmpeg.martin-riedl.de, script de compilation :
  https://git.martin-riedl.de/ffmpeg/build-script) et par Gyan Doshi pour Windows
  (https://www.gyan.dev/ffmpeg/builds/, build « essentials » publié sur
  https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2)
- Licence : GNU General Public License v3 (https://www.gnu.org/licenses/gpl-3.0.html), car ces
  builds incluent libx264 et d'autres bibliothèques sous GPL
- Code source : https://ffmpeg.org/download.html et https://git.ffmpeg.org/ffmpeg.git (version
  `n9.0.2`) ; les options de compilation de chaque build sont affichées par
  `rutile-ffmpeg -version`

Pour utiliser un autre FFmpeg, définir la variable d'environnement `RUTILE_FFMPEG` avec son
chemin.
