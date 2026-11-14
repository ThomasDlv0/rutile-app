import { invoke } from "@tauri-apps/api/core";

/** Ce que montre la fenêtre de mise à jour (`Prompt` dans updates.rs). */
export type UpdatePrompt =
  /** Une version plus récente est publiée ; `notes` en Markdown. */
  | { step: "available"; version: string; current: string; notes: string | null }
  /** Téléchargement en cours ; `progress` de 0 à 1 quand la taille est connue. */
  | { step: "downloading"; version: string; progress: number | null }
  /** Téléchargée et vérifiée : la mise à jour s'installe, puis Rutile redémarre. */
  | { step: "installing"; version: string }
  /** Recherche demandée : rien de plus récent. */
  | { step: "upToDate"; current: string }
  /** Recherche ou installation impossible. */
  | { step: "failed"; message: string };

export interface UpdateView {
  /** `macos`, `windows` ou `linux` : la barre de titre n'est pas la même. */
  platform: string;
  prompt: UpdatePrompt | null;
}

/** Nouvel état de la fenêtre. */
export const UPDATE_PROMPT_EVENT = "update://prompt";

export const updateView = () => invoke<UpdateView>("update_view");
/** La fenêtre prend la hauteur du contenu, et s'affiche la première fois. */
export const fitUpdateWindow = (height: number) => invoke("fit_update_window", { height });
/** Télécharge et installe la version proposée ; l'avancement arrive par `UPDATE_PROMPT_EVENT`. */
export const acceptUpdate = () => invoke("accept_update");
/** Ferme la fenêtre ; un téléchargement en cours continue. */
export const dismissUpdate = () => invoke("dismiss_update");
/** Page des versions publiées, dans le navigateur. */
export const openReleases = () => invoke("open_releases");
