import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Éléments du groupe qui portent la bulle : l'onglet ou le bouton choisi. */
const SELECTED = ':scope > [aria-selected="true"], :scope > [aria-checked="true"]';

/** Groupe d'onglets ou de boutons segmentés dont la sélection est une bulle qui glisse d'un
 * élément à l'autre. Les enfants marquent l'élément choisi par `aria-selected` ou
 * `aria-checked` ; `selected` dit quand le choix change. */
export function BubbleGroup({
  as: Tag = "div",
  className,
  role,
  label,
  selected,
  children,
}: {
  as?: "div" | "nav";
  className: string;
  role: "tablist" | "radiogroup";
  label: string;
  selected: unknown;
  children: ReactNode;
}) {
  const group = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  // La première fois, la bulle apparaît à sa place sans glisser depuis le coin
  const placed = useRef(false);

  useLayoutEffect(() => {
    const element = group.current;
    const shape = bubble.current;
    if (!element || !shape) return;
    const place = (animate: boolean) => {
      const target = element.querySelector<HTMLElement>(SELECTED);
      if (!target) {
        shape.style.opacity = "0";
        return;
      }
      if (!animate) shape.style.transition = "none";
      shape.style.opacity = "1";
      shape.style.width = `${target.offsetWidth}px`;
      shape.style.height = `${target.offsetHeight}px`;
      shape.style.transform = `translate(${target.offsetLeft}px, ${target.offsetTop}px)`;
      if (!animate) {
        // Appliqué tout de suite, avant de rendre les transitions
        void shape.offsetWidth;
        shape.style.transition = "";
      }
    };
    place(placed.current);
    placed.current = true;
    // Le groupe ou un de ses éléments change de taille (fenêtre, police chargée, nom modifié) :
    // la bulle suit sans glisser. Le premier appel de l'observateur ne fait que constater la
    // taille actuelle
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) first = false;
      else place(false);
    });
    // Le groupe, et chacun de ses éléments : un onglet qui change de largeur déplace la bulle
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [selected]);

  return (
    <Tag ref={group} className={`bubble-group ${className}`} role={role} aria-label={label}>
      <span ref={bubble} className="bubble" aria-hidden="true" />
      {children}
    </Tag>
  );
}
