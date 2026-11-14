import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { GemIcon } from "../GemIcon";
import {
  UPDATE_PROMPT_EVENT,
  acceptUpdate,
  dismissUpdate,
  fitUpdateWindow,
  openReleases,
  updateView,
  type UpdatePrompt,
  type UpdateView,
} from "./ipc";
import { type Inline, parseNotes } from "./notes";
import "./update.css";

// Aperçu dans un navigateur : `?view=update&state=available|downloading|installing|uptodate|error`
// et `&platform=windows|linux` pour la barre dessinée par la page
const PREVIEW_NOTES = `**Rutile 1.5.0** soigne son allure : un nouveau logo, des réglages animés et cette fenêtre de mise à jour.

## Nouveautés

- **Nouveau logo** : la roue et sa gemme, redessinées.
- **Réglages animés** : la bulle de l'onglet choisi glisse d'un onglet à l'autre.
- **Contour de la roue** : aucun par défaut, clair, noir, ou la couleur de votre choix.
- **Vos roues dans Couleurs** : chaque roue que vous créez a son onglet.

## À savoir

- **macOS** : macOS peut oublier les autorisations Enregistrement de l'écran et Accessibilité
  après la mise à jour : retirez Rutile de la liste avec « − », puis autorisez-le de nouveau.`;

function previewView(): UpdateView {
  const params = new URLSearchParams(window.location.search);
  const prompts: Record<string, UpdatePrompt> = {
    available: { step: "available", version: "1.5.0", current: "1.4.0", notes: PREVIEW_NOTES },
    downloading: { step: "downloading", version: "1.5.0", progress: 0.42 },
    installing: { step: "installing", version: "1.5.0" },
    uptodate: { step: "upToDate", current: "1.4.0" },
    error: {
      step: "failed",
      message:
        "Cette installation ne se met pas à jour toute seule : téléchargez la nouvelle version sur https://github.com/ThomasDlv0/rutile-app/releases/latest",
    },
  };
  return {
    platform: params.get("platform") ?? "macos",
    prompt: prompts[params.get("state") ?? "available"] ?? prompts.available,
  };
}

export function UpdateApp() {
  const [view, setView] = useState<UpdateView | null>(isTauri() ? null : previewView);
  const page = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTauri()) return;
    void updateView().then(setView);
    const unlisten = listen<UpdatePrompt>(UPDATE_PROMPT_EVENT, ({ payload }) =>
      setView((current) => current && { ...current, prompt: payload }),
    );
    return () => void unlisten.then((stop) => stop());
  }, []);

  // La fenêtre prend la hauteur de la page, à chaque changement d'état
  const ready = view !== null;
  useLayoutEffect(() => {
    const element = page.current;
    if (!isTauri() || !element) return;
    const fit = () => void fitUpdateWindow(Math.ceil(element.getBoundingClientRect().height));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready]);

  const prompt = view?.prompt ?? null;
  const busy = prompt?.step === "downloading" || prompt?.step === "installing";
  const later = () => {
    if (isTauri()) void dismissUpdate();
  };
  const accept = () => {
    if (isTauri()) void acceptUpdate();
    // Aperçu : l'état suivant, sans rien télécharger
    else if (prompt?.step === "available")
      setView((current) =>
        current && { ...current, prompt: { step: "downloading", version: prompt.version, progress: 0 } },
      );
  };

  // Échap : plus tard ; Entrée : le bouton principal. Un bouton qui a le focus garde la sienne
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLButtonElement) return;
      if (event.key === "Escape" && !busy) later();
      else if (event.key === "Enter" && prompt) {
        if (prompt.step === "available") accept();
        else if (!busy) later();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Aperçu : le téléchargement avance tout seul
  const previewProgress = !isTauri() && prompt?.step === "downloading";
  useEffect(() => {
    if (!previewProgress) return;
    const timer = window.setInterval(
      () =>
        setView((current) => {
          if (current?.prompt?.step !== "downloading") return current;
          const progress = ((current.prompt.progress ?? 0) + 0.04) % 1.04;
          return { ...current, prompt: { ...current.prompt, progress: Math.min(progress, 1) } };
        }),
      120,
    );
    return () => window.clearInterval(timer);
  }, [previewProgress]);

  if (!view) return null;
  const platform = view.platform === "macos" ? "macos" : view.platform === "windows" ? "windows" : "linux";

  return (
    <div ref={page} className="update-page" data-platform={platform} data-preview={!isTauri() || undefined}>
      <div className="update-bar" data-tauri-drag-region>
        {platform !== "macos" && (
          <button
            type="button"
            className="update-close"
            aria-label={busy ? "Masquer" : "Fermer"}
            title={busy ? "Masquer (le téléchargement continue)" : "Fermer"}
            onClick={later}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1 1l8 8M9 1L1 9" />
            </svg>
          </button>
        )}
      </div>
      {prompt && <PromptView prompt={prompt} onLater={later} onAccept={accept} />}
    </div>
  );
}

function PromptView({
  prompt,
  onLater,
  onAccept,
}: {
  prompt: UpdatePrompt;
  onLater: () => void;
  onAccept: () => void;
}) {
  switch (prompt.step) {
    case "available":
      return (
        <>
          <Hero
            title={`Rutile ${prompt.version} est disponible`}
            subtitle={
              <span className="update-versions">
                <span className="version-pill">{prompt.current}</span>
                <svg className="version-arrow" width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
                  <path d="M1 5h13M10 1l4 4-4 4" />
                </svg>
                <span className="version-pill" data-new>
                  {prompt.version}
                </span>
              </span>
            }
          />
          {prompt.notes && <Notes markdown={prompt.notes} />}
          <p className="update-footnote">Rutile redémarrera une fois la mise à jour installée.</p>
          <div className="update-actions">
            <button type="button" className="update-button" onClick={onLater}>
              Plus tard
            </button>
            <button type="button" className="update-button" data-primary onClick={onAccept}>
              Mettre à jour
            </button>
          </div>
        </>
      );
    case "downloading": {
      const percent = prompt.progress === null ? null : Math.round(prompt.progress * 100);
      return (
        <>
          <Hero badge="busy" title={`Téléchargement de Rutile ${prompt.version}`} />
          <Progress value={prompt.progress} label={percent === null ? "Téléchargement…" : `${percent} %`} />
          <p className="update-footnote">
            Rutile redémarrera tout seul une fois la mise à jour installée. Vous pouvez fermer cette
            fenêtre en attendant.
          </p>
          <div className="update-actions">
            <button type="button" className="update-button" onClick={onLater}>
              Masquer
            </button>
          </div>
        </>
      );
    }
    case "installing":
      return (
        <>
          <Hero badge="busy" title={`Installation de Rutile ${prompt.version}`} />
          <Progress value={null} label="Vérifiée · Rutile va redémarrer…" />
          <div className="update-actions-spacer" />
        </>
      );
    case "upToDate":
      return (
        <>
          <Hero
            badge="ok"
            title="Rutile est à jour"
            subtitle={`Vous avez la dernière version, ${prompt.current}.`}
          />
          <div className="update-actions">
            <button type="button" className="update-button" data-primary onClick={onLater}>
              OK
            </button>
          </div>
        </>
      );
    case "failed":
      return (
        <>
          <Hero badge="error" title="Mise à jour impossible" />
          <p className="update-message">{prompt.message}</p>
          <div className="update-actions">
            <button
              type="button"
              className="update-button"
              onClick={() => {
                if (isTauri()) void openReleases();
              }}
            >
              Page des versions
            </button>
            <button type="button" className="update-button" data-primary onClick={onLater}>
              Fermer
            </button>
          </div>
        </>
      );
  }
}

/** Logo, titre et sous-titre ; la pastille dit où en est la mise à jour. */
function Hero({
  badge,
  title,
  subtitle,
}: {
  badge?: "busy" | "ok" | "error";
  title: string;
  subtitle?: ReactNode;
}) {
  return (
    <header className="update-hero">
      <div className="update-logo" data-badge={badge}>
        <span className="update-logo-glow" aria-hidden="true" />
        {badge === "busy" && <span className="update-logo-ring" aria-hidden="true" />}
        <GemIcon size={68} />
        {(badge === "ok" || badge === "error") && (
          <span className="update-badge" data-kind={badge} aria-hidden="true">
            {badge === "ok" ? (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M2.5 6.3l2.3 2.3 4.7-5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M6 2.6v4.2M6 9.2v.1" />
              </svg>
            )}
          </span>
        )}
      </div>
      <h1 className="update-title">{title}</h1>
      {subtitle && <p className="update-subtitle">{subtitle}</p>}
    </header>
  );
}

/** Barre d'avancement ; sans valeur, elle défile. */
function Progress({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="update-progress">
      <div
        className="update-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value === null ? undefined : Math.round(value * 100)}
        data-indeterminate={value === null || undefined}
      >
        <div
          className="update-progress-fill"
          style={value === null ? undefined : { width: `${Math.max(value, 0.02) * 100}%` }}
        />
      </div>
      <span className="update-progress-label">{label}</span>
    </div>
  );
}

function Notes({ markdown }: { markdown: string }) {
  const blocks = parseNotes(markdown);
  return (
    <div className="update-notes" tabIndex={0} aria-label="Nouveautés">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <h2 key={index}>
                <Inlines inlines={block.inlines} />
              </h2>
            );
          case "paragraph":
            return (
              <p key={index}>
                <Inlines inlines={block.inlines} />
              </p>
            );
          case "list":
            return (
              <ul key={index}>
                {block.items.map((item, i) => (
                  <li key={i}>
                    <Inlines inlines={item} />
                  </li>
                ))}
              </ul>
            );
        }
      })}
    </div>
  );
}

function Inlines({ inlines }: { inlines: readonly Inline[] }) {
  return inlines.map((inline, index) =>
    inline.strong ? (
      <strong key={index}>{inline.text}</strong>
    ) : inline.code ? (
      <code key={index}>{inline.text}</code>
    ) : (
      <span key={index}>{inline.text}</span>
    ),
  );
}
